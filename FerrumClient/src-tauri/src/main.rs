#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{copy, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WindowEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    relay_address: String,
    token: String,
    tcp_enabled: bool,
    udp_enabled: bool,
    #[serde(default = "default_local_host")]
    local_host: String,
    tcp_local_port: u16,
    udp_local_port: u16,
    haproxy: bool,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            relay_address: "127.0.0.1:7000".to_string(),
            token: String::new(),
            tcp_enabled: true,
            udp_enabled: false,
            local_host: default_local_host(),
            tcp_local_port: 25565,
            udp_local_port: 25565,
            haproxy: false,
        }
    }
}

fn default_local_host() -> String {
    "127.0.0.1".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigResponse {
    config: ClientConfig,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicEndpoint {
    protocol: String,
    host: String,
    port: u16,
    display: String,
}

struct FlagOnDrop(Arc<AtomicBool>);

impl Drop for FlagOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ShareSessionStatus {
    Waiting,
    Running,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareSession {
    running: bool,
    status: ShareSessionStatus,
    relay_address: String,
    endpoint: Option<PublicEndpoint>,
    queue_waiting_clients: Option<usize>,
    queue_max_size: Option<usize>,
    error: Option<String>,
}

#[derive(Default)]
struct ClientState {
    session: Mutex<Option<ActiveShareSession>>,
}

struct ActiveShareSession {
    public: Arc<Mutex<ShareSession>>,
    stop: Arc<AtomicBool>,
}

fn config_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn shared_client_runtime() -> &'static str {
    "FerrumProxy shared-service client runtime is available"
}

#[tauri::command]
fn load_client_config() -> Result<ClientConfigResponse, String> {
    let path = config_path()?;
    if !path.exists() {
        let config = ClientConfig::default();
        save_client_config(config.clone())?;
        return Ok(ClientConfigResponse {
            config,
            path: path.display().to_string(),
        });
    }

    let text = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let config = serde_json::from_str(&text).unwrap_or_default();
    Ok(ClientConfigResponse {
        config,
        path: path.display().to_string(),
    })
}

#[tauri::command]
fn save_client_config(config: ClientConfig) -> Result<String, String> {
    let path = config_path()?;
    let text = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(&path, text).map_err(|err| err.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn probe_client_connection(config: ClientConfig) -> Result<(), String> {
    probe_tcp_endpoint(&config.relay_address, Duration::from_secs(2))?;

    Ok(())
}

#[tauri::command]
fn start_sharing(config: ClientConfig, state: State<ClientState>) -> Result<ShareSession, String> {
    if !config.tcp_enabled && !config.udp_enabled {
        return Err("Enable TCP, UDP, or both".to_string());
    }

    let local_port = if config.tcp_enabled {
        config.tcp_local_port
    } else {
        config.udp_local_port
    };
    let local_host = normalized_local_host(&config.local_host);
    let target = if config.token.trim().is_empty() {
        format!("{local_host}:{local_port}")
    } else {
        format!("{}:{local_host}:{local_port}", config.token.trim())
    };
    let stop = Arc::new(AtomicBool::new(false));
    let session = Arc::new(Mutex::new(ShareSession {
        running: false,
        status: ShareSessionStatus::Waiting,
        relay_address: config.relay_address.clone(),
        endpoint: None,
        queue_waiting_clients: None,
        queue_max_size: None,
        error: None,
    }));
    let session_handle = Arc::clone(&session);

    {
        let mut current = state
            .session
            .lock()
            .map_err(|_| "failed to lock client session".to_string())?;
        if let Some(active) = current.as_ref() {
            let status = active
                .public
                .lock()
                .map_err(|_| "failed to lock client session".to_string())?
                .status
                .clone();
            if status == ShareSessionStatus::Waiting || status == ShareSessionStatus::Running {
                return Err("sharing is already in progress".to_string());
            }
        }

        *current = Some(ActiveShareSession {
            public: Arc::clone(&session),
            stop: Arc::clone(&stop),
        });
    }

    let relay_address = config.relay_address.clone();
    let token = config.token.trim().to_string();
    thread::spawn(move || {
        if let Err(error) = run_share_session(
            relay_address,
            token,
            target,
            local_host,
            config.tcp_enabled,
            config.udp_enabled,
            config.tcp_local_port,
            config.udp_local_port,
            stop,
            Arc::clone(&session),
        ) {
            if let Ok(mut guard) = session.lock() {
                guard.running = false;
                guard.status = ShareSessionStatus::Failed;
                guard.error = Some(error);
            }
        }
    });

    session_handle
        .lock()
        .map_err(|_| "failed to lock client session".to_string())
        .map(|guard| guard.clone())
}

fn normalized_local_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        default_local_host()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
fn stop_sharing(state: State<ClientState>) -> Result<(), String> {
    stop_active_sharing(&state)
}

fn stop_active_sharing(state: &ClientState) -> Result<(), String> {
    let mut current = state
        .session
        .lock()
        .map_err(|_| "failed to lock client session".to_string())?;
    if let Some(active) = current.as_ref() {
        active.stop.store(true, Ordering::Relaxed);
        let session = active
            .public
            .lock()
            .map_err(|_| "failed to lock client session".to_string())?
            .clone();
        if let Some(endpoint) = session.endpoint {
            if session.status == ShareSessionStatus::Running {
                let _ = send_relay_command(
                    &session.relay_address,
                    &format!("RELEASE {}\n", endpoint.port),
                );
            }
        }
    }
    *current = None;
    Ok(())
}

#[tauri::command]
fn get_share_session(state: State<ClientState>) -> Result<Option<ShareSession>, String> {
    let current = state
        .session
        .lock()
        .map_err(|_| "failed to lock client session".to_string())?;
    Ok(match current.as_ref() {
        Some(active) => Some(
            active
                .public
                .lock()
                .map_err(|_| "failed to lock client session".to_string())?
                .clone(),
        ),
        None => None,
    })
}

fn run_share_session(
    relay_address: String,
    _token: String,
    target: String,
    local_host: String,
    tcp_enabled: bool,
    udp_enabled: bool,
    tcp_local_port: u16,
    udp_local_port: u16,
    stop: Arc<AtomicBool>,
    session: Arc<Mutex<ShareSession>>,
) -> Result<(), String> {
    let request = format!("CONNECT {target}\n");
    let mut stream = connect_tcp_endpoint(&relay_address, Duration::from_secs(5))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| err.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("failed to write relay command: {err}"))?;
    stream
        .flush()
        .map_err(|err| format!("failed to flush relay command: {err}"))?;

    let response = wait_for_connect_response(&relay_address, &mut stream, &stop, &session)?;
    if stop.load(Ordering::Relaxed) {
        return Err("sharing cancelled".to_string());
    }

    let (host, port) = parse_connect_response(&response)?;
    let protocol = match (tcp_enabled, udp_enabled) {
        (true, true) => "tcp/udp",
        (true, false) => "tcp",
        (false, true) => "udp",
        (false, false) => unreachable!(),
    }
    .to_string();

    let endpoint = PublicEndpoint {
        display: format!("{protocol}: {host}:{port}"),
        protocol,
        host,
        port,
    };

    {
        let mut guard = session
            .lock()
            .map_err(|_| "failed to lock client session".to_string())?;
        guard.running = true;
        guard.status = ShareSessionStatus::Running;
        guard.endpoint = Some(endpoint.clone());
        guard.error = None;
    }

    if tcp_enabled {
        start_tcp_tunnel_pool(
            relay_address.clone(),
            port,
            local_host.clone(),
            tcp_local_port,
            stop.clone(),
        );
    }
    if udp_enabled {
        start_udp_tunnel(relay_address, port, local_host, udp_local_port, stop);
    }

    Ok(())
}

fn wait_for_connect_response(
    relay_address: &str,
    stream: &mut TcpStream,
    stop: &Arc<AtomicBool>,
    session: &Arc<Mutex<ShareSession>>,
) -> Result<String, String> {
    let mut response = Vec::new();
    let mut buffer = [0u8; 1024];

    loop {
        if stop.load(Ordering::Relaxed) {
            return Err("sharing cancelled".to_string());
        }

        match stream.read(&mut buffer) {
            Ok(0) => {
                if response.is_empty() {
                    return Err("relay closed the connection before responding".to_string());
                }
                break;
            }
            Ok(bytes_read) => {
                response.extend_from_slice(&buffer[..bytes_read]);
                if response.contains(&b'\n') {
                    break;
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::TimedOut
                    || error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                if let Some((waiting_clients, queue_max_size)) = poll_queue_status(relay_address) {
                    if let Ok(mut guard) = session.lock() {
                        guard.queue_waiting_clients = Some(waiting_clients);
                        guard.queue_max_size = Some(queue_max_size);
                    }
                }
            }
            Err(error) => return Err(format!("failed to read relay response: {error}")),
        }
    }

    String::from_utf8(response)
        .map(|value| value.trim().to_string())
        .map_err(|error| error.to_string())
}

fn poll_queue_status(relay_address: &str) -> Option<(usize, usize)> {
    let response = send_relay_command(relay_address, "STATS\n").ok()?;
    parse_queue_status(&response)
}

fn parse_queue_status(response: &str) -> Option<(usize, usize)> {
    let mut waiting_clients = None;
    let mut queue_max_size = None;

    for part in response.split_whitespace() {
        if let Some(value) = part.strip_prefix("waiting=") {
            waiting_clients = value.parse::<usize>().ok();
        } else if let Some(value) = part.strip_prefix("queue_max=") {
            queue_max_size = value.parse::<usize>().ok();
        }
    }

    match (waiting_clients, queue_max_size) {
        (Some(waiting_clients), Some(queue_max_size)) => Some((waiting_clients, queue_max_size)),
        _ => None,
    }
}

fn start_udp_tunnel(
    relay_address: String,
    public_port: u16,
    local_host: String,
    local_port: u16,
    stop: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match run_udp_tunnel(&relay_address, public_port, &local_host, local_port, &stop) {
                Ok(()) => {}
                Err(_) => thread::sleep(Duration::from_millis(500)),
            }
        }
    });
}

fn run_udp_tunnel(
    relay_address: &str,
    public_port: u16,
    local_host: &str,
    local_port: u16,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut tunnel = connect_tcp_endpoint(relay_address, Duration::from_secs(5))?;
    tunnel
        .write_all(format!("UDP_TUNNEL {public_port}\n").as_bytes())
        .map_err(|err| format!("failed to register UDP tunnel: {err}"))?;

    let mut ready = [0u8; 6];
    tunnel
        .read_exact(&mut ready)
        .map_err(|err| format!("failed to wait for UDP tunnel readiness: {err}"))?;
    if &ready != b"READY\n" {
        return Err("relay rejected UDP tunnel readiness".to_string());
    }

    let local_target = format!("{local_host}:{local_port}");
    let local_target_addr = resolve_single_addr(&local_target)?;
    let tunnel_alive = Arc::new(AtomicBool::new(true));
    let _tunnel_alive_guard = FlagOnDrop(Arc::clone(&tunnel_alive));
    let tunnel_writer =
        Arc::new(Mutex::new(tunnel.try_clone().map_err(|err| {
            format!("failed to clone UDP tunnel writer: {err}")
        })?));
    let mut peers = HashMap::<SocketAddr, Arc<UdpSocket>>::new();

    eprintln!("[UDP] Tunnel started: forwarding to {}", local_target);

    while !stop.load(Ordering::Relaxed) {
        let (remote_addr, payload) = match read_udp_frame_blocking(&mut tunnel) {
            Ok(frame) => frame,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(err) => return Err(format!("UDP tunnel read failed: {err}")),
        };

        eprintln!(
            "[UDP] Received from relay: {} bytes from {}",
            payload.len(),
            remote_addr
        );
        let local = match peers.get(&remote_addr) {
            Some(local) => Arc::clone(local),
            None => {
                let local = Arc::new(UdpSocket::bind("0.0.0.0:0").map_err(|err| err.to_string())?);
                local
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .map_err(|err| err.to_string())?;
                let local_addr = local.local_addr().map_err(|err| err.to_string())?;
                eprintln!(
                    "[UDP] Peer started: {} via local {} -> {}",
                    remote_addr, local_addr, local_target
                );

                let local_reader = Arc::clone(&local);
                let tunnel_writer = Arc::clone(&tunnel_writer);
                let local_target_addr = local_target_addr;
                let tunnel_alive = Arc::clone(&tunnel_alive);
                let stop = Arc::clone(stop);
                thread::spawn(move || {
                    let mut response = vec![0u8; 65_507];
                    while !stop.load(Ordering::Relaxed) && tunnel_alive.load(Ordering::Relaxed) {
                        match local_reader.recv_from(&mut response) {
                            Ok((len, from)) => {
                                eprintln!("[UDP] Received from local: {} bytes from {}", len, from);
                                if from != local_target_addr {
                                    eprintln!(
                                        "[UDP] Ignored local UDP response from unexpected source: {}",
                                        from
                                    );
                                    continue;
                                }

                                let write_result = tunnel_writer
                                    .lock()
                                    .map_err(|err| err.to_string())
                                    .and_then(|mut tunnel| {
                                        write_udp_frame_blocking(
                                            &mut tunnel,
                                            remote_addr,
                                            &response[..len],
                                        )
                                    });
                                match write_result {
                                    Ok(()) => eprintln!(
                                        "[UDP] Forwarded response to relay: {} bytes for {}",
                                        len, remote_addr
                                    ),
                                    Err(err) => {
                                        eprintln!(
                                            "[UDP] Failed to forward local response: {}",
                                            err
                                        );
                                        break;
                                    }
                                }
                            }
                            Err(err)
                                if err.kind() == std::io::ErrorKind::WouldBlock
                                    || err.kind() == std::io::ErrorKind::TimedOut =>
                            {
                                continue;
                            }
                            Err(err) => {
                                eprintln!("[UDP] Failed to read from local service: {}", err);
                                break;
                            }
                        }
                    }
                });

                peers.insert(remote_addr, Arc::clone(&local));
                local
            }
        };

        match local.send_to(&payload, local_target_addr) {
            Ok(sent) => eprintln!("[UDP] Sent to local service: {} bytes", sent),
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(err) => {
                eprintln!("[UDP] Failed to send to local service: {}", err);
                return Err(format!("failed to send UDP to local service: {err}"));
            }
        }
    }

    Ok(())
}

fn write_udp_frame_blocking(
    stream: &mut TcpStream,
    remote_addr: SocketAddr,
    payload: &[u8],
) -> Result<(), String> {
    let remote = remote_addr.to_string();
    let remote_bytes = remote.as_bytes();
    stream
        .write_all(&(remote_bytes.len() as u16).to_be_bytes())
        .map_err(|err| err.to_string())?;
    stream
        .write_all(remote_bytes)
        .map_err(|err| err.to_string())?;
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|err| err.to_string())?;
    stream.write_all(payload).map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())
}

