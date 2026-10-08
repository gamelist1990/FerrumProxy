use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::net::{lookup_host, UdpSocket};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::bedrock::{
    describe_offline_ping, describe_raknet_packet, describe_unconnected_pong, is_offline_ping,
    is_open_connection_request_1, is_unconnected_pong, normalize_unconnected_pong_motd,
    rewrite_unconnected_pong_ports, rewrite_unconnected_pong_timestamp,
};
use crate::config::{ListenerRule, Protocol, ProxyTarget};
use crate::proxy_protocol::{build_proxy_v2_header, parse_proxy_chain};
use crate::runtime::AppRuntime;
use crate::tcp_tuning::apply_udp_buffer_sizes;

const MAX_DATAGRAM_SIZE: usize = 65_535;

type SessionMap = Arc<StdMutex<HashMap<SocketAddr, Arc<UdpSession>>>>;

type SharedPongCache = Arc<StdMutex<Option<CachedPong>>>;

#[derive(Clone)]
struct CachedPong {
    payload: Vec<u8>,

    updated_at: Instant,
}

const PONG_CACHE_FRESH_MS: u64 = 3_000;

// Cloudburst RakServerChannel stores sender -> forwarded-client mappings in an
// ExpiringMap with RakConstants.SESSION_TIMEOUT_MS (10 seconds) and ACCESSED
// expiration. FerrumProxy may retain an upstream socket longer than that, so
// it must send a fresh PROXY header after the same amount of inactivity.
const CLOUDBURST_PROXY_MAPPING_TIMEOUT_MS: u64 = 10_000;

const RAKNET_STAGE_NEW: usize = 0;
const RAKNET_STAGE_PING: usize = 1;
const RAKNET_STAGE_PONG: usize = 2;
const RAKNET_STAGE_OCR1: usize = 3;
const RAKNET_STAGE_REPLY1: usize = 4;
const RAKNET_STAGE_OCR2: usize = 5;
const RAKNET_STAGE_REPLY2: usize = 6;
const RAKNET_STAGE_FRAME_SET: usize = 7;
const RAKNET_STAGE_CONNECTION_REQUEST: usize = 8;
const RAKNET_STAGE_CONNECTION_ACCEPTED: usize = 9;
const RAKNET_STAGE_NEW_INCOMING: usize = 10;
const RAKNET_STAGE_DISCONNECTED: usize = 11;

fn raknet_stage_name(stage: usize) -> &'static str {
    match stage {
        RAKNET_STAGE_PING => "Unconnected Ping",
        RAKNET_STAGE_PONG => "Unconnected Pong",
        RAKNET_STAGE_OCR1 => "Open Connection Request 1",
        RAKNET_STAGE_REPLY1 => "Open Connection Reply 1",
        RAKNET_STAGE_OCR2 => "Open Connection Request 2",
        RAKNET_STAGE_REPLY2 => "Open Connection Reply 2",
        RAKNET_STAGE_FRAME_SET => "Frame Set",
        RAKNET_STAGE_CONNECTION_REQUEST => "Connection Request",
        RAKNET_STAGE_CONNECTION_ACCEPTED => "Connection Request Accepted",
        RAKNET_STAGE_NEW_INCOMING => "New Incoming Connection",
        RAKNET_STAGE_DISCONNECTED => "Disconnect Notification",
        _ => "New endpoint",
    }
}

fn raknet_packet_stage(payload: &[u8]) -> Option<usize> {
    match payload.first().copied()? {
        0x01 | 0x02 => Some(RAKNET_STAGE_PING),
        0x1c => Some(RAKNET_STAGE_PONG),
        0x05 => Some(RAKNET_STAGE_OCR1),
        0x06 => Some(RAKNET_STAGE_REPLY1),
        0x07 => Some(RAKNET_STAGE_OCR2),
        0x08 => Some(RAKNET_STAGE_REPLY2),
        0x09 => Some(RAKNET_STAGE_CONNECTION_REQUEST),
        0x10 => Some(RAKNET_STAGE_CONNECTION_ACCEPTED),
        0x13 => Some(RAKNET_STAGE_NEW_INCOMING),
        0x15 => Some(RAKNET_STAGE_DISCONNECTED),
        0x80..=0x8d => Some(RAKNET_STAGE_FRAME_SET),
        _ => None,
    }
}

