import tel.schich.libdatachannel.*;
import java.net.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;
public class WebRtcRelayProbe {
  static CompletableFuture<String> gather(PeerConnection peer, String type) {
    var result = new CompletableFuture<String>();
    peer.onGatheringStateChange.register((pc, state) -> {
      if (state == GatheringState.RTC_GATHERING_COMPLETE) result.complete(pc.localDescription());
    });
    peer.setLocalDescription(type); return result;
  }
  public static void main(String[] args) throws Exception {
    // args: reachable local IPv4, backend UDP port, client UDP port, proxy UDP port
    LibDataChannelArchDetect.initialize();
    InetAddress addr = InetAddress.getByName(args[0]);
    int backend = Integer.parseInt(args[1]), clientPort = Integer.parseInt(args[2]), proxy = Integer.parseInt(args[3]);
    var base = PeerConnectionConfiguration.DEFAULT.withBindAddress(addr).withDisableAutoNegotiation(true);
    var server = PeerConnection.createPeer(base.withPortRangeBegin(backend).withPortRangeEnd(backend));
    var client = PeerConnection.createPeer(base.withPortRangeBegin(clientPort).withPortRangeEnd(clientPort));
    var received = new LinkedBlockingQueue<String>();
    var opened = new CompletableFuture<Void>();
    try {
      server.onDataChannel.register((pc, channel) -> channel.onMessage.register(
        DataChannelCallback.Message.handleText((dc, text) -> dc.sendMessage("echo:" + text))));
      var dc = client.createDataChannel("ReliableDataChannel");
      dc.onOpen.register(channel -> opened.complete(null));
      dc.onMessage.register(DataChannelCallback.Message.handleText((channel, text) -> received.offer(text)));
      String offer = gather(client, "offer").get(5, TimeUnit.SECONDS);
      // Force ICE checks to traverse the proxy. No direct client candidates go to the server.
      offer = offer.lines().filter(line -> !line.startsWith("a=candidate:") && !line.equals("a=end-of-candidates"))
        .collect(Collectors.joining("\r\n", "", "\r\n"));
      var answer = new CompletableFuture<String>();
      server.onGatheringStateChange.register((pc, state) -> {
        if (state == GatheringState.RTC_GATHERING_COMPLETE) answer.complete(pc.localDescription());
      });
      server.setRemoteDescription(offer, SessionDescriptionType.OFFER);
      server.setLocalDescription("answer");
      String sdp = answer.get(5, TimeUnit.SECONDS);
      sdp = sdp.replaceAll("(?m)^a=candidate:[^\\r\\n]+", "a=candidate:1 1 UDP 2130706431 " + args[0] + " " + proxy + " typ host");
      client.setRemoteDescription(sdp, SessionDescriptionType.ANSWER);
      opened.get(15, TimeUnit.SECONDS);
      dc.sendMessage("nethernet-through-ferrum");
      String reply = received.poll(5, TimeUnit.SECONDS);
      if (!reply.equals("echo:nethernet-through-ferrum")) throw new AssertionError(reply);
      if (client.remoteAddress().getPort() != proxy) throw new AssertionError("ICE bypassed proxy: " + client.remoteAddress());
      System.out.println("PASS native WebRTC SCTP DataChannel roundtrip: " + reply);
      System.out.println("Client selected remote: " + client.remoteAddress());
      System.out.println("Backend selected remote: " + server.remoteAddress());
      if (args.length > 4) {
        int quietSeconds = Integer.parseInt(args[4]);
        Thread.sleep(quietSeconds * 1000L);
        dc.sendMessage("after-idle");
        String idleReply = received.poll(5, TimeUnit.SECONDS);
        if (!"echo:after-idle".equals(idleReply)) throw new AssertionError("UDP mapping lost after idle: " + idleReply);
        System.out.println("PASS DataChannel still usable after " + quietSeconds + " seconds quiet");
      }
    } finally {
      client.closeAndAwait(java.time.Duration.ofSeconds(3));
      server.closeAndAwait(java.time.Duration.ofSeconds(3));
    }
  }
}