fn read_udp_frame_blocking(stream: &mut TcpStream) -> std::io::Result<(SocketAddr, Vec<u8>)> {
    let mut addr_len = [0u8; 2];
    stream.read_exact(&mut addr_len)?;
    let addr_len = u16::from_be_bytes(addr_len) as usize;
    let mut addr_bytes = vec![0u8; addr_len];
    stream.read_exact(&mut addr_bytes)?;
    let addr_text = String::from_utf8(addr_bytes).map_err(std::io::Error::other)?;
    let remote_addr = addr_text
        .parse::<SocketAddr>()
        .map_err(std::io::Error::other)?;
    let mut payload_len = [0u8; 4];
    stream.read_exact(&mut payload_len)?;
    let payload_len = u32::from_be_bytes(payload_len) as usize;
    let mut payload = vec![0u8; payload_len];
    stream.read_exact(&mut payload)?;
    Ok((remote_addr, payload))
}

fn start_tcp_tunnel_pool(
    relay_address: String,
    public_port: u16,
    local_host: String,
    local_port: u16,
    stop: Arc<AtomicBool>,
) {
    for _ in 0..8 {
        let relay_address = relay_address.clone();
        let local_host = local_host.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match open_tcp_tunnel(&relay_address, public_port, &local_host, local_port, &stop) {
                    Ok(()) => {}
                    Err(_) => thread::sleep(Duration::from_millis(250)),
                }
            }
        });
    }
}

