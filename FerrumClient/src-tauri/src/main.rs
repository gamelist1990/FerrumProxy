#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
    relay_ping_ms: Option<u64>,
    tcp_tunnels: usize,
    udp_tunnel: bool,
    bytes_in: u64,
    bytes_out: u64,
    error: Option<String>,
}

#[derive(Default)]
struct ClientState {
    session: Mutex<Option<ActiveShareSession>>,
}

struct ActiveShareSession {
    public: Arc<Mutex<ShareSession>>,
    stop: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
}

#[derive(Default)]
struct SessionStats {
    tcp_tunnels: AtomicUsize,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
    udp_tunnel: AtomicBool,
    relay_ping_ms: AtomicU64,
}

#[derive(Default)]
struct GeoState {
    cache: Mutex<HashMap<String, CachedGeoLocation>>,
    last_request_at: Mutex<Option<Instant>>,
}

#[derive(Debug, Clone)]
struct CachedGeoLocation {
    region: String,
    country_code: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    provider: String,
    cached_at: Instant,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialServerLocationRequest {
    id: String,
    manager_address: String,
    #[serde(default)]
    relay_address: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficialServerLocationResponse {
    id: String,
    manager_address: String,
    host: String,
    region: String,
    country_code: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    provider: String,
    cached: bool,
    error: Option<String>,
    manager_error: Option<String>,
    ping_ms: Option<u64>,
    load_rate: Option<f64>,
    load_percent: Option<f64>,
    active_sessions: Option<u64>,
    max_sessions: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct IpWhoIsResponse {
    success: bool,
    message: Option<String>,
    region: Option<String>,
    country_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Debug, Clone)]
struct RelayStatusSample {
    ping_ms: Option<u64>,
    load_rate: Option<f64>,
    load_percent: Option<f64>,
    active_sessions: Option<u64>,
    max_sessions: Option<u64>,
    region: Option<String>,
    country_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiRelayStatusResponse {
    ping_ms: Option<u64>,
    load_rate: Option<f64>,
    load_percent: Option<f64>,
    active_sessions: Option<u64>,
    max_sessions: Option<u64>,
    location: Option<GuiRelayLocation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiRelayLocation {
    region: Option<String>,
    country_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

fn legacy_config_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(dir.join("config.json"))
}

fn config_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join("FerrumProxy Client"));
        }

        if let Some(app_data) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(app_data).join("FerrumProxy Client"));
        }

        return Err("failed to resolve AppData directory".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config_home).join("ferrumproxy-client"));
        }

        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home)
                .join(".config")
                .join("ferrumproxy-client"));
        }

        Err("failed to resolve config directory".to_string())
    }
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

fn official_server_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;

    let mut candidates = vec![
        exe_dir.join("OfficialServer.json"),
        exe_dir.join("../OfficialServer.json"),
    ];

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("OfficialServer.json"));
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("OfficialServer.json"));
        candidates.push(current_dir.join("../OfficialServer.json"));
        candidates.push(current_dir.join("../../OfficialServer.json"));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "OfficialServer.json was not found".to_string())
}

fn ensure_config_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn migrate_legacy_config(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    let legacy_path = legacy_config_path()?;
    if !legacy_path.exists() {
        return Ok(());
    }

    ensure_config_parent(path)?;
    fs::copy(&legacy_path, path).map_err(|err| {
        format!(
            "failed to migrate config from {} to {}: {err}",
            legacy_path.display(),
            path.display()
        )
    })?;

    Ok(())
}

#[tauri::command]
fn shared_client_runtime() -> &'static str {
    "FerrumProxy shared-service client runtime is available"
}

