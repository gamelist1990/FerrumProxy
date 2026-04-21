import type { PlayerIPEntry } from "../api";
import "./PlayerIPList.css";

interface PlayerIPListProps {
  playerIPs: PlayerIPEntry[];
}

export function PlayerIPList({ playerIPs }: PlayerIPListProps) {
  // プレイヤー名でソート (a-z順)
  const sortedPlayers = [...playerIPs].sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase())
  );

  const formatLastSeen = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatTimeSince = (timestamp: number) => {
    const diff = Date.now() - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "今";
    if (minutes < 60) return `${minutes}分前`;
    if (hours < 24) return `${hours}時間前`;
    return `${days}日前`;
  };

  if (sortedPlayers.length === 0) {
    return (
      <div className="player-ip-list">
        <div className="no-data">データ無し</div>
      </div>
    );
  }

  return (
    <div className="player-ip-list">
      <table className="player-ip-table">
        <thead>
          <tr>
            <th>プレイヤー名</th>
            <th>IPアドレス</th>
            <th>プロトコル</th>
            <th>最終確認</th>
            <th>経過時間</th>
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
    </div>
  );
}
