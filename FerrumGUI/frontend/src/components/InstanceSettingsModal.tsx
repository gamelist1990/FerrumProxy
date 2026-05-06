import { useState, useEffect } from "react";
import { t } from "../lang";
import "./InstanceSettingsModal.css";

interface InstanceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  instanceId: string;
  instanceName: string;
  instanceVersion: string;
  autoRestart: boolean;
  autoStart?: boolean;
  managerPort?: number;
  managerToken?: string;
  onUpdateName: (name: string) => Promise<void>;
  onToggleAutoRestart: (enabled: boolean) => Promise<void>;
  onToggleAutoStart?: (enabled: boolean) => Promise<void>;
  onUpdateManagerApi?: (settings: { managerPort?: number | null; managerToken?: string | null }) => Promise<void>;
  onUpdateInstance: (version: string, forceReinstall?: boolean) => Promise<void>;
  availableVersions: string[];
  latestVersion: string;
  isUpdating?: boolean;
}

export function InstanceSettingsModal({
  isOpen,
  onClose,
  instanceId,
  instanceName,
  instanceVersion,
  autoRestart,
  autoStart,
  managerPort,
  managerToken,
  onUpdateName,
  onToggleAutoRestart,
  onToggleAutoStart,
  onUpdateManagerApi,
  onUpdateInstance,
  availableVersions,
  latestVersion,
  isUpdating = false,
}: InstanceSettingsModalProps) {
  const [nameInput, setNameInput] = useState(instanceName);
  const [autoRestartChecked, setAutoRestartChecked] = useState(autoRestart);
  const [autoStartChecked, setAutoStartChecked] = useState(autoStart ?? false);
  const [managerPortInput, setManagerPortInput] = useState(managerPort ? String(managerPort) : "");
  const [managerTokenInput, setManagerTokenInput] = useState(managerToken ?? "");
  const [managerTokenVisible, setManagerTokenVisible] = useState(false);
  const [managerTokenCopied, setManagerTokenCopied] = useState(false);
  const [instanceIdCopied, setInstanceIdCopied] = useState(false);
  const [managerTokenListPathCopied, setManagerTokenListPathCopied] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState("latest");
  const [isSaving, setIsSaving] = useState(false);
  const resolvedSelectedVersion =
    selectedVersion === "latest" ? latestVersion : selectedVersion;
  const isReinstall = resolvedSelectedVersion === instanceVersion;

  useEffect(() => {
    setNameInput(instanceName);
    setAutoRestartChecked(autoRestart);
    setAutoStartChecked(autoStart ?? false);
    setManagerPortInput(managerPort ? String(managerPort) : "");
    setManagerTokenInput(managerToken ?? "");
    setManagerTokenCopied(false);
    setInstanceIdCopied(false);
    setManagerTokenListPathCopied(false);
  }, [instanceId, instanceName, autoRestart, autoStart, managerPort, managerToken]);

  useEffect(() => {
    if (!isOpen) return;

    const prevOverflow = document.body.style.overflow || "";
    const prevPaddingRight = document.body.style.paddingRight || "";

    document.body.style.overflow = "hidden";

    const scrollBarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    if (scrollBarWidth > 0) {
      document.body.style.paddingRight = `${scrollBarWidth}px`;
    }

    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (nameInput !== instanceName && nameInput.trim()) {
        await onUpdateName(nameInput.trim());
      }

      if (autoRestartChecked !== autoRestart) {
        await onToggleAutoRestart(autoRestartChecked);
      }

      if (
        typeof onToggleAutoStart === "function" &&
        autoStartChecked !== (autoStart ?? false)
      ) {
        await onToggleAutoStart(autoStartChecked);
      }

      const nextManagerPort = managerPortInput.trim() ? Number(managerPortInput) : undefined;
      const nextManagerToken = managerTokenInput.trim();
      if (
        typeof onUpdateManagerApi === "function" &&
        (nextManagerPort !== managerPort || nextManagerToken !== (managerToken ?? ""))
      ) {
        if (
          nextManagerPort !== undefined &&
          (!Number.isInteger(nextManagerPort) || nextManagerPort < 1 || nextManagerPort > 65535)
        ) {
          throw new Error("managerPort must be a valid port number");
        }
        await onUpdateManagerApi({
          managerPort: nextManagerPort ?? null,
          managerToken: nextManagerToken || null,
        });
      }

      onClose();
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorSaveConfig")}: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (
      confirm(
        isReinstall
          ? `インスタンスのバージョン ${resolvedSelectedVersion} を再インストールしますか？`
          : `インスタンスをバージョン ${resolvedSelectedVersion} にアップデートしますか？`
      )
    ) {
      try {
        onClose();
      } finally {
        void onUpdateInstance(selectedVersion, isReinstall);
      }
    }
  };

  const regenerateManagerToken = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    setManagerTokenInput(token);
    setManagerTokenVisible(true);
    setManagerTokenCopied(false);
  };

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (!copied) {
      throw new Error("Clipboard copy is not available in this browser");
    }
  };

  const copyManagerToken = async () => {
    if (!managerTokenInput.trim()) return;
    try {
      await writeClipboardText(managerTokenInput.trim());
      setManagerTokenCopied(true);
      window.setTimeout(() => setManagerTokenCopied(false), 1400);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const copyInstanceId = async () => {
    try {
      await writeClipboardText(instanceId);
      setInstanceIdCopied(true);
      window.setTimeout(() => setInstanceIdCopied(false), 1400);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const managerTokenListPath = `/api/instances/${instanceId}/manager/api/v1/tokens`;
  const copyManagerTokenListPath = async () => {
    try {
      await writeClipboardText(managerTokenListPath);
      setManagerTokenListPathCopied(true);
      window.setTimeout(() => setManagerTokenListPathCopied(false), 1400);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content instance-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t("instanceSettings") || "インスタンス設定"}</h2>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="setting-section">
            <label htmlFor="instance-name">
              {t("instanceName") || "インスタンス名"}
            </label>
            <input
              id="instance-name"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={
                t("placeholderInstanceName") || "インスタンス名を入力"
              }
            />
          </div>

          <div className="setting-section">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoStartChecked}
                onChange={(e) => setAutoStartChecked(e.target.checked)}
              />
              <span>{t("autoStart") || "自動起動"}</span>
            </label>
            <small className="setting-description">
              {t("autoStartDescription") ||
                "システム起動時に自動的にインスタンスを起動します"}
            </small>
          </div>

          <div className="setting-section">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoRestartChecked}
                onChange={(e) => setAutoRestartChecked(e.target.checked)}
              />
              <span>{t("autoRestart") || "自動再起動"}</span>
            </label>
            <small className="setting-description">
              {t("autoRestartDescription") ||
                "プロセスが停止した場合、自動的に再起動します"}
            </small>
          </div>

          <div className="setting-section">
            <label htmlFor="version-select">
              {t("updateVersion") || "アップデート"}
            </label>
            <div className="version-info">
              <span className="current-version">
                {t("currentVersion") || "現在のバージョン"}: v{instanceVersion}
              </span>
            </div>
            <select
              id="version-select"
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
              disabled={isUpdating}
            >
              <option value="latest">
                {t("latestVersion") || "最新版"} (v{latestVersion})
              </option>
              {availableVersions.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </select>
            <button
              className="update-button"
              onClick={handleUpdate}
              disabled={isUpdating}
            >
              {isUpdating
                ? t("updating") || "更新中..."
                : isReinstall
                  ? t("reinstallNow") || "今すぐ再インストール"
                  : t("updateNow") || "今すぐアップデート"}
            </button>
          </div>

          <div className="setting-section manager-api-section">
            <div className="setting-title-row">
              <label htmlFor="manager-port">Manager API</label>
              <button
                type="button"
                className="small-action-button"
                onClick={regenerateManagerToken}
              >
                再発行
              </button>
            </div>
            <small className="setting-description">
              FerrumProxy の --manager-port と --manager-token に合わせて設定します。
            </small>
            <div className="copy-value-row">
              <code title={instanceId}>{instanceId}</code>
              <button
                type="button"
                className="small-action-button"
                onClick={copyInstanceId}
              >
                {instanceIdCopied ? "コピー済み" : "Instance IDをコピー"}
              </button>
            </div>
            <input
              id="manager-port"
              type="number"
              min={1}
              max={65535}
              value={managerPortInput}
              onChange={(e) => setManagerPortInput(e.target.value.replace(/\D/g, ""))}
              placeholder="7600"
            />
            <div className="manager-token-row">
              <input
                type={managerTokenVisible ? "text" : "password"}
                value={managerTokenInput}
                onChange={(e) => setManagerTokenInput(e.target.value)}
                placeholder="manager-token"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="small-action-button"
                onClick={() => setManagerTokenVisible((visible) => !visible)}
              >
                {managerTokenVisible ? "隠す" : "表示"}
              </button>
              <button
                type="button"
                className="small-action-button"
                onClick={copyManagerToken}
                disabled={!managerTokenInput.trim()}
              >
                {managerTokenCopied ? "コピー済み" : "コピー"}
              </button>
            </div>
            <div className="copy-value-row">
              <code title={managerTokenListPath}>{managerTokenListPath}</code>
              <button
                type="button"
                className="small-action-button"
                onClick={copyManagerTokenListPath}
              >
                {managerTokenListPathCopied ? "コピー済み" : "Token list pathをコピー"}
              </button>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button
            className="cancel-button"
            onClick={onClose}
            disabled={isSaving}
          >
            {t("cancel") || "キャンセル"}
          </button>
          <button
            className="save-button"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? t("saving") || "保存中..." : t("save") || "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
