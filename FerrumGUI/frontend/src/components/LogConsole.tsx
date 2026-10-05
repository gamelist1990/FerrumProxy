import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Download, Search, Terminal } from 'lucide-react';
import type { LogEntry } from '../api';
import { t } from '../lang';
import { formatLogMessage } from '../utils/ansi';

export function LogConsole({ logs, instanceName }: { logs: LogEntry[]; instanceName: string }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [follow, setFollow] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => logs.filter((log) => (type === 'all' || log.type === type)
    && log.message.toLowerCase().includes(query.toLowerCase())), [logs, query, type]);
  useEffect(() => {
    if (follow && container.current) container.current.scrollTop = container.current.scrollHeight;
  }, [filtered, follow]);
  const download = () => {
    const content = filtered.map((log) => `${log.timestamp} [${log.type}] ${log.message}`).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${instanceName}-logs.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="surface-card console-card log-console">
      <div className="section-head">
        <h3 className="icon-label"><Terminal size={18} aria-hidden="true" />{t('consoleLogs')}</h3>
        <span>{filtered.length.toLocaleString()} / {logs.length.toLocaleString()} {t('logLines')}</span>
      </div>
      <div className="log-toolbar">
        <label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">{t('searchLogs')}</span>
          <input type="search" placeholder={t('searchLogs')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select className="compact-select" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('allLogs')}>
          <option value="all">{t('allLogs')}</option><option value="stdout">{t('logStdout')}</option>
          <option value="stderr">{t('logStderr')}</option><option value="system">{t('logSystem')}</option>
        </select>
        <button type="button" className={`btn tertiary ${follow ? 'active' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}>
          <ArrowDown size={16} aria-hidden="true" />{t('followLogs')}
        </button>
        <button type="button" className="btn tertiary" onClick={download} disabled={!filtered.length} aria-label={t('downloadLogs')} title={t('downloadLogs')}>
          <Download size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="log-container" ref={container} tabIndex={0} aria-label={t('consoleLogs')} onScroll={() => {
        const element = container.current;
        if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 48) setFollow(false);
      }}>
        {!filtered.length && <div className="log-empty"><Terminal size={28} aria-hidden="true" />
          <strong>{logs.length ? t('noMatchingLogs') : t('noLogs')}</strong>
          {!logs.length && <span>{t('noLogsHint')}</span>}
        </div>}
        {filtered.map((log, index) => <div key={`${log.timestamp}-${index}`} className={`log-entry log-${log.type}`}>
          <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
          <span className="log-type">{log.type === 'stdout' ? 'OUT' : log.type === 'stderr' ? 'ERR' : 'SYS'}</span>
          <span className="log-message" dangerouslySetInnerHTML={{ __html: formatLogMessage(log.message) }} />
        </div>)}
      </div>
    </section>
  );
}
