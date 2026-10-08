import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from "react";
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
  clearPerformanceCache,
  updateInstance,
  updateInstanceMetadata,
  fetchSystemInfo,
  checkUpdates,
  fetchGuiSelfVersion,
  performGuiSelfUpdate,
} from "./api";
import { t, setLanguage, getLanguage, type Language } from "./lang";
import { Login } from "./components/Login";
import { ConfigEditor } from "./components/ConfigEditor";
import { PlayerIPList } from "./components/PlayerIPList";
import { UpdateProgress } from "./components/UpdateProgress";
import { InstanceSettingsPage } from "./components/InstanceSettingsPage";
import { SharedRelayDashboard } from "./components/SharedRelayDashboard";
import { Activity, ChevronDown, ChevronRight, LogOut, Moon, Play, Plus, RefreshCw, Search, Server, Settings2, Square, Sun, Terminal, Trash2, Users } from 'lucide-react';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { LogConsole } from './components/LogConsole';
import { NetherNetPanel } from './components/NetherNetPanel';
import './AppLayout.css';
const PerformanceMonitor = lazy(() => import('./components/PerformanceMonitor').then((module) => ({ default: module.PerformanceMonitor })));
import { DEFAULT_FERRUMPROXY_VERSION } from "./utils/version";
import { waitForGuiRestart } from './utils/guiRestart';
import type { WebSocketEventMap } from "./api";
import { LOG_DISPLAY_LIMIT } from "./utils/constants";

