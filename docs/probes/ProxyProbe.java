import io.netty.channel.*;
import io.netty.channel.nio.NioIoHandler;
import org.cloudburstmc.netty.channel.nethernet.signaling.*;
import org.cloudburstmc.netty.util.nethernet.*;
import java.net.*;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
public class ProxyProbe {
  static void probe(String name, boolean enabled, List<String> trust, int version, String xff, String expected) throws Exception {
    AtomicReference<InetSocketAddress> seen = new AtomicReference<>();
    var group = new MultiThreadIoEventLoopGroup(1, NioIoHandler.newFactory());
    var signaling = new NetherNetHTTPSignaling.Builder().setIdentity(ServerIdentity.generate("probe"))
      .setProxyProtocol(enabled).setTrustedProxies(trust).setMotdProvider((host, address) -> {
        seen.set(address); return NetherNetServerSignaling.PongData.DEFAULT;
      }).build();
    int port;
    try (var free = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = free.getLocalPort(); }
    try {
      signaling.bind(new InetSocketAddress("127.0.0.1", port), group.next());
      try (var socket = new Socket("127.0.0.1", port)) {
        socket.setSoTimeout(3000);
        var out = socket.getOutputStream();
        if (version == 1) out.write(("PROXY TCP4 203.0.113.42 127.0.0.1 45678 " + port + "\r\n").getBytes(StandardCharsets.US_ASCII));
        if (version == 2) {
          var b = ByteBuffer.allocate(28); b.put(new byte[]{13,10,13,10,0,13,10,81,85,73,84,10});
          b.put((byte)0x21).put((byte)0x11).putShort((short)12);
          b.put(InetAddress.getByName("203.0.113.42").getAddress()).put(InetAddress.getByName("127.0.0.1").getAddress());
          b.putShort((short)45678).putShort((short)port); out.write(b.array());
        }
        out.write(("GET /v1/join HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n" + (xff == null ? "" : "X-Forwarded-For: " + xff + "\r\n") + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        var response = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        String actual = seen.get() == null ? "NONE" : seen.get().getAddress().getHostAddress();
        if (!actual.equals(expected)) throw new AssertionError(name + " expected=" + expected + " actual=" + actual + " response=" + response);
        System.out.println("PASS " + name + " address=" + seen.get() + " status=" + response.lines().findFirst().orElse("EMPTY"));
      }
    } finally { signaling.close(); group.shutdownGracefully(0, 1, java.util.concurrent.TimeUnit.SECONDS).sync(); }
  }
  public static void main(String[] args) throws Exception {
    probe("TCP PROXY v1 trusted", true, List.of("127.0.0.1"), 1, null, "203.0.113.42");
    probe("TCP PROXY v2 trusted", true, List.of("127.0.0.1"), 2, null, "203.0.113.42");
    probe("TCP plaintext accepted", true, List.of("127.0.0.1"), 0, null, "127.0.0.1");
    probe("trusted XFF", true, List.of("127.0.0.1"), 0, "203.0.113.43", "203.0.113.43");
    probe("untrusted XFF ignored", true, List.of("192.0.2.1"), 0, "203.0.113.43", "127.0.0.1");
  }
}
