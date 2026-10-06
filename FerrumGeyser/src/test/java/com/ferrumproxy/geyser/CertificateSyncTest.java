package com.ferrumproxy.geyser;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.io.ByteArrayInputStream;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;

class CertificateSyncTest {
    @TempDir Path directory;

    static String fixture(String name) throws Exception {
        try (var stream = CertificateSyncTest.class.getResourceAsStream("/fixtures/" + name)) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    static CertificateSync.Bundle bundle(String kind, String keyName, String revision) throws Exception {
        String pem = fixture(kind + "-cert.pem");
        var cert = CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
        return new CertificateSync.Bundle("geyser", "play.pexserver.com", revision, "2099-01-01T00:00:00Z", hash, pem, fixture(keyName), "132.145.118.98", 19132);
    }

    @Test void verifiesRsaEcAndTraditionalKeyEncodings() throws Exception {
        for (String kind : new String[]{"rsa", "ec"}) {
            CertificateSync.verify(bundle(kind, kind + "-key.pem", "a".repeat(64)));
            CertificateSync.verify(bundle(kind, kind + "-traditional-key.pem", "a".repeat(64)));
        }
    }

    @Test void rejectsWrongKeyDomainAndExpiredCertificate() throws Exception {
        assertThrows(Exception.class, () -> CertificateSync.verify(bundle("rsa", "rotated-key.pem", "a".repeat(64))));
        assertThrows(CertificateExpiredException.class, () -> CertificateSync.verify(bundle("expired", "expired-key.pem", "a".repeat(64))));
        var original = bundle("rsa", "rsa-key.pem", "a".repeat(64));
        var wrong = new CertificateSync.Bundle(original.id(), "other.pexserver.com", original.revision(), original.expiresAt(), original.certificateSha256(), original.certificatePem(), original.privateKeyPem(), null, null);
        assertThrows(CertificateException.class, () -> CertificateSync.verify(wrong));
        assertFalse(CertificateSync.domainMatches("*.pexserver.com", "a.play.pexserver.com"));
    }

    @Test void restrictsCredentialTransport() {
        CertificateSync.validateUri(URI.create("https://manager.example.com/api/instances/x/manager"), false);
        CertificateSync.validateUri(URI.create("http://100.83.127.8:3000"), false);
        assertThrows(IllegalArgumentException.class, () -> CertificateSync.validateUri(URI.create("http://public.example.com"), false));
        assertThrows(IllegalArgumentException.class, () -> CertificateSync.validateUri(URI.create("https://secret@manager.example.com"), false));
    }

    @Test void correctsRepeatedPathSlashesAndReportsItWithoutChangingSchemeOrEscapes() throws Exception {
        var warnings = new java.util.ArrayList<String>();
        Path config = directory.resolve("config.yml");
        Files.writeString(config, "enabled: true\nmanager-url: 'http://100.64.0.1:3000//api//instances/test%20id/manager///'\ncertificate-id: geyser\ndomain: example.com\n");
        var settings = CertificateSync.Settings.load(directory, warnings::add);
        assertEquals("http://100.64.0.1:3000/api/instances/test%20id/manager", settings.managerUrl().toString());
        assertEquals(1, warnings.size());
        assertTrue(warnings.getFirst().contains("corrected automatically"));
        assertFalse(warnings.getFirst().contains("100.64.0.1"));
        Files.writeString(config, "enabled: true\nmanager-url: 'https://manager.example.com/api/instances/test/manager/'\ncertificate-id: geyser\ndomain: example.com\n");
        warnings.clear();
        assertEquals("https://manager.example.com/api/instances/test/manager", CertificateSync.Settings.load(directory, warnings::add).managerUrl().toString());
        assertTrue(warnings.isEmpty());
        Files.writeString(config, "enabled: true\nmanager-url: 'https://secret@manager.example.com//manager'\ncertificate-id: geyser\ndomain: example.com\n");
        assertThrows(IllegalArgumentException.class, () -> CertificateSync.Settings.load(directory, warnings::add));
    }

    @Test void syncsRotationAndPreservesWorkingConfigOnFailure() throws Exception {
        var response = new AtomicReference<>(bundle("rsa", "rsa-key.pem", "a".repeat(64)));
        var auth = new AtomicReference<>("Bearer first-token");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/certificates/geyser", exchange -> {
            try {
                if (!auth.get().equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                    exchange.sendResponseHeaders(403, -1); return;
                }
                byte[] body = json(response.get()).getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } finally { exchange.close(); }
        });
        server.start();
        Path token = directory.resolve("manager-token.txt"), config = directory.resolve("geyser.yml");
        Files.writeString(token, "first-token\n");
        String original = "# retain 🌍\nbedrock:\n  port: 19132\njava:\n  auth-type: floodgate\n";
        Files.writeString(config, original);
        var settings = new CertificateSync.Settings(true, URI.create("http://127.0.0.1:" + server.getAddress().getPort()), token, "geyser", "play.pexserver.com", 30, true);
        try (var sync = new CertificateSync(settings, directory, config)) {
            assertTrue(sync.sync().changed());
            assertFalse(sync.sync().changed());
            try (var restarted = new CertificateSync(settings, directory, config)) {
                assertFalse(restarted.sync().changed());
            }
            assertEquals(original, Files.readString(directory.resolve("geyser.yml.ferrum-backup")));
            auth.set("Bearer rotated-token"); Files.writeString(token, "rotated-token");
            response.set(bundle("rotated", "rotated-key.pem", "b".repeat(64)));
            assertTrue(sync.sync().changed());
            assertFalse(sync.sync().changed());
            String working = Files.readString(config);
            Files.writeString(config, working.replace("port: 19132", "port: 19133"));
            assertThrows(java.io.IOException.class, sync::sync);
            Files.writeString(config, working);
            response.set(bundle("expired", "expired-key.pem", "c".repeat(64)));
            assertThrows(CertificateExpiredException.class, sync::sync);
            assertEquals("verify-certificate", sync.stage());
            assertEquals(working, Files.readString(config));
            auth.set("Bearer different-token");
            var unauthorized = assertThrows(java.io.IOException.class, sync::sync);
            assertEquals("manager-response", sync.stage());
            assertTrue(SyncDiagnostics.detail(unauthorized).contains("HTTP 403"));
            assertEquals(working, Files.readString(config));
        } finally { server.stop(0); }
    }

    static String json(CertificateSync.Bundle bundle) {
        JsonObject object = new JsonObject();
        object.addProperty("id", bundle.id());
        object.addProperty("domain", bundle.domain());
        object.addProperty("revision", bundle.revision());
        object.addProperty("expiresAt", bundle.expiresAt());
        object.addProperty("certificateSha256", bundle.certificateSha256());
        object.addProperty("certificatePem", bundle.certificatePem());
        object.addProperty("privateKeyPem", bundle.privateKeyPem());
        object.addProperty("advertiseHost", bundle.advertiseHost());
        object.addProperty("advertisePort", bundle.advertisePort());
        return object.toString();
    }

    @Test void decodesExplicitFieldsAndRejectsInvalidTypes() throws Exception {
        var original = bundle("rsa", "rsa-key.pem", "a".repeat(64));
        assertEquals(original, CertificateSync.decodeBundle(json(original)));
        assertNull(CertificateSync.decodeBundle("{\"id\":\"geyser\",\"advertisePort\":null}").advertisePort());
        for (String invalid : List.of("null", "[]", "{\"id\":123}", "{\"advertisePort\":\"19132\"}",
                "{\"advertisePort\":19132.5}", "{\"advertisePort\":4294967296}")) {
            assertThrows(java.io.IOException.class, () -> CertificateSync.decodeBundle(invalid));
        }
    }
}
