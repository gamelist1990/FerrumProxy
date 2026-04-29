use std::fs;
use std::path::Path;

use tokio::net::TcpStream;
use tracing::{debug, info, warn};

const TCP_AVAILABLE_CONGESTION_CONTROL: &str =
    "/proc/sys/net/ipv4/tcp_available_congestion_control";
const TCP_CONGESTION_CONTROL: &str = "/proc/sys/net/ipv4/tcp_congestion_control";
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

#[cfg(target_os = "linux")]
fn tune_linux_bbr() {
    let available = match read_trimmed(TCP_AVAILABLE_CONGESTION_CONTROL) {
        Ok(value) => value,
        Err(err) => {
            debug!("TCP BBR auto tuning skipped: failed to read available algorithms: {err}");
            return;
        }
    };

    if !available.split_whitespace().any(|name| name == "bbr") {
        info!("TCP BBR unavailable; available congestion controls: {available}");
        return;
    }

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
