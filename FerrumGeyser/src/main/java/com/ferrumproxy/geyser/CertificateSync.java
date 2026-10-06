package com.ferrumproxy.geyser;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.*;
import java.security.cert.*;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.util.*;
import java.util.function.Consumer;

final class CertificateSync implements AutoCloseable {
    record Settings(boolean enabled, URI managerUrl, Path tokenFile, String certificateId, String domain,
            long pollSeconds, boolean autoReload) {
        static Settings load(Path directory) throws IOException {
            return load(directory, ignored -> {});
        }

        static Settings load(Path directory, Consumer<String> warning) throws IOException {
            org.yaml.snakeyaml.LoaderOptions options = new org.yaml.snakeyaml.LoaderOptions();
            options.setAllowDuplicateKeys(false);
            Map<String, Object> config = new Yaml(new SafeConstructor(options)).load(Files.readString(directory.resolve("config.yml")));
            if (config == null)
                throw new IllegalArgumentException("Extension config is empty");
            if (!Boolean.TRUE.equals(config.get("enabled")))
                return new Settings(false, null, null, "", "", 300, false);
            URI uri = URI.create(Objects.toString(config.get("manager-url"), "").trim());
            validateUri(uri, Boolean.TRUE.equals(config.get("allow-insecure-http")));
            String rawPath = Objects.toString(uri.getRawPath(), "");
            String path = rawPath.replaceAll("/{2,}", "/").replaceAll("/+$", "");
            if (rawPath.contains("//"))
                warning.accept("manager-url path contains repeated slashes; corrected automatically. Use a single / before api/instances/.");
            uri = URI.create(uri.getScheme() + "://" + uri.getRawAuthority() + path);
            String id = Objects.toString(config.get("certificate-id"), "");
            String domain = Objects.toString(config.get("domain"), "").toLowerCase(Locale.ROOT);
            if (!id.matches("[A-Za-z0-9_-]{1,64}") || !domain.matches("[a-z0-9.-]+") || !domain.contains("."))
                throw new IllegalArgumentException("Configure certificate-id and domain");
            Path token = directory.resolve(Objects.toString(config.get("token-file"), "manager-token.txt")).normalize();
            long interval = ((Number) config.getOrDefault("poll-seconds", 300)).longValue();
            if (interval < 30 || interval > 86400)
                throw new IllegalArgumentException("poll-seconds must be 30-86400");
            return new Settings(true, uri, token, id, domain, interval,
                    !Boolean.FALSE.equals(config.get("auto-reload")));
        }
    }

    record Bundle(String id, String domain, String revision, String expiresAt, String certificateSha256,
            String certificatePem, String privateKeyPem, String advertiseHost, Integer advertisePort) {
    }

    record Applied(boolean changed, String revision, String advertiseHost, Integer advertisePort) {
    }

    private final Settings settings;
    private final Path directory, geyserConfig;
    private final HttpClient client;
    private String revision;
    private volatile String stage = "idle";
    private static final int LIMIT = 1024 * 1024;

    String stage() { return stage; }