#[tauri::command]
fn load_client_config() -> Result<ClientConfigResponse, String> {
    let path = config_path()?;
    migrate_legacy_config(&path)?;
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
    ensure_config_parent(&path)?;
    let text = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(&path, text).map_err(|err| err.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn load_official_servers(app: tauri::AppHandle) -> Result<String, String> {
    let path = official_server_path(&app)?;
    fs::read_to_string(&path).map_err(|err| format!("failed to read {}: {err}", path.display()))
}

#[tauri::command]
fn probe_client_connection(config: ClientConfig) -> Result<(), String> {
    validate_shared_relay_api(&config)
}

#[tauri::command]
fn resolve_official_server_locations(
    servers: Vec<OfficialServerLocationRequest>,
    state: State<GeoState>,
) -> Result<Vec<OfficialServerLocationResponse>, String> {
    let mut resolved = Vec::with_capacity(servers.len());
    for server in servers {
        let manager_address = normalize_manager_address(&server.manager_address);
        let relay_address = server.relay_address.trim().to_string();
        let host = manager_address
            .rsplit_once(':')
            .map(|(value, _)| value.to_string())
            .unwrap_or_else(|| manager_address.clone());

        let manager_status = fetch_manager_status(&manager_address, &relay_address).ok();
        let mut region = String::new();
        let mut country_code = String::new();
        let mut latitude = None;
        let mut longitude = None;
        let mut provider = "ipwho.is".to_string();
        let mut cached = false;
        let mut geo_error: Option<String> = None;

        if let Some(status) = manager_status.as_ref() {
            if let Some(value) = status.region.as_ref() {
                region = value.clone();
            }
            if let Some(value) = status.country_code.as_ref() {
                country_code = value.clone();
            }
            if status.latitude.is_some() {
                latitude = status.latitude;
            }
            if status.longitude.is_some() {
                longitude = status.longitude;
            }
            if !region.is_empty() || !country_code.is_empty() || latitude.is_some() || longitude.is_some() {
                provider = "manager".to_string();
                cached = true;
            }
        }

        if region.is_empty() && country_code.is_empty() && latitude.is_none() && longitude.is_none() {
            match resolve_location_for_host(&host, &state) {
                Ok((geo, from_cache)) => {
                    region = geo.region;
                    country_code = geo.country_code;
                    latitude = geo.latitude;
                    longitude = geo.longitude;
                    provider = geo.provider;
                    cached = from_cache;
                }
                Err(_error) => {
                    // Keep UI clean in restricted networks (e.g. timeout/10060).
                    geo_error = None;
                }
            }
        }

        let mut manager_error: Option<String> = None;
        let mut ping_ms = None;
        let mut load_rate = None;
        let mut load_percent = None;
        let mut active_sessions = None;
        let mut max_sessions = None;
        if let Some(status) = manager_status {
                ping_ms = status.ping_ms;
                load_rate = status.load_rate;
                load_percent = status.load_percent;
                active_sessions = status.active_sessions;
                max_sessions = status.max_sessions;
        } else {
            manager_error = Some("manager status unavailable".to_string());
        }

        resolved.push(OfficialServerLocationResponse {
            id: server.id,
            manager_address,
            host,
            region,
            country_code,
            latitude,
            longitude,
            provider,
            cached,
            error: geo_error,
            manager_error,
            ping_ms,
            load_rate,
            load_percent,
            active_sessions,
            max_sessions,
        });
    }

    Ok(resolved)
}

fn normalize_manager_address(address: &str) -> String {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let host = trimmed
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or(trimmed);

    match host.rsplit_once(':') {
        Some((value, _)) if !value.is_empty() => format!("{value}:3000"),
        _ => format!("{host}:3000"),
    }
}

fn resolve_location_for_host(
    host: &str,
    state: &GeoState,
) -> Result<(CachedGeoLocation, bool), String> {
    let normalized_host = host.trim().trim_matches('[').trim_matches(']').to_string();
    if normalized_host.is_empty() {
        return Err("server host is empty".to_string());
    }

    const CACHE_TTL: Duration = Duration::from_secs(60 * 30);
    if let Some(cached) = state
        .cache
        .lock()
        .map_err(|_| "failed to lock geolocation cache".to_string())?
        .get(&normalized_host)
        .cloned()
    {
        if cached.cached_at.elapsed() <= CACHE_TTL {
            return Ok((cached, true));
        }
    }

    {
        let mut guard = state
            .last_request_at
            .lock()
            .map_err(|_| "failed to lock geolocation throttle".to_string())?;
        if let Some(last) = *guard {
            let elapsed = last.elapsed();
            let min_wait = Duration::from_millis(1100);
            if elapsed < min_wait {
                thread::sleep(min_wait - elapsed);
            }
        }
        *guard = Some(Instant::now());
    }

    let body = http_get_text("ipwho.is:80", &format!("/{}", normalized_host), "ipwho.is")?;
    let payload: IpWhoIsResponse = serde_json::from_str(&body)
        .map_err(|err| format!("failed to parse geolocation response: {err}"))?;

    if !payload.success {
        return Err(payload
            .message
            .unwrap_or_else(|| "geolocation provider returned success=false".to_string()));
    }

    let result = CachedGeoLocation {
        region: payload.region.unwrap_or_default(),
        country_code: payload.country_code.unwrap_or_default().to_uppercase(),
        latitude: payload.latitude,
        longitude: payload.longitude,
        provider: "ipwho.is".to_string(),
        cached_at: Instant::now(),
    };

    state
        .cache
        .lock()
        .map_err(|_| "failed to lock geolocation cache".to_string())?
        .insert(normalized_host, result.clone());

    Ok((result, false))
}

fn fetch_manager_status(manager_address: &str, relay_address: &str) -> Result<RelayStatusSample, String> {
    let endpoint = normalize_manager_address(manager_address);
    if endpoint.is_empty() {
        return Err("manager endpoint is empty".to_string());
    }

    let mut request_path = "/public/shared-relay/status".to_string();
    if !relay_address.trim().is_empty() {
        request_path.push_str("?relay=");
        request_path.push_str(&url_encode(relay_address.trim()));
    }

    let started = Instant::now();
    let body = http_get_text(&endpoint, &request_path, &extract_host_header(&endpoint))?;
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let payload: GuiRelayStatusResponse = serde_json::from_str(&body)
        .map_err(|err| format!("failed to parse manager status response: {err}"))?;

    Ok(RelayStatusSample {
        ping_ms: payload.ping_ms.or(Some(elapsed_ms)),
        load_rate: payload.load_rate,
        load_percent: payload.load_percent,
        active_sessions: payload.active_sessions,
        max_sessions: payload.max_sessions,
        region: payload
            .location
            .as_ref()
            .and_then(|location| location.region.as_ref())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        country_code: payload
            .location
            .as_ref()
            .and_then(|location| location.country_code.as_ref())
            .map(|value| value.trim().to_uppercase())
            .filter(|value| !value.is_empty()),
        latitude: payload.location.as_ref().and_then(|location| location.latitude),
        longitude: payload.location.as_ref().and_then(|location| location.longitude),
    })
}

fn extract_host_header(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or(endpoint)
        .to_string()
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let is_unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn http_get_text(endpoint: &str, path: &str, host_header: &str) -> Result<String, String> {
    let request_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let request = format!(
        "GET {request_path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: FerrumProxyClient/0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );

    let mut stream = connect_tcp_endpoint(endpoint, Duration::from_secs(6))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(6)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(6)))
        .map_err(|err| err.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("failed to request geolocation endpoint: {err}"))?;
    stream
        .flush()
        .map_err(|err| format!("failed to flush geolocation request: {err}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|err| format!("failed to read geolocation response: {err}"))?;
    let text = String::from_utf8(response).map_err(|err| err.to_string())?;
    let (header, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "invalid geolocation response".to_string())?;
    let status_line = header.lines().next().unwrap_or_default();
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_default();

    if status_code != 200 {
        return Err(format!("geolocation HTTP {status_code}"));
    }

    Ok(body.to_string())
}

#[tauri::command]
fn start_sharing(config: ClientConfig, state: State<ClientState>) -> Result<ShareSession, String> {
    if !config.tcp_enabled && !config.udp_enabled {
        return Err("Enable TCP, UDP, or both".to_string());
    }
    validate_shared_relay_api(&config)?;

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
    let stats = Arc::new(SessionStats::default());
    let session = Arc::new(Mutex::new(ShareSession {
        running: false,
        status: ShareSessionStatus::Waiting,
        relay_address: config.relay_address.clone(),
        endpoint: None,
        queue_waiting_clients: None,
        queue_max_size: None,
        relay_ping_ms: None,
        tcp_tunnels: 0,
        udp_tunnel: false,
        bytes_in: 0,
        bytes_out: 0,
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
            stats: Arc::clone(&stats),
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
            config.haproxy,
            stop,
            stats,
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
        Some(active) => {
            let mut session = active
                .public
                .lock()
                .map_err(|_| "failed to lock client session".to_string())?
                .clone();
            apply_session_stats(&mut session, &active.stats);
            Some(session)
        }
        None => None,
    })
}

fn apply_session_stats(session: &mut ShareSession, stats: &SessionStats) {
    session.tcp_tunnels = stats.tcp_tunnels.load(Ordering::Relaxed);
    session.udp_tunnel = stats.udp_tunnel.load(Ordering::Relaxed);
    session.bytes_in = stats.bytes_in.load(Ordering::Relaxed);
    session.bytes_out = stats.bytes_out.load(Ordering::Relaxed);
    let ping = stats.relay_ping_ms.load(Ordering::Relaxed);
    session.relay_ping_ms = if ping > 0 { Some(ping) } else { None };
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
    haproxy: bool,
    stop: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
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
            haproxy,
            stop.clone(),
            Arc::clone(&stats),
        );
    }
    if udp_enabled {
        start_udp_tunnel(
            relay_address.clone(),
            port,
            local_host,
            udp_local_port,
            haproxy,
            stop.clone(),
            Arc::clone(&stats),
        );
    }

    monitor_relay_allocation(&relay_address, port, stop, stats, session)
}

fn monitor_relay_allocation(
    relay_address: &str,
    public_port: u16,
    stop: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
    session: Arc<Mutex<ShareSession>>,
) -> Result<(), String> {
    let mut missed_checks = 0usize;

    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_secs(2));

        let started = Instant::now();
        match send_relay_command(relay_address, "LIST\n") {
            Ok(response) if relay_list_contains_port(&response, public_port) => {
                stats.relay_ping_ms.store(
                    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                    Ordering::Relaxed,
                );
                missed_checks = 0;
            }
            Ok(response) => {
                missed_checks += 1;
                if missed_checks >= 2 {
                    if let Ok(mut guard) = session.lock() {
                        guard.running = false;
                        guard.status = ShareSessionStatus::Failed;
                        guard.error = Some(format!(
                            "relay allocation {public_port} disappeared: {}",
                            response.trim()
                        ));
                    }
                    return Err(format!("relay allocation {public_port} disappeared"));
                }
            }
            Err(error) => {
                missed_checks += 1;
                if missed_checks >= 3 {
                    if let Ok(mut guard) = session.lock() {
                        guard.running = false;
                        guard.status = ShareSessionStatus::Failed;
                        guard.error = Some(format!("relay monitor failed: {error}"));
                    }
                    return Err(format!("relay monitor failed: {error}"));
                }
            }
        }
    }

    Ok(())
}

fn relay_list_contains_port(response: &str, public_port: u16) -> bool {
    let needle = format!("port={public_port} ");
    response.lines().any(|line| line.contains(&needle))
}

fn validate_shared_relay_api(config: &ClientConfig) -> Result<(), String> {
    validate_shared_relay_control_api(&config.relay_address)?;
    let token = config.token.trim();
    if !token.is_empty() {
        validate_shared_relay_auth(&config.relay_address, token)?;
    }
    Ok(())
}

fn validate_shared_relay_control_api(relay_address: &str) -> Result<(), String> {
    let response = send_relay_command(relay_address, "STATS\n")
        .map_err(|err| format!("Shared relay API check failed: {err}"))?;
    let trimmed = response.trim();
    if trimmed.starts_with("STAT ") {
        return Ok(());
    }

    Err(format!(
        "Shared relay API check failed: {relay_address} is reachable, but it did not respond as a FerrumProxy shared relay API. Response: {}",
        if trimmed.is_empty() { "<empty>" } else { trimmed }
    ))
}

fn validate_shared_relay_auth(relay_address: &str, token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Ok(());
    }

    let response = send_relay_command(relay_address, &format!("TOKEN {token}\n"))
        .map_err(|err| format!("Shared relay token check failed: {err}"))?;
    let trimmed = response.trim();
    if trimmed.starts_with("OK ") {
        return Ok(());
    }
    if trimmed.eq_ignore_ascii_case("ERROR Invalid token") {
        return Err("Shared relay token check failed: invalid authentication token.".to_string());
    }

    Err(format!(
        "Shared relay token check failed: unexpected response from relay: {}",
        if trimmed.is_empty() {
            "<empty>"
        } else {
            trimmed
        }
    ))
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
    haproxy: bool,
    stop: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
) {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match run_udp_tunnel(
                &relay_address,
                public_port,
                &local_host,
                local_port,
                haproxy,
                &stop,
                &stats,
            ) {
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
    haproxy: bool,
    stop: &Arc<AtomicBool>,
    stats: &Arc<SessionStats>,
) -> Result<(), String> {
    let mut tunnel = connect_tcp_endpoint(relay_address, Duration::from_secs(5))?;
    let command = if haproxy {
        format!("UDP_TUNNEL {public_port} HAPROXY\n")
    } else {
        format!("UDP_TUNNEL {public_port}\n")
    };
    tunnel
        .write_all(command.as_bytes())
        .map_err(|err| format!("failed to register UDP tunnel: {err}"))?;

    let mut ready = [0u8; 6];
    tunnel
        .read_exact(&mut ready)
        .map_err(|err| format!("failed to wait for UDP tunnel readiness: {err}"))?;
    if &ready != b"READY\n" {
        return Err("relay rejected UDP tunnel readiness".to_string());
    }
    stats.udp_tunnel.store(true, Ordering::Relaxed);

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

    let result = (|| -> Result<(), String> {
        while !stop.load(Ordering::Relaxed) {
            let (remote_addr, payload) = match read_udp_frame_blocking(&mut tunnel) {
                Ok(frame) => frame,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(err) => return Err(format!("UDP tunnel read failed: {err}")),
            };
            stats
                .bytes_in
                .fetch_add(payload.len() as u64, Ordering::Relaxed);

            eprintln!(
                "[UDP] Received from relay: {} bytes from {}",
                payload.len(),
                remote_addr
            );
            let local = match peers.get(&remote_addr) {
                Some(local) => Arc::clone(local),
                None => {
                    let local =
                        Arc::new(UdpSocket::bind("0.0.0.0:0").map_err(|err| err.to_string())?);
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
                    let stats = Arc::clone(stats);
                    thread::spawn(move || {
                        let mut response = vec![0u8; 65_507];
                        while !stop.load(Ordering::Relaxed) && tunnel_alive.load(Ordering::Relaxed)
                        {
                            match local_reader.recv_from(&mut response) {
                                Ok((len, from)) => {
                                    eprintln!(
                                        "[UDP] Received from local: {} bytes from {}",
                                        len, from
                                    );
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
                                        Ok(()) => {
                                            stats
                                                .bytes_out
                                                .fetch_add(len as u64, Ordering::Relaxed);
                                            eprintln!(
                                            "[UDP] Forwarded response to relay: {} bytes for {}",
                                            len, remote_addr
                                        );
                                        }
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
    })();
    stats.udp_tunnel.store(false, Ordering::Relaxed);
    result
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
    haproxy: bool,
    stop: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
) {
    for _ in 0..8 {
        let relay_address = relay_address.clone();
        let local_host = local_host.clone();
        let stop = stop.clone();
        let stats = Arc::clone(&stats);
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match open_tcp_tunnel(
                    &relay_address,
                    public_port,
                    &local_host,
                    local_port,
                    haproxy,
                    &stop,
                    &stats,
                ) {
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
    haproxy: bool,
    stop: &Arc<AtomicBool>,
    stats: &Arc<SessionStats>,
) -> Result<(), String> {
    let mut tunnel = connect_tcp_endpoint(relay_address, Duration::from_secs(5))?;
    let command = if haproxy {
        format!("TUNNEL {public_port} HAPROXY\n")
    } else {
        format!("TUNNEL {public_port}\n")
    };
    tunnel
        .write_all(command.as_bytes())
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
    stats.tcp_tunnels.fetch_add(1, Ordering::Relaxed);
    let result = pipe_bidirectional(tunnel, local, stop, stats);
    stats.tcp_tunnels.fetch_sub(1, Ordering::Relaxed);
    result
}

fn pipe_bidirectional(
    mut left: TcpStream,
    mut right: TcpStream,
    stop: &Arc<AtomicBool>,
    stats: &Arc<SessionStats>,
) -> Result<(), String> {
    let mut left_read = left.try_clone().map_err(|err| err.to_string())?;
    let mut right_write = right.try_clone().map_err(|err| err.to_string())?;
    let stop_copy = stop.clone();
    let forward_stats = Arc::clone(stats);
    let forward = thread::spawn(move || {
        let _ = copy_counting(&mut left_read, &mut right_write, |bytes| {
            forward_stats.bytes_in.fetch_add(bytes, Ordering::Relaxed);
        });
        let _ = right_write.shutdown(Shutdown::Write);
        stop_copy.load(Ordering::Relaxed)
    });

    let _ = copy_counting(&mut right, &mut left, |bytes| {
        stats.bytes_out.fetch_add(bytes, Ordering::Relaxed);
    });
    let _ = left.shutdown(Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

fn copy_counting<R, W, F>(reader: &mut R, writer: &mut W, mut on_bytes: F) -> std::io::Result<u64>
where
    R: Read,
    W: Write,
    F: FnMut(u64),
{
    let mut total = 0;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            return Ok(total);
        }
        writer.write_all(&buffer[..bytes_read])?;
        let bytes = bytes_read as u64;
        total += bytes;
        on_bytes(bytes);
    }
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

fn apply_tcp_nodelay(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
}

fn main() {
    tauri::Builder::default()
        .manage(ClientState::default())
        .manage(GeoState::default())
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
            load_official_servers,
            probe_client_connection,
            resolve_official_server_locations,
            start_sharing,
            stop_sharing,
            get_share_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running FerrumProxy client");
}
