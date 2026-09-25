import { Download, Gauge, Map, RefreshCw, Trash2, Users } from 'lucide-react';
import world from '@svg-maps/world';
import type { PerformanceMetrics } from '../api';
import { t } from '../lang';

type Props = {
  performance: PerformanceMetrics | null;
  error: string | null;
  clearing: boolean;
  onExport: () => void;
  onClear: () => void;
  formatBytes: (bytes: number) => string;
  formatDuration: (seconds: number) => string;
};

export function PerformanceMonitor({
  performance,
  error,
  clearing,
  onExport,
  onClear,
  formatBytes,
  formatDuration,
}: Props) {
  const analytics = performance?.ipAnalytics;
  const locations = analytics?.locations || [];
  const countryConnections = locations.reduce<Record<string, number>>((totals, location) => {
    const countryCode = location.countryCode?.toLowerCase();
    if (countryCode) totals[countryCode] = (totals[countryCode] || 0) + (location.connections || 1);
    return totals;
  }, {});
  const maxCountryConnections = Math.max(1, ...Object.values(countryConnections));

  return (
    <section className="surface-card performance-card performance-monitor">
      <div className="section-head performance-head">
        <div>
          <h3>{t('performanceMonitor')}</h3>
          <span>{performance?.persisted ? t('performancePersisted') : t('performanceLiveOnly')}</span>
        </div>
        <div className="performance-actions">
          <button className="btn tertiary small icon-label" type="button" onClick={onExport} disabled={!performance}>
            <Download size={15} aria-hidden="true" />
            {t('exportJson')}
          </button>
          <button className="btn danger small icon-label" type="button" onClick={onClear} disabled={clearing}>
            {clearing ? <RefreshCw className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
            {t('clearPerformanceCache')}
          </button>
        </div>
      </div>

      {performance ? (
        <>
          <div className="performance-grid performance-summary">
            <article className="metric-card featured-metric">
              <Gauge size={18} aria-hidden="true" />
              <span>{t('activeSessions')}</span>
              <strong>{performance.totalActiveSessions.toLocaleString()}</strong>
            </article>
            <article className="metric-card">
              <span>{t('totalSessions')}</span>
              <strong>{performance.totalSessions.toLocaleString()}</strong>
              <small>{t('persistentTotal')}</small>
            </article>
            <article className="metric-card">
              <span>{t('totalTraffic')}</span>
              <strong>{formatBytes(performance.totalBytes)}</strong>
              <small>{t('persistentTotal')}</small>
            </article>
            <article className="metric-card">
              <span>{t('uptime')}</span>
              <strong>{formatDuration(performance.uptimeSeconds)}</strong>
              <small>{t('currentProcess')}</small>
            </article>
          </div>

          <div className="performance-layout">
            <div className="protocol-grid">
              {(['tcp', 'udp'] as const).map((protocol) => {
                const metrics = performance[protocol];
                return (
                  <article key={protocol} className="protocol-card">
                    <h4>{protocol.toUpperCase()}</h4>
                    <dl>
                      <div><dt>{t('activeSessions')}</dt><dd>{metrics.activeSessions.toLocaleString()}</dd></div>
                      <div><dt>{t('totalSessions')}</dt><dd>{metrics.totalSessions.toLocaleString()}</dd></div>
                      <div><dt>{t('clientToTarget')}</dt><dd>{formatBytes(metrics.bytesClientToTarget)}</dd></div>
                      <div><dt>{t('targetToClient')}</dt><dd>{formatBytes(metrics.bytesTargetToClient)}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </div>

            <article className="ip-overview">
              <div className="subsection-title">
                <Users size={18} aria-hidden="true" />
                <div><h4>{t('connectionAnalytics')}</h4><span>{analytics?.enabled ? t('ipRecordingEnabled') : t('ipRecordingDisabled')}</span></div>
              </div>
              {analytics?.enabled ? (
                <div className="ip-kpis">
                  <div><strong>{analytics.totalRecordedConnections.toLocaleString()}</strong><span>{t('recordedConnections')}</span></div>
                  <div><strong>{analytics.uniqueIps.toLocaleString()}</strong><span>{t('uniqueIps')}</span></div>
                </div>
              ) : <p className="performance-note">{t('enableIpRecordingHint')}</p>}
            </article>
          </div>

          {analytics?.enabled && (
            <div className="geo-grid">
              <article className="world-map-panel">
                <div className="subsection-title">
                  <Map size={18} aria-hidden="true" />
                  <div><h4>{t('worldConnectionMap')}</h4><span>{t('worldMapHint')}</span></div>
                </div>
                <div className="world-map-frame">
                  <svg viewBox={world.viewBox} role="img" aria-label={t('worldConnectionMap')}>
                    <g className="world-countries">
                      {world.locations.map((country: { id: string; name: string; path: string }) => {
                        const connections = countryConnections[country.id] || 0;
                        const intensity = connections > 0
                          ? 0.28 + (connections / maxCountryConnections) * 0.72
                          : 0;
                        return (
                          <path
                            key={country.id}
                            d={country.path}
                            className={connections > 0 ? 'has-connections' : undefined}
                            style={connections > 0 ? { '--map-intensity': intensity } as React.CSSProperties : undefined}
                          >
                            <title>{connections > 0 ? `${country.name} · ${connections}` : country.name}</title>
                          </path>
                        );
                      })}
                    </g>
                  </svg>
                  {Object.keys(countryConnections).length === 0 && <div className="map-empty">{t('locationPending')}</div>}
                </div>
                <small className="map-attribution">Map data: @svg-maps/world (CC BY 4.0)</small>
              </article>

              <article className="top-ip-panel">
                <div className="subsection-title"><Users size={18} aria-hidden="true" /><div><h4>{t('topConnectionIps')}</h4><span>{t('rankedByConnections')}</span></div></div>
                <div className="top-ip-list">
                  {analytics.topIps.map((entry, index) => (
                    <div className="top-ip-row" key={entry.ip}>
                      <span className="rank">{index + 1}</span>
                      <div><strong>{entry.ip}</strong><small>{entry.location ? [entry.location.city, entry.location.countryCode].filter(Boolean).join(', ') : t('unknownLocation')}</small></div>
                      <div className="ip-count"><strong>{entry.connections.toLocaleString()}</strong><small>{t('connections')}</small></div>
                    </div>
                  ))}
                  {analytics.topIps.length === 0 && <p className="performance-note">{t('noIpRecords')}</p>}
                </div>
              </article>
            </div>
          )}

          <p className="performance-note sampled-at">{t('performanceSampledAt')} {new Date(performance.sampledAt).toLocaleTimeString()}</p>
        </>
      ) : <p className="performance-note performance-empty">{error || t('performanceUnavailable')}</p>}
    </section>
  );
}