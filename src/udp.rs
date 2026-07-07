use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

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

const MAX_DATAGRAM_SIZE: usize = 65_535;

type SessionMap = Arc<Mutex<HashMap<SocketAddr, Arc<UdpSession>>>>;

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
    /// Last backend UNCONNECTED_PONG, replayed instantly to new pings.
    cached_offline_pong: StdMutex<Option<Vec<u8>>>,
    /// Handle to the backend receive loop, so teardown can abort it promptly.
    recv_task: StdMutex<Option<JoinHandle<()>>>,
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
    let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));

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

    let is_new_conn = is_open_connection_request_1(&payload);
    let session = obtain_session(&server, &sessions, &rule, &runtime, peer, is_new_conn).await?;

    if is_offline_ping(&payload) {
        let cached = session.cached_offline_pong.lock().unwrap().clone();
        if let (Some(cached_pong), Some(timestamp)) = (cached, payload.get(1..9)) {
            let immediate_pong = rewrite_unconnected_pong_timestamp(&cached_pong, timestamp)
                .unwrap_or_else(|| {
                    let mut out = cached_pong.clone();
                    if out.len() >= 9 {
                        out[1..9].copy_from_slice(timestamp);
                    }
                    out
                });
            if let Err(err) = server.send_to(&immediate_pong, peer).await {
                debug!("Immediate Bedrock pong send to {peer} failed: {err}");
            } else {
                let description = describe_unconnected_pong(&immediate_pong)
                    .unwrap_or_else(|| format!("len={}", immediate_pong.len()));
                debug!(
                    "Sent immediate Bedrock pong to {peer}; refreshing backend in parallel: {description}"
                );
            }
        }
    }

    try_send_udp(&rule, &runtime, &session, original_client, &payload).await?;

    if matches!(payload.first(), Some(0x80..=0x8d)) {
        session.established.store(true, Ordering::Relaxed);
    }

    if !session.notified.swap(true, Ordering::Relaxed) {
        maybe_notify_connect(&runtime, &rule, &session, original_client).await;
    }

    // NOTE: 以前はここで `contains_disconnect(&payload)` を判定して

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
/// 正しい再接続は「DisconnectNotification (0x15) → 新規 OpenConnectionRequest1」
/// のシーケンスで、前者は `contains_disconnect` が検出して `close_session` が
/// セッションを削除するため、次の 0x05 では自然に新規セッションが作られる。
/// つまり `is_new_conn` に基づくリセットは不要どころか有害。
///
/// `is_new_conn` 引数は将来の再拡張余地のために残しているが、現在は使わない。
async fn obtain_session(
    server: &Arc<UdpSocket>,
    sessions: &SessionMap,
    rule: &Arc<ListenerRule>,
    runtime: &Arc<AppRuntime>,
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

    let mut guard = sessions.lock().await;
    if let Some(existing) = guard.get(&peer) {
        return Ok(Arc::clone(existing));
    }

    let session = Arc::new(UdpSession {
        socket: Arc::clone(&socket),
        active_target_index: AtomicUsize::new(0),
        header_sent: AtomicBool::new(false),
        notified: AtomicBool::new(false),
        established: AtomicBool::new(false),
        cached_offline_pong: StdMutex::new(None),
        recv_task: StdMutex::new(None),
    });
    runtime.metrics.udp_session_opened();

    let handle = spawn_backend_recv(
        Arc::clone(&session),
        Arc::clone(server),
        Arc::clone(sessions),
        Arc::clone(rule),
        Arc::clone(runtime),
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
    peer: SocketAddr,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
        loop {
            match timeout(
                runtime.timeouts.udp_session_idle,
                session.socket.recv_from(&mut buf),
            )
            .await
            {
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
                        *session.cached_offline_pong.lock().unwrap() = Some(response.clone());
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

                    // NOTE: 以前はここで `contains_disconnect(&response)` を判定して
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
                    debug!("UDP session idle timeout {peer}");
                    maybe_notify_disconnect(&runtime, &rule, peer).await;
                    break;
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
    let target_addr = resolve_target_addr(&target.host, target_port).await?;
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
