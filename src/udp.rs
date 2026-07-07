use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::net::{lookup_host, UdpSocket};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::bedrock::{
    describe_offline_ping, describe_raknet_packet, describe_unconnected_pong, is_offline_ping,
    is_open_connection_request_1, is_unconnected_pong, rewrite_unconnected_pong_ports,
    rewrite_unconnected_pong_timestamp, strip_unconnected_pong_name_quotes,
};
use crate::config::{ListenerRule, Protocol, ProxyTarget};
use crate::proxy_protocol::{build_proxy_v2_header, parse_proxy_chain};
use crate::runtime::AppRuntime;
use crate::tcp_tuning::apply_udp_buffer_sizes;

const MAX_DATAGRAM_SIZE: usize = 65_535;

type SessionMap = Arc<Mutex<HashMap<SocketAddr, Arc<UdpSession>>>>;

/// Listener-wide cache of the most recent backend UNCONNECTED_PONG.
/// Shared across every session on a listener so a fresh pong from one client
/// can be replayed instantly to future pings from any client without another
/// backend round-trip.
type SharedPongCache = Arc<StdMutex<Option<CachedPong>>>;

#[derive(Clone)]
struct CachedPong {
    /// Fully rewritten pong (post port-fix + name-quote-strip) ready to relay.
    /// Only the timestamp field (bytes 1..9) still needs per-ping rewriting.
    payload: Vec<u8>,
    /// When this pong was captured from the backend.
    updated_at: Instant,
}

/// If the shared pong cache is fresher than this, we skip forwarding the ping
/// to the backend entirely -- replaying the cached pong is enough for a MOTD
/// refresh, saving a full backend RTT + one backend send/recv per ping.
const PONG_CACHE_FRESH_MS: u64 = 3_000;

/// Per-client relay state.
///
/// Sessions are shared via `Arc` and mutated in place through atomics / small
/// locks. Nothing is ever cloned-out and written back, which removes the
/// read-modify-write races (including the "resurrected session" bug) that the
/// previous `insert`-on-every-datagram design suffered from.
struct UdpSession {
    /// Dedicated upstream socket for this client.
    socket: Arc<UdpSocket>,
    /// Index of the currently selected upstream target (failover cursor).
    active_target_index: AtomicUsize,
    /// Whether a PROXY v2 header has already been prepended on this socket.
    header_sent: AtomicBool,
    /// Whether the connect webhook/notification has fired.
    notified: AtomicBool,
    /// True once we have seen a connected FrameSet from the client. A fresh
    /// OpenConnectionRequest1 arriving after this point means a real reconnect.
    established: AtomicBool,
    /// Handle to the backend receive loop, so teardown can abort it promptly.
    recv_task: StdMutex<Option<JoinHandle<()>>>,
    /// Session start monotonic reference. `last_activity_ms` is stored as ms
    /// since this instant so we can compute idle time without allocating.
    session_start: Instant,
    /// Milliseconds since `session_start` of the last observed activity in
    /// **either direction** (client->backend send OR backend->client recv).
    /// The receive loop uses this instead of a raw `recv_from` timeout so a
    /// silent backend (e.g. world-load pause) doesn't tear down a session
    /// that is still actively receiving client packets.
    last_activity_ms: AtomicU64,
    /// Per-target resolved socket address cache. Indexed by target index in
    /// `rule.targets_for(Protocol::Udp)`. `None` means "not resolved yet".
    ///
    /// This is critical: without it, `send_to_target()` called
    /// `resolve_target_addr()` (= `lookup_host()` = getaddrinfo/DNS) on
    /// EVERY forwarded packet. On a stock Linux without a DNS cache daemon
    /// (systemd-resolved / nscd) each RakNet handshake packet would sync-
    /// block for the DNS RTT, and with ~20 handshake packets + hundreds of
    /// world-load packets this alone accounted for tens of seconds on the
    /// "参加" -> "接続完了" timeline. Resolve once at session creation,
    /// reuse forever after.
    resolved_targets: StdMutex<Vec<Option<SocketAddr>>>,
}

impl UdpSession {
    fn touch(&self) {
        let elapsed = self.session_start.elapsed().as_millis() as u64;
        self.last_activity_ms.store(elapsed, Ordering::Relaxed);
    }

    fn ms_since_last_activity(&self) -> u64 {
        let now = self.session_start.elapsed().as_millis() as u64;
        now.saturating_sub(self.last_activity_ms.load(Ordering::Relaxed))
    }
}

