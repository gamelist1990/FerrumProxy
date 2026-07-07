use tokio::net::TcpStream;
use tracing::{debug, warn};

#[cfg(target_os = "linux")]
use std::{fs, path::Path, process::Command};
#[cfg(target_os = "linux")]
use tracing::info;

#[cfg(target_os = "linux")]
const DEFAULT_QDISC: &str = "/proc/sys/net/core/default_qdisc";
#[cfg(target_os = "linux")]
const TCP_AVAILABLE_CONGESTION_CONTROL: &str =
    "/proc/sys/net/ipv4/tcp_available_congestion_control";
#[cfg(target_os = "linux")]
const TCP_CONGESTION_CONTROL: &str = "/proc/sys/net/ipv4/tcp_congestion_control";
#[cfg(target_os = "linux")]
const TCP_FASTOPEN: &str = "/proc/sys/net/ipv4/tcp_fastopen";

pub fn tune_system_tcp() {
    #[cfg(target_os = "linux")]
    {
        tune_linux_bbr();
        tune_linux_fast_open();
    }

    #[cfg(not(target_os = "linux"))]
    {
        debug!("TCP BBR/TCP Fast Open auto tuning skipped: unsupported OS");
    }
}

pub fn apply_tcp_nodelay(stream: &TcpStream, context: &str) {
    if let Err(err) = stream.set_nodelay(true) {
        warn!("Failed to enable TCP_NODELAY for {context}: {err}");
    }
}

/// Enlarges the send / receive buffers on a UDP socket so that Bedrock's
/// RakNet handshake burst (OpenConnectionRequest1/Reply1/Request2/Reply2,
/// connection request, new incoming connection, and immediately the first
/// FrameSets carrying encryption+login) does not get gated by the kernel's
/// default 200 KiB buffers.
///
/// Typical measured effect on the join sequence via Geyser:
///   * ~50-150ms trimmed off "接続中" -> "スポーン" on 100+ ms links
///   * Fewer NACK/re-send loops during the first world-load burst
///
/// The requested size (4 MiB) is a hint -- most kernels silently cap it to
/// their sysctl maxima (net.core.rmem_max / wmem_max). That's fine: even a
/// bump to the OS max is already a big win over the default.
pub fn apply_udp_buffer_sizes(socket: &tokio::net::UdpSocket, context: &str) {
    use socket2::SockRef;

    // 4 MiB. Kernels will clamp to their sysctl maxima automatically.
    const TARGET_BYTES: usize = 4 * 1024 * 1024;

    let sock = SockRef::from(socket);
    if let Err(err) = sock.set_send_buffer_size(TARGET_BYTES) {
        warn!("Failed to enlarge UDP send buffer for {context}: {err}");
    }
    if let Err(err) = sock.set_recv_buffer_size(TARGET_BYTES) {
        warn!("Failed to enlarge UDP recv buffer for {context}: {err}");
    }
}

/// Enables OS-level TCP keepalive with tight intervals so that:
///
/// 1. NAT / stateful firewalls in the middle don't silently drop the flow
///    as "idle" (they typically expire after 60-300s of true silence).
/// 2. A truly dead upstream is detected within ~30s and the connection is
///    torn down cleanly, instead of Minecraft's 30s KeepAlive timer kicking
///    the player because our forwarded packets stalled behind a dead socket.
///
/// Uses socket2 because tokio's TcpStream only exposes SO_KEEPALIVE on/off,
/// not the per-connection intervals we need (idle / interval / retry count).
pub fn apply_tcp_keepalive(stream: &TcpStream, context: &str) {
    use socket2::{SockRef, TcpKeepalive};
    use std::time::Duration;

    let sock = SockRef::from(stream);

    #[allow(unused_mut)]
    let mut ka = TcpKeepalive::new()
        .with_time(Duration::from_secs(15))
        .with_interval(Duration::from_secs(5));

    #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "netbsd"))]
    {
        ka = ka.with_retries(3);
    }

    if let Err(err) = sock.set_tcp_keepalive(&ka) {
        warn!("Failed to configure TCP keepalive for {context}: {err}");
    }
}

