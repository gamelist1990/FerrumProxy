#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tracing::{debug, error, info, warn};

use crate::config::SharedServiceConfig;
use crate::runtime::AppRuntime;

const BUFFER_SIZE: usize = 16 * 1024;
const RELAY_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub struct SharedRelayState {
    pub config: SharedServiceConfig,
    pub tcp_connections: Arc<RwLock<HashMap<String, TcpConnection>>>,
    pub udp_peers: Arc<RwLock<HashMap<String, UdpPeer>>>,
    pub port_allocations: Arc<RwLock<HashMap<u16, PortAllocation>>>,
    pub tcp_tunnels: Arc<Mutex<HashMap<u16, VecDeque<TcpStream>>>>,
    pub udp_tunnels: Arc<Mutex<HashMap<u16, mpsc::Sender<UdpRelayPacket>>>>,
    pub udp_sockets: Arc<Mutex<HashMap<u16, Arc<UdpSocket>>>>,
    pub next_port: Arc<RwLock<u16>>,
}

#[derive(Debug, Clone)]
pub struct TcpConnection {
    pub token: Option<String>,
    pub client_addr: SocketAddr,
    pub target_host: String,
    pub target_port: u16,
    pub connected_at: u64,
}

#[derive(Debug, Clone)]
pub struct UdpPeer {
    pub token: Option<String>,
    pub client_addr: SocketAddr,
    pub target_host: String,
    pub target_port: u16,
    pub expires_at: u64,
}

#[derive(Debug, Clone)]
pub struct PortAllocation {
    pub port: u16,
    pub token: Option<String>,
    pub client_addr: SocketAddr,
}

#[derive(Debug, Clone)]
pub struct UdpRelayPacket {
    pub remote_addr: SocketAddr,
    pub payload: Vec<u8>,
}

pub async fn start_shared_relay(
    config: SharedServiceConfig,
    runtime: Arc<AppRuntime>,
) -> Result<()> {
    let bind_addr = &config.control_bind;
    let listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("failed to bind shared relay on {bind_addr}"))?;

    info!("Shared relay listening on {}", bind_addr);

    let state = Arc::new(SharedRelayState {
        config: config.clone(),
        tcp_connections: Arc::new(RwLock::new(HashMap::new())),
        udp_peers: Arc::new(RwLock::new(HashMap::new())),
        port_allocations: Arc::new(RwLock::new(HashMap::new())),
        tcp_tunnels: Arc::new(Mutex::new(HashMap::new())),
        udp_tunnels: Arc::new(Mutex::new(HashMap::new())),
        udp_sockets: Arc::new(Mutex::new(HashMap::new())),
        next_port: Arc::new(RwLock::new(config.port_range.start)),
    });

    loop {
        match listener.accept().await {
            Ok((stream, client_addr)) => {
                let state = Arc::clone(&state);
                let config = config.clone();
                let runtime = Arc::clone(&runtime);
                tokio::spawn(async move {
                    if let Err(e) =
                        handle_control_connection(stream, client_addr, state, config, runtime).await
                    {
                        debug!("Control connection error from {}: {}", client_addr, e);
                    }
                });
            }
            Err(e) => {
                error!("Failed to accept connection: {}", e);
            }
        }
    }
}

