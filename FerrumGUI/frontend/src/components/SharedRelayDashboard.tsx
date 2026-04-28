import type { FerrumProxyConfig, PerformanceMetrics } from '../api';
import { t } from '../lang';
import { SharedRelaySettings } from './config/SharedRelaySettings';

type RuntimeState = 'initializing' | 'running' | 'stopped';

interface SharedRelayDashboardProps {
  config: FerrumProxyConfig;
  onChange: (config: FerrumProxyConfig) => void;
  onSave: () => void;
  formatBytes: (bytes: number) => string;
  formatDuration: (seconds: number) => string;
  runtimeState: RuntimeState;
  performance: PerformanceMetrics | null;
  performanceError: string | null;
}

export function SharedRelayDashboard({
  config,
  onChange,
  onSave,
  formatBytes,
  formatDuration,
  runtimeState,
  performance,
  performanceError,
}: SharedRelayDashboardProps) {
  const sharedService = config.sharedService || {};
  const defaults = sharedService.defaults || {};
  const queue = { enabled: true, maxSize: 128, ...(sharedService.queue || {}) };
  const tokenCount = sharedService.tokens?.length || sharedService.authTokens?.length || 0;
  const portRange = sharedService.portRange || { start: 40000, end: 49999 };
  const runtimeLabel =
    runtimeState === 'running'
      ? t('running')
      : runtimeState === 'initializing'
        ? t('initializing')
        : t('stopped');

  return (
    <div className="shared-relay-console">
      <section className="surface-card shared-relay-hero">
        <div>
          <p className="hero-overline">FerrumProxy</p>
          <h2>{t('sharedRelayDedicatedMode')}</h2>
          <div className="hero-meta">
            <span className={`state-chip ${runtimeState}`}>{runtimeLabel}</span>
          </div>
        </div>
        <button type="button" className="btn primary" onClick={onSave}>
          {t('saveConfig')}
        </button>
      </section>

      <section className="surface-card shared-relay-status">
        <div className="section-head">
          <h3>{t('relayStatus')}</h3>
          <span>
            {performance
              ? `${t('performanceSampledAt')} ${new Date(performance.sampledAt).toLocaleTimeString()}`
              : performanceError || t('performanceUnavailable')}
          </span>
        </div>

        {performance ? (
          <div className="performance-grid">
            <article className="metric-card">
              <span>{t('uptime')}</span>
              <strong>{formatDuration(performance.uptimeSeconds)}</strong>
            </article>
            <article className="metric-card">
              <span>{t('activeSessions')}</span>
              <strong>{performance.totalActiveSessions}</strong>
            </article>
            <article className="metric-card">
              <span>TCP</span>
              <strong>{performance.tcp.activeSessions}</strong>
            </article>
            <article className="metric-card">
              <span>UDP</span>
              <strong>{performance.udp.activeSessions}</strong>
            </article>
          </div>
        ) : (
          <p className="performance-note">{performanceError || t('performanceUnavailable')}</p>
        )}
      </section>

      <section className="shared-relay-overview">
        <article className="metric-card">
          <span>{t('relayControlEndpoint')}</span>
          <strong>{sharedService.controlBind || '0.0.0.0:7000'}</strong>
        </article>
        <article className="metric-card">
          <span>{t('relayPublicRange')}</span>
          <strong>
            {portRange.start}-{portRange.end}
          </strong>
        </article>
        <article className="metric-card">
          <span>{t('relayAnonymousPolicy')}</span>
          <strong>
            {sharedService.allowAnonymous ?? true
              ? t('allowAnonymousAccess')
              : t('tokenRequiredMode')}
          </strong>
        </article>
        <article className="metric-card">
          <span>{t('waitingQueue')}</span>
          <strong>{queue.enabled ? queue.maxSize : 'Off'}</strong>
        </article>
        <article className="metric-card">
          <span>{t('accessTokens')}</span>
          <strong>{tokenCount}</strong>
        </article>
        <article className="metric-card">
          <span>{t('bandwidthBytesPerSecond')}</span>
          <strong>{formatBytes(defaults.maxBytesPerSecond || 0)}/s</strong>
        </article>
      </section>

      <SharedRelaySettings
        config={config}
        onChange={(sharedService) => onChange({ ...config, sharedService })}
      />
    </div>
  );
}
