import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { detectLanguage, getTranslation, saveLanguage, type ClientLanguage } from "./lang";
import "./App.css";

type ClientConfig = {
  relayAddress: string;
  token: string;
  tcpEnabled: boolean;
  udpEnabled: boolean;
  localHost: string;
  tcpLocalPort: number;
  udpLocalPort: number;
  haproxy: boolean;
};

type ClientConfigResponse = {
  config: ClientConfig;
  path: string;
};

type ShareSession = {
  status: "waiting" | "running" | "failed";
  running: boolean;
  relayAddress: string;
  endpoint: {
    protocol: string;
    host: string;
    port: number;
    display: string;
  } | null;
  queueWaitingClients?: number | null;
  queueMaxSize?: number | null;
  relayPingMs?: number | null;
  tcpTunnels?: number;
  udpTunnel?: boolean;
  bytesIn?: number;
  bytesOut?: number;
  error?: string | null;
};

const defaultForm: ClientConfig = {
  relayAddress: "127.0.0.1:7000",
  token: "",
  tcpEnabled: true,
  udpEnabled: false,
  localHost: "127.0.0.1",
  tcpLocalPort: 25565,
  udpLocalPort: 25565,
  haproxy: false,
};

function App() {
  const [form, setForm] = useState(defaultForm);
  const [tcpPortInput, setTcpPortInput] = useState(String(defaultForm.tcpLocalPort));
  const [udpPortInput, setUdpPortInput] = useState(String(defaultForm.udpLocalPort));
  const [shareSession, setShareSession] = useState<ShareSession | null>(null);
  const [configPath, setConfigPath] = useState("config.json");
  const [configReady, setConfigReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [language, setLanguage] = useState<ClientLanguage>(() => detectLanguage());
  const previousErrorRef = useRef<string | null>(null);
  const text = getTranslation(language);

  const changeLanguage = (nextLanguage: ClientLanguage) => {
    setLanguage(nextLanguage);
    saveLanguage(nextLanguage);
  };

  const probeConnection = async (nextForm: ClientConfig) => {
    await invoke<void>("probe_client_connection", { config: nextForm });
    setConnectionError(null);
  };

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", preventContextMenu);
    return () => window.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await invoke<ClientConfigResponse>("load_client_config");
        const nextForm = { ...defaultForm, ...response.config };
        setForm(nextForm);
        setTcpPortInput(String(nextForm.tcpLocalPort));
        setUdpPortInput(String(nextForm.udpLocalPort));
        setConfigPath(response.path);
        await probeConnection(nextForm);
        const session = await invoke<ShareSession | null>("get_share_session");
        setShareSession(session);
      } catch (error) {
        console.error("failed to load or probe client config", error);
        setConnectionError(errorMessage(error, text.failedProbe));
      } finally {
        setConfigReady(true);
      }
    })();
  }, [text.failedProbe]);

  useEffect(() => {
    if (!configReady || (shareSession?.status !== "waiting" && shareSession?.status !== "running")) return;

    const timer = window.setInterval(() => {
      invoke<ShareSession | null>("get_share_session")
        .then((session) => setShareSession(session))
        .catch((error) => console.error("failed to refresh share session", error));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [configReady, shareSession?.status]);

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

  const updatePortInput = (key: "tcpLocalPort" | "udpLocalPort", value: string) => {
    const digits = value.replace(/\D/g, "");
    if (key === "tcpLocalPort") {
      setTcpPortInput(digits);
    } else {
      setUdpPortInput(digits);
    }

    if (digits === "") return;
    const port = Number(digits);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      update(key, port);
    }
  };

  const restorePortInput = (key: "tcpLocalPort" | "udpLocalPort") => {
    if (key === "tcpLocalPort" && tcpPortInput === "") {
      setTcpPortInput(String(form.tcpLocalPort));
    }
    if (key === "udpLocalPort" && udpPortInput === "") {
      setUdpPortInput(String(form.udpLocalPort));
    }
  };

  const protocols = [
    form.tcpEnabled ? `TCP ${form.localHost || "127.0.0.1"}:${tcpPortInput || form.tcpLocalPort}` : null,
    form.udpEnabled ? `UDP ${form.localHost || "127.0.0.1"}:${udpPortInput || form.udpLocalPort}` : null,
  ].filter(Boolean);
  const tcpPortReady = !form.tcpEnabled || tcpPortInput !== "";
  const udpPortReady = !form.udpEnabled || udpPortInput !== "";
  const canStart = form.relayAddress.trim() !== "" && protocols.length > 0 && tcpPortReady && udpPortReady;
  const isWaiting = shareSession?.status === "waiting";
  const isRunning = shareSession?.status === "running";
  const displayError = connectionError || shareSession?.error || null;
  const queueLabel =
    typeof shareSession?.queueWaitingClients === "number" &&
    typeof shareSession?.queueMaxSize === "number"
      ? `${shareSession.queueWaitingClients}/${shareSession.queueMaxSize}`
      : null;
  const endpointLabel = shareSession?.endpoint?.display || (isWaiting ? text.waitingForAllocation : null);
  const copyEndpoint = shareSession?.endpoint
    ? `${shareSession.endpoint.host}:${shareSession.endpoint.port}`
    : null;
  const statusMetrics = [
    { label: text.ping, value: typeof shareSession?.relayPingMs === "number" ? `${shareSession.relayPingMs} ms` : text.notMeasured },
    { label: text.tcpTunnels, value: String(shareSession?.tcpTunnels ?? 0) },
    { label: text.udpTunnel, value: shareSession?.udpTunnel ? text.ready : text.down },
    { label: text.bytesIn, value: formatBytes(shareSession?.bytesIn ?? 0) },
    { label: text.bytesOut, value: formatBytes(shareSession?.bytesOut ?? 0) },
  ];
  const currentStatusLabel = isRunning ? text.connected : isWaiting ? text.waiting : text.stopped;
  const currentStatusDetail = isRunning ? text.statusConnected : isWaiting ? text.statusAllocating : text.statusIdle;

  useEffect(() => {
    if (displayError && displayError !== previousErrorRef.current) {
      previousErrorRef.current = displayError;
      setErrorModalOpen(true);
    } else if (!displayError) {
      previousErrorRef.current = null;
    }
  }, [displayError]);

  const copyPublicEndpoint = async () => {
    if (!copyEndpoint) return;
    try {
      await navigator.clipboard.writeText(copyEndpoint);
      setCopiedEndpoint(true);
      window.setTimeout(() => setCopiedEndpoint(false), 1400);
    } catch (error) {
      setConnectionError(errorMessage(error, text.failedCopy));
    }
  };

  return (
    <main className="client-shell">
      <section className="client-panel" aria-label="FerrumProxy Client">
        <header className="client-header">
          <div>
            <p>{text.appName}</p>
            <h1>{text.title}</h1>
          </div>
          <div className="header-actions">
            <span className={`status ${isRunning ? "running" : isWaiting ? "waiting" : "stopped"}`}>
              {currentStatusLabel}
            </span>
            <button type="button" className="status-button" onClick={() => setStatusModalOpen(true)}>
              <span>{text.status}</span>
              <strong>{currentStatusDetail}</strong>
            </button>
          </div>
        </header>

        <div className="form-grid">
          <section className="form-section">
            <h2>{text.relay}</h2>
            <label>
              <span>{text.relayAddress}</span>
              <input
                value={form.relayAddress}
                onChange={(event) => update("relayAddress", event.target.value)}
                placeholder="203.0.113.10:7000"
              />
            </label>
            <label>
              <span>{text.authToken}</span>
              <div className="secret-input">
                <input
                  type={tokenVisible ? "text" : "password"}
                  value={form.token}
                  onChange={(event) => update("token", event.target.value)}
                  placeholder={text.optional}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setTokenVisible((visible) => !visible)}
                  aria-label={tokenVisible ? text.hideAuthToken : text.showAuthToken}
                  title={tokenVisible ? text.hideAuthToken : text.showAuthToken}
                >
                  {tokenVisible ? text.hide : text.show}
                </button>
              </div>
            </label>
          </section>

          <section className="form-section">
            <h2>{text.localService}</h2>
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

            <label>
              <span>{text.localHost}</span>
              <input
                value={form.localHost}
                onChange={(event) => update("localHost", event.target.value)}
                placeholder="127.0.0.1"
              />
            </label>

            <div className="port-grid">
              {form.tcpEnabled && (
                <label>
                  <span>{text.tcpPort}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={tcpPortInput}
                    onChange={(event) => updatePortInput("tcpLocalPort", event.target.value)}
                    onBlur={() => restorePortInput("tcpLocalPort")}
                  />
                </label>
              )}

              {form.udpEnabled && (
                <label>
                  <span>{text.udpPort}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={udpPortInput}
                    onChange={(event) => updatePortInput("udpLocalPort", event.target.value)}
                    onBlur={() => restorePortInput("udpLocalPort")}
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
              <span>{text.haproxy}</span>
            </label>
          </section>
        </div>

        <section className="summary">
          <div className="public-endpoint">
            <span>{text.publicUrl}</span>
            {copyEndpoint ? (
              <button type="button" className="copy-endpoint" onClick={copyPublicEndpoint}>
                <strong>{endpointLabel}</strong>
                <small>{copiedEndpoint ? text.copied : text.copyIpPort}</small>
              </button>
            ) : (
              <strong>{endpointLabel || text.notShared}</strong>
            )}
          </div>
          <div>
            <span>{text.relay}</span>
            <strong>{shareSession?.relayAddress || form.relayAddress || "not set"}</strong>
          </div>
          <div>
            <span>{text.mode}</span>
            <strong>{protocols.length ? protocols.join(" / ") : text.none}</strong>
          </div>
          <div>
            <span>HAProxy</span>
            <strong>{form.haproxy ? text.on : text.off}</strong>
          </div>
          <div>
            <span>{text.config}</span>
            <strong title={configPath}>{configPath.split(/[\\/]/).pop()}</strong>
          </div>
        </section>

        <button
          type="button"
          className={`start-button ${isWaiting ? "waiting" : isRunning ? "stop" : ""}`}
          onClick={() => {
            if (isWaiting || isRunning) {
              void (async () => {
                try {
                  await invoke<void>("stop_sharing");
                } finally {
                  setShareSession(null);
                  setConnectionError(null);
                }
              })();
              return;
            }

            void (async () => {
              try {
                const path = await invoke<string>("save_client_config", { config: form });
                setConfigPath(path);
                const session = await invoke<ShareSession>("start_sharing", { config: form });
                setShareSession(session);
                setConnectionError(null);
              } catch (error) {
                console.error("failed to connect relay", error);
                setConnectionError(errorMessage(error, text.failedConnect));
              }
            })();
          }}
          disabled={!canStart && !isWaiting && !isRunning}
        >
          {isWaiting ? text.cancelWaiting : isRunning ? text.stopSharing : text.startSharing}
        </button>

        {displayError && (
          <section className="error-panel" role="alert">
            <div>
              <span>{text.error}</span>
              <strong>{displayError}</strong>
            </div>
            <button type="button" onClick={() => setErrorModalOpen(true)}>
              {text.details}
            </button>
          </section>
        )}
      </section>

      {isWaiting && (
        <div className="modal-backdrop" role="presentation">
          <section className="queue-modal" role="dialog" aria-modal="true" aria-live="polite">
            <span className="queue-spinner" aria-hidden="true" />
            <div>
              <h2>{text.waitingRelayAllocation}</h2>
              <p>{queueLabel ? `${text.queue}: ${queueLabel}` : text.waitingAvailablePort}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    await invoke<void>("stop_sharing");
                  } finally {
                    setShareSession(null);
                    setConnectionError(null);
                  }
                })();
              }}
            >
              {text.cancelWaiting}
            </button>
          </section>
        </div>
      )}

      {statusModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setStatusModalOpen(false)}>
          <section
            className="status-modal"
            role="dialog"
            aria-modal="true"
            aria-label={text.statusDetails}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p>{text.status}</p>
                <h2>{text.statusDetails}</h2>
              </div>
              <button type="button" onClick={() => setStatusModalOpen(false)} aria-label={text.close}>
                {text.close}
              </button>
            </header>
            <div className="status-modal-body">
              <div className="status-panel-head">
                <div>
                  <span>{text.status}</span>
                  <strong>{currentStatusDetail}</strong>
                </div>
                <span className={`status-dot ${isRunning ? "running" : isWaiting ? "waiting" : ""}`} />
              </div>
              <div className="status-metrics">
                {statusMetrics.map((metric) => (
                  <div key={metric.label}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
              <label className="language-select">
                <span>{text.language}</span>
                <select value={language} onChange={(event) => changeLanguage(event.target.value as ClientLanguage)}>
                  <option value="en">{text.english}</option>
                  <option value="ja">{text.japanese}</option>
                </select>
              </label>
            </div>
          </section>
        </div>
      )}

      {displayError && errorModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setErrorModalOpen(false)}>
          <section
            className="error-modal"
            role="dialog"
            aria-modal="true"
            aria-label={text.details}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{text.connectionError}</h2>
              <button type="button" onClick={() => setErrorModalOpen(false)} aria-label={text.close}>
                {text.close}
              </button>
            </header>
            <pre>{displayError}</pre>
          </section>
        </div>
      )}
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export default App;
