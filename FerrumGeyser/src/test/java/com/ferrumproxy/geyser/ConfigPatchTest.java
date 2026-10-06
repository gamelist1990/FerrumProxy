package com.ferrumproxy.geyser;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ConfigPatchTest {
    @Test void preservesCommentsUnicodeAndUnrelatedSettings() {
        String original = "# サーバー 🌍\njava:\n  auth-type: floodgate\nbedrock:\n  port: 19132\n  signaling:\n    mode: builtin\n    builtin:\n      https:\n        certificate: '' # cert\n        private-key: ''\n        password: 'old'\n";
        String changed = ConfigPatch.https(original, "/a/fullchain.pem", "/a/key.pem");
        assertTrue(changed.startsWith("# サーバー 🌍\njava:\n  auth-type: floodgate\n"));
        assertTrue(changed.contains("certificate: '/a/fullchain.pem' # cert"));
        assertTrue(changed.contains("password: ''"));
        assertEquals(changed, ConfigPatch.https(changed, "/a/fullchain.pem", "/a/key.pem"));
    }

    @Test void createsMissingSectionsAndPreservesCrLf() {
        String changed = ConfigPatch.https("bedrock:\r\n  port: 19132\r\njava:\r\n  auth-type: floodgate\r\n", "cert.pem", "key.pem");
        assertTrue(changed.contains("    builtin:\r\n      https:\r\n        certificate: 'cert.pem'\r\n"));
        assertTrue(changed.endsWith("java:\r\n  auth-type: floodgate\r\n"));
        assertFalse(changed.replace("\r\n", "").contains("\n"));
    }

    @Test void rejectsAmbiguousDuplicateConfiguration() {
        assertThrows(RuntimeException.class, () -> ConfigPatch.https("bedrock: {}\nbedrock: {}\n", "c", "k"));
    }
}
