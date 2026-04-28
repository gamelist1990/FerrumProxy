#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    relay_address: String,
    token: String,
    tcp_enabled: bool,
    udp_enabled: bool,
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
            tcp_local_port: 25565,
            udp_local_port: 25565,
            haproxy: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigResponse {
    config: ClientConfig,
    path: String,
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            shared_client_runtime,
            load_client_config,
            save_client_config,
            probe_client_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running FerrumProxy client");
}