function App() {
  const [instances, setInstances] = useState<FerrumProxyInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [config, setConfig] = useState<FerrumProxyConfig | null>(null);
  const [configLoadError, setConfigLoadError] = useState<string | null>(null);
  const [playerIPs, setPlayerIPs] = useState<PlayerIPEntry[]>([]);
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(null);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [clearingPerformance, setClearingPerformance] = useState(false);
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
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [guiVersion, setGuiVersion] = useState<string | null>(null);
  const [guiLatestVersion, setGuiLatestVersion] = useState<string | null>(null);
  const [guiHasUpdate, setGuiHasUpdate] = useState(false);
  const [guiSelfUpdateSupported, setGuiSelfUpdateSupported] = useState(false);
  const [isGuiUpdating, setIsGuiUpdating] = useState(false);
  const selectedInstanceRef = useRef<string | null>(null);
  const [settingsPageOpen, setSettingsPageOpen] = useState(false);
  const closeSettingsPage = useCallback(() => {
    setSettingsPageOpen(false);
    requestAnimationFrame(() => document.getElementById('instance-settings-trigger')?.focus());
  }, []);
  const [workspaceTab, setWorkspaceTab] = useState<'overview' | 'logs' | 'config' | 'players' | 'nethernet'>('overview');
  const [instanceSearch, setInstanceSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [savedConfig, setSavedConfig] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const configEdited = useRef(false);
  const configDrafts = useRef(new Map<string, FerrumProxyConfig>());
  const configDirty = !!config && JSON.stringify(config) !== savedConfig;
  const hasUnsavedDrafts = configDirty || configDrafts.current.size > 0;
  const editConfig = (updated: FerrumProxyConfig) => {
    configEdited.current = JSON.stringify(updated) !== savedConfig;
    setSaveFeedback(null);
    setConfig(updated);
    if (selectedInstance) {
      if (JSON.stringify(updated) === savedConfig) configDrafts.current.delete(selectedInstance);
      else configDrafts.current.set(selectedInstance, updated);
    }
  };
  useEffect(() => {
    if (!hasUnsavedDrafts) return;
    const preventExit = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [hasUnsavedDrafts]);

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
      void loadGuiVersion();
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
                inst.id === data.instanceId
                  ? { ...inst, pid: undefined, lastStarted: undefined }
                  : inst
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
        if (data.version !== undefined) {
          setUpdatingInstances((prev) => {
            const next = new Map(prev);
            next.delete(data.instanceId);
            return next;
          });
          alert(`アップデートが完了しました: v${data.version}`);
        }
        loadInstances();
      }),
      on("log", (data: WebSocketEventMap["log"]) => {
        if (data.instanceId === selectedInstanceRef.current) {
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
        if (data.instanceId === selectedInstanceRef.current) {
          if (!configEdited.current) setConfig(data.config);
          setSavedConfig(JSON.stringify(data.config));
        }
      }),
      on("rateLimitError", (data: WebSocketEventMap["rateLimitError"]) => {
        alert(`⚠️ ${data.message}`);
      }),
    ];

    return () => unsubscribes.forEach((unsub) => unsub());
  }, [on]);

  useEffect(() => {
    selectedInstanceRef.current = selectedInstance;
    setLogs([]);
    setConfig(null);
    setConfigLoadError(null);
    setSavedConfig('');
    setSaveFeedback(null);
    configEdited.current = false;
    setPlayerIPs([]);
    setPerformance(null);
    setPerformanceError(null);

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
    setSettingsPageOpen(false);
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
      if (selectedInstanceRef.current === instanceId) {
        setLogs(data);
      }
    } catch (error) {
      console.error(t("errorLoadLogs"), error);
    }
  }

  async function loadConfig(instanceId: string) {
    setConfigLoadError(null);
    try {
      const data = await fetchConfig(instanceId);
      if (selectedInstanceRef.current === instanceId) {
        const draft = configDrafts.current.get(instanceId);
        setConfig(draft || data);
        configEdited.current = !!draft;
        setSavedConfig(JSON.stringify(data));
      }
    } catch (error) {
      console.error(t("errorLoadConfig"), error);
      if (selectedInstanceRef.current === instanceId) setConfigLoadError(`${t('errorLoadConfig')} ${(error as Error).message}`);
    }
  }

  async function loadPlayerIPs(instanceId: string) {
    try {
      const data = await fetchPlayerIPs(instanceId);
      if (selectedInstanceRef.current === instanceId) {
        setPlayerIPs(data);
      }
    } catch (error) {
      console.error("Failed to load player IPs", error);
      if (selectedInstanceRef.current === instanceId) {
        setPlayerIPs([]);
      }
    }
  }

  async function loadPerformance(instanceId: string) {
    try {
      const data = await fetchPerformance(instanceId);
      if (selectedInstanceRef.current !== instanceId) return;
      // サーバ側が 200 で `available: false` を返してきた場合はエラーではなく「未接続」扱い。
      if ((data as unknown as { available?: boolean }).available === false) {
        setPerformance(null);
        setPerformanceError(null);
        return;
      }
      setPerformance(data);
      setPerformanceError(null);
    } catch (error) {
      // ここに来るのは本当に GUI 側 API が落ちている時など。console スパムを避けるため logging しない。
      const err = error as Error;
      if (selectedInstanceRef.current === instanceId) {
        setPerformance(null);
        setPerformanceError(err.message);
      }
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
    if (!selectedInstance || !config || savingConfig) return;
    const instanceId = selectedInstance;
    const snapshot = config;
    setSavingConfig(true);
    setSaveFeedback(null);
    try {
      await updateConfig(instanceId, snapshot);
      configDrafts.current.delete(instanceId);
      if (selectedInstanceRef.current === instanceId) {
        setSavedConfig(JSON.stringify(snapshot));
        configEdited.current = false;
        setSaveFeedback({ error: false, text: t('saveSuccess') });
      }
    } catch (error) {
      const err = error as Error;
      if (selectedInstanceRef.current === instanceId) setSaveFeedback({ error: true, text: `${t('errorSaveConfig')} ${err.message}` });
    } finally {
      setSavingConfig(false);
    }
  }

  async function loadGuiVersion() {
    try {
      const info = await fetchGuiSelfVersion();
      setGuiVersion(info.current);
      setGuiSelfUpdateSupported(info.selfUpdateSupported);
      setGuiLatestVersion(info.latest?.version ?? null);
      setGuiHasUpdate(info.hasUpdate);
    } catch (error) {
      console.error("Failed to fetch GUI version", error);
    }
  }

  async function handleGuiSelfUpdate() {
    if (!guiSelfUpdateSupported) {
      alert(t("guiSelfUpdateUnsupported"));
      return;
    }
    if (!guiHasUpdate) {
      alert(t("guiAlreadyUpToDate"));
      return;
    }
    const proceed = confirm(
      `${t("guiUpdateConfirm")}\n\nv${guiVersion} → v${guiLatestVersion}\n\n${t("guiUpdateWillRestart")}`
    );
    if (!proceed) return;
    try {
      setIsGuiUpdating(true);
      const result = await performGuiSelfUpdate();
      await waitForGuiRestart(result.version, undefined, result.restartTimeoutMs ?? 90000);
      window.location.reload();
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorGuiUpdate")} ${err.message}`);
      setIsGuiUpdating(false);
    }
  }

  async function handleCheckAndUpdateAll() {
    if (isCheckingUpdates) return;
    setIsCheckingUpdates(true);
    try {
      const result = await checkUpdates();
      if (result.latestRelease?.version) {
        setLatestVersion(result.latestRelease.version);
      }

      const targets = result.updates.filter(
        (u) => u.hasUpdate && !updatingInstances.has(u.instanceId)
      );

      if (targets.length === 0) {
        alert(t("allUpToDate"));
        return;
      }

      const targetVersion = result.latestRelease?.version ?? "latest";
      const proceed = confirm(
        `${t("updatesAvailable")} v${targetVersion}\n\n${targets.length} instance(s) will be updated:\n` +
          targets
            .map((u) => {
              const inst = instances.find((i) => i.id === u.instanceId);
              return `  - ${inst?.name ?? u.instanceId} (v${u.currentVersion} → v${u.latestVersion})`;
            })
            .join("\n")
      );
      if (!proceed) return;

      // ロック用に先にまとめて状態を入れておく
      setUpdatingInstances((prev) => {
        const next = new Map(prev);
        for (const u of targets) {
          next.set(u.instanceId, { progress: 0, targetVersion });
        }
        return next;
      });

      // 順次実行（GitHub API のレート制限と同時 IO を避ける）
      for (const u of targets) {
        try {
          await updateInstance(u.instanceId, "latest", false);
        } catch (error) {
          const err = error as Error;
          setUpdatingInstances((prev) => {
            const next = new Map(prev);
            next.delete(u.instanceId);
            return next;
          });
          if (
            err.message &&
            (err.message.includes("rate limit") ||
              err.message.includes("レート制限"))
          ) {
            alert(
              `⚠️ GitHub APIのレート制限に達しました。\n\n残りのインスタンスの更新を中止します。しばらく待ってから再度試してください。`
            );
            return;
          }
          console.error(`Update failed for ${u.instanceId}:`, err);
        }
      }
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorCheckUpdates")} ${err.message}`);
    } finally {
      setIsCheckingUpdates(false);
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
  const isSharedRelayMode = !!config?.sharedService?.enabled;

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

  const handleClearPerformanceCache = async () => {
    if (!selectedInstanceData || !window.confirm(t('clearPerformanceConfirm'))) return;
    try {
      setClearingPerformance(true);
      await clearPerformanceCache(selectedInstanceData.id);
      await loadPerformance(selectedInstanceData.id);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setClearingPerformance(false);
    }
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
      <a className="skip-link" href="#workspace">{t('skipToWorkspace')}</a>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-symbol"><Server size={24} aria-hidden="true" /></div>
            <p className="brand-kicker">CONTROL CONSOLE</p>
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
              className="btn tertiary theme-toggle"
              onClick={toggleTheme}
              title={
                theme === "light" ? t('darkMode') : t('lightMode')
              }
            >
              {theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
              <span className="sr-only">{theme === 'light' ? t('darkMode') : t('lightMode')}</span>
            </button>
            <button
              type="button"
              className="btn tertiary"
              onClick={() => void handleCheckAndUpdateAll()}
              disabled={isCheckingUpdates || instances.length === 0}
              title={t("checkUpdates")}
            >
              <RefreshCw size={16} className={isCheckingUpdates ? 'spin' : ''} aria-hidden="true" />
              {isCheckingUpdates ? t("checking") : t("checkUpdates")}
            </button>
            {guiSelfUpdateSupported && (
              <button
                type="button"
                className={`btn ${guiHasUpdate ? "warning" : "tertiary"}`}
                onClick={() => void handleGuiSelfUpdate()}
                disabled={isGuiUpdating || !guiHasUpdate}
                title={
                  guiHasUpdate
                    ? `${t("guiUpdateAvailable")}: v${guiLatestVersion}`
                    : t("guiAlreadyUpToDate")
                }
              >
                {isGuiUpdating
                  ? t("guiUpdating")
                  : guiHasUpdate
                    ? `${t("guiUpdate")} → v${guiLatestVersion}`
                    : `GUI v${guiVersion ?? "?"}`}
              </button>
            )}
            {authStatus?.hasAuth && (
              <button
                type="button"
                className="btn tertiary logout-button"
                onClick={handleLogout}
              >
                <LogOut size={16} aria-hidden="true" />{t("logout")}
              </button>
            )}
          </div>
        </header>

        {settingsPageOpen && selectedInstanceData ? (
          <InstanceSettingsPage key={selectedInstanceData.id} instance={selectedInstanceData}
            onBack={closeSettingsPage}
            onOpenProxyConfig={() => { closeSettingsPage(); setWorkspaceTab('config'); }}
            onSaveMetadata={async patch => {
              const updated = await updateInstanceMetadata(selectedInstanceData.id, patch);
              setInstances(previous => previous.map(instance => instance.id === updated.id ? { ...instance, ...updated } : instance));
              return updated;
            }}
            onUpdateInstance={(version, force) => handleUpdateInstance(selectedInstanceData.id, version, !!force)}
            availableVersions={availableVersions} latestVersion={latestVersion}
            isUpdating={updatingInstances.has(selectedInstanceData.id)} />
        ) : (
        <div className="dashboard">
          <aside className={`instance-panel ${sidebarOpen ? 'mobile-open' : ''}`} aria-label={t('instances')}>
            <section className="panel-block metrics-block">
              <div className="panel-title-row">
                <h2>{t("instances")}</h2>
                <span className="count-badge">{instanceMetrics.total}</span>
                <button type="button" className="btn tertiary sidebar-toggle" aria-expanded={sidebarOpen} aria-controls="instance-navigation" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={sidebarOpen ? t('collapseInstances') : t('expandInstances')}>
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
              </div>

              <div className="metrics-grid">
                <article className="metric-card">
                  <span>{t('totalInstances')}</span>
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

            <div id="instance-navigation" className="instance-navigation">
            <section className="panel-block list-block">
              <label className="search-field instance-search"><Search size={16} aria-hidden="true" /><span className="sr-only">{t('searchInstances')}</span>
                <input type="search" placeholder={t('searchInstances')} value={instanceSearch} onChange={(event) => setInstanceSearch(event.target.value)} />
              </label>
              <div className="instance-list">
                {instances.length === 0 && (
                  <div className="instance-empty">{t('noInstances')}</div>
                )}

                {instances.length > 0 && !instances.some((instance) => instance.name.toLowerCase().includes(instanceSearch.toLowerCase())) && <div className="instance-empty">{t('noSearchResults')}</div>}
                {instances.filter((instance) => instance.name.toLowerCase().includes(instanceSearch.toLowerCase())).map((instance) => {
                  const state = getRuntimeState(instance);
                  const selected = selectedInstance === instance.id;

                  return (
                    <button
                      type="button"
                      key={instance.id}
                      className={`instance-item ${selected ? "selected" : ""} ${state}`}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => {
                        setSelectedInstance(instance.id);
                        setSidebarOpen(false);
                      }}
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

            <details className="panel-block create-block" open={instances.length === 0 ? true : undefined}>
              <summary><Plus size={18} aria-hidden="true" />{t("createNewInstance")}<ChevronRight size={16} className="create-chevron" aria-hidden="true" /></summary>
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
            </details>
            </div>
          </aside>

          <main className="workspace" id="workspace" tabIndex={-1}>
            {selectedInstanceData ? (
              <>
                <section className="instance-hero">
                  <div className="hero-copy">
                    <p className="hero-overline">{t('workspaceCaption')} <ChevronRight size={12} aria-hidden="true" /> {selectedInstanceData.platform}</p>
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

                  <div className="hero-actions" aria-label={t('instanceOperations')}>
                    {selectedInstanceData.pid ? (
                      <>
                        <button
                          type="button"
                          className="btn tertiary"
                          onClick={() => handleStopInstance(selectedInstanceData.id)}
                        >
                          <Square size={15} aria-hidden="true" />{t("stop")}
                        </button>
                        <button
                          type="button"
                          className="btn tertiary"
                          onClick={() =>
                            handleRestartInstance(selectedInstanceData.id)
                          }
                        >
                          <RefreshCw size={15} aria-hidden="true" />{t("restart")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => handleStartInstance(selectedInstanceData.id)}
                      >
                        <Play size={16} aria-hidden="true" />{t("start")}
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn tertiary"
                      id="instance-settings-trigger"
                      onClick={() => setSettingsPageOpen(true)}
                    >
                      <Settings2 size={16} aria-hidden="true" />{t("settings") || "設定"}
                    </button>

                    <button
                      type="button"
                      className="btn tertiary delete-instance"
                      onClick={() => handleDeleteInstance(selectedInstanceData.id)}
                    >
                      <Trash2 size={16} aria-hidden="true" /><span className="sr-only">{t('delete')}</span>
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

                <WorkspaceTabs prefix="workspace" label={t('workspaceCaption')} active={workspaceTab} onChange={setWorkspaceTab}
                  tabs={[
                    { id: 'overview', label: t('workspaceOverview'), icon: Activity },
                    { id: 'logs', label: t('workspaceLogs'), icon: Terminal },
                    { id: 'config', label: t('workspaceConfig'), icon: Settings2, badge: configDirty ? '•' : undefined },
                    { id: 'players', label: t('workspacePlayers'), icon: Users },
                    { id: 'nethernet', label: 'NetherNet', icon: Activity },
                  ]} />
                <div className="workspace-intro">
                  <h3>{workspaceTab === 'nethernet' ? 'NetherNet' : workspaceTab === 'overview' ? t('workspaceOverview') : workspaceTab === 'logs' ? t('workspaceLogs') : workspaceTab === 'config' ? t('workspaceConfig') : t('workspacePlayers')}</h3>
                  <p>{workspaceTab === 'nethernet' ? t('netherWorkspaceHint') : workspaceTab === 'overview' ? t('overviewHint') : workspaceTab === 'logs' ? t('logsHint') : workspaceTab === 'config' ? t('configHint') : t('playersHint')}</p>
                </div>



                <div id="workspace-panel-overview" role="tabpanel" aria-labelledby="workspace-tab-overview" hidden={workspaceTab !== 'overview'} tabIndex={0}>
                  {isSharedRelayMode && config ? (
                    <SharedRelayDashboard config={config} onChange={editConfig} onSave={() => setWorkspaceTab('config')}
                      overviewOnly formatBytes={formatBytes} formatDuration={formatDuration}
                      runtimeState={getRuntimeState(selectedInstanceData)} performance={performance} performanceError={performanceError} logs={logs} />
                  ) : (
                    <Suspense fallback={<div className="panel-loading" role="status">{t('loadingWorkspace')}</div>}>
                    <PerformanceMonitor performance={performance} error={performanceError} clearing={clearingPerformance}
                      onExport={exportPerformanceJson} onClear={handleClearPerformanceCache} formatBytes={formatBytes} formatDuration={formatDuration} />
                    </Suspense>
                  )}
                </div>
                <div id="workspace-panel-logs" role="tabpanel" aria-labelledby="workspace-tab-logs" hidden={workspaceTab !== 'logs'} tabIndex={0}>
                  <LogConsole key={selectedInstanceData.id} logs={logs} instanceName={selectedInstanceData.name} />
                </div>
                <div id="workspace-panel-nethernet" role="tabpanel" aria-labelledby="workspace-tab-nethernet" hidden={workspaceTab !== 'nethernet'} tabIndex={0}>
                  <NetherNetPanel key={selectedInstanceData.id} logs={logs} instanceName={selectedInstanceData.name}
                    enabled={config?.listeners?.some(listener => listener.bedrockTransport === 'nethernet' && listener.nethernetDiagnostics) || false} />
                </div>
                <div id="workspace-panel-config" role="tabpanel" aria-labelledby="workspace-tab-config" hidden={workspaceTab !== 'config'} tabIndex={0}>
                  {saveFeedback && <div className={`feedback-banner ${saveFeedback.error ? 'error' : 'success'}`} role={saveFeedback.error ? 'alert' : 'status'}>{saveFeedback.text}</div>}
                  <section className="surface-card config-card">
                    {config ? <ConfigEditor key={selectedInstanceData.id} instanceId={selectedInstanceData.id} config={config}
                      onChange={editConfig} onSave={handleSaveConfig} dirty={configDirty} saving={savingConfig} sharedMode={isSharedRelayMode} />
                    : configLoadError ? <div className="panel-empty"><p role="alert">{configLoadError}</p>
                        <button type="button" className="btn tertiary" onClick={() => void loadConfig(selectedInstanceData.id)}>{t('retryRequest')}</button>
                      </div> : <div className="panel-loading" role="status">{t('loadingWorkspace')}</div>}
                  </section>
                </div>
                <div id="workspace-panel-players" role="tabpanel" aria-labelledby="workspace-tab-players" hidden={workspaceTab !== 'players'} tabIndex={0}>
                  <section className="surface-card player-ip-card">
                    <div className="section-head">
                      <h3 className="icon-label"><Users size={18} aria-hidden="true" />{t('workspacePlayers')}</h3>
                      <button type="button" className="btn tertiary" onClick={() => loadPlayerIPs(selectedInstanceData.id)}>
                        <RefreshCw size={16} aria-hidden="true" />{t('refreshData')}
                      </button>
                    </div>
                    {config?.savePlayerIP ? <PlayerIPList playerIPs={playerIPs} />
                      : <div className="panel-empty"><Users size={30} aria-hidden="true" /><p>{t('ipDisabledHint')}</p>
                        <button type="button" className="btn primary" onClick={() => setWorkspaceTab('config')}>{t('openConfig')}</button>
                      </div>}
                  </section>
                </div>
              </>
            ) : (
              <section className="empty-state">
                <div className="empty-state-icon"><Server size={32} aria-hidden="true" /></div>
                <h2>{instances.length ? t("workspaceCaption") : t("noInstances")}</h2>
                <p>{instances.length ? t("selectInstanceHint") : t("createInstanceHint")}</p>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setSidebarOpen(true);
                    const createBlock = document.querySelector<HTMLDetailsElement>('.create-block');
                    if (createBlock) createBlock.open = true;
                    window.setTimeout(() => document.getElementById('create-instance-name')?.focus(), 0);
                  }}
                >
                  {t("createNewInstance")}
                </button>
              </section>
            )}
          </main>
        </div>
        )}
      </div>
    </div>
  );
}

export default App;

