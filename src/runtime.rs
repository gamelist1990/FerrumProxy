use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::warn;

use crate::webhook_queue::WebhookGroupNotifier;

const BUFFER_TIMEOUT: Duration = Duration::from_secs(30);
const TIMESTAMP_TOLERANCE_MS: i64 = 30_000;

#[derive(Clone)]
pub struct AppRuntime {
    pub use_rest_api: bool,
    pub webhooks: Vec<String>,
    pub http_client: reqwest::Client,
    pub notifier: WebhookGroupNotifier,
    pub connection_buffer: ConnectionBuffer,
    pub player_mapper: TimestampPlayerMapper,
    pub player_ip_mapper: PlayerIpMapper,
    pub metrics: PerformanceMetrics,
}

impl AppRuntime {
    pub fn new(use_rest_api: bool, save_player_ip: bool, webhooks: Vec<String>) -> Self {
        let http_client = reqwest::Client::new();
        Self {
            use_rest_api,
            webhooks,
            notifier: WebhookGroupNotifier::new(http_client.clone()),
            http_client,
            connection_buffer: ConnectionBuffer::default(),
            player_mapper: TimestampPlayerMapper::default(),
            player_ip_mapper: PlayerIpMapper::new(PathBuf::from("playerIP.json"), save_player_ip),
            metrics: PerformanceMetrics::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSnapshot {
    pub uptime_seconds: u64,
    pub tcp: ProtocolMetricsSnapshot,
    pub udp: ProtocolMetricsSnapshot,
    pub total_active_sessions: u64,
    pub total_sessions: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolMetricsSnapshot {
    pub active_sessions: u64,
    pub total_sessions: u64,
    pub bytes_client_to_target: u64,
    pub bytes_target_to_client: u64,
    pub total_bytes: u64,
}

#[derive(Clone)]
pub struct PerformanceMetrics {
    started_at: Instant,
    tcp: Arc<ProtocolMetrics>,
    udp: Arc<ProtocolMetrics>,
}

impl PerformanceMetrics {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            tcp: Arc::new(ProtocolMetrics::default()),
            udp: Arc::new(ProtocolMetrics::default()),
        }
    }

    pub fn tcp_session_opened(&self) {
        self.tcp.session_opened();
    }

    pub fn tcp_session_closed(&self) {
        self.tcp.session_closed();
    }

    pub fn tcp_client_to_target_bytes(&self, bytes: usize) {
        self.tcp.client_to_target_bytes(bytes);
    }

    pub fn tcp_target_to_client_bytes(&self, bytes: usize) {
        self.tcp.target_to_client_bytes(bytes);
    }

    pub fn udp_session_opened(&self) {
        self.udp.session_opened();
    }

    pub fn udp_session_closed(&self) {
        self.udp.session_closed();
    }

    pub fn udp_client_to_target_bytes(&self, bytes: usize) {
        self.udp.client_to_target_bytes(bytes);
    }

    pub fn udp_target_to_client_bytes(&self, bytes: usize) {
        self.udp.target_to_client_bytes(bytes);
    }

    pub fn snapshot(&self) -> PerformanceSnapshot {
        let tcp = self.tcp.snapshot();
        let udp = self.udp.snapshot();
        PerformanceSnapshot {
            uptime_seconds: self.started_at.elapsed().as_secs(),
            total_active_sessions: tcp.active_sessions + udp.active_sessions,
            total_sessions: tcp.total_sessions + udp.total_sessions,
            total_bytes: tcp.total_bytes + udp.total_bytes,
            tcp,
            udp,
        }
    }
}

#[derive(Default)]
struct ProtocolMetrics {
    active_sessions: AtomicU64,
    total_sessions: AtomicU64,
    bytes_client_to_target: AtomicU64,
    bytes_target_to_client: AtomicU64,
}

impl ProtocolMetrics {
    fn session_opened(&self) {
        self.active_sessions.fetch_add(1, Ordering::Relaxed);
        self.total_sessions.fetch_add(1, Ordering::Relaxed);
    }

    fn session_closed(&self) {
        self.active_sessions
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_sub(1)
            })
            .ok();
    }

