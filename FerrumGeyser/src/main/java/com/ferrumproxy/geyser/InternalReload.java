package com.ferrumproxy.geyser;

import org.geysermc.geyser.GeyserImpl;
import org.geysermc.geyser.api.util.PlatformType;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.channels.DatagramChannel;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Direct internal API calls, on the same executor used by the native reload command. */
final class InternalReload {
    private CompletableFuture<Void> pending;

    void install() throws ReflectiveOperationException {
        GeyserImpl geyser = GeyserImpl.getInstance();
        if (geyser.platformType() == PlatformType.STANDALONE)
            StandaloneConsoleGuard.install(geyser.getBootstrap());
    }

    synchronized CompletableFuture<Void> request() {
        if (pending != null && !pending.isDone())
            return pending;
        GeyserImpl geyser = GeyserImpl.getInstance();
        if (!geyser.isEnabled() || geyser.isShuttingDown() || geyser.isReloading())
            return CompletableFuture.failedFuture(new IOException("Geyser is not ready for reload"));
        if (geyser.platformType() == PlatformType.STANDALONE && !StandaloneConsoleGuard.ready(geyser.getBootstrap()))
            return CompletableFuture.failedFuture(new IOException("Standalone console has not initialized"));
        CompletableFuture<Void> result = new CompletableFuture<>();
        pending = result;
        try {
            geyser.getScheduledThread().execute(() -> {
                try {
                    if (geyser.isShuttingDown() || geyser.isReloading())
                        throw new IOException("Geyser reload is already in progress");
                    // Mirror the native reload command's disconnect reason,
                    // then call its actual reload implementation directly.
                    geyser.getSessionManager().disconnectAll("geyser.commands.reload.kick");
                    geyser.reloadGeyser();
                    if (!geyser.isEnabled())
                        throw new IOException("Geyser did not enable after reload");
                    result.complete(null);
                } catch (Exception | LinkageError failure) {
                    result.completeExceptionally(failure);
                }
            });
        } catch (RuntimeException failure) {
            result.completeExceptionally(failure);
        }
        return result;
    }

    void awaitNetworkShutdown() throws IOException, InterruptedException {
        GeyserImpl geyser = GeyserImpl.getInstance();
        var server = geyser.getNetherNetServer();
        if (server == null)
            return;
        var bedrock = geyser.config().bedrock();
        int port = bedrock.signaling().port();
        if (port == 0)
            port = bedrock.port();
        InetAddress address = InetAddress.getByName(bedrock.address());
        InetSocketAddress listen = new InetSocketAddress(address, port);
        InetSocketAddress probe = new InetSocketAddress(address.isAnyLocalAddress()
                ? InetAddress.getByName(address.getAddress().length == 16 ? "::1" : "127.0.0.1") : address, port);
        server.shutdown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        do {
            boolean tcpClosed;
            try (Socket socket = new Socket()) {
                socket.connect(probe, 250);
                tcpClosed = false;
            } catch (ConnectException closed) {
                tcpClosed = true;
            }
            if (tcpClosed) {
                try (DatagramChannel udp = DatagramChannel.open()) {
                    udp.bind(listen);
                    return;
                } catch (java.net.BindException closing) {
                    // The UDP listener may close just after the TCP listener.
                }
            }
            Thread.sleep(25);
        } while (System.nanoTime() < deadline);
        throw new IOException("NetherNet listeners did not close before reload");
    }
}
