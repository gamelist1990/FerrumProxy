"""Real Geyser HTTPS/renewal check; public test keys and isolated local processes only."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.request


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", default="java")
    parser.add_argument("--geyser-jar", type=Path)
    parser.add_argument("--proxy", type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    module = root / "FerrumGeyser"
    extension = module / "target" / "FerrumGeyser.jar"
    geyser_jar = (args.geyser_jar or module / ".deps" / "Geyser-Standalone.jar").resolve()
    proxy_exe = (args.proxy or root / "target" / "debug" /
                 ("ferrum-proxy.exe" if sys.platform == "win32" else "ferrum-proxy")).resolve()
    for required in (extension, geyser_jar, proxy_exe):
        if not required.is_file():
            raise RuntimeError(f"Build/download required file first: {required}")
    work = module / ".deps" / f"smoke-{time.time_ns()}"
    work.mkdir(parents=True)
    print(f"Isolated diagnostics: {work}", flush=True)
    fixtures = module / "src" / "test" / "resources" / "fixtures"
    manager_port, bedrock_port = free_port(), free_port()
    while manager_port == bedrock_port:
        bedrock_port = free_port()
    proxy_cfg = work / "proxy.json"
    proxy_cfg.write_text(json.dumps({"listeners": [], "useRestApi": False,
                                    "savePlayerIP": False, "firewall": {"enabled": False}}))
    cert, key = work / "source-cert.pem", work / "source-key.pem"
    shutil.copyfile(fixtures / "rsa-cert.pem", cert)
    shutil.copyfile(fixtures / "rsa-key.pem", key)
    java_dir = work / "geyser"
    data = java_dir / "extensions" / "FerrumCertificates"
    data.mkdir(parents=True)
    shutil.copyfile(extension, java_dir / "extensions" / "FerrumGeyser.jar")
    (java_dir / "config.yml").write_text(f"""bedrock:
  address: 127.0.0.1
  port: {bedrock_port}
  webrtc-port: 0
  transport: nethernet
  signaling:
    mode: builtin
    builtin:
      https:
        certificate: ''
        private-key: ''
        password: ''
java:
  auth-type: offline
advanced:
  bedrock:
    use-haproxy-protocol: false
    validate-bedrock-login: false
debug-mode: false
config-version: 8
""", encoding="utf-8")
    (data / "config.yml").write_text(f"""enabled: true