struct UdpSession {
    diagnostic_seen: AtomicUsize,
    diagnostic_sent: AtomicU64,
    diagnostic_received: AtomicU64,
    socket: Arc<UdpSocket>,

    active_target_index: AtomicUsize,

    header_sent: AtomicBool,

    notified: AtomicBool,

    established: AtomicBool,

    // established が最初に true になった時刻 (session_start からの経過 ms)。
    // 0 = まだ established になっていない。再接続判定で「ハンドシェイク直後の
    // 遅延 OCR1 (アーティファクト)」と「実プレイ後の再接続」を区別するために使う。
    established_at_ms: AtomicU64,

    /// Last observed RakNet handshake stage for endpoint-correlated debug logs.
    raknet_stage: AtomicUsize,

    recv_task: StdMutex<Option<JoinHandle<()>>>,

    session_start: Instant,

    last_activity_ms: AtomicU64,

    resolved_targets: StdMutex<Vec<Option<SocketAddr>>>,
}

impl UdpSession {
    fn diagnose(&self, peer: SocketAddr, backend: SocketAddr, payload: &[u8], response: bool) {
        let (kind, index) = crate::nethernet_diagnostics::udp_kind(payload);
        let flag = 1 << (index + if response { 8 } else { 0 });
        if response {
            self.diagnostic_received.fetch_add(1, Ordering::Relaxed);
        } else {
            self.diagnostic_sent.fetch_add(1, Ordering::Relaxed);
        }
        if self.diagnostic_seen.fetch_or(flag, Ordering::Relaxed) & flag == 0 {
            crate::nethernet_diagnostics::Context { client: peer, backend }.emit("udp_packet",serde_json::json!({"kind":kind,"direction":if response {"backend_to_client"} else {"client_to_backend"},"bytes":payload.len(),"upstream":self.socket.local_addr().ok().map(|a|a.to_string())}));
        }
    }
    fn touch(&self) {
        let elapsed = self.session_start.elapsed().as_millis() as u64;
        self.last_activity_ms.store(elapsed, Ordering::Relaxed);
    }

    fn ms_since_last_activity(&self) -> u64 {
        let now = self.session_start.elapsed().as_millis() as u64;
        now.saturating_sub(self.last_activity_ms.load(Ordering::Relaxed))
    }

    /// established になってからの経過 ms。まだ established でなければ None。
    fn ms_since_established(&self) -> Option<u64> {
        if !self.established.load(Ordering::Relaxed) {
            return None;
        }
        let at = self.established_at_ms.load(Ordering::Relaxed);
        let now = self.session_start.elapsed().as_millis() as u64;
        Some(now.saturating_sub(at))
    }

    /// 0x80..=0x8d (RakNet FrameSet) を初めて観測したときに established を立て、
    /// その時刻を記録する。二度目以降は時刻を上書きしない。
    fn mark_established(&self) {
        if !self.established.swap(true, Ordering::Relaxed) {
            let elapsed = self.session_start.elapsed().as_millis() as u64;
            self.established_at_ms.store(elapsed, Ordering::Relaxed);
        }
    }

