import { useState, useEffect, useMemo, useCallback } from "react";
import "./App.css";
import { useWebSocket } from "./useWebSocket";
import type {
  FerrumProxyInstance,
  LogEntry,
  FerrumProxyConfig,
  FerrumProxyPlatform,
  AuthStatus,
  PlayerIPEntry,
  PerformanceMetrics,
} from "./api";
import {
  fetchInstances,
  createInstance,
  deleteInstance,
  startInstance,
  stopInstance,
  restartInstance,
  fetchLogs,
  fetchConfig,
  updateConfig,
  fetchLatestRelease,
  fetchAllReleases,
  checkAuthStatus,
  login,
  logout,
  setupAuth,
  fetchPlayerIPs,
  fetchPerformance,
  updateInstance,
  updateInstanceMetadata,
  fetchSystemInfo,
} from "./api";
import { t, setLanguage, getLanguage, type Language } from "./lang";
import { Login } from "./components/Login";
import { ConfigEditor } from "./components/ConfigEditor";
import { PlayerIPList } from "./components/PlayerIPList";
import { UpdateProgress } from "./components/UpdateProgress";
import { InstanceSettingsModal } from "./components/InstanceSettingsModal";
import { formatLogMessage } from "./utils/ansi";
import { DEFAULT_FERRUMPROXY_VERSION } from "./utils/version";
import type { WebSocketEventMap } from "./api";
import { LOG_DISPLAY_LIMIT } from "./utils/constants";

