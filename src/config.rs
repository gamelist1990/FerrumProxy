use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use url::Url;

#[derive(Debug, Clone, Copy)]
pub enum Protocol {
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default = "default_endpoint")]
    pub endpoint: u16,
    #[serde(default)]
    pub use_rest_api: bool,
    #[serde(default = "default_save_player_ip")]
    pub save_player_ip: bool,
    #[serde(default)]
    pub debug: bool,
    #[serde(default)]
    pub shared_service: Option<SharedServiceConfig>,
    pub listeners: Vec<ListenerRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServiceConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_shared_control_bind")]
    pub control_bind: String,
    #[serde(default = "default_shared_public_bind")]
    pub public_bind: String,
    #[serde(default = "default_shared_public_host")]
    pub public_host: String,
    #[serde(default = "default_shared_port_range")]
    pub port_range: SharedServicePortRange,
    #[serde(default)]
    pub auth_tokens: Vec<String>,
    #[serde(default = "default_true")]
    pub allow_anonymous: bool,
    #[serde(default)]
    pub queue: SharedServiceQueueConfig,
    #[serde(default)]
    pub tokens: Vec<SharedServiceToken>,
    #[serde(default)]
    pub defaults: SharedServiceLimits,
    #[serde(default)]
    pub maximums: SharedServiceLimits,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServicePortRange {
    #[serde(default = "default_shared_port_start")]
    pub start: u16,
    #[serde(default = "default_shared_port_end")]
    pub end: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServiceQueueConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_shared_queue_max_size")]
    pub max_size: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServiceToken {
    #[serde(default)]
    pub name: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_shared_token_priority")]
    pub priority: u16,
    #[serde(default)]
    pub limits: SharedServiceLimits,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedServiceLimits {
    #[serde(default = "default_max_tcp_connections")]
    pub max_tcp_connections: usize,
    #[serde(default = "default_max_udp_peers")]
    pub max_udp_peers: usize,
    #[serde(default = "default_max_bytes_per_second")]
    pub max_bytes_per_second: u64,
    #[serde(default = "default_idle_timeout_seconds")]
    pub idle_timeout_seconds: u64,
    #[serde(default = "default_udp_session_timeout_seconds")]
    pub udp_session_timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerRule {
    #[serde(default = "default_bind")]
    pub bind: String,
    pub tcp: Option<u16>,
    pub udp: Option<u16>,
    #[serde(default)]
    pub haproxy: bool,
    #[serde(default)]
    pub https: Option<ListenerHttpsConfig>,
    #[serde(default = "default_rewrite_bedrock_pong_ports")]
    pub rewrite_bedrock_pong_ports: bool,
    #[serde(default)]
    pub webhook: Option<String>,
    #[serde(default)]
    pub target: Option<ProxyTarget>,
    #[serde(default)]
    pub targets: Vec<ProxyTarget>,
    #[serde(default)]
    pub http_mappings: Vec<HttpTargetMapping>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProxyTarget {
    pub host: String,
    pub tcp: Option<u16>,
    pub udp: Option<u16>,
    #[serde(skip)]
    pub url_protocol: Option<String>,
    #[serde(skip)]
    pub url_base_path: Option<String>,
    #[serde(skip)]
    pub mount_path: Option<String>,
    #[serde(skip)]
    pub original_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTargetMapping {
    pub path: String,
    #[serde(default)]
    pub target: Option<ProxyTarget>,
    #[serde(default)]
    pub targets: Vec<ProxyTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerHttpsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub auto_detect: bool,
    pub lets_encrypt_domain: Option<String>,
    pub cert_path: Option<PathBuf>,
    pub key_path: Option<PathBuf>,
}

impl ProxyConfig {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            write_default_config(path)?;
        }

        let text = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        let mut config: Self = serde_yaml::from_str(&text)
            .with_context(|| format!("failed to parse config {}", path.display()))?;
        config.normalize_targets();
        Ok(config)
    }

    fn normalize_targets(&mut self) {
        for listener in &mut self.listeners {
            if let Some(target) = &mut listener.target {
                target.normalize_url_host();
            }

            for target in &mut listener.targets {
                target.normalize_url_host();
            }

            for mapping in &mut listener.http_mappings {
                mapping.normalize();
            }
        }
    }
}

fn write_default_config(path: &Path) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }

    fs::write(path, default_config_text())
        .with_context(|| format!("failed to create default config {}", path.display()))?;
    Ok(())
}

fn default_config_text() -> &'static str {
    r#"endpoint: 6000
useRestApi: false
savePlayerIP: true
debug: false
sharedService:
  enabled: false
  controlBind: 0.0.0.0:7000
  publicBind: 0.0.0.0
  publicHost: ""
  portRange:
    start: 40000
    end: 49999
  authTokens: []
  allowAnonymous: true
  queue:
    enabled: true
    maxSize: 128
  tokens: []
  defaults:
    maxTcpConnections: 32
    maxUdpPeers: 64
    maxBytesPerSecond: 10485760
    idleTimeoutSeconds: 120
    udpSessionTimeoutSeconds: 60
  maximums:
    maxTcpConnections: 256
    maxUdpPeers: 512
    maxBytesPerSecond: 104857600
    idleTimeoutSeconds: 3600
    udpSessionTimeoutSeconds: 600
listeners:
  - bind: 0.0.0.0
    tcp: 8000
    udp: 8001
    haproxy: false
    https:
      enabled: false
      autoDetect: true
    webhook: ""
    rewriteBedrockPongPorts: true
    target:
      host: 127.0.0.1
      tcp: 9000
      udp: 9001
"#
}

