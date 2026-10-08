use std::collections::HashSet;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const DEFAULT_VPN_FEED_URL: &str =
    "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt";
const DEFAULT_DATACENTER_FEED_URL: &str =
    "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpBlockEntry {
    pub ip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IpBlockConfig {
    pub enabled: bool,
    pub block_vpn: bool,
    pub block_datacenter: bool,
    #[serde(default = "default_vpn_feed_url")]
    pub vpn_feed_url: String,
    #[serde(default = "default_datacenter_feed_url")]
    pub datacenter_feed_url: String,
    /// How often to refresh feeds from GitHub, in seconds. 0 = only on startup.
    #[serde(default = "default_feed_refresh_interval_seconds")]
    pub feed_refresh_interval_seconds: u64,
    #[serde(default)]
    pub blocked_ips: Vec<IpBlockEntry>,
    #[serde(default)]
    pub blocked_cidrs: Vec<String>,
}

impl Default for IpBlockConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            block_vpn: false,
            block_datacenter: false,
            vpn_feed_url: default_vpn_feed_url(),
            datacenter_feed_url: default_datacenter_feed_url(),
            feed_refresh_interval_seconds: default_feed_refresh_interval_seconds(),
            blocked_ips: Vec::new(),
            blocked_cidrs: Vec::new(),
        }
    }
}

fn default_vpn_feed_url() -> String {
    DEFAULT_VPN_FEED_URL.to_string()
}

fn default_datacenter_feed_url() -> String {
    DEFAULT_DATACENTER_FEED_URL.to_string()
}

fn default_feed_refresh_interval_seconds() -> u64 {
    86400
}

#[derive(Clone)]
pub struct IpBlockList {
    inner: Arc<RwLock<IpBlockState>>,
}

struct IpBlockState {
    enabled: bool,
    block_vpn: bool,
    block_datacenter: bool,
    exact: HashSet<IpAddr>,
    cidrs: Vec<(IpAddr, u8)>,
    vpn_feed_cidrs: Vec<(IpAddr, u8)>,
    datacenter_feed_cidrs: Vec<(IpAddr, u8)>,
    last_feed_update: Option<Instant>,
}