    CertificateSync(Settings settings, Path directory, Path geyserConfig) {
        this.settings = settings;
        this.directory = directory.toAbsolutePath().normalize();
        this.geyserConfig = geyserConfig;
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    synchronized Applied sync() throws Exception {
        stage = "read-token";
        String token = Files.readString(settings.tokenFile()).trim();
        if (token.isEmpty() || token.length() > 1024 || token.contains("\n") || token.contains("\r"))
            throw new IOException("Invalid manager token file");
        URI uri = URI.create(settings.managerUrl() + "/api/v1/certificates/" + settings.certificateId());
        stage = "manager-request";
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + token)
                .header("User-Agent", "FerrumGeyserCertificates/1.0").GET();
        // Fetch the bundle each time: a 304 must not hide deleted local files,
        // configuration edits, or a certificate that has since expired.
        HttpResponse<InputStream> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
        stage = "manager-response";
        byte[] bytes;
        try (InputStream body = response.body()) {
            if (response.statusCode() != 200)
                throw new IOException("Manager certificate API returned HTTP " + response.statusCode());
            bytes = body.readNBytes(LIMIT + 1);
            if (bytes.length > LIMIT)
                throw new IOException("Certificate response exceeds 1 MiB");
        }
        stage = "decode-response";
        Bundle bundle = decodeBundle(new String(bytes, StandardCharsets.UTF_8));
        if (bundle == null || !settings.certificateId().equals(bundle.id())
                || !settings.domain().equalsIgnoreCase(bundle.domain())
                || bundle.revision() == null || !bundle.revision().matches("[a-f0-9]{64}"))
            throw new IOException("Certificate response identity mismatch");
        stage = "verify-certificate";
        verify(bundle);
        stage = "read-geyser-config";
        String current = Files.readString(geyserConfig);
        stage = "validate-geyser-network";
        if (bundle.advertisePort() != null) {
            Map<?, ?> config = new Yaml(new SafeConstructor(new org.yaml.snakeyaml.LoaderOptions())).load(current);
            Map<?, ?> bedrock = (Map<?, ?>) config.get("bedrock");
            if (!(bedrock.get("port") instanceof Number port) || port.intValue() != bundle.advertisePort())
                throw new IOException("Advertised and Geyser Bedrock ports must match for transparent HTTPS");
            Object transport = bedrock.get("transport");
            Object webrtc = bedrock.get("webrtc-port");
            if (transport != null && !"nethernet".equals(transport)
                    || webrtc instanceof Number udp && udp.intValue() != 0 && udp.intValue() != port.intValue())
                throw new IOException("Automatic advertisement requires nethernet transport on the Bedrock port");
        }
        stage = "write-certificate";
        Path generation = directory.resolve("tls").resolve(bundle.revision());
        if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(directory.resolve("tls"))
                || Files.isSymbolicLink(generation))
            throw new IOException("Managed certificate directories must not be symbolic links");
        Files.createDirectories(generation);
        privatePermissions(generation, true);
        Path cert = generation.resolve("fullchain.pem"), key = generation.resolve("privkey.pem");
        writeIfChanged(cert, bundle.certificatePem(), true);
        writeIfChanged(key, bundle.privateKeyPem(), true);
        stage = "write-geyser-config";
        String updated = ConfigPatch.https(current, cert.toString().replace('\\', '/'),
                key.toString().replace('\\', '/'));
        boolean changed = (revision != null && !Objects.equals(revision, bundle.revision())) || !updated.equals(current);
        if (!updated.equals(current)) {
            Path backup = geyserConfig.resolveSibling(geyserConfig.getFileName() + ".ferrum-backup");
            if (!Files.exists(backup))
                atomicWrite(backup, current, true);
            atomicWrite(geyserConfig, updated, true);
        }
        revision = bundle.revision();
        stage = "complete";
        return new Applied(changed, revision, bundle.advertiseHost(), bundle.advertisePort());
    }

    static Bundle decodeBundle(String json) throws IOException {
        try {
            JsonObject object = JsonParser.parseString(json).getAsJsonObject();
            return new Bundle(string(object, "id"), string(object, "domain"), string(object, "revision"),
                    string(object, "expiresAt"), string(object, "certificateSha256"), string(object, "certificatePem"),
                    string(object, "privateKeyPem"), string(object, "advertiseHost"),
                    integer(object, "advertisePort"));
        } catch (RuntimeException invalid) {
            throw new IOException("Invalid certificate response JSON");
        }
    }

    private static Integer integer(JsonObject object, String name) throws IOException {
        var value = object.get(name);
        if (value == null || value.isJsonNull())
            return null;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
            throw new IOException("Invalid certificate response field type");
        return value.getAsBigDecimal().intValueExact();
    }

    private static String string(JsonObject object, String name) throws IOException {
        var value = object.get(name);
        if (value == null || value.isJsonNull())
            return null;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
            throw new IOException("Invalid certificate response field type");
        return value.getAsString();
    }

    static void validateUri(URI uri, boolean allowInsecure) {
        String host = uri.getHost();
        if (host == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException(
                    "Manager URL must have a host and no embedded credentials, query or fragment");
        boolean loopback = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]")
                || host.equals("::1");
        String[] parts = host.split("\\.");
        boolean tailscale = false;
        if (parts.length == 4 && host.matches("[0-9.]+")) {
            int[] octets = Arrays.stream(parts).mapToInt(Integer::parseInt).toArray();
            tailscale = octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127
                    && Arrays.stream(octets).allMatch(n -> n >= 0 && n <= 255);
        }
        if (!"https".equals(uri.getScheme())
                && !("http".equals(uri.getScheme()) && (loopback || tailscale || allowInsecure)))
            throw new IllegalArgumentException("Use HTTPS or the Tailscale IP for the Manager API");
    }

    static void verify(Bundle bundle) throws Exception {
        if (bundle.certificatePem() == null || bundle.privateKeyPem() == null)
            throw new IOException("Missing certificate material");
        var certificates = CertificateFactory.getInstance("X.509").generateCertificates(
                new ByteArrayInputStream(bundle.certificatePem().getBytes(StandardCharsets.US_ASCII)));
        if (certificates.isEmpty())
            throw new CertificateException("Certificate chain is empty");
        X509Certificate leaf = (X509Certificate) certificates.iterator().next();
        for (var certificate : certificates)
            ((X509Certificate) certificate).checkValidity();
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(leaf.getEncoded()));
        if (!digest.equals(bundle.certificateSha256()))
            throw new CertificateException("Certificate fingerprint mismatch");
        var names = leaf.getSubjectAlternativeNames();
        if (names == null || names.stream().noneMatch(name -> Integer.valueOf(2).equals(name.getFirst())
                && domainMatches(name.get(1).toString(), bundle.domain())))
            throw new CertificateException("Certificate does not cover the configured domain");
        String algorithm = leaf.getPublicKey().getAlgorithm();
        String signatureAlgorithm = switch (algorithm) {
            case "RSA" -> "SHA256withRSA";
            case "EC" -> "SHA256withECDSA";
            default -> throw new InvalidKeyException("Only RSA and EC certificate keys are supported");
        };
        byte[] der = pemKey(bundle.privateKeyPem());
        if (bundle.privateKeyPem().contains("BEGIN RSA PRIVATE KEY")
                || bundle.privateKeyPem().contains("BEGIN EC PRIVATE KEY")) {
            Der publicInfo = new Der(leaf.getPublicKey().getEncoded());
            Der inner = new Der(publicInfo.content(0x30));
            byte[] algorithmId = inner.element(0x30);
            der = encode(0x30, concat(new byte[] { 2, 1, 0 }, algorithmId, encode(4, der)));
        }
        PrivateKey privateKey = KeyFactory.getInstance(algorithm).generatePrivate(new PKCS8EncodedKeySpec(der));
        byte[] challenge = new byte[32];
        new SecureRandom().nextBytes(challenge);
        Signature signature = Signature.getInstance(signatureAlgorithm);
        signature.initSign(privateKey);
        signature.update(challenge);
        byte[] signed = signature.sign();
        signature.initVerify(leaf.getPublicKey());
        signature.update(challenge);
        if (!signature.verify(signed))
            throw new InvalidKeyException("Certificate and private key do not match");
        if ((bundle.advertiseHost() == null) != (bundle.advertisePort() == null))
            throw new IOException("Incomplete advertised UDP endpoint");
        if (bundle.advertiseHost() != null && (!bundle.advertiseHost().matches("[0-9a-fA-F:.]+")
                || bundle.advertisePort() < 1 || bundle.advertisePort() > 65535))
            throw new IOException("Invalid advertised UDP endpoint");
    }

    static boolean domainMatches(String pattern, String domain) {
        pattern = pattern.toLowerCase(Locale.ROOT);
        domain = domain.toLowerCase(Locale.ROOT);
        int dot = domain.indexOf('.');
        return pattern.equals(domain)
                || pattern.startsWith("*.") && dot > 0 && domain.substring(dot + 1).equals(pattern.substring(2));
    }

    private static byte[] pemKey(String pem) throws IOException {
        if (!pem.contains("BEGIN PRIVATE KEY") && !pem.contains("BEGIN RSA PRIVATE KEY")
                && !pem.contains("BEGIN EC PRIVATE KEY"))
            throw new IOException("Use an unencrypted PEM private key");
        try {
            return Base64.getDecoder().decode(pem.replaceAll("-----[^-]+-----", "").replaceAll("\\s", ""));
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid private key PEM");
        }
    }

    private static final class Der {
        final byte[] bytes;
        int position;

        Der(byte[] bytes) {
            this.bytes = bytes;
        }

        byte[] element(int tag) throws IOException {
            int start = position;
            content(tag);
            return Arrays.copyOfRange(bytes, start, position);
        }

        byte[] content(int tag) throws IOException {
            if (position + 2 > bytes.length || (bytes[position++] & 255) != tag)
                throw new IOException("Invalid DER key");
            int size = bytes[position++] & 255;
            if (size > 127) {
                int count = size & 127;
                if (count == 0 || count > 4 || position + count > bytes.length)
                    throw new IOException("Invalid DER length");
                size = 0;
                while (count-- > 0)
                    size = (size << 8) | (bytes[position++] & 255);
            }
            if (size < 0 || size > bytes.length - position)
                throw new IOException("Invalid DER size");
            byte[] value = Arrays.copyOfRange(bytes, position, position + size);
            position += size;
            return value;
        }
    }

    private static byte[] encode(int tag, byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (data.length < 128)
            out.write(data.length);
        else {
            int count = 0, length = data.length;
            while (length != 0) {
                count++;
                length >>>= 8;
            }
            out.write(128 | count);
            for (int i = count - 1; i >= 0; i--)
                out.write(data.length >>> (i * 8));
        }
        out.writeBytes(data);
        return out.toByteArray();
    }

    private static byte[] concat(byte[]... arrays) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] array : arrays)
            out.writeBytes(array);
        return out.toByteArray();
    }

    private static void writeIfChanged(Path path, String text, boolean secret) throws IOException {
        if (Files.isSymbolicLink(path))
            throw new IOException("Managed certificate files must not be symbolic links");
        if (!Files.exists(path) || !Files.readString(path).equals(text))
            atomicWrite(path, text, secret);
        privatePermissions(path, false);
    }

    static void atomicWrite(Path path, String value, boolean secret) throws IOException {
        Path temporary = Files.createTempFile(path.toAbsolutePath().getParent(), ".ferrum-", ".tmp");
        try {
            if (secret)
                privatePermissions(temporary, false);
            Files.writeString(temporary, value, StandardCharsets.UTF_8);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    static void privatePermissions(Path path, boolean directory) throws IOException {
        if (Files.getFileStore(path).supportsFileAttributeView("posix"))
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(directory ? "rwx------" : "rw-------"));
    }

    @Override
    public void close() {
        client.close();
    }
}
