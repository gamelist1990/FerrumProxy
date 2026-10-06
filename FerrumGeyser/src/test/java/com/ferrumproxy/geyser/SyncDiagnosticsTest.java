package com.ferrumproxy.geyser;

import java.io.IOException;
import java.nio.file.NoSuchFileException;
import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SyncDiagnosticsTest {
    @Test void showsHttpStatusWithoutResponseBody() {
        assertEquals("Manager certificate API returned HTTP 404. Check manager-url, instance ID and registered certificate ID.",
                SyncDiagnostics.detail(new IOException("Manager certificate API returned HTTP 404")));
        assertTrue(SyncDiagnostics.detail(new IOException("Manager certificate API returned HTTP 401")).contains("delegated token"));
    }

    @Test void neverLogsArbitraryExceptionMessagesOrFileNames() {
        String secret = "PRIVATE-FIXTURE-TOKEN\n-----BEGIN PRIVATE KEY-----";
        for (Throwable error : new Throwable[] {
                new IOException(secret), new IOException("Manager certificate API returned HTTP 401 " + secret),
                new NoSuchFileException(secret), new ExecutionException(new IOException(secret)) }) {
            String detail = SyncDiagnostics.detail(error);
            assertFalse(detail.contains("PRIVATE-FIXTURE-TOKEN"));
            assertFalse(detail.contains("BEGIN PRIVATE KEY"));
        }
        assertTrue(SyncDiagnostics.detail(new IOException("Invalid manager token file")).contains("Invalid manager token file"));
    }
}