fn open_tcp_tunnel(
    relay_address: &str,
    public_port: u16,
    local_host: &str,
    local_port: u16,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut tunnel = connect_tcp_endpoint(relay_address, Duration::from_secs(5))?;
    tunnel
        .write_all(format!("TUNNEL {public_port}\n").as_bytes())
        .map_err(|err| format!("failed to register tunnel: {err}"))?;

    let mut start = [0u8; 6];
    tunnel
        .read_exact(&mut start)
        .map_err(|err| format!("failed to wait for tunnel start: {err}"))?;
    if &start != b"START\n" {
        return Err("relay rejected tunnel start".to_string());
    }

    let local_addr = format!("{local_host}:{local_port}");
    let local = connect_tcp_endpoint(&local_addr, Duration::from_secs(5))?;
    pipe_bidirectional(tunnel, local, stop)
}

fn pipe_bidirectional(
    mut left: TcpStream,
    mut right: TcpStream,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    let mut left_read = left.try_clone().map_err(|err| err.to_string())?;
    let mut right_write = right.try_clone().map_err(|err| err.to_string())?;
    let stop_copy = stop.clone();
    let forward = thread::spawn(move || {
        let _ = copy(&mut left_read, &mut right_write);
        let _ = right_write.shutdown(Shutdown::Write);
        stop_copy.load(Ordering::Relaxed)
    });

    let _ = copy(&mut right, &mut left);
    let _ = left.shutdown(Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

fn send_relay_command(address: &str, command: &str) -> Result<String, String> {
    let endpoint = address.trim();
    if endpoint.is_empty() {
        return Err("relay address is required".to_string());
    }

    let mut last_error = None;
    let resolved = endpoint
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve {endpoint}: {err}"))?;

    for socket_address in resolved {
        match TcpStream::connect_timeout(&socket_address, Duration::from_secs(3)) {
            Ok(mut stream) => {
                apply_tcp_nodelay(&stream);
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .map_err(|err| err.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .map_err(|err| err.to_string())?;
                stream
                    .write_all(command.as_bytes())
                    .map_err(|err| format!("failed to write relay command: {err}"))?;

                let mut response = String::new();
                stream
                    .read_to_string(&mut response)
                    .map_err(|err| format!("failed to read relay response: {err}"))?;
                return Ok(response);
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    match last_error {
        Some(err) => Err(format!("{endpoint} did not respond: {err}")),
        None => Err(format!("no socket addresses resolved for {endpoint}")),
    }
}

fn resolve_single_addr(address: &str) -> Result<SocketAddr, String> {
    let endpoint = address.trim();
    if endpoint.is_empty() {
        return Err("address is required".to_string());
    }

    endpoint
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve {endpoint}: {err}"))?
        .next()
        .ok_or_else(|| format!("no socket addresses resolved for {endpoint}"))
}

fn connect_tcp_endpoint(address: &str, timeout: Duration) -> Result<TcpStream, String> {
    let endpoint = address.trim();
    if endpoint.is_empty() {
        return Err("address is required".to_string());
    }

    let mut last_error = None;
    let resolved = endpoint
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve {endpoint}: {err}"))?;

    for socket_address in resolved {
        match TcpStream::connect_timeout(&socket_address, timeout) {
            Ok(stream) => {
                apply_tcp_nodelay(&stream);
                return Ok(stream);
            }
            Err(err) => last_error = Some(err),
        }
    }

    match last_error {
        Some(err) => Err(format!("{endpoint} did not respond: {err}")),
        None => Err(format!("no socket addresses resolved for {endpoint}")),
    }
}

fn parse_connect_response(response: &str) -> Result<(String, u16), String> {
    let trimmed = response.trim();
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 3 || parts[0] != "OK" {
        return Err(if trimmed.is_empty() {
            "relay returned an empty response".to_string()
        } else {
            trimmed.to_string()
        });
    }

    let fallback_port = parts[1]
        .parse::<u16>()
        .map_err(|_| format!("relay returned invalid port: {}", parts[1]))?;
    let endpoint = parts[2];
    let (host, port_text) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| format!("relay returned invalid endpoint: {endpoint}"))?;
    let port = port_text.parse::<u16>().unwrap_or(fallback_port);
    Ok((host.to_string(), port))
}

fn probe_tcp_endpoint(address: &str, timeout: Duration) -> Result<(), String> {
    let endpoint = address.trim();
    if endpoint.is_empty() {
        return Err("relay address is required".to_string());
    }

    let mut last_error = None;
    let resolved = endpoint
        .to_socket_addrs()
        .map_err(|err| format!("failed to resolve {endpoint}: {err}"))?;

    for socket_address in resolved {
        match TcpStream::connect_timeout(&socket_address, timeout) {
            Ok(stream) => {
                apply_tcp_nodelay(&stream);
                let _ = stream.shutdown(Shutdown::Both);
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    match last_error {
        Some(err) => Err(format!("{endpoint} did not respond: {err}")),
        None => Err(format!("no socket addresses resolved for {endpoint}")),
    }
}

fn apply_tcp_nodelay(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
}

fn main() {
    tauri::Builder::default()
        .manage(ClientState::default())
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let state = window.state::<ClientState>();
                let _ = stop_active_sharing(&state);
            }
        })
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            shared_client_runtime,
            load_client_config,
            save_client_config,
            probe_client_connection,
            start_sharing,
            stop_sharing,
            get_share_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running FerrumProxy client");
}