async fn handle_control_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    state: Arc<SharedRelayState>,
    config: SharedServiceConfig,
    _runtime: Arc<AppRuntime>,
) -> Result<()> {
    let mut buf = [0u8; 4096];
    let n = timeout(Duration::from_secs(5), stream.read(&mut buf)).await??;

    if n == 0 {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buf[..n]);
    let request = request.trim();

    if request.starts_with("TUNNEL ") {
        handle_tcp_tunnel(request, stream, &state).await?;
        return Ok(());
    }
    if request.starts_with("UDP_TUNNEL ") {
        handle_udp_tunnel(request, stream, &state).await?;
        return Ok(());
    }

    let response = if request.starts_with("CONNECT ") {
        handle_connect(request, client_addr, &state, &config).await
    } else if request.starts_with("UDP ") {
        handle_udp_associate(request, &state, &config).await
    } else if request.starts_with("TOKEN ") {
        handle_token_validation(request, &state, &config).await
    } else if request == "STATS" {
        handle_stats(&state).await
    } else if request == "LIST" {
        handle_list_allocations(&state).await
    } else if request.starts_with("RELEASE ") {
        handle_release(request, &state, &config).await
    } else {
        Ok("ERROR Unknown command\n".to_string())
    };

    let response = response?;
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

async fn handle_connect(
    request: &str,
    client_addr: SocketAddr,
    state: &Arc<SharedRelayState>,
    config: &SharedServiceConfig,
) -> Result<String> {
    // Format: CONNECT <target_spec>
    // target_spec can be:
    //   token:host:port   (authenticated)
    //   host:port         (anonymous, if allowed)
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok("ERROR Usage: CONNECT <token:host:port> or CONNECT <host:port>\n".to_string());
    }

    let target = parts[1];
    let target_parts: Vec<&str> = target.splitn(3, ':').collect();

    let (token, target_host, target_port) = if target_parts.len() == 3 {
        // token:host:port
        let port: u16 = target_parts[2].parse().unwrap_or(0);
        (
            Some(target_parts[0].to_string()),
            target_parts[1].to_string(),
            port,
        )
    } else if target_parts.len() == 2 {
        // host:port (anonymous)
        if !config.allow_anonymous {
            return Ok("ERROR Token required\n".to_string());
        }
        let port: u16 = target_parts[1].parse().unwrap_or(0);
        (None, target_parts[0].to_string(), port)
    } else {
        return Ok("ERROR Invalid format. Use token:host:port or host:port\n".to_string());
    };

    if target_port == 0 {
        return Ok("ERROR Invalid port\n".to_string());
    }

    // Validate token if provided
    if let Some(ref token_value) = token {
        if !token_value.is_empty() {
            let valid = config
                .tokens
                .iter()
                .any(|t| t.enabled && t.token == *token_value)
                || config.auth_tokens.iter().any(|t| t == token_value);
            if !valid && !config.allow_anonymous {
                return Ok("ERROR Invalid token\n".to_string());
            }
        }
    }

    // Allocate a port
    let port_range_start = config.port_range.start;
    let port_range_end = config.port_range.end;
    let port_range_size = (port_range_end - port_range_start + 1) as usize;

    let mut port_allocations = state.port_allocations.write().await;
    let current_next = *state.next_port.read().await;
    let mut allocated_port: Option<u16> = None;

    for i in 0..port_range_size {
        let candidate = port_range_start
            + ((current_next - port_range_start + i as u16) % port_range_size as u16);
        if !port_allocations.contains_key(&candidate) {
            allocated_port = Some(candidate);
            break;
        }
    }

    let port = match allocated_port {
        Some(p) => p,
        None => return Ok("ERROR No available ports\n".to_string()),
    };

    port_allocations.insert(
        port,
        PortAllocation {
            port,
            token: token.clone(),
            client_addr,
        },
    );

    drop(port_allocations);

    // Advance next_port with proper wraparound
    let new_next = if port >= port_range_end {
        port_range_start
    } else {
        port + 1
    };
    *state.next_port.write().await = new_next;

    let _bind_addr = format!("{}:{}", config.public_bind, port);
    let public_addr = format!("{}:{}", config.public_host, port);

    info!(
        "Allocated relay port {} for {} -> {}:{} (client: {})",
        port,
        token.as_deref().unwrap_or("anonymous"),
        target_host,
        target_port,
        client_addr
    );

    // Actually start the relay listener on the allocated port
    let relay_state = Arc::clone(state);
    let relay_config = Arc::new(config.clone());
    let relay_target_host = target_host.clone();
    let relay_token = token.clone();
    tokio::spawn(async move {
        let udp_state = Arc::clone(&relay_state);
        let udp_config = Arc::clone(&relay_config);
        tokio::spawn(async move {
            if let Err(e) = start_udp_relay_port(port, udp_config, udp_state).await {
                warn!("UDP relay port {} stopped: {}", port, e);
            }
        });

        if let Err(e) = start_relay_port(
            port,
            relay_target_host,
            target_port,
            relay_token,
            relay_config,
            relay_state,
        )
        .await
        {
            warn!("Relay port {} stopped: {}", port, e);
        }
    });

    Ok(format!("OK {port} {public_addr}\n"))
}

async fn handle_udp_associate(
    _request: &str,
    _state: &Arc<SharedRelayState>,
    _config: &SharedServiceConfig,
) -> Result<String> {
    Ok("OK UDP associated\n".to_string())
}

async fn handle_token_validation(
    request: &str,
    _state: &Arc<SharedRelayState>,
    config: &SharedServiceConfig,
) -> Result<String> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok("ERROR Usage: TOKEN <token>\n".to_string());
    }

    let token = parts[1];

    let valid = config.tokens.iter().any(|t| t.enabled && t.token == token)
        || config.auth_tokens.iter().any(|t| t == token);

    if valid {
        Ok("OK Token valid\n".to_string())
    } else if config.allow_anonymous {
        Ok("OK Anonymous allowed\n".to_string())
    } else {
        Ok("ERROR Invalid token\n".to_string())
    }
}

