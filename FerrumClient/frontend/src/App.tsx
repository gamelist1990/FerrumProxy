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

type OfficialServer = {
  id: string;
  name: string;
  address: string;
  enabled?: boolean;
  description?: string;
};

type OfficialServerFile = {
  servers?: OfficialServer[];
};

type ClientErrorInfo = {
  code: string;
  title: string;
  titleJa: string;
  cause: string;
  causeJa: string;
  pattern: RegExp;
};

const customRelayValue = "__custom__";
const officialServerUrl =
  "https://raw.githubusercontent.com/gamelist1990/FerrumProxy/main/FerrumClient/OfficialServer.json";

const clientErrorCodes: ClientErrorInfo[] = [
  {
    code: "FPC-1001",
    title: "Relay address is missing",
    titleJa: "リレーアドレス未入力",
    cause: "The FerrumProxy relay ip:port field is empty.",
    causeJa: "FerrumProxy relay の ip:port が空です。",
    pattern: /relay.*address.*empty|ip:port.*empty|not set/i,
  },
  {
    code: "FPC-1101",
    title: "Relay API unreachable",
    titleJa: "リレーAPIに到達できません",
    cause: "The client could not connect to the selected relay address.",
    causeJa: "選択したリレーアドレスへ接続できませんでした。",
    pattern: /shared relay api check failed|connection refused|timed out|failed to lookup address|could not resolve|network is unreachable/i,
  },
  {
    code: "FPC-1102",
    title: "Unexpected relay API response",
    titleJa: "リレーAPIの応答が不正です",
    cause: "The selected server is reachable, but it is not responding as a FerrumProxy shared relay.",
    causeJa: "サーバーには到達できましたが、FerrumProxy shared relay として応答していません。",
    pattern: /did not respond as a ferrumproxy shared relay api|unexpected response from relay/i,
  },
  {
    code: "FPC-1201",
    title: "Invalid auth token",
    titleJa: "認証トークンが無効です",
    cause: "The relay rejected the configured authentication token.",
    causeJa: "設定された認証トークンがリレーに拒否されました。",
    pattern: /invalid authentication token|invalid token|token check failed/i,
  },
  {
    code: "FPC-1301",
    title: "No protocol selected",
    titleJa: "プロトコル未選択",
    cause: "TCP, UDP, or both must be enabled before sharing.",
    causeJa: "共有開始前に TCP、UDP、または両方を有効にしてください。",
    pattern: /enable tcp, udp, or both/i,
  },
  {
    code: "FPC-1401",
    title: "Relay allocation failed",
    titleJa: "リレー割り当て失敗",
    cause: "The relay could not allocate or keep the public port for this session.",
    causeJa: "このセッション用の公開ポートをリレーが割り当て、または維持できませんでした。",
    pattern: /allocation|waiting.*available port|relay returned invalid|disappeared/i,
  },
  {
    code: "FPC-1501",
    title: "Relay session interrupted",
    titleJa: "リレーセッション中断",
    cause: "The active relay session was closed or cancelled before it completed.",
    causeJa: "アクティブなリレーセッションが完了前に閉じられた、またはキャンセルされました。",
    pattern: /sharing cancelled|closed the connection|failed to read relay response|failed to write relay command|failed to flush relay command/i,
  },
  {
    code: "FPC-1601",
    title: "Local service connection failed",
    titleJa: "ローカルサービス接続失敗",
    cause: "The local service host or port is not reachable from FerrumProxy Client.",
    causeJa: "FerrumProxy Client からローカルサービスの host または port に到達できません。",
    pattern: /local.*error|local service|failed to connect local|connection reset/i,
  },
  {
    code: "FPC-1701",
    title: "Clipboard failed",
    titleJa: "クリップボード操作失敗",
    cause: "The operating system did not allow copying the public endpoint.",
    causeJa: "OS が公開エンドポイントのコピーを許可しませんでした。",
    pattern: /clipboard|copy/i,
  },
  {
    code: "FPC-9000",
    title: "Unknown client error",
    titleJa: "未分類のクライアントエラー",
    cause: "The message did not match a known FerrumProxy Client error category.",
    causeJa: "既知の FerrumProxy Client エラー分類に一致しないメッセージです。",
    pattern: /.*/,
  },
];

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
  const [errorCodeModalOpen, setErrorCodeModalOpen] = useState(false);
  const [highlightedErrorCode, setHighlightedErrorCode] = useState<string | null>(null);
  const [officialServers, setOfficialServers] = useState<OfficialServer[]>([]);
  const [officialServerStatus, setOfficialServerStatus] = useState("");
  const [relayDropdownOpen, setRelayDropdownOpen] = useState(false);
  const [relaySelection, setRelaySelection] = useState(customRelayValue);
  const [customRelayAddress, setCustomRelayAddress] = useState(defaultForm.relayAddress);
  const [relayTokens, setRelayTokens] = useState<Record<string, string>>({ [customRelayValue]: defaultForm.token });
  const [language, setLanguage] = useState<ClientLanguage>(() => detectLanguage());
  const previousErrorRef = useRef<string | null>(null);
  const relayAddressRef = useRef(defaultForm.relayAddress);
  const officialServersRef = useRef<OfficialServer[]>([]);
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
      let loadedLocal = false;
      try {
        const localText = await invoke<string>("load_official_servers");
        const localServers = parseOfficialServers(localText);
        if (localServers.length) {
          loadedLocal = true;
          officialServersRef.current = localServers;
          setOfficialServers(localServers);
          setRelaySelection(selectRelayForAddress(localServers, relayAddressRef.current));
          setOfficialServerStatus(text.officialServerListFallback);
        }
      } catch (error) {
        console.warn("failed to load bundled official servers", error);
      }

      try {
        const response = await fetch(`${officialServerUrl}?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const remoteServers = parseOfficialServers(await response.text());
        if (remoteServers.length) {
          officialServersRef.current = remoteServers;
          setOfficialServers(remoteServers);
          setRelaySelection(selectRelayForAddress(remoteServers, relayAddressRef.current));
          setOfficialServerStatus(text.officialServerListLoaded);
          return;
        }
      } catch (error) {
        console.warn("failed to refresh official servers", error);
      }

      if (!loadedLocal) {
        officialServersRef.current = [];
        setOfficialServers([]);
        setRelaySelection(customRelayValue);
        setOfficialServerStatus(text.officialServerListFailed);
      }
    })();
  }, [text.officialServerListFailed, text.officialServerListFallback, text.officialServerListLoaded]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await invoke<ClientConfigResponse>("load_client_config");
        const nextForm = { ...defaultForm, ...response.config };
        relayAddressRef.current = nextForm.relayAddress;
        const nextSelection = selectRelayForAddress(officialServersRef.current, nextForm.relayAddress);
        setForm(nextForm);
        setRelaySelection(nextSelection);
        if (nextSelection === customRelayValue) {
          setCustomRelayAddress(nextForm.relayAddress);
        }
        const tokenKey = nextSelection === customRelayValue ? customRelayValue : nextSelection;
        setRelayTokens((prev) => ({ ...prev, [tokenKey]: nextForm.token }));
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
    if (key === "relayAddress") {
      relayAddressRef.current = String(value);
    }
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

  const selectedOfficialServer =
    relaySelection === customRelayValue ? null : officialServers.find((server) => server.id === relaySelection) ?? null;
  const activeRelayTokenKey = selectedOfficialServer?.id ?? customRelayValue;

  useEffect(() => {
    if (relaySelection === customRelayValue) {
      if (form.relayAddress !== customRelayAddress) {
        update("relayAddress", customRelayAddress);
      }
      return;
    }

    if (selectedOfficialServer && form.relayAddress !== selectedOfficialServer.address) {
      update("relayAddress", selectedOfficialServer.address);
    }
  }, [customRelayAddress, form.relayAddress, relaySelection, selectedOfficialServer]);

  useEffect(() => {
    const nextToken = relayTokens[activeRelayTokenKey] ?? "";
    if (form.token !== nextToken) {
      update("token", nextToken);
    }
  }, [activeRelayTokenKey, form.token, relayTokens]);

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
  const displayErrorInfo = displayError ? getClientErrorInfo(displayError) : null;
  const displayErrorWithCode = displayError && displayErrorInfo ? `[${displayErrorInfo.code}] ${displayError}` : null;
  const displayErrorTitle = displayErrorInfo ? localizeErrorTitle(displayErrorInfo, language) : "";
  const highlightedError = highlightedErrorCode
    ? clientErrorCodes.find((item) => item.code === highlightedErrorCode) ?? null
    : null;
  const relayButtonLabel = selectedOfficialServer?.name ?? text.customRelay;
  const summaryRelayAddress = shareSession?.relayAddress || form.relayAddress || "not set";
  const summaryOfficialServer = officialServers.find((server) => server.address === summaryRelayAddress);
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
            <div
              className="relay-picker-field"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setRelayDropdownOpen(false);
                }
              }}
            >
              <span>{text.relayServer}</span>
              <button
                type="button"
                className="relay-picker-button"
                aria-haspopup="listbox"
                aria-expanded={relayDropdownOpen}
                onClick={() => setRelayDropdownOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRelayDropdownOpen(false);
                  }
                }}
              >
                <strong>{relayButtonLabel}</strong>
                <span aria-hidden="true">⌄</span>
              </button>
              {relayDropdownOpen && (
                <div className="relay-picker-menu" role="listbox" aria-label={text.relayServer}>
                  {officialServers.map((server) => (
                    <button
                      key={server.id}
                      type="button"
                      className={selectedOfficialServer?.id === server.id ? "selected" : undefined}
                      role="option"
                      aria-selected={selectedOfficialServer?.id === server.id}
                      onClick={() => {
                        setRelaySelection(server.id);
                        setRelayDropdownOpen(false);
                      }}
                    >
                      <strong>{server.name}</strong>
                      {server.description && <small>{server.description}</small>}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={relaySelection === customRelayValue ? "selected" : undefined}
                    role="option"
                    aria-selected={relaySelection === customRelayValue}
                    onClick={() => {
                      setRelaySelection(customRelayValue);
                      setRelayDropdownOpen(false);
                    }}
                  >
                    <strong>{text.customRelay}</strong>
                    <small>{text.customRelayDescription}</small>
                  </button>
                </div>
              )}
            </div>
            <div className="server-list-state">{officialServerStatus || text.officialServerList}</div>
            {!selectedOfficialServer && (
              <label>
                <span>{text.manualRelayAddress}</span>
                <input
                  value={form.relayAddress}
                  onChange={(event) => {
                    const nextAddress = event.target.value;
                    setRelaySelection(customRelayValue);
                    setCustomRelayAddress(nextAddress);
                    update("relayAddress", nextAddress);
                  }}
                  placeholder="203.0.113.10:7000"
                />
              </label>
            )}
            <label>
              <span>{text.authToken}</span>
              <div className="secret-input">
                <input
                  type={tokenVisible ? "text" : "password"}
                  value={relayTokens[activeRelayTokenKey] ?? ""}
                  onChange={(event) => {
                    const nextToken = event.target.value;
                    setRelayTokens((prev) => ({ ...prev, [activeRelayTokenKey]: nextToken }));
                    update("token", nextToken);
                  }}
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
            {summaryOfficialServer ? (
              <strong>{summaryOfficialServer.name}</strong>
            ) : (
              <strong>{summaryRelayAddress}</strong>
            )}
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
              <span>{displayErrorInfo ? `${text.error} ${displayErrorInfo.code}` : text.error}</span>
              <strong>{displayErrorWithCode}</strong>
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
              <button
                type="button"
                className="error-code-list-button"
                onClick={() => {
                  setHighlightedErrorCode(null);
                  setErrorCodeModalOpen(true);
                }}
              >
                {text.errorCodeList}
              </button>
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
            <div className="error-detail-body">
              {displayErrorInfo && (
                <div className="error-code-summary">
                  <span>{text.errorCode}</span>
                  <strong>{displayErrorInfo.code}</strong>
                  <small>{displayErrorTitle}</small>
                </div>
              )}
              <pre>{displayError}</pre>
              <button
                type="button"
                className="error-code-list-button"
                onClick={() => {
                  setHighlightedErrorCode(displayErrorInfo?.code ?? null);
                  setErrorCodeModalOpen(true);
                }}
              >
                {text.errorCodeList}
              </button>
            </div>
          </section>
        </div>
      )}

      {errorCodeModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setErrorCodeModalOpen(false)}>
          <section
            className="error-code-modal"
            role="dialog"
            aria-modal="true"
            aria-label={text.errorCodeList}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p>{text.errorCode}</p>
                <h2>{text.errorCodeList}</h2>
              </div>
              <button type="button" onClick={() => setErrorCodeModalOpen(false)} aria-label={text.close}>
                {text.close}
              </button>
            </header>
            <div className="error-code-body">
              {highlightedError && (
                <div className="error-code-focus">
                  <span>{text.errorCode}</span>
                  <strong>{highlightedError.code}</strong>
                  <small>
                    {localizeErrorTitle(highlightedError, language)} - {localizeErrorCause(highlightedError, language)}
                  </small>
                </div>
              )}
              <p>{text.errorCodeListDescription}</p>
              <div className="error-code-grid">
                {clientErrorCodes.map((item) => (
                  <div
                    key={item.code}
                    className={highlightedErrorCode === item.code ? "selected" : undefined}
                    aria-current={highlightedErrorCode === item.code ? "true" : undefined}
                  >
                    <strong>{item.code}</strong>
                    <span>{localizeErrorTitle(item, language)}</span>
                    <small>{text.possibleCause}: {localizeErrorCause(item, language)}</small>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function parseOfficialServers(text: string): OfficialServer[] {
  const parsed = JSON.parse(text) as OfficialServerFile;
  if (!Array.isArray(parsed.servers)) return [];

  return parsed.servers
    .filter((server) => server.enabled !== false && server.id && server.name && server.address)
    .map((server) => ({
      id: String(server.id),
      name: String(server.name),
      address: String(server.address),
      enabled: server.enabled,
      description: server.description ? String(server.description) : undefined,
    }));
}

function selectRelayForAddress(servers: OfficialServer[], address: string): string {
  return servers.find((server) => server.address === address)?.id ?? customRelayValue;
}

function getClientErrorInfo(message: string): ClientErrorInfo {
  return clientErrorCodes.find((item) => item.pattern.test(message)) ?? clientErrorCodes[clientErrorCodes.length - 1];
}

function localizeErrorTitle(error: ClientErrorInfo, language: ClientLanguage): string {
  return language === "ja" ? error.titleJa : error.title;
}

function localizeErrorCause(error: ClientErrorInfo, language: ClientLanguage): string {
  return language === "ja" ? error.causeJa : error.cause;
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