    fn client_to_target_bytes(&self, bytes: usize) {
        self.bytes_client_to_target
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn target_to_client_bytes(&self, bytes: usize) {
        self.bytes_target_to_client
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn snapshot(&self) -> ProtocolMetricsSnapshot {
        let bytes_client_to_target = self.bytes_client_to_target.load(Ordering::Relaxed);
        let bytes_target_to_client = self.bytes_target_to_client.load(Ordering::Relaxed);
        ProtocolMetricsSnapshot {
            active_sessions: self.active_sessions.load(Ordering::Relaxed),
            total_sessions: self.total_sessions.load(Ordering::Relaxed),
            bytes_client_to_target,
            bytes_target_to_client,
            total_bytes: bytes_client_to_target + bytes_target_to_client,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PendingConnection {
    pub ip: String,
    pub port: u16,
    pub protocol: &'static str,
    pub timestamp: i64,
    pub target: String,
}

#[derive(Clone, Default)]
pub struct ConnectionBuffer {
    pending: Arc<Mutex<HashMap<String, PendingConnection>>>,
}

impl ConnectionBuffer {
    pub async fn add_pending(&self, ip: String, port: u16, protocol: &'static str, target: String) {
        let key = format!("{ip}:{port}:{protocol}");
        self.pending.lock().await.insert(
            key.clone(),
            PendingConnection {
                ip,
                port,
                protocol,
                timestamp: now_ms(),
                target,
            },
        );

        let pending = self.pending.clone();
        tokio::spawn(async move {
            tokio::time::sleep(BUFFER_TIMEOUT).await;
            pending.lock().await.remove(&key);
        });
    }

    pub async fn process_for_timestamp(&self, timestamp: i64) -> Vec<PendingConnection> {
        let mut guard = self.pending.lock().await;
        let keys = guard
            .iter()
            .filter_map(|(key, pending)| {
                (pending.timestamp - timestamp)
                    .abs()
                    .lt(&TIMESTAMP_TOLERANCE_MS)
                    .then(|| key.clone())
            })
            .collect::<Vec<_>>();

        keys.into_iter()
            .filter_map(|key| guard.remove(&key))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerEntry {
    pub username: String,
    pub timestamp: i64,
    #[serde(rename = "timestampStr")]
    pub timestamp_str: String,
}

#[derive(Clone, Default)]
pub struct TimestampPlayerMapper {
    players: Arc<Mutex<HashMap<i64, (String, i64)>>>,
}

impl TimestampPlayerMapper {
    pub async fn register_login(&self, timestamp: i64, username: String) {
        self.players
            .lock()
            .await
            .insert(timestamp, (username, timestamp));
    }

    pub async fn register_logout(&self, timestamp: i64, username: &str) {
        let mut guard = self.players.lock().await;
        let key = guard
            .iter()
            .find_map(|(key, (existing, existing_timestamp))| {
                (existing == username
                    && (*existing_timestamp - timestamp).abs() < TIMESTAMP_TOLERANCE_MS)
                    .then_some(*key)
            });
        if let Some(key) = key {
            guard.remove(&key);
        }
    }

    pub async fn all_players(&self) -> Vec<PlayerEntry> {
        self.players
            .lock()
            .await
            .values()
            .map(|(username, timestamp)| PlayerEntry {
                username: username.clone(),
                timestamp: *timestamp,
                timestamp_str: chrono::DateTime::from_timestamp_millis(*timestamp)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| timestamp.to_string()),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerIpRecord {
    pub username: String,
    pub ips: Vec<PlayerIpInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerIpInfo {
    pub ip: String,
    pub protocol: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: i64,
}

#[derive(Clone)]
pub struct PlayerIpMapper {
    records: Arc<Mutex<HashMap<String, PlayerIpRecord>>>,
    file_path: PathBuf,
    enabled: bool,
}

impl PlayerIpMapper {
    pub fn new(file_path: PathBuf, enabled: bool) -> Self {
        let mapper = Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            file_path,
            enabled,
        };
        mapper.load_sync();
        mapper
    }

    pub async fn register_player_ip(&self, username: &str, ip: String, protocol: &str) {
        if !self.enabled {
            return;
        }

        let mut guard = self.records.lock().await;
        guard.insert(
            username.to_string(),
            PlayerIpRecord {
                username: username.to_string(),
                ips: vec![PlayerIpInfo {
                    ip,
                    protocol: protocol.to_string(),
                    last_seen: now_ms(),
                }],
            },
        );
        drop(guard);
        if let Err(err) = self.save().await {
            warn!("failed to save player IPs: {err:#}");
        }
    }

    pub async fn get_player_ips(&self, username: &str) -> Option<PlayerIpRecord> {
        self.records.lock().await.get(username).cloned()
    }

    fn load_sync(&self) {
        if !self.enabled || !self.file_path.exists() {
            return;
        }

        let Ok(text) = std::fs::read_to_string(&self.file_path) else {
            return;
        };
        let Ok(records) = serde_json::from_str::<Vec<PlayerIpRecord>>(&text) else {
            return;
        };
        let normalized = records
            .into_iter()
            .map(|record| (record.username.clone(), record))
            .collect::<HashMap<_, _>>();
        if let Ok(mut guard) = self.records.try_lock() {
            *guard = normalized;
        }
    }

    async fn save(&self) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let records = self
            .records
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let text = serde_json::to_string_pretty(&records)?;
        tokio::fs::write(&self.file_path, text).await?;
        Ok(())
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
