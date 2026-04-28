import { useState } from "react";
import type { SharedServiceStatus, SharedServiceStartRequest } from "../api";
import { startSharedService, stopSharedService } from "../api";
import "./SharedServicePanel.css";

interface SharedServicePanelProps {
  status: SharedServiceStatus | null;
  onStatusChange: (status: SharedServiceStatus | null) => void;
  formatBytes: (bytes: number) => string;
}

const defaultForm = {
  name: "Shared Service",
  publicHost: "127.0.0.1",
  bindHost: "0.0.0.0",
  haproxy: false,
  tcpEnabled: true,
  udpEnabled: false,
  tcpLocalPort: 25565,
  udpLocalPort: 25565,
  maxTcpConnections: 32,
  maxUdpPeers: 64,
  maxBytesPerSecond: 10 * 1024 * 1024,
  idleTimeoutSeconds: 120,
  udpSessionTimeoutSeconds: 60,
};

export function SharedServicePanel({
  status,
  onStatusChange,
  formatBytes,
}: SharedServicePanelProps) {
  const [form, setForm] = useState(defaultForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof typeof defaultForm>(
    key: K,
    value: (typeof defaultForm)[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: SharedServiceStartRequest = {
        name: form.name,
        publicHost: form.publicHost,
        bindHost: form.bindHost,
        haproxy: form.haproxy,
        tcp: {
          enabled: form.tcpEnabled,
          localHost: "127.0.0.1",
          localPort: form.tcpLocalPort,
        },
        udp: {
          enabled: form.udpEnabled,
          localHost: "127.0.0.1",
          localPort: form.udpLocalPort,
        },
        limits: {
          maxTcpConnections: form.maxTcpConnections,
          maxUdpPeers: form.maxUdpPeers,
          maxBytesPerSecond: form.maxBytesPerSecond,
          idleTimeoutSeconds: form.idleTimeoutSeconds,
          udpSessionTimeoutSeconds: form.udpSessionTimeoutSeconds,
        },
      };
      onStatusChange(await startSharedService(payload));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stopSharedService();
      onStatusChange(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard?.writeText(value);
  };

  return (
    <section className="shared-service-page">
      <div className="shared-header">
        <div>
          <p className="hero-overline">FerrumProxy Shared Service</p>
          <h2>共有サービス</h2>
        </div>
        {status?.running ? (
          <button type="button" className="btn danger" onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={start} disabled={busy}>
            Start
          </button>
        )}
      </div>

      {error && <p className="shared-error">{error}</p>}

      <div className="shared-grid">
        <section className="surface-card shared-form">
          <div className="section-head">
            <h3>Share</h3>
          </div>

          <label>Name</label>
          <input value={form.name} onChange={(e) => update("name", e.target.value)} />

          <label>Public host</label>
          <input
            value={form.publicHost}
            onChange={(e) => update("publicHost", e.target.value)}
          />

          <label>Bind host</label>
          <input value={form.bindHost} onChange={(e) => update("bindHost", e.target.value)} />

          <div className="protocol-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={form.haproxy}
                onChange={(e) => update("haproxy", e.target.checked)}
              />
              HAProxy PROXY protocol
            </label>
          </div>

          <div className="protocol-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={form.tcpEnabled}
                onChange={(e) => update("tcpEnabled", e.target.checked)}
              />
              TCP
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.udpEnabled}
                onChange={(e) => update("udpEnabled", e.target.checked)}
              />
              UDP
            </label>
          </div>

          {form.tcpEnabled && (
            <>
              <label>TCP local port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={form.tcpLocalPort}
                onChange={(e) => update("tcpLocalPort", Number(e.target.value))}
              />
            </>
          )}

          {form.udpEnabled && (
            <>
              <label>UDP local port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={form.udpLocalPort}
                onChange={(e) => update("udpLocalPort", Number(e.target.value))}
              />
            </>
          )}
        </section>

        <section className="surface-card shared-form">
          <div className="section-head">
            <h3>Limits</h3>
          </div>

          <label>Max TCP connections</label>
          <input
            type="number"
            min={1}
            value={form.maxTcpConnections}
            onChange={(e) => update("maxTcpConnections", Number(e.target.value))}
          />

          <label>Max UDP peers</label>
          <input
            type="number"
            min={1}
            value={form.maxUdpPeers}
            onChange={(e) => update("maxUdpPeers", Number(e.target.value))}
          />

          <label>Bandwidth limit bytes/sec</label>
          <input
            type="number"
            min={1024}
            value={form.maxBytesPerSecond}
            onChange={(e) => update("maxBytesPerSecond", Number(e.target.value))}
          />

          <label>TCP idle timeout seconds</label>
          <input
            type="number"
            min={1}
            value={form.idleTimeoutSeconds}
            onChange={(e) => update("idleTimeoutSeconds", Number(e.target.value))}
          />

          <label>UDP session timeout seconds</label>
          <input
            type="number"
            min={1}
            value={form.udpSessionTimeoutSeconds}
            onChange={(e) => update("udpSessionTimeoutSeconds", Number(e.target.value))}
          />
        </section>
      </div>

      {status?.running && (
        <>
          <section className="surface-card shared-endpoints">
            <div className="section-head">
              <h3>Public endpoints</h3>
            </div>
            {status.tcp && (
              <button
                type="button"
                className="endpoint-pill"
                onClick={() => copy(`${status.publicHost}:${status.tcp?.publicPort}`)}
              >
                TCP {status.publicHost}:{status.tcp.publicPort}
              </button>
            )}
            {status.udp && (
              <button
                type="button"
                className="endpoint-pill"
                onClick={() => copy(`${status.publicHost}:${status.udp?.publicPort}`)}
              >
                UDP {status.publicHost}:{status.udp.publicPort}
              </button>
            )}
            <span className="endpoint-mode">
              HAProxy {status.haproxy ? "enabled" : "disabled"}
            </span>
          </section>

          <section className="surface-card">
            <div className="performance-grid">
              <article className="metric-card">
                <span>Active TCP</span>
                <strong>{status.stats.activeTcpConnections}</strong>
              </article>
              <article className="metric-card">
                <span>Active UDP peers</span>
                <strong>{status.stats.activeUdpPeers}</strong>
              </article>
              <article className="metric-card">
                <span>Traffic in</span>
                <strong>{formatBytes(status.stats.bytesIn)}</strong>
              </article>
              <article className="metric-card">
                <span>Traffic out</span>
                <strong>{formatBytes(status.stats.bytesOut)}</strong>
              </article>
            </div>
          </section>

          <section className="surface-card shared-logs">
            <div className="section-head">
              <h3>Shared service logs</h3>
              <span>{status.logs.length} events</span>
            </div>
            <div className="log-container">
              {status.logs.map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`} className={`log-entry log-${entry.level}`}>
                  <span className="log-time">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="log-type">[{entry.event}]</span>
                  <span className="log-message">
                    {entry.protocol ? `${entry.protocol.toUpperCase()} ` : ""}
                    {entry.remoteAddress ? `${entry.remoteAddress} ` : ""}
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