impl UdpSession {
    #[allow(dead_code)]
    fn abort_recv_task(&self) {
        if let Some(handle) = self.recv_task.lock().unwrap().take() {
            handle.abort();
        }
    }
}

pub async fn start_udp_proxy(rule: Arc<ListenerRule>, runtime: Arc<AppRuntime>) -> Result<()> {
    let port = rule.udp.context("UDP listener missing port")?;
    let bind = format!("{}:{port}", rule.bind);
    let server = Arc::new(
        UdpSocket::bind(&bind)
            .await
            .with_context(|| format!("failed to bind UDP listener {bind}"))?,
    );
    // Enlarge kernel buffers so the RakNet handshake burst + chunk-load
    // spike don't spend microseconds queueing behind the default 200 KiB
    // send/recv sizes.
    apply_udp_buffer_sizes(&server, "udp listener");
    let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
    let shared_pong: SharedPongCache = Arc::new(StdMutex::new(None));

    info!("UDP listening on {bind}");

    let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
    loop {
        let (len, peer) = server.recv_from(&mut buf).await?;
        let packet = buf[..len].to_vec();

        // IMPORTANT: シーケンシャル処理にする。

        if let Err(err) = handle_datagram(
            Arc::clone(&server),
            Arc::clone(&sessions),
            Arc::clone(&rule),
            Arc::clone(&runtime),
            Arc::clone(&shared_pong),
            peer,
            packet,
        )
        .await
        {
            warn!("UDP datagram from {peer} failed: {err:#}");
        }
    }
}

async fn handle_datagram(
    server: Arc<UdpSocket>,
    sessions: SessionMap,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
    shared_pong: SharedPongCache,
    peer: SocketAddr,
    packet: Vec<u8>,
) -> Result<()> {
    let mut original_client = peer;
    let parsed =
        parse_proxy_chain(&packet).unwrap_or_else(|_| crate::proxy_protocol::ParsedProxyChain {
            headers: Vec::new(),
            payload_offset: 0,
        });
    if let Some(last_header) = parsed.headers.last() {
        original_client = SocketAddr::new(last_header.source_address, last_header.source_port);
        debug!(
            "UDP incoming PROXY header original={} destination={}:{}",
            original_client, last_header.destination_address, last_header.destination_port
        );
    }
    let payload = packet[parsed.payload_offset..].to_vec();

    if payload.is_empty() {
        return Ok(());
    }

    if let Err(reason) = runtime
        .ddos_guard
        .udp_datagram_allowed(original_client.ip(), payload.len())
    {
        debug!(
            "DDoS guard dropped UDP datagram from {original_client} via {peer}: {}",
            reason.as_str()
        );
        return Ok(());
    }

    if let Some(description) = describe_offline_ping(&payload) {
        debug!("Bedrock offline ping from {original_client} via {peer}: {description}");
    } else if let Some(description) = describe_raknet_packet(&payload) {
        debug!("RakNet client packet from {original_client} via {peer}: {description}");
    }

    // Bedrock offline-ping fast path: try the listener-wide shared pong cache
    // first. If the cache is fresh (<PONG_CACHE_FRESH_MS since last backend
    // pong), we serve the client immediately AND skip forwarding to the
    // backend entirely. If the cache is stale/absent, we still serve from it
    // (if we have anything at all) and then fall through so the backend gets
    // pinged and the cache is refreshed.
    if is_offline_ping(&payload) {
        let cached = shared_pong.lock().unwrap().clone();
        let mut cache_is_fresh = false;
        if let (Some(entry), Some(timestamp)) = (cached.as_ref(), payload.get(1..9)) {
            let age_ms = entry.updated_at.elapsed().as_millis() as u64;
            cache_is_fresh = age_ms < PONG_CACHE_FRESH_MS;
            let immediate_pong = rewrite_unconnected_pong_timestamp(&entry.payload, timestamp)
                .unwrap_or_else(|| {
                    let mut out = entry.payload.clone();
                    if out.len() >= 9 {
                        out[1..9].copy_from_slice(timestamp);
                    }
                    out
                });
            if let Err(err) = server.send_to(&immediate_pong, peer).await {
                debug!("Immediate Bedrock pong send to {peer} failed: {err}");
            } else if cache_is_fresh {
                debug!(
                    "Served Bedrock pong to {peer} from shared cache (age {age_ms}ms) without touching backend"
                );
            } else {
                debug!(
                    "Served Bedrock pong to {peer} from shared cache (stale {age_ms}ms); refreshing backend in parallel"
                );
            }
        }
        if cache_is_fresh {
            // Fresh cache: no session/backend traffic needed. All done.
            return Ok(());
        }
        // Empty or stale cache: fall through so the backend is pinged and
        // spawn_backend_recv publishes the fresh pong to shared_pong.
    }

    let is_new_conn = is_open_connection_request_1(&payload);
    let session = obtain_session(
        &server,
        &sessions,
        &rule,
        &runtime,
        Arc::clone(&shared_pong),
        peer,
        is_new_conn,
    )
    .await?;

    try_send_udp(&rule, &runtime, &session, original_client, &payload).await?;

    // Refresh the bidirectional idle marker: this client is clearly alive.
    session.touch();

    if matches!(payload.first(), Some(0x80..=0x8d)) {
        session.established.store(true, Ordering::Relaxed);
    }

    if !session.notified.swap(true, Ordering::Relaxed) {
        maybe_notify_connect(&runtime, &rule, &session, original_client).await;
    }

    Ok(())
}

