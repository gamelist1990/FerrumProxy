#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
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

    Ok(format!(
        "STAT tcp={tcp_count} udp={udp_count} ports={port_count}\n"
    ))
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
                let target_host = target_host.clone();
                let _state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(e) =
                        relay_tcp_connection(client_stream, client_addr, &target_host, target_port)
                            .await
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
                return Ok(());
            }
        }
    }
}

async fn relay_tcp_connection(
    mut client_stream: TcpStream,
    client_addr: SocketAddr,
    target_host: &str,
    target_port: u16,
) -> Result<()> {
    let target = format!("{target_host}:{target_port}");
    let mut target_stream = timeout(Duration::from_secs(10), TcpStream::connect(&target)).await??;

    debug!("Relay connection {} -> {}", client_addr, target);

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
