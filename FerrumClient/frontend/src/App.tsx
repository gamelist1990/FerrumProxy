import { useState } from "react";
import "./App.css";
import "./SharedServicePanel.css";

const defaultForm = {
  relayAddress: "127.0.0.1:7000",
  token: "",
  tcpEnabled: true,
  udpEnabled: false,
  tcpLocalPort: 25565,
  udpLocalPort: 25565,
  haproxy: false,
};

function App() {
  const [form, setForm] = useState(defaultForm);
  const [running, setRunning] = useState(false);

  const update = <K extends keyof typeof defaultForm>(
    key: K,
    value: (typeof defaultForm)[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const protocols = [
    form.tcpEnabled ? `TCP 127.0.0.1:${form.tcpLocalPort}` : null,
    form.udpEnabled ? `UDP 127.0.0.1:${form.udpLocalPort}` : null,
  ].filter(Boolean);

  return (
    <div className="app">
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <p className="brand-kicker">FerrumProxy User Client</p>
            <h1>FerrumProxy Client</h1>
            <div className="status-strip" aria-live="polite">
              <span className={`connection-pill ${running ? "online" : "offline"}`}>
                {running ? "Connected" : "Stopped"}
              </span>
            </div>
          </div>

          <button
            type="button"
            className={running ? "btn danger" : "btn primary"}
            onClick={() => setRunning((value) => !value)}
            disabled={!form.tcpEnabled && !form.udpEnabled}
          >
            {running ? "Stop" : "Start"}
          </button>
        </header>

        <main className="workspace">
          <section className="shared-service-page">
            <div className="shared-header">
              <div>
                <p className="hero-overline">Connect local service to relay</p>
                <h2>共有クライアント</h2>
              </div>
            </div>

            <div className="shared-grid">
              <section className="surface-card shared-form">
                <div className="section-head">
                  <h3>Relay</h3>
                </div>

                <label>FerrumProxy relay ip:port</label>
                <input
                  value={form.relayAddress}
                  onChange={(event) => update("relayAddress", event.target.value)}
                />

                <label>Auth token</label>
                <input
                  type="password"
                  value={form.token}
                  onChange={(event) => update("token", event.target.value)}
                />

                <div className="protocol-toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.haproxy}
                      onChange={(event) => update("haproxy", event.target.checked)}
                    />
                    HAProxy PROXY protocol
                  </label>
                </div>
              </section>

              <section className="surface-card shared-form">
                <div className="section-head">
                  <h3>Local Service</h3>
                </div>

                <div className="protocol-toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.tcpEnabled}
                      onChange={(event) => update("tcpEnabled", event.target.checked)}
                    />
                    TCP
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.udpEnabled}
                      onChange={(event) => update("udpEnabled", event.target.checked)}
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
                      onChange={(event) => update("tcpLocalPort", Number(event.target.value))}
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
                      onChange={(event) => update("udpLocalPort", Number(event.target.value))}
                    />
                  </>
                )}
              </section>
            </div>

            <section className="surface-card shared-endpoints">
              <div className="section-head">
                <h3>Session</h3>
              </div>
              <span className="endpoint-mode">Relay {form.relayAddress}</span>
              <span className="endpoint-mode">
                HAProxy {form.haproxy ? "enabled" : "disabled"}
              </span>
              {protocols.map((protocol) => (
                <span className="endpoint-pill" key={protocol}>
                  {protocol}
                </span>
              ))}
            </section>
          </section>
        </main>
      </div>
    </div>
  );
}

export default App;