impl IpBlockList {
    pub fn new(config: &IpBlockConfig) -> Self {
        let mut exact = HashSet::new();
        for entry in &config.blocked_ips {
            if let Ok(ip) = IpAddr::from_str(&entry.ip) {
                exact.insert(ip);
            }
        }
        let mut cidrs = Vec::new();
        for cidr in &config.blocked_cidrs {
            if let Some(parsed) = parse_cidr(cidr) {
                cidrs.push(parsed);
            }
        }
        Self {
            inner: Arc::new(RwLock::new(IpBlockState {
                enabled: config.enabled,
                block_vpn: config.block_vpn,
                block_datacenter: config.block_datacenter,
                exact,
                cidrs,
                vpn_feed_cidrs: Vec::new(),
                datacenter_feed_cidrs: Vec::new(),
                last_feed_update: None,
            })),
        }
    }

    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        let state = self.inner.read().expect("ip block rwlock poisoned");
        if !state.enabled {
            return false;
        }
        if state.exact.contains(&ip) {
            return true;
        }
        for (net, prefix) in &state.cidrs {
            if cidr_contains(*net, *prefix, ip) {
                return true;
            }
        }
        if state.block_vpn {
            for (net, prefix) in &state.vpn_feed_cidrs {
                if cidr_contains(*net, *prefix, ip) {
                    return true;
                }
            }
        }
        if state.block_datacenter {
            for (net, prefix) in &state.datacenter_feed_cidrs {
                if cidr_contains(*net, *prefix, ip) {
                    return true;
                }
            }
        }
        false
    }

    pub fn add_ip(&self, ip: IpAddr) {
        let mut state = self.inner.write().expect("ip block rwlock poisoned");
        state.exact.insert(ip);
    }

    pub fn remove_ip(&self, ip: IpAddr) -> bool {
        let mut state = self.inner.write().expect("ip block rwlock poisoned");
        state.exact.remove(&ip)
    }

    pub fn add_cidr(&self, cidr: &str) -> bool {
        if let Some(parsed) = parse_cidr(cidr) {
            let mut state = self.inner.write().expect("ip block rwlock poisoned");
            if !state.cidrs.contains(&parsed) {
                state.cidrs.push(parsed);
            }
            return true;
        }
        false
    }

    pub fn remove_cidr(&self, cidr: &str) -> bool {
        if let Some(parsed) = parse_cidr(cidr) {
            let mut state = self.inner.write().expect("ip block rwlock poisoned");
            let before = state.cidrs.len();
            state.cidrs.retain(|c| *c != parsed);
            return state.cidrs.len() < before;
        }
        false
    }

    pub fn list_ips(&self) -> Vec<IpAddr> {
        let state = self.inner.read().expect("ip block rwlock poisoned");
        state.exact.iter().copied().collect()
    }

    pub fn list_cidrs(&self) -> Vec<String> {
        let state = self.inner.read().expect("ip block rwlock poisoned");
        state
            .cidrs
            .iter()
            .map(|(ip, prefix)| format!("{ip}/{prefix}"))
            .collect()
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.inner.write().expect("ip block rwlock poisoned");
        state.enabled = enabled;
    }

    pub fn set_block_vpn(&self, block: bool) {
        let mut state = self.inner.write().expect("ip block rwlock poisoned");
        state.block_vpn = block;
    }

    pub fn set_block_datacenter(&self, block: bool) {
        let mut state = self.inner.write().expect("ip block rwlock poisoned");
        state.block_datacenter = block;
    }

    pub async fn refresh_feeds(
        &self,
        http_client: &reqwest::Client,
        config: &IpBlockConfig,
    ) -> (usize, usize) {
        let vpn_count = if config.block_vpn {
            match fetch_cidr_list(http_client, &config.vpn_feed_url).await {
                Ok(cidrs) => {
                    let count = cidrs.len();
                    let mut state = self.inner.write().expect("ip block rwlock poisoned");
                    state.vpn_feed_cidrs = cidrs;
                    state.last_feed_update = Some(Instant::now());
                    info!("IP block: loaded {count} VPN CIDRs from feed");
                    count
                }
                Err(err) => {
                    warn!("IP block: failed to fetch VPN feed from {}: {err}", config.vpn_feed_url);
                    0
                }
            }
        } else {
            0
        };

        let datacenter_count = if config.block_datacenter {
            match fetch_cidr_list(http_client, &config.datacenter_feed_url).await {
                Ok(cidrs) => {
                    let count = cidrs.len();
                    let mut state = self.inner.write().expect("ip block rwlock poisoned");
                    state.datacenter_feed_cidrs = cidrs;
                    state.last_feed_update = Some(Instant::now());
                    info!("IP block: loaded {count} datacenter CIDRs from feed");
                    count
                }
                Err(err) => {
                    warn!(
                        "IP block: failed to fetch datacenter feed from {}: {err}",
                        config.datacenter_feed_url
                    );
                    0
                }
            }
        } else {
            0
        };

        (vpn_count, datacenter_count)
    }

    pub fn feed_stats(&self) -> FeedStats {
        let state = self.inner.read().expect("ip block rwlock poisoned");
        FeedStats {
            vpn_cidrs: state.vpn_feed_cidrs.len(),
            datacenter_cidrs: state.datacenter_feed_cidrs.len(),
            last_updated_seconds_ago: state.last_feed_update.map(|t| t.elapsed().as_secs()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStats {
    pub vpn_cidrs: usize,
    pub datacenter_cidrs: usize,
    pub last_updated_seconds_ago: Option<u64>,
}

pub async fn start_feed_refresh_task(
    ip_block: IpBlockList,
    http_client: reqwest::Client,
    config: IpBlockConfig,
) {
    if !config.enabled || (!config.block_vpn && !config.block_datacenter) {
        return;
    }

    ip_block.refresh_feeds(&http_client, &config).await;

    if config.feed_refresh_interval_seconds == 0 {
        return;
    }

    let interval = Duration::from_secs(config.feed_refresh_interval_seconds);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            ip_block.refresh_feeds(&http_client, &config).await;
        }
    });
}

impl Default for IpBlockList {
    fn default() -> Self {
        Self::new(&IpBlockConfig::default())
    }
}

async fn fetch_cidr_list(
    client: &reqwest::Client,
    url: &str,
) -> anyhow::Result<Vec<(IpAddr, u8)>> {
    let text = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    let cidrs = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_cidr)
        .collect();
    Ok(cidrs)
}

fn parse_cidr(cidr: &str) -> Option<(IpAddr, u8)> {
    let (ip_str, prefix_str) = cidr.split_once('/')?;
    let ip = IpAddr::from_str(ip_str.trim()).ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    let max_prefix = match ip {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    };
    if prefix > max_prefix {
        return None;
    }
    Some((ip, prefix))
}

fn cidr_contains(network: IpAddr, prefix: u8, ip: IpAddr) -> bool {
    match (network, ip) {
        (IpAddr::V4(net), IpAddr::V4(addr)) => {
            if prefix == 0 {
                return true;
            }
            let mask = u32::MAX << (32 - prefix);
            (u32::from(net) & mask) == (u32::from(addr) & mask)
        }
        (IpAddr::V6(net), IpAddr::V6(addr)) => {
            if prefix == 0 {
                return true;
            }
            let net_bits = u128::from(net);
            let addr_bits = u128::from(addr);
            let mask = u128::MAX << (128 - prefix);
            (net_bits & mask) == (addr_bits & mask)
        }
        _ => false,
    }
}

pub fn normalize_ip_str(s: &str) -> Option<IpAddr> {
    IpAddr::from_str(s.trim()).ok()
}