async fn handle_stats(state: &Arc<SharedRelayState>) -> Result<String> {
    let tcp_count = state.tcp_connections.read().await.len();
    let udp_count = state.udp_peers.read().await.len();
    let port_count = state.port_allocations.read().await.len();
    let tunnel_count = state
        .tcp_tunnels
        .lock()
        .await
        .values()
        .map(VecDeque::len)
        .sum::<usize>();

    Ok(format!(
        "STAT tcp={tcp_count} udp={udp_count} ports={port_count} tunnels={tunnel_count}\n"
    ))
}

async fn handle_tcp_tunnel(
    request: &str,
    stream: TcpStream,
    state: &Arc<SharedRelayState>,
) -> Result<()> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() != 2 {
        return Ok(());
    }

    let port = match parts[1].parse::<u16>() {
        Ok(port) => port,
        Err(_) => return Ok(()),
    };

    if !state.port_allocations.read().await.contains_key(&port) {
        return Ok(());
    }

    state
        .tcp_tunnels
        .lock()
        .await
        .entry(port)
        .or_default()
        .push_back(stream);
    debug!("Queued client tunnel for relay port {}", port);
    Ok(())
}

async fn handle_udp_tunnel(
    request: &str,
    stream: TcpStream,
    state: &Arc<SharedRelayState>,
) -> Result<()> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() != 2 {
        return Ok(());
    }

    let port = match parts[1].parse::<u16>() {
        Ok(port) => port,
        Err(_) => return Ok(()),
    };

    if !state.port_allocations.read().await.contains_key(&port) {
        return Ok(());
    }

    let Some(socket) = state.udp_sockets.lock().await.get(&port).cloned() else {
        return Ok(());
    };

    let (tx, mut rx) = mpsc::channel::<UdpRelayPacket>(512);
    state.udp_tunnels.lock().await.insert(port, tx);

    let (mut reader, mut writer) = stream.into_split();
    let write_task = tokio::spawn(async move {
        while let Some(packet) = rx.recv().await {
            if write_udp_frame(&mut writer, packet.remote_addr, &packet.payload)
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let read_task = tokio::spawn(async move {
        while let Ok((remote_addr, payload)) = read_udp_frame(&mut reader).await {
            let _ = socket.send_to(&payload, remote_addr).await;
        }
    });

    let _ = tokio::join!(write_task, read_task);
    state.udp_tunnels.lock().await.remove(&port);
    Ok(())
}

async fn write_udp_frame<W>(writer: &mut W, remote_addr: SocketAddr, payload: &[u8]) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let remote = remote_addr.to_string();
    let remote_bytes = remote.as_bytes();
    writer.write_u16(remote_bytes.len() as u16).await?;
    writer.write_all(remote_bytes).await?;
    writer.write_u32(payload.len() as u32).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_udp_frame<R>(reader: &mut R) -> Result<(SocketAddr, Vec<u8>)>
where
    R: AsyncReadExt + Unpin,
{
    let addr_len = reader.read_u16().await? as usize;
    let mut addr_bytes = vec![0u8; addr_len];
    reader.read_exact(&mut addr_bytes).await?;
    let addr_text = String::from_utf8(addr_bytes)?;
    let remote_addr = addr_text.parse::<SocketAddr>()?;
    let payload_len = reader.read_u32().await? as usize;
    let mut payload = vec![0u8; payload_len];
    reader.read_exact(&mut payload).await?;
    Ok((remote_addr, payload))
}

async fn handle_list_allocations(state: &Arc<SharedRelayState>) -> Result<String> {
    let allocations = state.port_allocations.read().await;
    if allocations.is_empty() {
        return Ok("LIST empty\n".to_string());
    }

    let mut lines = Vec::new();
    for (port, alloc) in allocations.iter() {
        lines.push(format!(
            "  port={} token={} client={}",
            port,
            alloc.token.as_deref().unwrap_or("anonymous"),
            alloc.client_addr
        ));
    }

    Ok(format!(
        "LIST {}\n{}\n",
        allocations.len(),
        lines.join("\n")
    ))
}

async fn handle_release(
    request: &str,
    state: &Arc<SharedRelayState>,
    config: &SharedServiceConfig,
) -> Result<String> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() != 2 {
        return Ok("ERROR Usage: RELEASE <port>\n".to_string());
    }

    let port = match parts[1].parse::<u16>() {
        Ok(port) => port,
        Err(_) => return Ok("ERROR Invalid port\n".to_string()),
    };

    let removed = state.port_allocations.write().await.remove(&port).is_some();
    if removed {
        let wake_addr = format!("127.0.0.1:{port}");
        tokio::spawn(async move {
            let _ = TcpStream::connect(wake_addr).await;
        });
        tokio::spawn(async move {
            if let Ok(socket) = UdpSocket::bind("127.0.0.1:0").await {
                let _ = socket.send_to(&[], format!("127.0.0.1:{port}")).await;
            }
        });
        state.tcp_tunnels.lock().await.remove(&port);
        state.udp_tunnels.lock().await.remove(&port);
        state.udp_sockets.lock().await.remove(&port);
        info!("Released relay port {} by client request", port);
        Ok("OK Released\n".to_string())
    } else if port >= config.port_range.start && port <= config.port_range.end {
        Ok("OK Not allocated\n".to_string())
    } else {
        Ok("ERROR Port outside shared relay range\n".to_string())
    }
}

pub async fn start_relay_port(
    port: u16,
    target_host: String,
    target_port: u16,
    token: Option<String>,
    _config: Arc<SharedServiceConfig>,
    state: Arc<SharedRelayState>,
) -> Result<()> {
    let bind_addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&bind_addr).await?;

    info!(
        "Relay port {} listening for {} -> {}:{}",
        port,
        token.as_deref().unwrap_or("anonymous"),
        target_host,
        target_port
    );

    loop {
        match timeout(RELAY_IDLE_TIMEOUT, listener.accept()).await {
            Ok(Ok((client_stream, client_addr))) => {
                if !state.port_allocations.read().await.contains_key(&port) {
                    info!("Relay port {} released, stopping listener", port);
                    return Ok(());
                }

                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(e) =
                        relay_tcp_connection(client_stream, client_addr, port, state).await
                    {
                        debug!("Relay error on port {}: {}", port, e);
                    }
                });
            }
            Ok(Err(e)) => {
                error!("Failed to accept on relay port {port}: {e}");
            }
            Err(_) => {
                // Idle timeout — no connections for a while, clean up
                info!("Relay port {} idle timeout, releasing", port);
                state.port_allocations.write().await.remove(&port);
                state.tcp_tunnels.lock().await.remove(&port);
                state.udp_tunnels.lock().await.remove(&port);
                state.udp_sockets.lock().await.remove(&port);
                return Ok(());
            }
        }
    }
}

