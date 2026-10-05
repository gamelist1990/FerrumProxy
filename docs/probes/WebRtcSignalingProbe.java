import tel.schich.libdatachannel.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/** Local transport fixture: actual Ferrum HTTP rewrite and UDP relay, no Minecraft login. */
public class WebRtcSignalingProbe {
  public static void main(String[] args) throws Exception {
    // local IPv4, backend TCP, backend UDP, client UDP, public TCP/UDP
    LibDataChannelArchDetect.initialize();
    var address = InetAddress.getByName(args[0]);
    int backendTcp = Integer.parseInt(args[1]), backendUdp = Integer.parseInt(args[2]);
    int clientUdp = Integer.parseInt(args[3]), proxyPort = Integer.parseInt(args[4]);
    var base = PeerConnectionConfiguration.DEFAULT.withBindAddress(address).withDisableAutoNegotiation(true);
    var server = PeerConnection.createPeer(base.withPortRangeBegin(backendUdp).withPortRangeEnd(backendUdp));
    var client = PeerConnection.createPeer(base.withPortRangeBegin(clientUdp).withPortRangeEnd(clientUdp));
    var http = HttpServer.create(new InetSocketAddress(address, backendTcp), 0);
    var answer = new CompletableFuture<String>();
    var opened = new CompletableFuture<Void>();
    var received = new LinkedBlockingQueue<String>();
    try {
      server.onDataChannel.register((pc, channel) -> channel.onMessage.register(
        DataChannelCallback.Message.handleText((dc, text) -> dc.sendMessage("echo:" + text))));
      server.onGatheringStateChange.register((pc, state) -> {
        if (state == GatheringState.RTC_GATHERING_COMPLETE) answer.complete(pc.localDescription());
      });
      http.createContext("/v1/join/123", exchange -> {
        try {
          String offer = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
          server.setRemoteDescription(offer, SessionDescriptionType.OFFER);
          server.setLocalDescription("answer");
          byte[] body = answer.get(5, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8);
          exchange.getResponseHeaders().set("Content-Type", "application/sdp");
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
        } catch (Exception error) { throw new RuntimeException(error); }
        finally { exchange.close(); }
      });
      http.start();
      var dc = client.createDataChannel("ReliableDataChannel");
      dc.onOpen.register(channel -> opened.complete(null));
      dc.onMessage.register(DataChannelCallback.Message.handleText((channel, text) -> received.offer(text)));
      var gathered = new CompletableFuture<String>();
      client.onGatheringStateChange.register((pc, state) -> {
        if (state == GatheringState.RTC_GATHERING_COMPLETE) gathered.complete(pc.localDescription());
      });
      client.setLocalDescription("offer");
      // Only the fixture removes direct candidates, to prove traffic cannot bypass Ferrum.
      String offer = gathered.get(5, TimeUnit.SECONDS).lines()
        .filter(line -> !line.startsWith("a=candidate:") && !line.equals("a=end-of-candidates"))
        .collect(Collectors.joining("\r\n", "", "\r\n"));
      try (var httpClient = HttpClient.newHttpClient()) {
        var request = HttpRequest.newBuilder(URI.create("http://" + args[0] + ":" + proxyPort + "/v1/join/123"))
          .timeout(java.time.Duration.ofSeconds(10)).header("Content-Type", "application/sdp")
          .POST(HttpRequest.BodyPublishers.ofString(offer)).build();
        var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) throw new AssertionError("HTTP " + response.statusCode());
        String sdp = response.body();
        String publicEndpoint = " " + args[0] + " " + proxyPort + " typ srflx";
        if (sdp.lines().filter(line -> line.startsWith("a=candidate:") && line.contains(publicEndpoint)).count() != 1)
          throw new AssertionError("Missing public candidate");
        for (String line : answer.get().lines().filter(line -> line.startsWith("a=fingerprint:") || line.startsWith("a=ice-")).toList())
          if (!sdp.lines().anyMatch(line::equals)) throw new AssertionError("Security field changed");
        sdp = sdp.lines().filter(line -> !line.startsWith("a=candidate:") || line.contains(publicEndpoint))
          .collect(Collectors.joining("\r\n", "", "\r\n"));
        client.setRemoteDescription(sdp, SessionDescriptionType.ANSWER);
        opened.get(15, TimeUnit.SECONDS);
        dc.sendMessage("corrected-through-ferrum");
        String reply = received.poll(5, TimeUnit.SECONDS);
        if (!"echo:corrected-through-ferrum".equals(reply)) throw new AssertionError("Reply: " + reply);
        if (client.remoteAddress().getPort() != proxyPort) throw new AssertionError("Proxy bypassed");
        System.out.println("PASS HTTP SDP correction + ICE/DTLS/SCTP echo; selected " + client.remoteAddress());
      }
    } finally {
      http.stop(0);
      client.closeAndAwait(java.time.Duration.ofSeconds(3));
      server.closeAndAwait(java.time.Duration.ofSeconds(3));
    }
  }
}