impl ListenerRule {
    pub fn has_targets_for(&self, protocol: Protocol) -> bool {
        !self.targets_for(protocol).is_empty() || !self.http_targets_for(protocol).is_empty()
    }

    pub fn targets_for(&self, protocol: Protocol) -> Vec<ProxyTarget> {
        let mut targets = if self.targets.is_empty() {
            self.target.iter().cloned().collect::<Vec<_>>()
        } else {
            self.targets.clone()
        };

        targets.retain(|target| match protocol {
            Protocol::Tcp => target.tcp.is_some(),
            Protocol::Udp => target.udp.is_some(),
        });
        targets
    }

    fn http_targets_for(&self, protocol: Protocol) -> Vec<ProxyTarget> {
        self.http_mappings
            .iter()
            .flat_map(|mapping| {
                if mapping.targets.is_empty() {
                    mapping.target.iter().cloned().collect::<Vec<_>>()
                } else {
                    mapping.targets.clone()
                }
            })
            .filter(|target| match protocol {
                Protocol::Tcp => target.tcp.is_some(),
                Protocol::Udp => target.udp.is_some(),
            })
            .collect()
    }

    pub fn http_targets_for_path(
        &self,
        protocol: Protocol,
        request_path: Option<&str>,
    ) -> Vec<ProxyTarget> {
        let Some(request_path) = request_path else {
            return Vec::new();
        };

        let Some(mapping) = self
            .http_mappings
            .iter()
            .filter(|mapping| path_matches_mapping(request_path, &mapping.path))
            .max_by_key(|mapping| mapping.path.len())
        else {
            return Vec::new();
        };

        let mut targets = if mapping.targets.is_empty() {
            mapping.target.iter().cloned().collect::<Vec<_>>()
        } else {
            mapping.targets.clone()
        };

        targets.retain(|target| match protocol {
            Protocol::Tcp => target.tcp.is_some(),
            Protocol::Udp => target.udp.is_some(),
        });
        targets
    }
}

impl ProxyTarget {
    fn normalize_url_host(&mut self) {
        let Ok(parsed) = Url::parse(&self.host) else {
            return;
        };

        let Some(host) = parsed.host_str() else {
            return;
        };

        let default_port = match parsed.scheme() {
            "https" => Some(443),
            "http" => Some(80),
            _ => None,
        };
        let port = parsed.port().or(default_port);

        self.host = host.to_string();
        self.url_protocol = match parsed.scheme() {
            "https" | "http" => Some(parsed.scheme().to_string()),
            _ => None,
        };
        self.url_base_path = match parsed.path() {
            "" | "/" => None,
            path => Some(path.trim_end_matches('/').to_string()),
        };
        self.original_url = Some(parsed.to_string());
        if self.tcp.is_none() {
            self.tcp = port;
        }
        if self.udp.is_none() {
            self.udp = port;
        }
    }
}

impl HttpTargetMapping {
    fn normalize(&mut self) {
        self.path = normalize_mapping_path(&self.path);

        if let Some(target) = &mut self.target {
            target.normalize_url_host();
            target.mount_path = Some(self.path.clone());
        }

        for target in &mut self.targets {
            target.normalize_url_host();
            target.mount_path = Some(self.path.clone());
        }
    }
}

fn normalize_mapping_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "/" {
        return "/".to_string();
    }
    format!("/{}", trimmed.trim_start_matches('/').trim_end_matches('/'))
}

fn path_matches_mapping(request_path: &str, mapping_path: &str) -> bool {
    mapping_path == "/"
        || request_path == mapping_path
        || request_path.starts_with(&format!("{mapping_path}/"))
}

fn default_endpoint() -> u16 {
    6000
}

fn default_bind() -> String {
    "0.0.0.0".to_string()
}

fn default_save_player_ip() -> bool {
    true
}

fn default_rewrite_bedrock_pong_ports() -> bool {
    true
}

impl Default for SharedServicePortRange {
    fn default() -> Self {
        Self {
            start: default_shared_port_start(),
            end: default_shared_port_end(),
        }
    }
}

impl Default for SharedServiceLimits {
    fn default() -> Self {
        Self {
            max_tcp_connections: default_max_tcp_connections(),
            max_udp_peers: default_max_udp_peers(),
            max_bytes_per_second: default_max_bytes_per_second(),
            idle_timeout_seconds: default_idle_timeout_seconds(),
            udp_session_timeout_seconds: default_udp_session_timeout_seconds(),
        }
    }
}

impl Default for SharedServiceQueueConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_size: default_shared_queue_max_size(),
        }
    }
}

fn default_shared_control_bind() -> String {
    "0.0.0.0:7000".to_string()
}

fn default_shared_public_bind() -> String {
    "0.0.0.0".to_string()
}

fn default_shared_public_host() -> String {
    String::new()
}

fn default_shared_port_range() -> SharedServicePortRange {
    SharedServicePortRange::default()
}

fn default_shared_port_start() -> u16 {
    40000
}

fn default_shared_port_end() -> u16 {
    49999
}

fn default_shared_queue_max_size() -> usize {
    128
}

fn default_shared_token_priority() -> u16 {
    10
}

fn default_max_tcp_connections() -> usize {
    32
}

fn default_max_udp_peers() -> usize {
    64
}

fn default_max_bytes_per_second() -> u64 {
    10 * 1024 * 1024
}

fn default_idle_timeout_seconds() -> u64 {
    120
}

fn default_udp_session_timeout_seconds() -> u64 {
    60
}

fn default_true() -> bool {
    true
}
