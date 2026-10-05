import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import java.net.*;
import java.util.concurrent.*;
import org.cloudburstmc.netty.channel.nethernet.*;
import org.cloudburstmc.netty.channel.nethernet.signaling.*;
import org.cloudburstmc.netty.channel.nethernet.config.NetherChannelOption;
import org.cloudburstmc.netty.util.nethernet.ServerIdentity;
import org.geysermc.geyser.network.bedrock.nethernet.NetherNetPeer;
import org.cloudburstmc.protocol.bedrock.BedrockServerSession;
import tel.schich.libdatachannel.*;

public class LiveAddressProbe {
    static class Signal implements NetherNetServerSignaling {
        final CompletableFuture<String> answer = new CompletableFuture<>();
        final ServerIdentity identity;

        Signal() throws Exception {
            identity = ServerIdentity.generate("probe");
        }

        public void bind(SocketAddress address, EventLoop loop) {
        }

        public void setNewConnectionHandler(NewConnectionHandler handler) {
        }

        public void setAdvertisementData(PongData pong) {
        }

        public ServerIdentity serverIdentity() {
            return identity;
        }

        public java.util.List<NetherNetSignaling.IceServerInfo> getIceServers() {
            return java.util.List.of();
        }

        public void sendFullSdp(String network, String sdp) {
            answer.complete(sdp);
        }

        public void setSignalHandler(long id, NetherNetSignaling.SignalHandler handler) {
        }

        public void removeSignalHandler(long id) {
        }

        public String getLocalNetworkId() {
            return "1";
        }

        public boolean isActive() {
            return true;
        }

        public boolean usesTrickleIce() {
            return false;
        }

        public void close() {
        }
    }

    public static void main(String[] args) throws Exception {
        LibDataChannelArchDetect.initialize();
        var signal = new Signal();
        var group = new DefaultEventLoopGroup(1);
        var original = new InetSocketAddress("203.0.113.42", 45678);
        var accepted = new CompletableFuture<NetherNetChildChannel>();
        var active = new CompletableFuture<NetherNetChildChannel>();
        var server = new NetherNetServerChannel(signal);
        var client = PeerConnection.createPeer(PeerConnectionConfiguration.DEFAULT
                .withBindAddress(InetAddress.getByName(args[0])).withDisableAutoNegotiation(true));
        try {
            new ServerBootstrap().group(group).channelFactory(() -> server)
                    .option(NetherChannelOption.NETHER_PEER_CONNECTION_CONFIG,
                            PeerConnectionConfiguration.DEFAULT.withBindAddress(InetAddress.getByName(args[0])))
                    .option(NetherChannelOption.NETHER_INFER_PEER_CANDIDATES, false)
                    .childHandler(new ChannelInitializer<NetherNetChildChannel>() {
                        protected void initChannel(NetherNetChildChannel channel) {
                            // Mirrors Geyser NetherNetChannelInitialiser.preInitChannel's address read.
                            System.out.println("Child init address: " + channel.remoteAddress());
                            accepted.complete(channel);
                            channel.pipeline().addLast(new ChannelInboundHandlerAdapter() {
                                public void channelActive(ChannelHandlerContext ctx) {
                                    active.complete(channel);
                                    ctx.fireChannelActive();
                                }
                            });
                        }
                    }).bind(args[0], 0).sync();
            var gathered = new CompletableFuture<String>();
            client.onGatheringStateChange.register((pc, state) -> {
                if (state == GatheringState.RTC_GATHERING_COMPLETE)
                    gathered.complete(pc.localDescription());
            });
            client.createDataChannel("ReliableDataChannel");
            client.createDataChannel("UnreliableDataChannel");
            client.setLocalDescription("offer");
            String offer = gathered.get(5, TimeUnit.SECONDS);
            server.eventLoop().submit(() -> server.acceptConnection(42L, offer, "2", original)).sync();
            var child = accepted.get(5, TimeUnit.SECONDS);
            String answer = signal.answer.get(5, TimeUnit.SECONDS);
            client.setRemoteDescription(answer, SessionDescriptionType.ANSWER);
            active.get(10, TimeUnit.SECONDS);
            var raw = NetherNetChannel.class.getDeclaredMethod("remoteAddress0");
            raw.setAccessible(true);
            var peer = new NetherNetPeer(child, BedrockServerSession::new);
            System.out.println("Native WebRTC connected; raw UDP peer: " + raw.invoke(child));
            System.out.println("Netty channel.remoteAddress: " + child.remoteAddress());
            System.out.println("Geyser peer.getRealAddress: " + peer.getRealAddress());
            if (!original.equals(peer.getRealAddress()))
                throw new AssertionError("signaling IP lost");
            System.out.println("PASS original signaling address survives an actual WebRTC connection");
            child.close().sync();
        } finally {
            client.closeAndAwait(java.time.Duration.ofSeconds(3));
            server.close().sync();
            group.shutdownGracefully(0, 1, TimeUnit.SECONDS).sync();
        }
    }
}