manager-url: 'http://127.0.0.1:{manager_port}'
token-file: manager-token.txt
certificate-id: geyser
domain: play.pexserver.com
poll-seconds: 30
auto-reload: true
allow-insecure-http: false
""", encoding="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proxy = java = None
    log_proxy = (work / "proxy.log").open("w", encoding="utf-8")
    log_java = (work / "geyser.log").open("w", encoding="utf-8")
    base = f"http://127.0.0.1:{manager_port}"

    def api(method, path, body=None):
        request = urllib.request.Request(
            base + path, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer smoke-test-root", "Content-Type": "application/json"},
            method=method)
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def start_geyser():
        return subprocess.Popen([args.java, "-Xmx512m", "-jar", str(geyser_jar), "--nogui"],
                                cwd=java_dir, stdin=subprocess.PIPE, stdout=log_java,
                                stderr=subprocess.STDOUT, creationflags=flags)

    def check_geyser():
        if java.poll() is not None:
            raise RuntimeError(f"Geyser exited ({java.returncode}); see {work / 'geyser.log'}")

    def probe():
        # Only self-signed public fixtures; independently compare the certificate fingerprint.
        context = ssl._create_unverified_context()
        with socket.create_connection(("127.0.0.1", bedrock_port), timeout=2) as raw:
            with context.wrap_socket(raw, server_hostname="play.pexserver.com") as connection:
                digest = hashlib.sha256(connection.getpeercert(binary_form=True)).hexdigest()
                connection.sendall(b"GET /v1/join HTTP/1.1\r\nHost: play.pexserver.com\r\nConnection: close\r\n\r\n")
                response = b""
                while b"\r\n\r\n" not in response and len(response) < 65536:
                    chunk = connection.recv(8192)
                    if not chunk:
                        break
                    response += chunk
                if b"200 OK" not in response.split(b"\r\n", 1)[0]:
                    raise RuntimeError("Geyser join endpoint did not return HTTP 200")
                return digest

    def wait_for_certificate(expected, seconds, label):
        deadline = time.monotonic() + seconds
        next_notice = 0
        while time.monotonic() < deadline:
            check_geyser()
            try:
                if probe() == expected:
                    return
            except (OSError, RuntimeError):
                pass
            if time.monotonic() >= next_notice:
                print(f"Waiting for {label}...", flush=True)
                next_notice = time.monotonic() + 15
            time.sleep(1)
        raise RuntimeError(f"Timed out waiting for {label}; see {work / 'geyser.log'}")

    try:
        proxy = subprocess.Popen([str(proxy_exe), "--config", str(proxy_cfg), "--manager-port",
                                  str(manager_port), "--manager-token", "smoke-test-root"],
                                 cwd=work, stdout=log_proxy, stderr=subprocess.STDOUT, creationflags=flags)
        for _ in range(40):
            try:
                api("GET", "/api/v1/health")
                break
            except (OSError, ValueError):
                time.sleep(.25)
        else:
            raise RuntimeError("Manager did not start")
        api("POST", "/api/v1/certificates", {
            "id": "geyser", "domain": "play.pexserver.com", "certificatePath": str(cert),
            "privateKeyPath": str(key), "advertiseHost": "127.0.0.1", "advertisePort": bedrock_port})
        token = api("POST", "/api/v1/credentials", {
            "name": "Smoke Geyser", "scopes": ["certificates:read:geyser"], "expiresIn": 600})["token"]
        (data / "manager-token.txt").write_text(token, encoding="utf-8")
        expected = api("GET", "/api/v1/certificates/geyser")["certificateSha256"]
        java = start_geyser()
        initial_pid = java.pid
        wait_for_certificate(expected, 120, "Geyser HTTPS startup")
        print("PASS real Geyser patches config and applies HTTPS /v1/join through its native internal reload", flush=True)

        shutil.copyfile(fixtures / "rotated-cert.pem", cert)
        shutil.copyfile(fixtures / "rotated-key.pem", key)
        renewed = api("GET", "/api/v1/certificates/geyser")["certificateSha256"]
        assert expected != renewed
        wait_for_certificate(renewed, 90, "certificate renewal")
        assert java.pid == initial_pid
        print("PASS certificate renewal reaches live Geyser HTTPS without a process restart", flush=True)

        # Allow another actual poll: identical material must not trigger another reload.
        print("Checking unchanged certificate over another poll interval...", flush=True)
        for _ in range(33):
            check_geyser()
            time.sleep(1)
        log_java.flush()
        logged = (work / "geyser.log").read_text(encoding="utf-8", errors="replace")
        assert logged.count("Geyser HTTPS reload completed.") == 2, "Expected exactly initial and renewal reloads"
        assert "Certificate sync/apply failed" not in logged
        print("PASS unchanged certificate does not trigger repeated reloads", flush=True)

        # The original console must still execute commands, including native reload.
        starts = logged.count("Built-in signaling started on")
        java.stdin.write(b"geyser reload\n")
        java.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            check_geyser()
            log_java.flush()
            logged = (work / "geyser.log").read_text(encoding="utf-8", errors="replace")
            if logged.count("Built-in signaling started on") > starts:
                break
            time.sleep(.25)
        else:
            raise RuntimeError("Original console could not execute geyser reload")
        wait_for_certificate(renewed, 15, "HTTPS after console geyser reload")
        help_mentions = logged.count("geyser help")
        java.stdin.write(b"geyser help\n")
        java.stdin.flush()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            log_java.flush()
            logged = (work / "geyser.log").read_text(encoding="utf-8", errors="replace")
            if logged.count("geyser help") > help_mentions:
                break
            time.sleep(.25)
        else:
            raise RuntimeError("Console did not respond after native reload")
        assert "Built-in signaling could not start" not in logged
        assert java.pid == initial_pid
        print("PASS manual geyser reload and subsequent console commands work in the same process", flush=True)
        log_java.flush()
        log_proxy.flush()
        logged = (work / "geyser.log").read_text(encoding="utf-8", errors="replace")
        assert token not in logged and "PRIVATE KEY-----" not in logged
        assert token not in (work / "proxy.log").read_text(encoding="utf-8", errors="replace")
        print("PASS token and private key are absent from logs", flush=True)
    finally:
        stop(java)
        stop(proxy)
        log_java.close()
        log_proxy.close()


if __name__ == "__main__":
    main()
