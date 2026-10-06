package com.ferrumproxy.geyser;

import org.geysermc.geyser.GeyserBootstrap;
import org.geysermc.geyser.platform.standalone.GeyserStandaloneBootstrap;
import org.geysermc.geyser.platform.standalone.GeyserStandaloneLogger;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The single reflective exception: replace Standalone's private console logger
 * once, because onGeyserEnable() calls its blocking start() on every reload.
 * Config loading, events, listener lifecycle and reload remain Geyser's own code.
 */
final class StandaloneConsoleGuard {
    static void install(GeyserBootstrap bootstrap) throws ReflectiveOperationException {
        GeyserStandaloneBootstrap standalone = (GeyserStandaloneBootstrap) bootstrap;
        if (standalone.getGeyserLogger() instanceof ReloadSafeLogger)
            return;
        Field loggerField = GeyserStandaloneBootstrap.class.getDeclaredField("geyserLogger");
        if (!loggerField.trySetAccessible())
            throw new IllegalAccessException("Standalone console guard is unavailable");
        loggerField.set(standalone, new ReloadSafeLogger(standalone.getGeyserLogger()));
    }

    static boolean ready(GeyserBootstrap bootstrap) {
        return bootstrap.getGeyserLogger() instanceof ReloadSafeLogger logger && logger.started.get();
    }

    static final class ReloadSafeLogger extends GeyserStandaloneLogger {
        private final GeyserStandaloneLogger delegate;
        private final AtomicBoolean started = new AtomicBoolean();

        ReloadSafeLogger(GeyserStandaloneLogger delegate) {
            this.delegate = delegate;
        }

        @Override
        public void start() {
            if (started.compareAndSet(false, true))
                delegate.start();
        }
    }
}