    fn record_raknet_stage(
        &self,
        peer: SocketAddr,
        direction: &str,
        payload: &[u8],
        detail: Option<&str>,
    ) {
        if !tracing::enabled!(tracing::Level::DEBUG) {
            return;
        }
        let Some(next) = raknet_packet_stage(payload) else {
            return;
        };
        let previous = self.raknet_stage.swap(next, Ordering::Relaxed);
        let description = describe_raknet_packet(payload)
            .unwrap_or_else(|| format!("id=0x{:02x} len={}", payload[0], payload.len()));
        debug!(
            "[RakNet FLOW] client={peer} direction={direction} transition=\"{} -> {}\" source={} packet={description}",
            raknet_stage_name(previous),
            raknet_stage_name(next),
            detail.unwrap_or("network")
        );
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

    apply_udp_buffer_sizes(&server, "udp listener");
    let sessions: SessionMap = Arc::new(StdMutex::new(HashMap::new()));
    let shared_pong: SharedPongCache = Arc::new(StdMutex::new(None));

    info!("UDP listening on {bind}");

    let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
    loop {
        let (len, peer) = server.recv_from(&mut buf).await?;
        if runtime.ip_block.is_blocked(peer.ip()) {
            debug!("IP block: dropped UDP datagram from {peer}");
            continue;
        }

        // P99 最適化: `buf[..len].to_vec()` によるパケット毎のヒープ確保を削除。
        // handle_datagram は await されるだけで spawn しないので、buf の借用は
        // 次の recv_from が呼ばれるまで生存し続けるため安全。
        if let Err(err) = handle_datagram(
            &server,
            &sessions,
            &rule,
            &runtime,
            &shared_pong,
            peer,
            &buf[..len],
        )
        .await
        {
            warn!("UDP datagram from {peer} failed: {err:#}");
        }
    }
}

async fn handle_datagram(
    server: &Arc<UdpSocket>,
    sessions: &SessionMap,
    rule: &Arc<ListenerRule>,
    runtime: &Arc<AppRuntime>,
    shared_pong: &SharedPongCache,
    peer: SocketAddr,
    packet: &[u8],
) -> Result<()> {
    let mut original_client = peer;

    // ファストパス: PROXY v2 シグネチャを最初の 12 バイトで判定。
    // 通常のゲームパケットはこの分岐を通らず parse_proxy_chain を呼ばない。
    let payload: &[u8] = if rule.uses_raknet_udp()
        && packet.len() >= 12
        && &packet[..12] == b"\r\n\r\n\0\r\nQUIT\n"
    {
        let parsed =
            parse_proxy_chain(packet).unwrap_or_else(|_| crate::proxy_protocol::ParsedProxyChain {
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
        &packet[parsed.payload_offset..]
    } else {
        packet
    };

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

    if rule.uses_raknet_udp() && tracing::enabled!(tracing::Level::DEBUG) {
        if let Some(description) = describe_offline_ping(payload) {
            debug!("Bedrock offline ping from {original_client} via {peer}: {description}");
        } else if let Some(description) = describe_raknet_packet(payload) {
            debug!("RakNet client packet from {original_client} via {peer}: {description}");
        }
    }

    if rule.uses_raknet_udp() && is_offline_ping(payload) {
        let cached = shared_pong.lock().unwrap().clone();
        if let (Some(entry), Some(timestamp)) = (cached.as_ref(), payload.get(1..9)) {
            let age_ms = entry.updated_at.elapsed().as_millis() as u64;
            if age_ms < PONG_CACHE_FRESH_MS {
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
                } else {
                    debug!(
                        "[RakNet FLOW] client={peer} direction=server->client transition=\"Unconnected Ping -> Unconnected Pong\" source=shared-cache packet={}",
                        describe_unconnected_pong(&immediate_pong)
                            .unwrap_or_else(|| format!("id=0x1c len={}", immediate_pong.len()))
                    );
                    debug!(
                        "Served Bedrock pong to {peer} from shared cache (age {age_ms}ms) without touching backend"
                    );
                }
                return Ok(());
            } else {
                debug!(
                    "Skipped stale Bedrock pong cache for {peer} (age {age_ms}ms); requesting one fresh backend pong"
                );
            }
        }
    }

    let is_new_conn = rule.uses_raknet_udp() && is_open_connection_request_1(&payload);
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

    if rule.uses_raknet_udp() {
        session.record_raknet_stage(peer, "client->server", payload, Some("client"));
    }

    // Cloudburst does not remove the sender mapping when a RakNet child session
    // closes. RakProxyServerHandler reuses it until the ExpiringMap entry has
    // been idle for SESSION_TIMEOUT_MS (10 seconds). Therefore an OCR1 must not
    // unconditionally re-arm the header: doing so while the mapping is present
    // forwards the binary PROXY header into the RakNet decoder as packet data.
    // Re-arm only when Cloudburst's mapping has actually had enough idle time
    // to expire while FerrumProxy's longer-lived upstream socket still exists.
    let upstream_idle_ms = session.ms_since_last_activity();
    if rule.uses_raknet_udp()
        && rule.haproxy
        && upstream_idle_ms >= CLOUDBURST_PROXY_MAPPING_TIMEOUT_MS
        && session.header_sent.swap(false, Ordering::Relaxed)
    {
        debug!(
            "UDP PROXY mapping for {peer} expired after {upstream_idle_ms}ms idle; re-arming initial header"
        );
    }

    try_send_udp(&rule, &runtime, &session, original_client, payload).await?;

    session.touch();

    if rule.uses_raknet_udp() && matches!(payload.first(), Some(0x80..=0x8d)) {
        session.mark_established();
    }

    // Exclude server-list pings from connection records and login matching.
    if (!rule.uses_raknet_udp() || !is_offline_ping(payload))
        && !session.notified.swap(true, Ordering::Relaxed)
    {
        maybe_notify_connect(&runtime, &rule, &session, original_client).await;
    }

    Ok(())
}

async fn obtain_session(
    server: &Arc<UdpSocket>,
    sessions: &SessionMap,
    rule: &Arc<ListenerRule>,
    runtime: &Arc<AppRuntime>,
    shared_pong: SharedPongCache,
    peer: SocketAddr,
    is_new_conn: bool,
) -> Result<Arc<UdpSession>> {
    // ワールドから抜けて再接続するとき、Bedrock クライアントは同じソースポート
    // から新規 OpenConnectionRequest1 を送ってくる。ここで古いゾンビセッションを
    // 明示的にリセットしないと、idle_timeout (最大 30 分) 経過まで再接続できない。
    //
    // 判定は 2 つの条件の OR:
    //
    //   (A) established かつ 3 秒以上無音 (従来の挙動、そのまま維持)。
    //       ゲームプレイ中は RakNet keep-alive が 1 秒に何度も飛ぶので 3 秒無音は
    //       物理切断とみなせる。ハンドシェイク直後の遅延 OCR1 (アーティファクト)
    //       はゲームトラフィックで無音時間が短いため誤発火しない。
    //
    //   (B) established になってから十分経過 (>= 5 秒) していて、かつ 1 秒以上無音。
    //       これは「実際にしばらくプレイした後に抜けて “即” 再参加した」ケース。
    //       (A) の 3 秒閾値だと 3 秒未満で戻ってきたときに再接続を検出できず、
    //       30 分プリセットではゾンビが残り続けて参加できない問題があった。
    //       established からの経過時間 (established_age) を見ることで、ハンドシェイク
    //       直後の遅延 OCR1 アーティファクト (established_age < 5s) とは明確に区別
    //       でき、(A) の保護を一切弱めずに高速再接続だけを拾える。1 秒無音を要求
    //       するので、パケットが途切れず流れている本当にアクティブなセッションを
    //       誤破棄することはない。
    //
    //   - まだ established になっていない (ハンドシェイク途中) の重複 OCR1 は
    //     単なる再送なので、どちらの条件にも当たらず再利用される。
    const RECONNECT_IDLE_THRESHOLD_MS: u64 = 3_000;
    const ESTABLISHED_GRACE_MS: u64 = 5_000;
    const FAST_RECONNECT_IDLE_MS: u64 = 1_000;
    if is_new_conn {
        let reconnect_info = {
            let guard = sessions.lock().unwrap();
            guard
                .get(&peer)
                .map(|s| (s.ms_since_last_activity(), s.ms_since_established()))
        };
        let should_reset = matches!(
            reconnect_info,
            Some((idle, Some(established_age)))
                if idle >= RECONNECT_IDLE_THRESHOLD_MS
                    || (established_age >= ESTABLISHED_GRACE_MS && idle >= FAST_RECONNECT_IDLE_MS)
        );
        if should_reset {
            let (idle_ms, est_age) = match reconnect_info {
                Some((idle, est)) => (idle, est.unwrap_or(0)),
                None => (0, 0),
            };
            debug!(
                "UDP reconnect detected from {peer}: dropping stale session (idle {idle_ms}ms, established_age {est_age}ms) for fresh handshake"
            );
            let removed = { sessions.lock().unwrap().remove(&peer) };
            if let Some(old) = removed {
                old.abort_recv_task();
                runtime.metrics.udp_session_closed();
            }
        }
    }

    {
        let guard = sessions.lock().unwrap();
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

    apply_udp_buffer_sizes(&socket, "udp upstream session");

    let mut guard = sessions.lock().unwrap();
    if let Some(existing) = guard.get(&peer) {
        return Ok(Arc::clone(existing));
    }

    let target_count = rule.targets_for(Protocol::Udp).len();
    let session = Arc::new(UdpSession {
        socket: Arc::clone(&socket),
        active_target_index: AtomicUsize::new(0),
        header_sent: AtomicBool::new(false),
        notified: AtomicBool::new(false),
        diagnostic_seen: AtomicUsize::new(0),
        diagnostic_sent: AtomicU64::new(0),
        diagnostic_received: AtomicU64::new(0),
        established: AtomicBool::new(false),
        established_at_ms: AtomicU64::new(0),
        raknet_stage: AtomicUsize::new(RAKNET_STAGE_NEW),
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

#[allow(dead_code)]
async fn close_session(sessions: &SessionMap, runtime: &AppRuntime, peer: SocketAddr) {
    let removed = { sessions.lock().unwrap().remove(&peer) };
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
    // ICE keepalives can be farther apart than RakNet traffic. Keep the NAT-like
    // upstream socket alive through a quiet WebRTC connection; preserve longer
    // configured timeouts (e.g. the high-latency preset).
    let idle_budget = if rule.uses_raknet_udp() {
        runtime.timeouts.udp_session_idle
    } else {
        runtime
            .timeouts
            .udp_session_idle
            .max(std::time::Duration::from_secs(60))
    };
    let poll_interval = std::time::Duration::from_secs(1);
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
        loop {
            match timeout(poll_interval, session.socket.recv_from(&mut buf)).await {
                Ok(Ok((len, backend_addr))) => {
                    // P99 最適化: バックエンド応答パスもファストパス化。
                    // 通常のゲームパケットは PROXY ヘッダを持たず、Pong 書換も
                    // 発生しないので、その場合は借用スライスのまま直接転送する。
                    let raw = &buf[..len];

                    // 1) PROXY v2 ヘッダは 12 バイトシグネチャで判定 (parse_proxy_chain は Zone 判定が重い)。
                    let stripped: &[u8] = if rule.uses_raknet_udp()
                        && raw.len() >= 12
                        && &raw[..12] == b"\r\n\r\n\0\r\nQUIT\n"
                    {
                        match parse_proxy_chain(raw) {
                            Ok(parsed) if !parsed.headers.is_empty() => {
                                &raw[parsed.payload_offset..]
                            }
                            _ => raw,
                        }
                    } else {
                        raw
                    };

                    // 2) Pong 判定/書換は Pong opcode (0x1c) の場合だけ行う。
                    //    通常フレームでは owned Vec を確保しない。
                    let is_pong = rule.uses_raknet_udp() && matches!(stripped.first(), Some(&0x1c));
                    let response_owned: Option<Vec<u8>> = if is_pong {
                        let mut buf_out: Vec<u8> = stripped.to_vec();

                        if rule.rewrite_bedrock_pong_ports {
                            let before_rewrite = describe_unconnected_pong(&buf_out);
                            if let Some(rewritten) = rewrite_unconnected_pong_ports(
                                &buf_out,
                                rule.udp.unwrap_or_default(),
                            ) {
                                if let Some(before_rewrite) = before_rewrite {
                                    let after_rewrite = describe_unconnected_pong(&rewritten)
                                        .unwrap_or_else(|| format!("len={}", rewritten.len()));
                                    debug!(
                                        "Rewrote Bedrock pong ports for {peer}: before {before_rewrite}; after {after_rewrite}"
                                    );
                                }
                                buf_out = rewritten;
                            } else if let Some(description) = before_rewrite {
                                debug!(
                                    "Bedrock pong did not need port rewrite for {peer}: {description}"
                                );
                            }
                        }

                        if let Some(normalized) = normalize_unconnected_pong_motd(&buf_out) {
                            if tracing::enabled!(tracing::Level::DEBUG) {
                                let before = describe_unconnected_pong(&buf_out)
                                    .unwrap_or_else(|| format!("len={}", buf_out.len()));
                                let after = describe_unconnected_pong(&normalized)
                                    .unwrap_or_else(|| format!("len={}", normalized.len()));
                                debug!(
                                    "Normalized Bedrock pong MOTD for {peer}: before {before}; after {after}"
                                );
                            }
                            buf_out = normalized;
                        }

                        if is_unconnected_pong(&buf_out) {
                            if tracing::enabled!(tracing::Level::DEBUG) {
                                if let Some(description) = describe_unconnected_pong(&buf_out) {
                                    debug!(
                                        "Bedrock pong from backend {backend_addr} to {peer}: {description}"
                                    );
                                }
                            }
                            *shared_pong.lock().unwrap() = Some(CachedPong {
                                payload: buf_out.clone(),
                                updated_at: Instant::now(),
                            });
                        }
                        Some(buf_out)
                    } else {
                        if rule.uses_raknet_udp() && tracing::enabled!(tracing::Level::DEBUG) {
                            if let Some(description) = describe_raknet_packet(stripped) {
                                debug!(
                                    "RakNet backend packet from {backend_addr} to {peer}: {description}"
                                );
                            }
                        }
                        None
                    };

                    let out: &[u8] = response_owned.as_deref().unwrap_or(stripped);

                    if rule.uses_raknet_udp() {
                        session.record_raknet_stage(
                            peer,
                            "server->client",
                            out,
                            Some(if response_owned.is_some() {
                                "backend-rewritten"
                            } else {
                                "backend"
                            }),
                        );
                    }

                    if let Err(err) = server.send_to(out, peer).await {
                        error!("UDP response send to {peer} failed: {err}");
                        break;
                    }
                    runtime.metrics.udp_target_to_client_bytes(out.len());
                    if rule.nethernet_diagnostics && !rule.uses_raknet_udp() {
                        session.diagnose(peer, backend_addr, out, true);
                    }
                    if tracing::enabled!(tracing::Level::DEBUG) {
                        debug!("UDP {backend_addr} -> {peer} {}B", out.len());
                    }

                    session.touch();
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
                    let idle_ms = session.ms_since_last_activity();
                    if idle_ms >= idle_budget.as_millis() as u64 {
                        if rule.nethernet_diagnostics && !rule.uses_raknet_udp() {
                            let backend = session
                                .resolved_targets
                                .lock()
                                .unwrap()
                                .iter()
                                .flatten()
                                .next()
                                .copied();
                            if let Some(backend) = backend {
                                crate::nethernet_diagnostics::Context { client: peer, backend }.emit("udp_idle",serde_json::json!({"sentPackets":session.diagnostic_sent.load(Ordering::Relaxed),"receivedPackets":session.diagnostic_received.load(Ordering::Relaxed),"idleMs":idle_ms}));
                            }
                        }
                        debug!(
                            "UDP session idle timeout {peer} ({}ms >= {}ms)",
                            idle_ms,
                            idle_budget.as_millis()
                        );
                        maybe_notify_disconnect(&runtime, &rule, peer).await;
                        break;
                    }
                }
            }
        }

        let removed = sessions.lock().unwrap().remove(&peer).is_some();
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
    runtime
        .connection_ip_mapper
        .register_connection(client_addr.ip().to_string(), "UDP")
        .await;
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
        let Some(webhook) = rule
            .webhook
            .as_deref()
            .filter(|webhook| !webhook.trim().is_empty())
        else {
            return;
        };
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

async fn try_send_udp<'a>(
    rule: &ListenerRule,
    runtime: &AppRuntime,
    session: &UdpSession,
    original_client: SocketAddr,
    payload: &'a [u8],
) -> Result<()> {
    let targets = rule.targets_for(Protocol::Udp);
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
) -> Result<()> {
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

    // Cloudburst RakProxyServerHandler requires a PROXY header when the
    // physical UDP sender has no cached mapping. It then advances the ByteBuf
    // past that header, caches sender -> original client, and passes the same
    // datagram's RakNet payload onward. While cached, subsequent datagrams must
    // contain RakNet only. The expiry-aligned re-arm is handled above.
    let need_header =
        rule.uses_raknet_udp() && rule.haproxy && !session.header_sent.load(Ordering::Relaxed);

    let bytes_sent = if need_header {
        let header = build_proxy_v2_header(
            original_client.ip(),
            original_client.port(),
            target_addr.ip(),
            target_port,
            true,
        );
        let mut out = Vec::with_capacity(header.len() + payload.len());
        out.extend_from_slice(&header);
        out.extend_from_slice(payload);

        session.header_sent.store(true, Ordering::Relaxed);

        if tracing::enabled!(tracing::Level::DEBUG) {
            debug!(
                "Added initial UDP PROXY v2 header for {original_client} -> {target_addr}: payload={}B total={}B",
                payload.len(),
                out.len()
            );
        }

        session.socket.send_to(&out, target_addr).await?;
        out.len()
    } else {
        session.socket.send_to(payload, target_addr).await?;
        payload.len()
    };
    runtime.metrics.udp_client_to_target_bytes(bytes_sent);
    session
        .active_target_index
        .store(target_index, Ordering::Relaxed);
    if tracing::enabled!(tracing::Level::DEBUG) {
        debug!("UDP {original_client} -> {target_addr} {bytes_sent}B");
    }
    if rule.nethernet_diagnostics && !rule.uses_raknet_udp() {
        session.diagnose(original_client, target_addr, payload, false);
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BedrockTransport;
    use crate::ddos_guard::DdosGuardSettings;
    use std::time::Duration;

    fn test_rule(port: u16, transport: BedrockTransport) -> Arc<ListenerRule> {
        let mut rule: ListenerRule = serde_yaml::from_str(&format!(
            "bind: 127.0.0.1\nudp: 5000\nhaproxy: true\ntarget:\n  host: 127.0.0.1\n  udp: {port}\n"
        ))
        .unwrap();
        rule.bedrock_transport = transport;
        Arc::new(rule)
    }

    async fn receive(socket: &UdpSocket) -> Result<(Vec<u8>, SocketAddr)> {
        let mut bytes = vec![0; MAX_DATAGRAM_SIZE];
        let (len, addr) = timeout(Duration::from_secs(2), socket.recv_from(&mut bytes)).await??;
        bytes.truncate(len);
        Ok((bytes, addr))
    }

    #[tokio::test]
    async fn records_udp_once_per_session_without_webhook_and_excludes_raknet_pings() -> Result<()>
    {
        use crate::runtime::{ip_tests, ConnectionIpMapper};
        for transport in [BedrockTransport::Raknet, BedrockTransport::Nethernet] {
            for use_rest_api in [false, true] {
                let directory = ip_tests::temporary_directory();
                let path = directory.join("connectionIP.json");
                let backend = UdpSocket::bind("127.0.0.1:0").await?;
                let server = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
                let rule = test_rule(backend.local_addr()?.port(), transport);
                let mut runtime =
                    AppRuntime::new(use_rest_api, false, vec![], DdosGuardSettings::default());
                runtime.connection_ip_mapper = ConnectionIpMapper::new(path.clone(), true);
                let runtime = Arc::new(runtime);
                let sessions: SessionMap = Arc::new(StdMutex::new(HashMap::new()));
                let cache = Arc::new(StdMutex::new(None));
                let peer = "127.0.0.1:12345".parse()?;
                if rule.uses_raknet_udp() {
                    let mut ping = vec![0x01];
                    ping.extend_from_slice(&[0; 8]);
                    ping.extend_from_slice(&[
                        0, 255, 255, 0, 254, 254, 254, 254, 253, 253, 253, 253, 18, 52, 86, 120,
                    ]);
                    handle_datagram(&server, &sessions, &rule, &runtime, &cache, peer, &ping)
                        .await?;
                    receive(&backend).await?;
                    assert!(!path.exists(), "server-list ping must not be counted");
                }
                for _ in 0..3 {
                    handle_datagram(
                        &server, &sessions, &rule, &runtime, &cache, peer, b"payload",
                    )
                    .await?;
                    receive(&backend).await?;
                }
                let records = ip_tests::read_connections(&path);
                assert_eq!(
                    records[0].connections, 1,
                    "packets must not be counted as sessions"
                );
                assert_eq!(records[0].protocol, "UDP");
                let matched = runtime
                    .connection_buffer
                    .process_for_timestamp(crate::runtime::now_ms())
                    .await;
                assert_eq!(matched.len(), usize::from(use_rest_api));
                close_session(&sessions, &runtime, peer).await;
                handle_datagram(
                    &server, &sessions, &rule, &runtime, &cache, peer, b"payload",
                )
                .await?;
                receive(&backend).await?;
                assert_eq!(ip_tests::read_connections(&path)[0].connections, 2);
                close_session(&sessions, &runtime, peer).await;
                std::fs::remove_dir_all(directory)?;
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn nethernet_relays_opaque_datagrams_with_stable_separate_peer_sockets() -> Result<()> {
        let backend = UdpSocket::bind("127.0.0.1:0").await?;
        let server = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
        let clients = [
            UdpSocket::bind("127.0.0.1:0").await?,
            UdpSocket::bind("127.0.0.1:0").await?,
        ];
        let rule = test_rule(backend.local_addr()?.port(), BedrockTransport::Nethernet);
        let runtime = Arc::new(AppRuntime::new(
            false,
            false,
            vec![],
            DdosGuardSettings::default(),
        ));
        let sessions: SessionMap = Arc::new(StdMutex::new(HashMap::new()));
        // A valid RakNet pong makes accidental caching/rewriting observable.
        let magic = [
            0, 255, 255, 0, 254, 254, 254, 254, 253, 253, 253, 253, 18, 52, 86, 120,
        ];
        let motd = b"MCPE;\"Probe\";390;1.20.0;0;10;123;;Survival;1;19132;19133;";
        let mut pong = vec![0x1c];
        pong.extend_from_slice(&[0; 16]);
        pong.extend_from_slice(&magic);
        pong.extend_from_slice(&(motd.len() as u16).to_be_bytes());
        pong.extend_from_slice(motd);
        let cache = Arc::new(StdMutex::new(Some(CachedPong {
            payload: pong.clone(),
            updated_at: Instant::now(),
        })));
        let mut ping = vec![0x01];
        ping.extend_from_slice(&[0; 8]);
        ping.extend_from_slice(&magic);
        let mut proxy_like = build_proxy_v2_header(
            "203.0.113.42".parse()?,
            12345,
            "127.0.0.1".parse()?,
            5000,
            true,
        );
        proxy_like.extend_from_slice(b"opaque");
        let mut ocr1 = vec![0x05];
        ocr1.extend_from_slice(&magic);
        ocr1.push(11);
        let packets = [
            vec![
                0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
            ],
            vec![22, 254, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 42],
            ping,
            pong.clone(),
            proxy_like,
            ocr1,
            vec![0x80, 1, 2, 3],
        ];
        let mut upstream_addresses = [None, None];
        for packet in &packets {
            for (index, client) in clients.iter().enumerate() {
                let peer = client.local_addr()?;
                handle_datagram(&server, &sessions, &rule, &runtime, &cache, peer, packet).await?;
                let (forwarded, upstream) = receive(&backend).await?;
                assert_eq!(forwarded, *packet, "client datagram was altered");
                if let Some(previous) = upstream_addresses[index] {
                    assert_eq!(upstream, previous, "ICE mapping changed during the session");
                }
                upstream_addresses[index] = Some(upstream);
                backend.send_to(packet, upstream).await?;
                let (reply, source) = receive(client).await?;
                assert_eq!(reply, *packet, "backend datagram was altered");
                assert_eq!(source, server.local_addr()?);
            }
        }
        assert_ne!(upstream_addresses[0], upstream_addresses[1]);
        assert_eq!(cache.lock().unwrap().as_ref().unwrap().payload, pong);
        for client in &clients {
            let peer = client.local_addr()?;
            {
                let guard = sessions.lock().unwrap();
                let session = guard.get(&peer).unwrap();
                assert!(!session.header_sent.load(Ordering::Relaxed));
                assert!(!session.established.load(Ordering::Relaxed));
            }
            close_session(&sessions, &runtime, peer).await;
        }
        Ok(())
    }

    #[tokio::test]
    async fn raknet_still_sends_proxy_header_only_on_initial_datagram() -> Result<()> {
        let backend = UdpSocket::bind("127.0.0.1:0").await?;
        let server = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
        let rule = test_rule(backend.local_addr()?.port(), BedrockTransport::Raknet);
        let runtime = Arc::new(AppRuntime::new(
            false,
            false,
            vec![],
            DdosGuardSettings::default(),
        ));
        let sessions: SessionMap = Arc::new(StdMutex::new(HashMap::new()));
        let cache = Arc::new(StdMutex::new(None));
        let peer: SocketAddr = "127.0.0.1:12345".parse()?;
        for index in 0..2 {
            handle_datagram(
                &server, &sessions, &rule, &runtime, &cache, peer, b"payload",
            )
            .await?;
            let (received, _) = receive(&backend).await?;
            let parsed = parse_proxy_chain(&received)?;
            assert_eq!(parsed.headers.len(), if index == 0 { 1 } else { 0 });
            assert_eq!(&received[parsed.payload_offset..], b"payload");
        }
        close_session(&sessions, &runtime, peer).await;
        Ok(())
    }
}
