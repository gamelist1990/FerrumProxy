#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};
use tracing::{debug, error, info};

use crate::config::SharedServiceConfig;
use crate::runtime::AppRuntime;

const BUFFER_SIZE: usize = 16 * 1024;

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
        .with_context(|| format!("failed to bind shared relay on {}", bind_addr))?;

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
                    if let Err(e) = handle_control_connection(stream, client_addr, state, config, runtime).await {
                        debug!("Control connection error: {}", e);
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
    _client_addr: SocketAddr,
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
        handle_connect(request, &state, &config).await
    } else if request.starts_with("UDP ") {
        handle_udp_associate(request, &state, &config).await
    } else if request.starts_with("TOKEN ") {
        handle_token_validation(request, &state, &config).await
    } else if request == "STATS" {
        handle_stats(&state).await
    } else {
        Ok(format!("ERROR Unknown command\n"))
    };

    let response = response?;
    stream.write_all(response.as_bytes()).await?;
    Ok(())
}

async fn handle_connect(request: &str, state: &Arc<SharedRelayState>, config: &SharedServiceConfig) -> Result<String> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() < 3 {
        return Ok("ERROR Usage: CONNECT <token>:<target_host>:<target_port>\n".to_string());
    }

    let target = parts[1];
    let target_parts: Vec<&str> = target.split(':').collect();
    
    let (token, target_host, target_port) = if target_parts.len() == 3 {
        (Some(target_parts[0].to_string()), target_parts[1].to_string(), target_parts[2].parse().unwrap_or(0))
    } else if config.allow_anonymous {
        (None, target_parts[0].to_string(), target_parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0))
    } else {
        return Ok("ERROR Token required\n".to_string());
    };

    if target_port == 0 {
        return Ok("ERROR Invalid port\n".to_string());
    }

    let mut port_allocations = state.port_allocations.write().await;
    let next_port = *state.next_port.read().await;
    let mut port = next_port;
    let max_port = config.port_range.end;
    
    for _ in 0..(max_port - next_port + 1) {
        if !port_allocations.contains_key(&port) {
            break;
        }
        port = if port >= max_port { config.port_range.start } else { port + 1 };
    }

    if port > max_port {
        return Ok("ERROR No available ports\n".to_string());
    }

    port_allocations.insert(port, PortAllocation {
        port,
        token: token.clone(),
        client_addr: SocketAddr::new(std::net::IpAddr::from([0, 0, 0, 0]), 0),
    });

    drop(port_allocations);

    let new_next_port = if port >= max_port { config.port_range.start } else { port + 1 };
    *state.next_port.write().await = new_next_port;

    let bind_addr = format!("{}:{}", config.public_bind, port);
    
    info!("Allocated relay port {} for {} -> {}:{}", port, token.as_deref().unwrap_or("anonymous"), target_host, target_port);

    Ok(format!("OK {} {}\n", port, bind_addr))
}

async fn handle_udp_associate(_request: &str, _state: &Arc<SharedRelayState>, _config: &SharedServiceConfig) -> Result<String> {
    Ok("OK UDP associated\n".to_string())
}

async fn handle_token_validation(request: &str, _state: &Arc<SharedRelayState>, config: &SharedServiceConfig) -> Result<String> {
    let parts: Vec<&str> = request.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok("ERROR Usage: TOKEN <token>\n".to_string());
    }

    let token = parts[1];

    let valid = config.tokens.iter().any(|t| t.enabled && t.token == token);
    
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
        "STAT tcp={} udp={} ports={}\n",
        tcp_count, udp_count, port_count
    ))
}

pub async fn start_relay_port(
    port: u16,
    target_host: String,
    target_port: u16,
    token: Option<String>,
    _config: Arc<SharedServiceConfig>,
) -> Result<()> {
    let bind_addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&bind_addr).await?;

    info!("Relay port {} listening for {} -> {}:{}", port, token.as_deref().unwrap_or("anonymous"), target_host, target_port);

    loop {
        match listener.accept().await {
            Ok((client_stream, client_addr)) => {
                let target_host = target_host.clone();
                let target_port = target_port;
                tokio::spawn(async move {
                    if let Err(e) = relay_tcp_connection(client_stream, client_addr, &target_host, target_port).await {
                        debug!("Relay error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("Failed to accept on relay port {}: {}", port, e);
            }
        }
    }
}

#[allow(dead_code)]
async fn relay_tcp_connection(
    mut client_stream: TcpStream,
    _client_addr: SocketAddr,
    target_host: &str,
    target_port: u16,
) -> Result<()> {
    let target = format!("{}:{}", target_host, target_port);
    let mut target_stream = timeout(
        Duration::from_secs(10),
        TcpStream::connect(&target)
    ).await??;

    let mut client_buf = vec![0u8; BUFFER_SIZE];
    let mut target_buf = vec![0u8; BUFFER_SIZE];

    loop {
        tokio::select! {
            result = client_stream.read(&mut client_buf) => {
                let n = result?;
                if n == 0 { break; }
                target_stream.write_all(&client_buf[..n]).await?;
            }
            result = target_stream.read(&mut target_buf) => {
                let n = result?;
                if n == 0 { break; }
                client_stream.write_all(&target_buf[..n]).await?;
            }
        }
    }

    Ok(())
}