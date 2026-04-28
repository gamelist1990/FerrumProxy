import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type ClientConfig = {
  relayAddress: string;
  token: string;
  tcpEnabled: boolean;
  udpEnabled: boolean;
  tcpLocalPort: number;
  udpLocalPort: number;
  haproxy: boolean;
};

type ClientConfigResponse = {
  config: ClientConfig;
  path: string;
};

const defaultForm: ClientConfig = {
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
  const [configPath, setConfigPath] = useState("config.json");
  const [configReady, setConfigReady] = useState(false);

  useEffect(() => {
    invoke<ClientConfigResponse>("load_client_config")
      .then((response) => {
        setForm({ ...defaultForm, ...response.config });
        setConfigPath(response.path);
      })
      .catch((error) => console.error("failed to load client config", error))
      .finally(() => setConfigReady(true));
  }, []);

  useEffect(() => {
    if (!configReady) return;
    const timer = window.setTimeout(() => {
      invoke<string>("save_client_config", { config: form })
        .then((path) => setConfigPath(path))
        .catch((error) => console.error("failed to save client config", error));
    }, 250);

    return () => window.clearTimeout(timer);
  }, [configReady, form]);

  const update = <K extends keyof ClientConfig>(
    key: K,
    value: ClientConfig[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const protocols = [
    form.tcpEnabled ? `TCP 127.0.0.1:${form.tcpLocalPort}` : null,
    form.udpEnabled ? `UDP 127.0.0.1:${form.udpLocalPort}` : null,
  ].filter(Boolean);
  const canStart = form.relayAddress.trim() !== "" && protocols.length > 0;

  return (
    <main className="client-shell">
      <section className="client-panel" aria-label="FerrumProxy Client">
        <header className="client-header">
          <div>
            <p>FerrumProxy Client</p>
            <h1>共有クライアント</h1>
          </div>
          <span className={`status ${running ? "running" : "stopped"}`}>
            {running ? "Connected" : "Stopped"}
          </span>
        </header>

        <div className="form-grid">
          <section className="form-section">
            <h2>Relay</h2>
            <label>
              <span>FerrumProxy ip:port</span>
                <input
                  value={form.relayAddress}
                  onChange={(event) => update("relayAddress", event.target.value)}
                  placeholder="203.0.113.10:7000"
                />
            </label>

            <label>
              <span>Auth token</span>
                <input
                  type="password"
                  value={form.token}
                  onChange={(event) => update("token", event.target.value)}
                  placeholder="optional"
                />
            </label>
          </section>

          <section className="form-section">
            <h2>Local Service</h2>
            <div className="segmented">
              <label>
                <input
                  type="checkbox"
                  checked={form.tcpEnabled}
                  onChange={(event) => update("tcpEnabled", event.target.checked)}
                />
                <span>TCP</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.udpEnabled}
                  onChange={(event) => update("udpEnabled", event.target.checked)}
                />
                <span>UDP</span>
              </label>
            </div>

            <div className="port-grid">
              {form.tcpEnabled && (
                <label>
                  <span>TCP port</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.tcpLocalPort}
                      onChange={(event) => update("tcpLocalPort", Number(event.target.value))}
                    />
                </label>
              )}

              {form.udpEnabled && (
                <label>
                  <span>UDP port</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.udpLocalPort}
                      onChange={(event) => update("udpLocalPort", Number(event.target.value))}
                    />
                </label>
              )}
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={form.haproxy}
                onChange={(event) => update("haproxy", event.target.checked)}
              />
              <span>HAProxy PROXY protocol</span>
            </label>
          </section>
        </div>

        <section className="summary">
          <div>
            <span>Relay</span>
            <strong>{form.relayAddress || "not set"}</strong>
          </div>
          <div>
            <span>Mode</span>
            <strong>{protocols.length ? protocols.join(" / ") : "none"}</strong>
          </div>
          <div>
            <span>HAProxy</span>
            <strong>{form.haproxy ? "On" : "Off"}</strong>
          </div>
          <div>
            <span>Config</span>
            <strong title={configPath}>{configPath.split(/[\\/]/).pop()}</strong>
          </div>
        </section>

        <button
          type="button"
          className={`start-button ${running ? "stop" : ""}`}
          onClick={() => {
            void invoke<string>("save_client_config", { config: form })
              .then((path) => setConfigPath(path))
              .catch((error) => console.error("failed to save client config", error));
            setRunning((value) => !value);
          }}
          disabled={!canStart}
        >
          {running ? "Stop sharing" : "Start sharing"}
        </button>
      </section>
    </main>
  );
}

export default App;
