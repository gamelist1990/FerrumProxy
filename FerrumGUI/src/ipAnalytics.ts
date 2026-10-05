export type IpRecord = {
  ip?: string;
  lastSeen?: number;
  connections?: number;
};

export type PlayerIpRecord = {
  username?: string;
  ips?: IpRecord[];
};

export function aggregateConnectionIps(players: PlayerIpRecord[], connections: IpRecord[]) {
  const byIp = new Map<string, { ip: string; connections: number; players: Set<string>; lastSeen: number }>();
  for (const player of players) {
    for (const entry of player.ips || []) {
      if (!entry.ip) continue;
      const current = byIp.get(entry.ip) || {
        ip: entry.ip, connections: 0, players: new Set<string>(), lastSeen: 0,
      };
      current.connections += Math.max(1, Number(entry.connections) || 1);
      if (player.username) current.players.add(player.username);
      current.lastSeen = Math.max(current.lastSeen, Number(entry.lastSeen) || 0);
      byIp.set(entry.ip, current);
    }
  }
  // TCP/UDP totals are authoritative for each IP; login notifications only add names.
  const trackedIps = new Set<string>();
  for (const entry of connections) {
    if (!entry.ip) continue;
    const current = byIp.get(entry.ip) || {
      ip: entry.ip, connections: 0, players: new Set<string>(), lastSeen: 0,
    };
    if (!trackedIps.has(entry.ip)) current.connections = 0;
    trackedIps.add(entry.ip);
    current.connections += Math.max(1, Number(entry.connections) || 1);
    current.lastSeen = Math.max(current.lastSeen, Number(entry.lastSeen) || 0);
    byIp.set(entry.ip, current);
  }
  return byIp;
}