/// Returns the session for `peer`, creating one if needed.
///
/// 以前は「established なセッションに OpenConnectionRequest1 (0x05) が来たら
/// 再接続とみなして即リセット」していたが、これは Bedrock クライアントが
/// パケットロス時に 0x05 を再送するケースで**進行中のセッションを勝手に破棄**
/// してしまい、Geyser 側 RakNet が古い upstream ソケットに応答を送り続けて
/// TIMED_OUT を引き起こしていた。
///
async fn obtain_session(
    server: &Arc<UdpSocket>,
    sessions: &SessionMap,
    rule: &Arc<ListenerRule>,
    runtime: &Arc<AppRuntime>,
    shared_pong: SharedPongCache,
    peer: SocketAddr,
    _is_new_conn: bool,
) -> Result<Arc<UdpSession>> {
    {
        let guard = sessions.lock().await;
        if let Some(existing) = guard.get(&peer) {
            return Ok(Arc::clone(existing));
        }
    }

    let socket = Arc::new(
        UdpSocket::bind(if peer.is_ipv6() {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        })
        .await?,
    );
    // Same reasoning as the listener bind: the RakNet handshake wants big
    // buffers to avoid drops during the initial burst to the backend.
    apply_udp_buffer_sizes(&socket, "udp upstream session");

    let mut guard = sessions.lock().await;
    if let Some(existing) = guard.get(&peer) {
        return Ok(Arc::clone(existing));
    }

    let target_count = rule.targets_for(Protocol::Udp).len();
    let session = Arc::new(UdpSession {
        socket: Arc::clone(&socket),
        active_target_index: AtomicUsize::new(0),
        header_sent: AtomicBool::new(false),
        notified: AtomicBool::new(false),
        established: AtomicBool::new(false),
        recv_task: StdMutex::new(None),
        session_start: Instant::now(),
        last_activity_ms: AtomicU64::new(0),
        resolved_targets: StdMutex::new(vec![None; target_count]),
    });
    runtime.metrics.udp_session_opened();

    let handle = spawn_backend_recv(
        Arc::clone(&session),
        Arc::clone(server),
        Arc::clone(sessions),
        Arc::clone(rule),
        Arc::clone(runtime),
        shared_pong,
        peer,
    );
    *session.recv_task.lock().unwrap() = Some(handle);
    guard.insert(peer, Arc::clone(&session));
    Ok(session)
}

/// Removes and tears down the session for `peer`. The map `remove` is the
/// single source of truth for who fires the close metric, so this never
/// double-counts against the backend receive loop's own natural-exit cleanup.
///
/// 現在は client 側 payload の内容による明示的 close は行っておらず、
/// backend 受信ループの自然終了 (idle timeout / backend disconnect / EOF)
/// に一本化しているので未使用だが、将来別経路で必要になった時に備えて残す。
#[allow(dead_code)]
async fn close_session(sessions: &SessionMap, runtime: &AppRuntime, peer: SocketAddr) {
    let removed = { sessions.lock().await.remove(&peer) };
    if let Some(session) = removed {
        session.abort_recv_task();
        runtime.metrics.udp_session_closed();
    }
}

