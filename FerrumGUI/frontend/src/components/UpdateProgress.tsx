import "./UpdateProgress.css";

interface UpdateProgressProps {
  isUpdating: boolean;
  progress: number;
  currentVersion: string;
  targetVersion: string;
}

export function UpdateProgress({
  isUpdating,
  progress,
  currentVersion,
  targetVersion,
}: UpdateProgressProps) {
  if (!isUpdating) return null;

  return (
    <div className="update-progress-overlay">
      <div className="update-progress-modal">
        <h3>アップデート中...</h3>

        <div className="update-version-info">
          <span className="update-version-label">現在のバージョン:</span>
          <span className="update-version-current">{currentVersion}</span>
          <span className="update-version-arrow">→</span>
          <span className="update-version-target">{targetVersion}</span>
        </div>

        <div className="update-progress-container">
          <div className="update-progress-bar">
            <div
              className="update-progress-fill"
              style={{
                transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})`,
              }}
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              role="progressbar"
            />
          </div>
          <div className="update-progress-text">{progress}%</div>
        </div>

        <p className="update-message">ダウンロード中です。しばらくお待ちください...</p>
      </div>
    </div>
  );
}