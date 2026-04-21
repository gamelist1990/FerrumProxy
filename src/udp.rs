use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::{lookup_host, UdpSocket};
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::bedrock::{
    is_disconnect_notification, is_offline_ping, is_unconnected_pong,
    rewrite_unconnected_pong_ports, rewrite_unconnected_pong_timestamp,
};
use crate::config::{ListenerRule, Protocol, ProxyTarget};
use crate::proxy_protocol::{build_proxy_v2_header, parse_proxy_chain};
use crate::runtime::AppRuntime;

const UDP_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_DATAGRAM_SIZE: usize = 65_535;

type SessionMap = Arc<Mutex<HashMap<SocketAddr, UdpSession>>>;

#[derive(Clone)]
struct UdpSession {
    socket: Arc<UdpSocket>,
    active_target_index: usize,
    header_sent: bool,
    notified: bool,
    cached_offline_pong: Option<Vec<u8>>,
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
        let server = Arc::clone(&server);
        let sessions = Arc::clone(&sessions);
        let rule = Arc::clone(&rule);
        let runtime = Arc::clone(&runtime);

        tokio::spawn(async move {
            if let Err(err) = handle_datagram(server, sessions, rule, runtime, peer, packet).await {
                warn!("UDP datagram from {peer} failed: {err:#}");
            }
        });
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

    let mut session = {
        let guard = sessions.lock().await;
        guard.get(&peer).cloned()
    };

    if session.is_none() {
        session = Some(
            create_session(
                Arc::clone(&server),
                Arc::clone(&sessions),
                Arc::clone(&rule),
                Arc::clone(&runtime),
                peer,
            )
            .await?,
        );
    }

    let mut session = session.context("failed to create UDP session")?;

    if is_disconnect_notification(&payload) {
        sessions.lock().await.remove(&peer);
        debug!("UDP session closed by disconnect notification {peer}");
        return Ok(());
    }

    if is_offline_ping(&payload) {
        if let (Some(cached_pong), Some(timestamp)) =
            (session.cached_offline_pong.as_ref(), payload.get(1..9))
        {
            let immediate_pong = rewrite_unconnected_pong_timestamp(cached_pong, timestamp)
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
                debug!("Sent immediate Bedrock pong to {peer}; refreshing backend in parallel");
            }
        }
    }

    try_send_udp(&rule, &runtime, &mut session, original_client, &payload).await?;
    if !session.notified {
        maybe_notify_connect(&runtime, &rule, &session, original_client).await;
        session.notified = true;
    }
    let mut guard = sessions.lock().await;
    if session.cached_offline_pong.is_none() {
        if let Some(current) = guard.get(&peer) {
            session.cached_offline_pong = current.cached_offline_pong.clone();
        }
    }
    guard.insert(peer, session);
    Ok(())
}

async fn create_session(
    server: Arc<UdpSocket>,
    sessions: SessionMap,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
    peer: SocketAddr,
) -> Result<UdpSession> {
    let socket = Arc::new(
        UdpSocket::bind(if peer.is_ipv6() {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        })
        .await?,
    );
    runtime.metrics.udp_session_opened();
    let recv_socket = Arc::clone(&socket);
    let send_server = Arc::clone(&server);
    let recv_sessions = Arc::clone(&sessions);
    let recv_rule = Arc::clone(&rule);
    let recv_runtime = Arc::clone(&runtime);

    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
        loop {
            match timeout(UDP_SESSION_IDLE_TIMEOUT, recv_socket.recv_from(&mut buf)).await {
                Ok(Ok((len, backend_addr))) => {
                    let mut response = buf[..len].to_vec();
                    if let Ok(parsed) = parse_proxy_chain(&response) {
                        if !parsed.headers.is_empty() {
                            response = response[parsed.payload_offset..].to_vec();
                        }
                    }

                    if recv_rule.rewrite_bedrock_pong_ports {
                        if let Some(rewritten) = rewrite_unconnected_pong_ports(
                            &response,
                            recv_rule.udp.unwrap_or_default(),
                        ) {
                            response = rewritten;
                        }
                    }

                    if is_unconnected_pong(&response) {
                        if let Some(session) = recv_sessions.lock().await.get_mut(&peer) {
                            session.cached_offline_pong = Some(response.clone());
                        }
                    }

                    if let Err(err) = send_server.send_to(&response, peer).await {
                        error!("UDP response send to {peer} failed: {err}");
                        break;
                    }
                    recv_runtime
                        .metrics
                        .udp_target_to_client_bytes(response.len());
                    debug!("UDP {backend_addr} -> {peer} {}B", response.len());
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
                    debug!("UDP session idle timeout {peer}");
                    maybe_notify_disconnect(&recv_runtime, &recv_rule, peer).await;
                    break;
                }
            }
        }

        recv_sessions.lock().await.remove(&peer);
        recv_runtime.metrics.udp_session_closed();
    });

    let session = UdpSession {
        socket,
        active_target_index: 0,
        header_sent: false,
        notified: false,
        cached_offline_pong: None,
    };
    sessions.lock().await.insert(peer, session.clone());
    Ok(session)
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
    let Some(target) = targets
        .get(session.active_target_index)
        .or_else(|| targets.first())
    else {
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
    session: &mut UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
) -> Result<()> {
    let targets = rule.targets_for(Protocol::Udp);
    let force_proxy_header = rule.haproxy && is_offline_ping(payload);
    let mut last_error = None;

    for index in session.active_target_index..targets.len() {
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
                session.active_target_index = index;
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err);
                session.header_sent = false;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("all UDP targets failed")))
}

async fn send_to_target(
    rule: &ListenerRule,
    runtime: &AppRuntime,
    session: &mut UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
    target: &ProxyTarget,
    target_port: u16,
    target_index: usize,
    force_proxy_header: bool,
) -> Result<()> {
    let target_addr = resolve_target_addr(&target.host, target_port).await?;
    let mut out = payload.to_vec();

    if rule.haproxy && (force_proxy_header || !session.header_sent) {
        let header = build_proxy_v2_header(
            original_client.ip(),
            original_client.port(),
            target_addr.ip(),
            target_port,
            true,
        );
        out = [header, out].concat();

        if !is_offline_ping(payload) {
            session.header_sent = true;
        }
    }

    session.socket.send_to(&out, target_addr).await?;
    runtime.metrics.udp_client_to_target_bytes(out.len());
    session.active_target_index = target_index;
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
