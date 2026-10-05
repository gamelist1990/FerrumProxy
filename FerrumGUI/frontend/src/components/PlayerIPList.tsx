import { useEffect, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { getLanguage, t } from '../lang';
import type { PlayerIPEntry } from "../api";
import "./PlayerIPList.css";

interface PlayerIPListProps {
  playerIPs: PlayerIPEntry[];
}

export function PlayerIPList({ playerIPs }: PlayerIPListProps) {
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  // プレイヤー名でソート (a-z順)
  const sortedPlayers = playerIPs.filter((player) => player.username.toLowerCase().includes(query.toLowerCase()) || player.ips.some((entry) => entry.ip.includes(query))).sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase())
  );

  const formatLastSeen = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatTimeSince = (timestamp: number) => {
    const diff = Math.max(0, now - timestamp);

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    const relative = new Intl.RelativeTimeFormat(getLanguage().replace('_', '-'), { numeric: 'auto' });
    if (minutes < 1) return relative.format(0, 'minute');
    if (minutes < 60) return relative.format(-minutes, 'minute');
    if (hours < 24) return relative.format(-hours, 'hour');
    return relative.format(-days, 'day');
  };

  return (
    <div className="player-ip-list">
      <label className="search-field player-search"><Search size={17} aria-hidden="true" /><span className="sr-only">{t('searchPlayers')}</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchPlayers')} />
      </label>
      {sortedPlayers.length === 0 ? <div className="panel-empty"><Users size={28} aria-hidden="true" />
        <strong>{query ? t('noMatchingPlayers') : t('noPlayerRecords')}</strong>
        {!query && <p>{t('noPlayerRecordsHint')}</p>}
      </div> : <div className="player-table-scroll" tabIndex={0} role="region" aria-label={t('workspacePlayers')}>
      <table className="player-ip-table">
        <thead>
          <tr>
            <th scope="col">{t('playerName')}</th>
            <th scope="col">{t('ipAddress')}</th>
            <th scope="col">{t('ipProtocol')}</th>
            <th scope="col">{t('ipLastSeen')}</th>
            <th scope="col">{t('ipElapsed')}</th>
          </tr>
        </thead>
        <tbody>
          {sortedPlayers.map((player) =>
            player.ips.map((ip, index) => (
              <tr key={`${player.username}-${index}`}>
                {index === 0 && (
                  <td rowSpan={player.ips.length} className="username-cell">
                    {player.username}
                  </td>
                )}
                <td className="ip-cell">{ip.ip}</td>
                <td className="protocol-cell">
                  <span
                    className={`protocol-badge ${ip.protocol.toLowerCase()}`}
                  >
                    {ip.protocol}
                  </span>
                </td>
                <td className="timestamp-cell">
                  {formatLastSeen(ip.lastSeen)}
                </td>
                <td className="time-since-cell">
                  {formatTimeSince(ip.lastSeen)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>}
    </div>
  );
}