fn spawn_backend_recv(
    session: Arc<UdpSession>,
    server: Arc<UdpSocket>,
    sessions: SessionMap,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
    shared_pong: SharedPongCache,
    peer: SocketAddr,
) -> JoinHandle<()> {
    // NOTE: 以前は `timeout(udp_session_idle, recv_from)` を回して 1 回でも
    // 時間切れになったら break していた。しかしそれは「backend が沈黙した
    // 時間」しか測っていない片方向 idle だった。Bedrock/Geyser の world load
    // 中は backend 応答が数秒〜十数秒沈黙することが普通にある一方、client は
    // ACK/移動パケットを送り続けているので、そのタイミングでセッションを
    // 破棄すると upstream socket が入れ替わって TIMED_OUT を引き起こす。
    //
    // 修正: recv_from は短い interval (1s) で poll し、実際の idle 判定は
    // `session.last_activity_ms` (両方向で更新される) を見る。これで backend
    // が沈黙していても client 側送信が続いていればセッションを保つ。
    let idle_budget = runtime.timeouts.udp_session_idle;
    let poll_interval = std::time::Duration::from_secs(1);
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
        loop {
            match timeout(poll_interval, session.socket.recv_from(&mut buf)).await {
                Ok(Ok((len, backend_addr))) => {
                    let mut response = buf[..len].to_vec();
                    if let Ok(parsed) = parse_proxy_chain(&response) {
                        if !parsed.headers.is_empty() {
                            response = response[parsed.payload_offset..].to_vec();
                        }
                    }

                    if rule.rewrite_bedrock_pong_ports {
                        let before_rewrite = describe_unconnected_pong(&response);
                        if let Some(rewritten) =
                            rewrite_unconnected_pong_ports(&response, rule.udp.unwrap_or_default())
                        {
                            if let Some(before_rewrite) = before_rewrite {
                                let after_rewrite = describe_unconnected_pong(&rewritten)
                                    .unwrap_or_else(|| format!("len={}", rewritten.len()));
                                debug!(
                                    "Rewrote Bedrock pong ports for {peer}: before {before_rewrite}; after {after_rewrite}"
                                );
                            }
                            response = rewritten;
                        } else if let Some(description) = before_rewrite {
                            debug!(
                                "Bedrock pong did not need port rewrite for {peer}: {description}"
                            );
                        }
                    }

                    if let Some(cleaned) = strip_unconnected_pong_name_quotes(&response) {
                        response = cleaned;
                    }

                    if is_unconnected_pong(&response) {
                        if let Some(description) = describe_unconnected_pong(&response) {
                            debug!(
                                "Bedrock pong from backend {backend_addr} to {peer}: {description}"
                            );
                        }
                        // Publish the freshly-rewritten pong to the
                        // listener-wide cache so future pings from any peer
                        // can be served without another backend round-trip.
                        *shared_pong.lock().unwrap() = Some(CachedPong {
                            payload: response.clone(),
                            updated_at: Instant::now(),
                        });
                    } else if let Some(description) = describe_raknet_packet(&response) {
                        debug!(
                            "RakNet backend packet from {backend_addr} to {peer}: {description}"
                        );
                    }

                    if let Err(err) = server.send_to(&response, peer).await {
                        error!("UDP response send to {peer} failed: {err}");
                        break;
                    }
                    runtime.metrics.udp_target_to_client_bytes(response.len());
                    debug!("UDP {backend_addr} -> {peer} {}B", response.len());

                    // Backend からの受信もセッション活性としてカウント。
                    session.touch();
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
                    // poll_interval 分だけ backend が沈黙しただけ。
                    // 実際の idle は last_activity_ms (両方向で更新される)
                    // で判定して、idle_budget を超えていたら破棄。
                    let idle_ms = session.ms_since_last_activity();
                    if idle_ms >= idle_budget.as_millis() as u64 {
                        debug!(
                            "UDP session idle timeout {peer} ({}ms >= {}ms)",
                            idle_ms,
                            idle_budget.as_millis()
                        );
                        maybe_notify_disconnect(&runtime, &rule, peer).await;
                        break;
                    }
                    // まだ活動中: 何もせず次の poll へ
                }
            }
        }

        let removed = sessions.lock().await.remove(&peer).is_some();
        if removed {
            runtime.metrics.udp_session_closed();
        }
    })
}

