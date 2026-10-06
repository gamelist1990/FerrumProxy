package com.ferrumproxy.geyser;

import org.geysermc.geyser.platform.standalone.GeyserStandaloneBootstrap;
import org.geysermc.geyser.platform.standalone.GeyserStandaloneLogger;
import org.junit.jupiter.api.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class StandaloneConsoleGuardTest {
    @Test void secondConsoleStartReturnsWhileOriginalInputLoopIsBlocked() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), finish = new CountDownLatch(1);
        AtomicInteger starts = new AtomicInteger();
        var original = new GeyserStandaloneLogger() {
            @Override public void start() {
                starts.incrementAndGet(); entered.countDown();
                try { finish.await(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            }
        };
        var guarded = new StandaloneConsoleGuard.ReloadSafeLogger(original);
        Thread first = Thread.ofPlatform().daemon().start(guarded::start);
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            assertTimeoutPreemptively(java.time.Duration.ofSeconds(2), guarded::start);
            assertEquals(1, starts.get());
        } finally { finish.countDown(); first.join(5000); }
    }

    @Test void installsOnlyOnceAndKeepsInitialConsoleStartPending() throws Exception {
        var bootstrap = new GeyserStandaloneBootstrap();
        StandaloneConsoleGuard.install(bootstrap);
        var logger = bootstrap.getGeyserLogger();
        assertInstanceOf(StandaloneConsoleGuard.ReloadSafeLogger.class, logger);
        assertFalse(StandaloneConsoleGuard.ready(bootstrap));
        StandaloneConsoleGuard.install(bootstrap);
        assertSame(logger, bootstrap.getGeyserLogger());
    }
}
