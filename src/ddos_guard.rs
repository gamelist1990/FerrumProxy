use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tracing::warn;

const VIOLATION_DECAY_AFTER: Duration = Duration::from_secs(30);
const TEMP_BLOCK_AFTER_VIOLATIONS: u32 = 24;
const TEMP_BLOCK_BASE: Duration = Duration::from_secs(20);
const TEMP_BLOCK_MAX: Duration = Duration::from_secs(10 * 60);
const IDLE_STATE_RETENTION: Duration = Duration::from_secs(10 * 60);

/// Tunable DDoS-guard thresholds.
///
/// Defaults are relaxed enough for HTTP/HTTPS reverse-proxy use — a browser
/// opens many parallel connections to load a single page, so the previous
/// 12 conn/s limit dropped legitimate asset/XHR connections and left pages
/// rendering without their body. UDP defaults stay sized for real-time gaming.
#[derive(Debug, Clone)]
pub struct DdosGuardSettings {
    pub enabled: bool,
    pub tcp_max_active_per_ip: usize,
    pub tcp_new_connections_per_second: f64,
    pub tcp_new_connection_burst: f64,
    pub udp_packets_per_second: f64,
    pub udp_packet_burst: f64,
    pub udp_bytes_per_second: f64,
    pub udp_byte_burst: f64,
    pub udp_max_datagram_bytes: usize,
}

impl Default for DdosGuardSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            tcp_max_active_per_ip: 256,
            tcp_new_connections_per_second: 100.0,
            tcp_new_connection_burst: 500.0,
            udp_packets_per_second: 240.0,
            udp_packet_burst: 480.0,
            udp_bytes_per_second: 2.0 * 1024.0 * 1024.0,
            udp_byte_burst: 4.0 * 1024.0 * 1024.0,
            udp_max_datagram_bytes: 8 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct DdosGuard {
    inner: Arc<Mutex<HashMap<IpAddr, IpProtectionState>>>,
    settings: Arc<DdosGuardSettings>,
}

impl Default for DdosGuard {
    fn default() -> Self {
        Self::new(DdosGuardSettings::default())
    }
}

impl DdosGuard {
    pub fn new(settings: DdosGuardSettings) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            settings: Arc::new(settings),
        }
    }

    pub fn tcp_connection_opened(&self, ip: IpAddr) -> Result<TcpConnectionPermit, DropReason> {
        // Guard disabled: hand back an inert permit that does not track state.
        if !self.settings.enabled {
            return Ok(TcpConnectionPermit {
                ip,
                guard: self.clone(),
                released: true,
            });
        }

        let now = Instant::now();
        let mut guard = self.inner.lock().expect("ddos guard mutex poisoned");
        prune_idle_states(&mut guard, now);

        let settings = &self.settings;
        let state = guard
            .entry(ip)
            .or_insert_with(|| IpProtectionState::new(now, settings));
        if let Some(reason) = state.block_reason(now) {
            return Err(reason);
        }

        if state.active_tcp_connections >= settings.tcp_max_active_per_ip {
            return Err(state.record_violation(now, DropReason::TcpActiveConnectionLimit));
        }

        if !state.tcp_new_connections.consume(1.0, now) {
            return Err(state.record_violation(now, DropReason::TcpNewConnectionRateLimit));
        }

        state.active_tcp_connections += 1;
        state.last_seen = now;
        Ok(TcpConnectionPermit {
            ip,
            guard: self.clone(),
            released: false,
        })
    }

    pub fn udp_datagram_allowed(&self, ip: IpAddr, bytes: usize) -> Result<(), DropReason> {
        if !self.settings.enabled {
            return Ok(());
        }

        let now = Instant::now();
        let mut guard = self.inner.lock().expect("ddos guard mutex poisoned");
        prune_idle_states(&mut guard, now);

        let settings = &self.settings;
        let state = guard
            .entry(ip)
            .or_insert_with(|| IpProtectionState::new(now, settings));
        if let Some(reason) = state.block_reason(now) {
            return Err(reason);
        }

        if bytes > settings.udp_max_datagram_bytes {
            return Err(state.record_violation(now, DropReason::UdpDatagramTooLarge));
        }

        if !state.udp_packets.consume(1.0, now) {
            return Err(state.record_violation(now, DropReason::UdpPacketRateLimit));
        }

        if !state.udp_bytes.consume(bytes as f64, now) {
            return Err(state.record_violation(now, DropReason::UdpByteRateLimit));
        }

        state.last_seen = now;
        Ok(())
    }

    fn tcp_connection_closed(&self, ip: IpAddr) {
        let mut guard = self.inner.lock().expect("ddos guard mutex poisoned");
        let Some(state) = guard.get_mut(&ip) else {
            return;
        };
        state.active_tcp_connections = state.active_tcp_connections.saturating_sub(1);
        state.last_seen = Instant::now();
    }
}

pub struct TcpConnectionPermit {
    ip: IpAddr,
    guard: DdosGuard,
    released: bool,
}

impl Drop for TcpConnectionPermit {
    fn drop(&mut self) {
        if !self.released {
            self.guard.tcp_connection_closed(self.ip);
            self.released = true;
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum DropReason {
    TemporarilyBlocked,
    TcpActiveConnectionLimit,
    TcpNewConnectionRateLimit,
    UdpPacketRateLimit,
    UdpByteRateLimit,
    UdpDatagramTooLarge,
}

impl DropReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TemporarilyBlocked => "temporarily_blocked",
            Self::TcpActiveConnectionLimit => "tcp_active_connection_limit",
            Self::TcpNewConnectionRateLimit => "tcp_new_connection_rate_limit",
            Self::UdpPacketRateLimit => "udp_packet_rate_limit",
            Self::UdpByteRateLimit => "udp_byte_rate_limit",
            Self::UdpDatagramTooLarge => "udp_datagram_too_large",
        }
    }
}