async fn maybe_notify_connect(
    runtime: &AppRuntime,
    rule: &ListenerRule,
    session: &UdpSession,
    client_addr: SocketAddr,
) {
    let Some(webhook) = rule
        .webhook
        .as_deref()
        .filter(|webhook| !webhook.trim().is_empty())
    else {
        return;
    };

    let targets = rule.targets_for(Protocol::Udp);
    let index = session.active_target_index.load(Ordering::Relaxed);
    let Some(target) = targets.get(index).or_else(|| targets.first()) else {
        return;
    };
    let target_key = format!("{}:{}", target.host, target.udp.unwrap_or_default());

    if runtime.use_rest_api {
        runtime
            .connection_buffer
            .add_pending(
                client_addr.ip().to_string(),
                client_addr.port(),
                "UDP",
                target_key,
            )
            .await;
    } else {
        runtime
            .notifier
            .add_connect_group(
                webhook.to_string(),
                target_key,
                client_addr.ip().to_string(),
                client_addr.port(),
                "UDP",
            )
            .await;
    }
}

async fn maybe_notify_disconnect(
    runtime: &AppRuntime,
    rule: &ListenerRule,
    client_addr: SocketAddr,
) {
    if runtime.use_rest_api {
        return;
    }
    let Some(webhook) = rule
        .webhook
        .as_deref()
        .filter(|webhook| !webhook.trim().is_empty())
    else {
        return;
    };
    let targets = rule.targets_for(Protocol::Udp);
    let Some(target) = targets.first() else {
        return;
    };
    runtime
        .notifier
        .add_disconnect_group(
            webhook.to_string(),
            format!("{}:{}", target.host, target.udp.unwrap_or_default()),
            client_addr.ip().to_string(),
            client_addr.port(),
            "UDP",
        )
        .await;
}

async fn try_send_udp(
    rule: &ListenerRule,
    runtime: &AppRuntime,
    session: &UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
) -> Result<()> {
    let targets = rule.targets_for(Protocol::Udp);
    let force_proxy_header = rule.haproxy && is_offline_ping(payload);
    let mut last_error = None;

    let start = session.active_target_index.load(Ordering::Relaxed);
    for index in start..targets.len() {
        let target = &targets[index];
        let Some(target_port) = target.udp else {
            continue;
        };

        match send_to_target(
            rule,
            runtime,
            session,
            original_client,
            payload,
            target,
            target_port,
            index,
            force_proxy_header,
        )
        .await
        {
            Ok(()) => {
                session.active_target_index.store(index, Ordering::Relaxed);
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err);
                session.header_sent.store(false, Ordering::Relaxed);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("all UDP targets failed")))
}

#[allow(clippy::too_many_arguments)]
async fn send_to_target(
    rule: &ListenerRule,
    runtime: &AppRuntime,
    session: &UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
    target: &ProxyTarget,
    target_port: u16,
    target_index: usize,
    force_proxy_header: bool,
) -> Result<()> {
    // Try the per-session resolved-address cache first. If we've already
    // sent to this target on this session, skip the DNS/getaddrinfo hop
    // entirely -- otherwise every RakNet handshake packet would sync-block
    // waiting for the resolver, which is the actual reason the join takes
    // ~30 seconds via FerrumProxy vs ~5s via a raw pass-through.
    let cached = {
        let slots = session.resolved_targets.lock().unwrap();
        slots.get(target_index).copied().flatten()
    };
    let target_addr = if let Some(addr) = cached {
        addr
    } else {
        let resolved = resolve_target_addr(&target.host, target_port).await?;
        let mut slots = session.resolved_targets.lock().unwrap();
        if let Some(slot) = slots.get_mut(target_index) {
            *slot = Some(resolved);
        }
        resolved
    };
    let mut out = payload.to_vec();

    if rule.haproxy && (force_proxy_header || !session.header_sent.load(Ordering::Relaxed)) {
        let header = build_proxy_v2_header(
            original_client.ip(),
            original_client.port(),
            target_addr.ip(),
            target_port,
            true,
        );
        out = [header, out].concat();

        if !is_offline_ping(payload) {
            session.header_sent.store(true, Ordering::Relaxed);
        }

        debug!(
            "Added UDP PROXY v2 header for {original_client} -> {target_addr}: payload={}B total={}B force={force_proxy_header}",
            payload.len(),
            out.len()
        );
    }

    session.socket.send_to(&out, target_addr).await?;
    runtime.metrics.udp_client_to_target_bytes(out.len());
    session
        .active_target_index
        .store(target_index, Ordering::Relaxed);
    debug!("UDP {original_client} -> {target_addr} {}B", out.len());
    Ok(())
}

async fn resolve_target_addr(host: &str, port: u16) -> Result<SocketAddr> {
    let mut addrs = lookup_host((host, port))
        .await
        .with_context(|| format!("failed to resolve {host}:{port}"))?;
    addrs
        .next()
        .with_context(|| format!("no addresses returned for {host}:{port}"))
}
