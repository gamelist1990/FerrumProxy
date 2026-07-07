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
    is_open_connection_request_1, is_unconnected_pong, rewrite_unconnected_pong_ports,
    rewrite_unconnected_pong_timestamp, strip_unconnected_pong_name_quotes,
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

struct UdpSession {
    socket: Arc<UdpSocket>,

    active_target_index: AtomicUsize,

    header_sent: AtomicBool,

    notified: AtomicBool,

    established: AtomicBool,

    recv_task: StdMutex<Option<JoinHandle<()>>>,

    session_start: Instant,

    last_activity_ms: AtomicU64,

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

    apply_udp_buffer_sizes(&server, "udp listener");
    let sessions: SessionMap = Arc::new(StdMutex::new(HashMap::new()));
    let shared_pong: SharedPongCache = Arc::new(StdMutex::new(None));

    info!("UDP listening on {bind}");

    let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
    loop {
        let (len, peer) = server.recv_from(&mut buf).await?;
        let packet = buf[..len].to_vec();

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

    let payload: &[u8] = if packet.len() >= 12 && &packet[..12] == b"\r\n\r\n\0\r\nQUIT\n" {
        let parsed = parse_proxy_chain(&packet).unwrap_or_else(|_| {
            crate::proxy_protocol::ParsedProxyChain {
                headers: Vec::new(),
                payload_offset: 0,
            }
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
        &packet[..]
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

    if tracing::enabled!(tracing::Level::DEBUG) {
        if let Some(description) = describe_offline_ping(payload) {
            debug!("Bedrock offline ping from {original_client} via {peer}: {description}");
        } else if let Some(description) = describe_raknet_packet(payload) {
            debug!("RakNet client packet from {original_client} via {peer}: {description}");
        }
    }

    if is_offline_ping(payload) {
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
            return Ok(());
        }
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

    try_send_udp(&rule, &runtime, &session, original_client, payload).await?;

    session.touch();

    if matches!(payload.first(), Some(0x80..=0x8d)) {
        session.established.store(true, Ordering::Relaxed);
    }

    if !session.notified.swap(true, Ordering::Relaxed) {
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
    _is_new_conn: bool,
) -> Result<Arc<UdpSession>> {
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

                    session.touch();
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
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

async fn try_send_udp<'a>(
    rule: &ListenerRule,
    runtime: &AppRuntime,
    session: &UdpSession,
    original_client: SocketAddr,
    payload: &'a [u8],
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

    let need_header =
        rule.haproxy && (force_proxy_header || !session.header_sent.load(Ordering::Relaxed));

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

        if !is_offline_ping(payload) {
            session.header_sent.store(true, Ordering::Relaxed);
        }

        if tracing::enabled!(tracing::Level::DEBUG) {
            debug!(
                "Added UDP PROXY v2 header for {original_client} -> {target_addr}: payload={}B total={}B force={force_proxy_header}",
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
