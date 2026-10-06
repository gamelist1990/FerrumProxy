package com.ferrumproxy.geyser;

import org.geysermc.event.subscribe.Subscribe;
import org.geysermc.geyser.api.extension.Extension;
import org.geysermc.geyser.api.event.lifecycle.GeyserPreInitializeEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserPostInitializeEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserShutdownEvent;
import org.geysermc.geyser.api.event.lifecycle.GeyserPreReloadEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Synchronizes TLS files and applies them through Geyser's internal reload implementation. */
public final class FerrumCertificates implements Extension {
    private CertificateSync sync;
    private CertificateSync.Settings settings;
    private ScheduledExecutorService worker;
    private volatile boolean initialized;
    private boolean needsApply;
    private boolean manualApplyNotified;
    private final InternalReload reload = new InternalReload();

    @Subscribe
    public void prepare(GeyserPreInitializeEvent event) {
        try {
            Files.createDirectories(dataFolder());
            Path config = dataFolder().resolve("config.yml");
            if (!Files.exists(config)) {
                try (var input = getClass().getResourceAsStream("/config.yml")) {
                    Files.copy(input, config);
                }
                CertificateSync.privatePermissions(config, false);
                logger().info("Configure " + config.toAbsolutePath() + " and manager-token.txt, then restart Geyser.");
            }
            settings = CertificateSync.Settings.load(dataFolder(), message -> logger().warning(message));
            if (!settings.enabled()) {
                logger().info("Certificate sync is disabled (enabled: false). Set enabled: true in "
                        + config.toAbsolutePath() + " and restart Geyser.");
                return;
            }
            logger().info("Certificate sync is enabled (certificate-id: " + settings.certificateId()
                    + ", poll-seconds: " + settings.pollSeconds() + "). Config: " + config.toAbsolutePath());
            if (Files.exists(settings.tokenFile()))
                CertificateSync.privatePermissions(settings.tokenFile(), false);
            sync = new CertificateSync(settings, dataFolder(), geyserApi().configDirectory().resolve("config.yml"));
            reload.install();
            // Geyser has already read its config. Reload after initialization
            // to apply the first disk change, just as for subsequent renewals.
            synchronize();
        } catch (Exception | LinkageError failure) {
            report(failure, "initialize");
        }
    }

    @Subscribe
    public void start(GeyserPostInitializeEvent event) {
        initialized = true;
        if (sync == null || worker != null)
            return;
        worker = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "Ferrum certificate sync");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::synchronize, 2, settings.pollSeconds(), TimeUnit.SECONDS);
    }

    private void synchronize() {
        String phase = "certificate-sync";
        try {
            CertificateSync.Applied result = sync.sync();
            if (result.advertiseHost() != null)
                System.setProperty("geyserAdvertiseAddresses", result.advertiseHost());
            if (result.changed()) {
                needsApply = true;
                manualApplyNotified = false;
                logger().info("Updated NetherNet HTTPS certificate: " + result.revision().substring(0, 12));
            }
            if (!initialized || !needsApply)
                return;
            if (settings.autoReload()) {
                phase = "reload-geyser";
                logger().info("Reloading Geyser to apply HTTPS; Bedrock players will disconnect.");
                reload.request().get(30, TimeUnit.SECONDS);
                needsApply = false;
                logger().info("Geyser HTTPS reload completed.");
            } else if (!manualApplyNotified) {
                logger().warning("Run geyser reload to apply HTTPS, or enable auto-reload for automatic application.");
                manualApplyNotified = true;
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception | LinkageError failure) {
            report(failure, "certificate-sync".equals(phase) ? sync.stage() : phase);
        }
    }

    private void report(Throwable failure, String stage) {
        // Never log tokens, PEM or response bodies.
        logger().warning("Certificate sync/apply failed (" + failure.getClass().getSimpleName()
                + ", stage: " + stage + "). " + SyncDiagnostics.detail(failure));
    }

    @Subscribe
    public void beforeReload(GeyserPreReloadEvent event) {
        if (sync == null)
            return;
        try {
            // Native NetherNet shutdown is asynchronous. Await the listeners
            // before either an automatic or a console-initiated native reload.
            reload.awaitNetworkShutdown();
        } catch (Exception | LinkageError failure) {
            report(failure, "close-nethernet");
        }
    }

    @Subscribe
    public void stop(GeyserShutdownEvent event) {
        initialized = false;
        if (worker != null)
            worker.shutdownNow();
        if (sync != null)
            sync.close();
    }
}