function App() {
  const [instances, setInstances] = useState<FerrumProxyInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [config, setConfig] = useState<FerrumProxyConfig | null>(null);
  const [playerIPs, setPlayerIPs] = useState<PlayerIPEntry[]>([]);
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(null);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [initializingInstances, setInitializingInstances] = useState<
    Set<string>
  >(new Set());
  const [updatingInstances, setUpdatingInstances] = useState<
    Map<string, { progress: number; targetVersion: string }>
  >(new Map());
  const [latestVersion, setLatestVersion] = useState<string>(
    DEFAULT_FERRUMPROXY_VERSION
  );
  const [availableVersions, setAvailableVersions] = useState<string[]>([
    DEFAULT_FERRUMPROXY_VERSION,
  ]);
  const [language, setLang] = useState<Language>(getLanguage());
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved as "light" | "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const [newInstanceForm, setNewInstanceForm] = useState({
    name: "",
    platform: "linux" as FerrumProxyPlatform,
    version: DEFAULT_FERRUMPROXY_VERSION,
  });

  const { isConnected, on } = useWebSocket();

  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    setLang(lang);
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const checkAuth = useCallback(async () => {
    try {
      const status = await checkAuthStatus();
      setAuthStatus(status);
      setAuthChecked(true);
    } catch (error) {
      console.error("Auth check failed:", error);
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!authChecked) return;
    if (authStatus?.requireAuth && !authStatus?.isAuthenticated) return;

    fetchSystemInfo()
      .then((info) => {
        if (info && info.platform) {
          setNewInstanceForm((prev) => ({ ...prev, platform: info.platform }));
        }
      })
      .catch(() => {});
  }, [authChecked, authStatus]);

  async function handleLogin(username: string, password: string) {
    if (!authStatus) return;

    if (authStatus.hasAuth) {
      await login(username, password);
    } else {
      await setupAuth(username, password);
    }

    await checkAuth();
  }

  async function handleLogout() {
    await logout();
    setAuthStatus({ hasAuth: true, isAuthenticated: false, requireAuth: true });
    setInstances([]);
    setSelectedInstance(null);
  }

  useEffect(() => {
    if (authStatus?.isAuthenticated) {
      loadInstances();
    }
  }, [authStatus]);

  useEffect(() => {
    const unsubscribes = [
      on("instances", (data: WebSocketEventMap["instances"]) => {
        const instancesData = Array.isArray(data) ? data : data.data || [];
        setInstances(instancesData);
      }),
      on("instanceAdded", () => loadInstances()),
      on("instanceRemoved", () => loadInstances()),
      on("instanceStarted", (data: WebSocketEventMap["instanceStarted"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId
                  ? {
                      ...inst,
                      pid: data.pid,
                      lastStarted: new Date().toISOString(),
                    }
                  : inst
              )
            : prev
        );
      }),
      on("instanceStopped", (data: WebSocketEventMap["instanceStopped"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId
                  ? { ...inst, pid: undefined, lastStarted: undefined }
                  : inst
              )
            : prev
        );
      }),
      on(
        "instanceRestarted",
        (data: WebSocketEventMap["instanceRestarted"]) => {
          setInstances((prev) =>
            Array.isArray(prev)
              ? prev.map((inst) =>
                  inst.id === data.instanceId
                    ? {
                        ...inst,
                        pid: data.pid,
                        lastStarted: new Date().toISOString(),
                      }
                    : inst
                )
              : prev
          );
        }
      ),
      on("processExit", (data: WebSocketEventMap["processExit"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId ? { ...inst, pid: undefined } : inst
              )
            : prev
        );
      }),
      on(
        "instanceInitializing",
        (data: WebSocketEventMap["instanceInitializing"]) => {
          setInitializingInstances((prev) =>
            new Set(prev).add(data.instanceId)
          );
        }
      ),
      on(
        "instanceInitialized",
        (data: WebSocketEventMap["instanceInitialized"]) => {
          setInitializingInstances((prev) => {
            const next = new Set(prev);
            next.delete(data.instanceId);
            return next;
          });
          loadInstances();
        }
      ),
      on("updateProgress", (data: WebSocketEventMap["updateProgress"]) => {
        setUpdatingInstances((prev) => {
          const next = new Map(prev);
          const current = next.get(data.instanceId);
          next.set(data.instanceId, {
            progress: data.percentage,
            targetVersion: current?.targetVersion || "unknown",
          });
          return next;
        });
      }),
      on("instanceUpdated", (data: WebSocketEventMap["instanceUpdated"]) => {
        setUpdatingInstances((prev) => {
          const next = new Map(prev);
          next.delete(data.instanceId);
          return next;
        });
        loadInstances();
        alert(`アップデートが完了しました: v${data.version}`);
      }),
      on("log", (data: WebSocketEventMap["log"]) => {
        if (data.instanceId === selectedInstance) {
          setLogs((prev) => {
            const next = [
              ...prev,
              {
                timestamp: data.timestamp,
                type: data.logType as "stdout" | "stderr" | "system",
                message: data.message,
              },
            ];
            // Keep only the last N entries to avoid unbounded memory growth
            if (next.length > LOG_DISPLAY_LIMIT) {
              return next.slice(next.length - LOG_DISPLAY_LIMIT);
            }
            return next;
          });
        }
      }),
      on("configUpdated", (data: WebSocketEventMap["configUpdated"]) => {
        if (data.instanceId === selectedInstance) {
          setConfig(data.config);
        }
      }),
      on("rateLimitError", (data: WebSocketEventMap["rateLimitError"]) => {
        alert(`⚠️ ${data.message}`);
      }),
    ];

    return () => unsubscribes.forEach((unsub) => unsub());
  }, [on, selectedInstance]);

  useEffect(() => {
    if (selectedInstance) {
      loadLogs(selectedInstance);
      loadConfig(selectedInstance);
      loadPlayerIPs(selectedInstance);
      loadPerformance(selectedInstance);
    } else {
      setPerformance(null);
      setPerformanceError(null);
    }
  }, [selectedInstance]);

  useEffect(() => {
    if (!selectedInstance) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadPerformance(selectedInstance);
    }, 2500);

    return () => window.clearInterval(interval);
  }, [selectedInstance]);

  useEffect(() => {
    setSettingsModalOpen(false);
  }, [selectedInstance]);

  async function loadInstances() {
    try {
      const data = await fetchInstances();
      setInstances(data);
    } catch (error) {
      console.error(t("errorLoadInstances"), error);
    }
  }

  async function loadReleases() {
    try {
      const [latest, allReleases] = await Promise.all([
        fetchLatestRelease(),
        fetchAllReleases(),
      ]);
      setLatestVersion(latest.version);
      setAvailableVersions(allReleases.map((r) => r.version).filter((version) => version !== "latest"));
    } catch (error) {
      console.error(t("errorLoadRelease"), error);

      setLatestVersion(DEFAULT_FERRUMPROXY_VERSION);
      setAvailableVersions([]);
    }
  }

  async function loadLogs(instanceId: string) {
    try {
      const data = await fetchLogs(instanceId, LOG_DISPLAY_LIMIT);
      setLogs(data);
    } catch (error) {
      console.error(t("errorLoadLogs"), error);
    }
  }

  async function loadConfig(instanceId: string) {
    try {
      const data = await fetchConfig(instanceId);
      setConfig(data);
    } catch (error) {
      console.error(t("errorLoadConfig"), error);
    }
  }

  async function loadPlayerIPs(instanceId: string) {
    try {
      const data = await fetchPlayerIPs(instanceId);
      setPlayerIPs(data);
    } catch (error) {
      console.error("Failed to load player IPs", error);
      setPlayerIPs([]);
    }
  }

  async function loadPerformance(instanceId: string) {
    try {
      const data = await fetchPerformance(instanceId);
      setPerformance(data);
      setPerformanceError(null);
    } catch (error) {
      const err = error as Error;
      setPerformance(null);
      setPerformanceError(err.message);
    }
  }

  async function handleCreateInstance() {
    try {
      setIsCreating(true);
      const preferredPlatform = newInstanceForm.platform;
      const preferredVersion = newInstanceForm.version;

      if (
        availableVersions.length === 1 &&
        availableVersions[0] === DEFAULT_FERRUMPROXY_VERSION
      ) {
        try {
          await loadReleases();
        } catch {
          console.warn("Failed to load releases, using default version");
        }
      }

      await createInstance(newInstanceForm);
      setNewInstanceForm({
        name: "",
        platform: preferredPlatform,
        version: preferredVersion,
      });
      await loadInstances();
    } catch (error) {
      const err = error as Error;
      if (err.message && err.message.includes("レート制限")) {
        alert(
          `⚠️ ${err.message}\n\n新規インスタンスの作成と更新確認ができません。しばらく待ってから再度試してください。`
        );
      } else {
        alert(`${t("errorCreateInstance")} ${err.message}`);
      }
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDeleteInstance(id: string) {
    if (!confirm(t("confirmDelete"))) return;

    try {
      await deleteInstance(id);
      if (selectedInstance === id) {
        setSelectedInstance(null);
      }
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorDeleteInstance")} ${err.message}`);
    }
  }

  async function handleStartInstance(id: string) {
    try {
      await startInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorStartInstance")} ${err.message}`);
    }
  }

  async function handleStopInstance(id: string) {
    try {
      await stopInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorStopInstance")} ${err.message}`);
    }
  }

  async function handleRestartInstance(id: string) {
    try {
      await restartInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorRestartInstance")} ${err.message}`);
    }
  }

  async function handleSaveConfig() {
    if (!selectedInstance || !config) return;

    try {
      await updateConfig(selectedInstance, config);
      alert(t("configSaved"));
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorSaveConfig")} ${err.message}`);
    }
  }

  async function handleUpdateInstance(
    instanceId: string,
    version: string = "latest",
    forceReinstall: boolean = false
  ) {
    try {
      setUpdatingInstances((prev) => {
        const next = new Map(prev);
        next.set(instanceId, { progress: 0, targetVersion: version });
        return next;
      });

      await updateInstance(instanceId, version, forceReinstall);
    } catch (error) {
      setUpdatingInstances((prev) => {
        const next = new Map(prev);
        next.delete(instanceId);
        return next;
      });

      const err = error as Error;
      if (
        err.message &&
        (err.message.includes("rate limit") ||
          err.message.includes("レート制限"))
      ) {
        alert(
          `⚠️ GitHub APIのレート制限に達しました。\n\nアップデートができません。しばらく待ってから再度試してください。`
        );
      } else {
        alert(`アップデートに失敗しました: ${err.message}`);
      }
    }
  }

  const selectedInstanceData = useMemo(
    () => instances.find((instance) => instance.id === selectedInstance) || null,
    [instances, selectedInstance]
  );

  const updateProgress = selectedInstance
    ? updatingInstances.get(selectedInstance)
    : undefined;

  const instanceMetrics = useMemo(() => {
    const running = instances.filter(
      (instance) => typeof instance.pid === "number"
    ).length;
    return {
      total: instances.length,
      running,
      initializing: initializingInstances.size,
    };
  }, [instances, initializingInstances]);

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  };

  const formatDuration = (seconds: number) => {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  };

  const exportPerformanceJson = () => {
    if (!performance || !selectedInstanceData) {
      return;
    }

    const payload = {
      instance: {
        id: selectedInstanceData.id,
        name: selectedInstanceData.name,
        version: selectedInstanceData.version,
        platform: selectedInstanceData.platform,
      },
      performance,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ferrum-performance-${selectedInstanceData.name}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const getRuntimeState = (
    instance: FerrumProxyInstance
  ): "initializing" | "running" | "stopped" => {
    if (initializingInstances.has(instance.id)) {
      return "initializing";
    }
    if (instance.pid) {
      return "running";
    }
    return "stopped";
  };

  const runtimeLabel = (
    state: "initializing" | "running" | "stopped"
  ): string => {
    if (state === "initializing") {
      return t("initializing");
    }
    if (state === "running") {
      return t("running");
    }
    return t("stopped");
  };

  if (!authChecked) {
    return (
      <div className="app loading">
        <p>Loading...</p>
      </div>
    );
  }

  if (
    authStatus?.requireAuth ||
    (authStatus?.hasAuth && !authStatus?.isAuthenticated)
  ) {
    return <Login onLogin={handleLogin} isSetup={!authStatus?.hasAuth} />;
  }

  if (!authStatus?.hasAuth && authStatus?.isAuthenticated) {
    return (
      <div className="app setup-prompt">
        <div className="setup-card">
          <h2>🔒 {t("securitySetup")}</h2>
          <p>{t("noAuthConfigured")}</p>
          <p>{t("setupAuthPrompt")}</p>
          <Login onLogin={handleLogin} isSetup={true} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <p className="brand-kicker">FerrumProxy Control Console</p>
            <h1>{t("appTitle")}</h1>
            <div className="status-strip" aria-live="polite">
              <span
                className={`connection-pill ${
                  isConnected ? "online" : "offline"
                }`}
              >
                {isConnected ? t("connected") : t("disconnected")}
              </span>
              {latestVersion && (
                <span className="latest-pill">
                  {t("latest")}: v{latestVersion}
                </span>
              )}
            </div>
          </div>

          <div className="toolbar">
            <select
              className="compact-select"
              aria-label="Language"
              value={language}
              onChange={(e) => handleLanguageChange(e.target.value as Language)}
            >
              <option value="ja_JP">日本語</option>
              <option value="en_US">English</option>
            </select>
            <button
              type="button"
              className="btn tertiary"
              onClick={toggleTheme}
              title={
                theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"
              }
            >
              {theme === "light" ? "Night" : "Light"}
            </button>
            {authStatus?.hasAuth && (
              <button
                type="button"
                className="btn danger"
                onClick={handleLogout}
              >
                {t("logout")}
              </button>
            )}
          </div>
        </header>

        <div className="dashboard">
          <aside className="instance-panel">
            <section className="panel-block metrics-block">
              <div className="panel-title-row">
                <h2>{t("instances")}</h2>
              </div>

              <div className="metrics-grid">
                <article className="metric-card">
                  <span>Total</span>
                  <strong>{instanceMetrics.total}</strong>
                </article>
                <article className="metric-card">
                  <span>{t("running")}</span>
                  <strong>{instanceMetrics.running}</strong>
                </article>
                <article className="metric-card">
                  <span>{t("initializing")}</span>
                  <strong>{instanceMetrics.initializing}</strong>
                </article>
              </div>
            </section>

            <section className="panel-block list-block">
              <div className="instance-list" role="list">
                {instances.length === 0 && (
                  <div className="instance-empty">No instance yet.</div>
                )}

                {instances.map((instance, index) => {
                  const state = getRuntimeState(instance);
                  const selected = selectedInstance === instance.id;

                  return (
                    <button
                      type="button"
                      key={instance.id}
                      className={`instance-item ${selected ? "selected" : ""} ${state}`}
                      role="listitem"
                      onClick={() => setSelectedInstance(instance.id)}
                      style={{ animationDelay: `${Math.min(index * 70, 560)}ms` }}
                    >
                      <div className="instance-item-header">
                        <strong>{instance.name}</strong>
                        <span className={`instance-dot ${state}`} />
                      </div>

                      <span className={`instance-status-tag ${state}`}>
                        {runtimeLabel(state)}
                      </span>

                      <small>
                        {instance.platform} ・ v{instance.version}
                      </small>

                      <div className="badge-row">
                        {instance.autoStart && (
                          <span className="mini-badge">{t("autoStart")}</span>
                        )}
                        {instance.autoRestart && (
                          <span className="mini-badge">{t("autoRestart")}</span>
                        )}
                        {instance.pid && (
                          <span className="mini-badge">PID {instance.pid}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="panel-block create-block">
              <h3>{t("createNewInstance")}</h3>
              <form
                className="create-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreateInstance();
                }}
              >
                <label htmlFor="create-instance-name">{t("instanceName")}</label>
                <input
                  id="create-instance-name"
                  type="text"
                  placeholder={t("placeholderInstanceName")}
                  value={newInstanceForm.name}
                  onChange={(e) =>
                    setNewInstanceForm({
                      ...newInstanceForm,
                      name: e.target.value,
                    })
                  }
                />

                <label htmlFor="create-instance-platform">{t("platform")}</label>
                <select
                  id="create-instance-platform"
                  value={newInstanceForm.platform}
                  onChange={(e) =>
                    setNewInstanceForm({
                      ...newInstanceForm,
                      platform: e.target.value as FerrumProxyPlatform,
                    })
                  }
                >
                  <option value="linux">{t("platformLinux")}</option>
                  <option value="linux-arm64">{t("platformLinux")} (ARM64)</option>
                  <option value="macos-arm64">{t("platformMacOS")}</option>
                  <option value="windows">{t("platformWindows")}</option>
                </select>

                <label htmlFor="create-instance-version">{t("version")}</label>
                <select
                  id="create-instance-version"
                  value={newInstanceForm.version}
                  onChange={(e) =>
                    setNewInstanceForm({
                      ...newInstanceForm,
                      version: e.target.value,
                    })
                  }
                >
                  <option value="latest">
                    {t("latestVersion") || "Latest"} (v{latestVersion})
                  </option>
                  {availableVersions.map((version) => (
                    <option key={version} value={version}>
                      v{version}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  className="btn primary"
                  disabled={isCreating || !newInstanceForm.name.trim()}
                >
                  {isCreating ? t("creating") : t("createInstance")}
                </button>
              </form>
            </section>
          </aside>

          <main className="workspace">
            {selectedInstanceData ? (
              <>
                <section className="instance-hero">
                  <div className="hero-copy">
                    <p className="hero-overline">{selectedInstanceData.platform}</p>
                    <h2>{selectedInstanceData.name}</h2>
                    <div className="hero-meta">
                      <span
                        className={`state-chip ${getRuntimeState(
                          selectedInstanceData
                        )}`}
                      >
                        {runtimeLabel(getRuntimeState(selectedInstanceData))}
                      </span>
                      <span>v{selectedInstanceData.version}</span>
                      {selectedInstanceData.pid && (
                        <span>PID {selectedInstanceData.pid}</span>
                      )}
                    </div>
                  </div>

                  <div className="hero-actions">
                    {selectedInstanceData.pid ? (
                      <>
                        <button
                          type="button"
                          className="btn tertiary"
                          onClick={() => handleStopInstance(selectedInstanceData.id)}
                        >
                          {t("stop")}
                        </button>
                        <button
                          type="button"
                          className="btn tertiary"
                          onClick={() =>
                            handleRestartInstance(selectedInstanceData.id)
                          }
                        >
                          {t("restart")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => handleStartInstance(selectedInstanceData.id)}
                      >
                        {t("start")}
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn tertiary"
                      onClick={() => setSettingsModalOpen(true)}
                    >
                      {t("settings") || "設定"}
                    </button>

                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => handleDeleteInstance(selectedInstanceData.id)}
                    >
                      {t("delete")}
                    </button>
                  </div>
                </section>

                {updateProgress && (
                  <UpdateProgress
                    isUpdating={true}
                    progress={updateProgress.progress}
                    currentVersion={selectedInstanceData.version}
                    targetVersion={updateProgress.targetVersion}
                  />
                )}

                <section className="surface-card performance-card">
                  <div className="section-head">
                    <h3>{t("performanceMonitor") || "Performance Monitor"}</h3>
                    <button
                      type="button"
                      className="btn tertiary small"
                      onClick={exportPerformanceJson}
                      disabled={!performance}
                    >
                      {t("exportJson") || "Export JSON"}
                    </button>
                  </div>

                  {performance ? (
                    <>
                      <div className="performance-grid">
                        <article className="metric-card">
                          <span>{t("uptime") || "Uptime"}</span>
                          <strong>{formatDuration(performance.uptimeSeconds)}</strong>
                        </article>
                        <article className="metric-card">
                          <span>{t("activeSessions") || "Active Sessions"}</span>
                          <strong>{performance.totalActiveSessions}</strong>
                        </article>
                        <article className="metric-card">
                          <span>{t("totalSessions") || "Total Sessions"}</span>
                          <strong>{performance.totalSessions}</strong>
                        </article>
                        <article className="metric-card">
                          <span>{t("totalTraffic") || "Total Traffic"}</span>
                          <strong>{formatBytes(performance.totalBytes)}</strong>
                        </article>
                      </div>

                      <div className="protocol-grid">
                        {(["tcp", "udp"] as const).map((protocol) => {
                          const metrics = performance[protocol];
                          return (
                            <article key={protocol} className="protocol-card">
                              <h4>{protocol.toUpperCase()}</h4>
                              <dl>
                                <div>
                                  <dt>{t("activeSessions") || "Active Sessions"}</dt>
                                  <dd>{metrics.activeSessions}</dd>
                                </div>
                                <div>
                                  <dt>{t("totalSessions") || "Total Sessions"}</dt>
                                  <dd>{metrics.totalSessions}</dd>
                                </div>
                                <div>
                                  <dt>{t("clientToTarget") || "Client -> Target"}</dt>
                                  <dd>{formatBytes(metrics.bytesClientToTarget)}</dd>
                                </div>
                                <div>
                                  <dt>{t("targetToClient") || "Target -> Client"}</dt>
                                  <dd>{formatBytes(metrics.bytesTargetToClient)}</dd>
                                </div>
                              </dl>
                            </article>
                          );
                        })}
                      </div>

                      <p className="performance-note">
                        {t("performanceSampledAt") || "Sampled at"}{" "}
                        {new Date(performance.sampledAt).toLocaleTimeString()}
                      </p>
                    </>
                  ) : (
                    <p className="performance-note">
                      {performanceError ||
                        t("performanceUnavailable") ||
                        "Performance metrics are unavailable. Enable useRestApi and start the instance."}
                    </p>
                  )}
                </section>

                <InstanceSettingsModal
                  isOpen={settingsModalOpen}
                  onClose={() => setSettingsModalOpen(false)}
                  instanceName={selectedInstanceData.name}
                  instanceVersion={selectedInstanceData.version}
                  autoStart={!!selectedInstanceData.autoStart}
                  autoRestart={!!selectedInstanceData.autoRestart}
                  onUpdateName={async (name) => {
                    await updateInstanceMetadata(selectedInstanceData.id, {
                      name,
                    });
                    setInstances((prev) =>
                      prev.map((instance) =>
                        instance.id === selectedInstanceData.id
                          ? { ...instance, name }
                          : instance
                      )
                    );
                  }}
                  onToggleAutoStart={async (enabled) => {
                    await updateInstanceMetadata(selectedInstanceData.id, {
                      autoStart: enabled,
                    });
                    setInstances((prev) =>
                      prev.map((instance) =>
                        instance.id === selectedInstanceData.id
                          ? { ...instance, autoStart: enabled }
                          : instance
                      )
                    );
                  }}
                  onToggleAutoRestart={async (enabled) => {
                    await updateInstanceMetadata(selectedInstanceData.id, {
                      autoRestart: enabled,
                    });
                    setInstances((prev) =>
                      prev.map((instance) =>
                        instance.id === selectedInstanceData.id
                          ? { ...instance, autoRestart: enabled }
                          : instance
                      )
                    );
                  }}
                  onUpdateInstance={async (version, forceReinstall) => {
                    await handleUpdateInstance(
                      selectedInstanceData.id,
                      version,
                      !!forceReinstall
                    );
                  }}
                  availableVersions={availableVersions}
                  latestVersion={latestVersion}
                  isUpdating={updatingInstances.has(selectedInstanceData.id)}
                />

                <div className="workspace-grid">
                  <section className="surface-card console-card">
                    <div className="section-head">
                      <h3>{t("consoleLogs")}</h3>
                      <span>{logs.length} lines</span>
                    </div>

                    <div className="log-container">
                      {logs.map((log, index) => (
                        <div
                          key={`${log.timestamp}-${index}`}
                          className={`log-entry log-${log.type}`}
                        >
                          <span className="log-time">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="log-type">
                            [
                            {log.type === "stdout"
                              ? t("logStdout")
                              : log.type === "stderr"
                                ? t("logStderr")
                                : t("logSystem")}
                            ]
                          </span>
                          <span
                            className="log-message"
                            dangerouslySetInnerHTML={{
                              __html: formatLogMessage(log.message),
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="surface-card config-card">
                    <div className="section-head">
                      <h3>{t("configuration")}</h3>
                    </div>

                    {config && (
                      <ConfigEditor
                        instanceId={selectedInstanceData.id}
                        config={config}
                        onChange={setConfig}
                        onSave={handleSaveConfig}
                      />
                    )}
                  </section>

                  {config?.savePlayerIP && (
                    <section className="surface-card player-ip-card">
                      <div className="section-head">
                        <h3>プレイヤーIP記録</h3>
                        <button
                          type="button"
                          className="btn tertiary small"
                          onClick={() => loadPlayerIPs(selectedInstanceData.id)}
                        >
                          更新
                        </button>
                      </div>
                      <PlayerIPList playerIPs={playerIPs} />
                    </section>
                  )}
                </div>
              </>
            ) : (
              <section className="empty-state">
                <h2>{t("appTitle")}</h2>
                <p>{t("noSelection")}</p>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    document.getElementById("create-instance-name")?.focus();
                  }}
                >
                  {t("createNewInstance")}
                </button>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;