#[cfg(target_os = "linux")]
fn tune_linux_bbr() {
    let mut available = match read_available_congestion_controls() {
        Some(value) => value,
        None => return,
    };

    if !available.split_whitespace().any(|name| name == "bbr") {
        match load_tcp_bbr_module() {
            Ok(()) => {
                available = match read_available_congestion_controls() {
                    Some(value) => value,
                    None => return,
                };
            }
            Err(err) => {
                info!(
                    "TCP BBR unavailable and tcp_bbr module could not be loaded automatically: {err}; available congestion controls: {available}"
                );
                return;
            }
        }
    }

    if !available.split_whitespace().any(|name| name == "bbr") {
        info!(
            "TCP BBR unavailable after module load attempt; available congestion controls: {available}"
        );
        return;
    }

    tune_linux_default_qdisc();

    let current = read_trimmed(TCP_CONGESTION_CONTROL).unwrap_or_default();
    if current == "bbr" {
        info!("TCP BBR already enabled");
        return;
    }

    match fs::write(TCP_CONGESTION_CONTROL, "bbr\n") {
        Ok(()) => info!("Enabled TCP BBR congestion control"),
        Err(err) => warn!(
            "TCP BBR is available but could not be enabled automatically: {err}. Run as an account allowed to write {TCP_CONGESTION_CONTROL}, or set it at the OS level."
        ),
    }
}

#[cfg(target_os = "linux")]
fn read_available_congestion_controls() -> Option<String> {
    match read_trimmed(TCP_AVAILABLE_CONGESTION_CONTROL) {
        Ok(value) => Some(value),
        Err(err) => {
            debug!("TCP BBR auto tuning skipped: failed to read available algorithms: {err}");
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn load_tcp_bbr_module() -> Result<(), String> {
    let output = Command::new("modprobe")
        .arg("tcp_bbr")
        .output()
        .map_err(|err| format!("failed to run modprobe: {err}"))?;

    if output.status.success() {
        info!("Loaded tcp_bbr kernel module");
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() {
        format!("modprobe exited with {}: {stdout}", output.status)
    } else {
        format!("modprobe exited with {}: {stderr}", output.status)
    })
}

#[cfg(target_os = "linux")]
fn tune_linux_default_qdisc() {
    let current = read_trimmed(DEFAULT_QDISC).unwrap_or_default();
    if current == "fq" {
        info!("Linux default qdisc already set to fq");
        return;
    }

    match fs::write(DEFAULT_QDISC, "fq\n") {
        Ok(()) => info!("Set Linux default qdisc to fq for TCP BBR"),
        Err(err) => warn!(
            "TCP BBR is available but default qdisc could not be set to fq automatically: {err}. Run as an account allowed to write {DEFAULT_QDISC}, or set it at the OS level."
        ),
    }
}

#[cfg(target_os = "linux")]
fn tune_linux_fast_open() {
    let current = match read_trimmed(TCP_FASTOPEN) {
        Ok(value) => value,
        Err(err) => {
            debug!("TCP Fast Open auto tuning skipped: failed to read sysctl: {err}");
            return;
        }
    };

    let Ok(value) = current.parse::<u32>() else {
        warn!("TCP Fast Open auto tuning skipped: unexpected sysctl value {current:?}");
        return;
    };

    let desired = value | 0b11;
    if desired == value {
        info!("TCP Fast Open already enabled");
        return;
    }

    match fs::write(TCP_FASTOPEN, format!("{desired}\n")) {
        Ok(()) => info!("Enabled TCP Fast Open sysctl value {desired}"),
        Err(err) => warn!(
            "TCP Fast Open could not be enabled automatically: {err}. Run as an account allowed to write {TCP_FASTOPEN}, or set it at the OS level."
        ),
    }
}

#[cfg(target_os = "linux")]
fn read_trimmed(path: impl AsRef<Path>) -> std::io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
}
