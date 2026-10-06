package com.ferrumproxy.geyser;

import java.net.ConnectException;
import java.net.http.HttpTimeoutException;
import java.nio.file.AccessDeniedException;
import java.nio.file.NoSuchFileException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.util.Set;
import java.util.concurrent.ExecutionException;

/** Log only fixed diagnostic text. Never forward arbitrary exception or API response text. */
final class SyncDiagnostics {
    private static final Set<String> SAFE_MESSAGES = Set.of(
            "Invalid manager token file", "Certificate response exceeds 1 MiB",
            "Certificate response identity mismatch", "Invalid certificate response JSON",
            "Invalid certificate response field type", "Missing certificate material",
            "Certificate chain is empty", "Certificate fingerprint mismatch",
            "Certificate does not cover the configured domain",
            "Only RSA and EC certificate keys are supported", "Certificate and private key do not match",
            "Incomplete advertised UDP endpoint", "Invalid advertised UDP endpoint",
            "Use an unencrypted PEM private key", "Invalid private key PEM",
            "Invalid DER key", "Invalid DER length", "Invalid DER size",
            "Advertised and Geyser Bedrock ports must match for transparent HTTPS",
            "Automatic advertisement requires nethernet transport on the Bedrock port",
            "Managed certificate directories must not be symbolic links",
            "Managed certificate files must not be symbolic links",
            "Geyser is not ready for reload", "Geyser reload is already in progress",
            "Geyser did not enable after reload", "NetherNet listeners did not close before reload",
            "Standalone console has not initialized",
            "Manager URL must have a host and no embedded credentials, query or fragment",
            "Use HTTPS or the Tailscale IP for the Manager API",
            "Configure certificate-id and domain", "Extension config is empty", "poll-seconds must be 30-86400");

    static String detail(Throwable failure) {
        if (failure instanceof ExecutionException && failure.getCause() != null)
            failure = failure.getCause();
        String message = failure.getMessage();
        if (message != null && message.matches("Manager certificate API returned HTTP [1-5][0-9]{2}")) {
            String hint = switch (message.substring(message.length() - 3)) {
                case "400" -> " Check manager-url/path and that Manager API is configured for this instance.";
                case "401" -> " Check the delegated token and its expiration.";
                case "403" -> " Check that the token permits this certificate ID.";
                case "404" -> " Check manager-url, instance ID and registered certificate ID.";
                case "502" -> " Check that the FerrumProxy instance and its Manager API are running.";
                case "503" -> " Check certificate source files and Manager availability.";
                default -> " Check the Manager certificate registration and source files.";
            };
            return message + "." + hint;
        }
        if (message != null && SAFE_MESSAGES.contains(message)) return message + ".";
        if (failure instanceof NoSuchFileException) return "A required local file is missing; check the logged stage.";
        if (failure instanceof AccessDeniedException) return "The Geyser user cannot access a required local file; check permissions.";
        if (failure instanceof HttpTimeoutException) return "Manager request timed out; check connectivity from the Geyser server.";
        if (failure instanceof ConnectException) return "Cannot connect to Manager; check the address, port and Tailscale connectivity.";
        if (failure instanceof CertificateExpiredException) return "The certificate has expired.";
        if (failure instanceof CertificateNotYetValidException) return "The certificate is not yet valid; check the server clock.";
        return "Check Manager URL, token, source validity and Geyser version compatibility.";
    }
}