struct IpProtectionState {
    active_tcp_connections: usize,
    tcp_new_connections: TokenBucket,
    udp_packets: TokenBucket,
    udp_bytes: TokenBucket,
    violations: u32,
    last_violation: Option<Instant>,
    temporary_block_until: Option<Instant>,
    last_seen: Instant,
}

impl IpProtectionState {
    fn new(now: Instant, settings: &DdosGuardSettings) -> Self {
        Self {
            active_tcp_connections: 0,
            tcp_new_connections: TokenBucket::new(
                settings.tcp_new_connections_per_second,
                settings.tcp_new_connection_burst,
                now,
            ),
            udp_packets: TokenBucket::new(
                settings.udp_packets_per_second,
                settings.udp_packet_burst,
                now,
            ),
            udp_bytes: TokenBucket::new(
                settings.udp_bytes_per_second,
                settings.udp_byte_burst,
                now,
            ),
            violations: 0,
            last_violation: None,
            temporary_block_until: None,
            last_seen: now,
        }
    }

    fn block_reason(&mut self, now: Instant) -> Option<DropReason> {
        if self.temporary_block_until.is_some_and(|until| until > now) {
            self.last_seen = now;
            return Some(DropReason::TemporarilyBlocked);
        }
        self.temporary_block_until = None;
        None
    }

    fn record_violation(&mut self, now: Instant, reason: DropReason) -> DropReason {
        if self
            .last_violation
            .is_none_or(|last| now.duration_since(last) > VIOLATION_DECAY_AFTER)
        {
            self.violations = 0;
        }

        self.violations = self.violations.saturating_add(1);
        self.last_violation = Some(now);
        self.last_seen = now;

        if self.violations >= TEMP_BLOCK_AFTER_VIOLATIONS {
            let multiplier = self.violations.saturating_sub(TEMP_BLOCK_AFTER_VIOLATIONS) + 1;
            let block_for = TEMP_BLOCK_BASE
                .saturating_mul(multiplier)
                .min(TEMP_BLOCK_MAX);
            self.temporary_block_until = Some(now + block_for);
            warn!(
                "DDoS guard temporarily blocked IP for {:?} after {} violations; last_reason={}",
                block_for,
                self.violations,
                reason.as_str()
            );
            return DropReason::TemporarilyBlocked;
        }

        reason
    }
}

struct TokenBucket {
    tokens: f64,
    refill_per_second: f64,
    burst: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(refill_per_second: f64, burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            refill_per_second,
            burst,
            last_refill: now,
        }
    }

    fn consume(&mut self, amount: f64, now: Instant) -> bool {
        self.refill(now);
        if self.tokens < amount {
            return false;
        }
        self.tokens -= amount;
        true
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        if elapsed <= 0.0 {
            return;
        }
        self.tokens = (self.tokens + elapsed * self.refill_per_second).min(self.burst);
        self.last_refill = now;
    }
}

fn prune_idle_states(states: &mut HashMap<IpAddr, IpProtectionState>, now: Instant) {
    states.retain(|_, state| {
        state.active_tcp_connections > 0
            || state
                .temporary_block_until
                .is_some_and(|blocked_until| blocked_until > now)
            || now.duration_since(state.last_seen) < IDLE_STATE_RETENTION
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_active_connections_are_limited_per_ip() {
        let limit = DdosGuardSettings::default().tcp_max_active_per_ip;
        let guard = DdosGuard::default();
        let ip = "192.0.2.10".parse().unwrap();
        let mut permits = Vec::new();

        for _ in 0..limit {
            permits.push(guard.tcp_connection_opened(ip).unwrap());
        }

        let denied = match guard.tcp_connection_opened(ip) {
            Ok(_) => panic!("connection above active limit was allowed"),
            Err(reason) => reason,
        };
        assert!(matches!(denied, DropReason::TcpActiveConnectionLimit));

        drop(permits.pop());
        assert!(guard.tcp_connection_opened(ip).is_ok());
    }

    #[test]
    fn oversized_udp_datagrams_are_dropped() {
        let max = DdosGuardSettings::default().udp_max_datagram_bytes;
        let guard = DdosGuard::default();
        let ip = "192.0.2.20".parse().unwrap();

        let denied = match guard.udp_datagram_allowed(ip, max + 1) {
            Ok(()) => panic!("oversized UDP datagram was allowed"),
            Err(reason) => reason,
        };
        assert!(matches!(denied, DropReason::UdpDatagramTooLarge));
    }

    #[test]
    fn disabled_guard_allows_everything() {
        let guard = DdosGuard::new(DdosGuardSettings {
            enabled: false,
            tcp_max_active_per_ip: 1,
            tcp_new_connections_per_second: 1.0,
            tcp_new_connection_burst: 1.0,
            ..DdosGuardSettings::default()
        });
        let ip = "192.0.2.30".parse().unwrap();
        // Far beyond the (tiny) configured limits, but the guard is disabled.
        for _ in 0..50 {
            assert!(guard.tcp_connection_opened(ip).is_ok());
        }
        assert!(guard.udp_datagram_allowed(ip, 10 * 1024 * 1024).is_ok());
    }
}