async fn start_udp_relay_port(
    port: u16,
    _config: Arc<SharedServiceConfig>,
    state: Arc<SharedRelayState>,
) -> Result<()> {
    let bind_addr = format!("0.0.0.0:{port}");
    let socket = Arc::new(UdpSocket::bind(&bind_addr).await?);
    state.udp_sockets.lock().await.insert(port, socket.clone());
    info!("UDP relay port {} listening", port);

    let mut buf = vec![0u8; 65_507];
    loop {
        let (len, remote_addr) = socket.recv_from(&mut buf).await?;
        if !state.port_allocations.read().await.contains_key(&port) {
            state.udp_sockets.lock().await.remove(&port);
            return Ok(());
        }

        let tunnel = state.udp_tunnels.lock().await.get(&port).cloned();
        if let Some(tunnel) = tunnel {
            let _ = tunnel
                .send(UdpRelayPacket {
                    remote_addr,
                    payload: buf[..len].to_vec(),
                })
                .await;
        } else {
            debug!(
                "Dropped UDP datagram on {} because no client tunnel is ready",
                port
            );
        }
    }
}

async fn relay_tcp_connection(
    mut client_stream: TcpStream,
    client_addr: SocketAddr,
    port: u16,
    state: Arc<SharedRelayState>,
) -> Result<()> {
    let mut target_stream = wait_for_client_tunnel(port, state).await?;
    target_stream.write_all(b"START\n").await?;

    debug!(
        "Relay connection {} -> client tunnel on {}",
        client_addr, port
    );

    let (mut client_read, mut client_write) = client_stream.split();
    let (mut target_read, mut target_write) = target_stream.split();

    let client_to_target = async {
        let mut buf = vec![0u8; BUFFER_SIZE];
        loop {
            let n = client_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            target_write.write_all(&buf[..n]).await?;
        }
        target_write.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };

    let target_to_client = async {
        let mut buf = vec![0u8; BUFFER_SIZE];
        loop {
            let n = target_read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            client_write.write_all(&buf[..n]).await?;
        }
        client_write.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };

    tokio::select! {
        result = client_to_target => {
            if let Err(e) = result {
                debug!("Relay client->target error: {}", e);
            }
        }
        result = target_to_client => {
            if let Err(e) = result {
                debug!("Relay target->client error: {}", e);
            }
        }
    }

    Ok(())
}

async fn wait_for_client_tunnel(port: u16, state: Arc<SharedRelayState>) -> Result<TcpStream> {
    let started = tokio::time::Instant::now();
    loop {
        if let Some(stream) = state
            .tcp_tunnels
            .lock()
            .await
            .get_mut(&port)
            .and_then(VecDeque::pop_front)
        {
            return Ok(stream);
        }

        if started.elapsed() >= Duration::from_secs(15) {
            anyhow::bail!("no client tunnel available for relay port {port}");
        }

        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
