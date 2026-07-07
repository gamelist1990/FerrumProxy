use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::config::{ListenerRule, Protocol};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FirewallConfig {
    pub enabled: bool,

    pub mode: FirewallMode,
}

impl Default for FirewallConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: FirewallMode::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FirewallMode {
    Auto,
    Off,
    Ufw,
    Firewalld,
    Iptables,
    Nftables,
    Netsh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    Ufw,
    Firewalld,
    Iptables,
    Nftables,
    Netsh,
}

impl Backend {
    fn name(self) -> &'static str {
        match self {
            Backend::Ufw => "ufw",
            Backend::Firewalld => "firewalld",
            Backend::Iptables => "iptables",
            Backend::Nftables => "nftables",
            Backend::Netsh => "netsh (Windows Defender Firewall)",
        }
    }
}

/// Entry point called once from `main` before we spawn listeners.
///
/// Iterates every listener and opens the required TCP/UDP ports. Any failure
/// on an individual port is logged as a warning but does NOT abort startup --
/// the proxy is more useful up-and-shouting-at-you than down entirely.
pub fn ensure_ports_open(cfg: &FirewallConfig, listeners: &[ListenerRule]) {
    if !cfg.enabled || cfg.mode == FirewallMode::Off {
        debug!("Firewall auto-config disabled by config; skipping");
        return;
    }

    let backend = match select_backend(cfg.mode) {
        Some(b) => b,
        None => {
            // On macOS or a host with no supported tool we just print a
            // helpful hint and move on -- users on those platforms typically
            // manage firewalls themselves.
            info!(
                "Firewall auto-config: no supported backend detected on this host. \
                 Ports are NOT auto-opened -- if you can't connect from outside, \
                 open the listener ports manually."
            );
            return;
        }
    };

    // On Linux the tools all need root. If we're not root, don't fail -- just
    // print the exact commands the user should run.
    #[cfg(unix)]
    let need_privilege_hint = !is_root() && backend != Backend::Netsh;
    #[cfg(not(unix))]
    let need_privilege_hint = false;

    if need_privilege_hint {
        warn!(
            "Firewall auto-config: detected {} but FerrumProxy is not running as root. \
             Ports will NOT be opened automatically. Manual commands follow:",
            backend.name()
        );
        for rule in listeners {
            emit_manual_commands(backend, rule);
        }
        return;
    }

    info!(
        "Firewall auto-config: using {} to ensure listener ports are open",
        backend.name()
    );

    for rule in listeners {
        if let Some(port) = rule.tcp {
            ensure_port(backend, Protocol::Tcp, port);
        }
        if let Some(port) = rule.udp {
            ensure_port(backend, Protocol::Udp, port);
        }
    }
}

fn select_backend(mode: FirewallMode) -> Option<Backend> {
    match mode {
        FirewallMode::Off => None,
        FirewallMode::Ufw => Some(Backend::Ufw),
        FirewallMode::Firewalld => Some(Backend::Firewalld),
        FirewallMode::Iptables => Some(Backend::Iptables),
        FirewallMode::Nftables => Some(Backend::Nftables),
        FirewallMode::Netsh => Some(Backend::Netsh),
        FirewallMode::Auto => auto_detect(),
    }
}

fn auto_detect() -> Option<Backend> {
    #[cfg(target_os = "windows")]
    {
        return Some(Backend::Netsh);
    }
    #[cfg(target_os = "linux")]
    {
        // Priority: ufw (only if active) > firewalld (if active) > nftables
        // (only if any ruleset is loaded) > iptables (fallback).
        if is_ufw_active() {
            return Some(Backend::Ufw);
        }
        if is_firewalld_active() {
            return Some(Backend::Firewalld);
        }
        if is_nftables_active() {
            return Some(Backend::Nftables);
        }
        if tool_exists("iptables") {
            return Some(Backend::Iptables);
        }
        return None;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

#[cfg(unix)]
fn is_root() -> bool {
    // Standard POSIX check: uid 0 is root. We avoid pulling in libc for this
    // one call by shelling out to `id -u`; it's called once at startup so the
    // cost is trivial.
    match Command::new("id").arg("-u").output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() == "0",
        _ => false,
    }
}

fn ensure_port(backend: Backend, proto: Protocol, port: u16) {
    match rule_exists(backend, proto, port) {
        Ok(true) => {
            info!(
                "Firewall: {}/{port} already open in {}; leaving existing rule alone",
                proto_str(proto),
                backend.name()
            );
        }
        Ok(false) => match add_rule(backend, proto, port) {
            Ok(()) => info!(
                "Firewall: opened {}/{port} via {}",
                proto_str(proto),
                backend.name()
            ),
            Err(err) => warn!(
                "Firewall: failed to open {}/{port} via {}: {err}. Run manually:\n    {}",
                proto_str(proto),
                backend.name(),
                manual_add_command(backend, proto, port)
            ),
        },
        Err(err) => warn!(
            "Firewall: could not verify rule for {}/{port} on {}: {err}. \
             Skipping to avoid duplicate rules. Add manually if needed:\n    {}",
            proto_str(proto),
            backend.name(),
            manual_add_command(backend, proto, port)
        ),
    }
}

fn proto_str(p: Protocol) -> &'static str {
    match p {
        Protocol::Tcp => "tcp",
        Protocol::Udp => "udp",
    }
}

// ---------------------------------------------------------------------------
// Backend probes
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn is_ufw_active() -> bool {
    if !tool_exists("ufw") {
        return false;
    }
    // `ufw status` prints "Status: active" when enabled. Requires root to be
    // 100% accurate, but the string still shows up even under `sudo -n` fails.
    match Command::new("ufw").arg("status").output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains("Status: active"),
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn is_firewalld_active() -> bool {
    if !tool_exists("firewall-cmd") {
        return false;
    }
    match Command::new("firewall-cmd").arg("--state").output() {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "running",
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn is_nftables_active() -> bool {
    if !tool_exists("nft") {
        return false;
    }
    // If `nft list ruleset` returns non-empty output, treat as active.
    match Command::new("nft").args(["list", "ruleset"]).output() {
        Ok(out) => out.status.success() && !out.stdout.is_empty(),
        Err(_) => false,
    }
}

// Only used by Linux backend probes. On Windows we go straight to netsh.
#[cfg(target_os = "linux")]
fn tool_exists(name: &str) -> bool {
    matches!(
        Command::new("which").arg(name).output(),
        Ok(out) if out.status.success()
    )
}

// ---------------------------------------------------------------------------
// Idempotency: does a rule for this (proto, port) already exist?
// ---------------------------------------------------------------------------

fn rule_exists(backend: Backend, proto: Protocol, port: u16) -> anyhow::Result<bool> {
    match backend {
        Backend::Iptables => {
            // `iptables -C INPUT ...` returns 0 if the rule exists, non-zero
            // otherwise. Stderr is noise on "not found" -- suppress it.
            let status = Command::new("iptables")
                .args([
                    "-C",
                    "INPUT",
                    "-p",
                    proto_str(proto),
                    "--dport",
                    &port.to_string(),
                    "-j",
                    "ACCEPT",
                ])
                .stderr(Stdio::null())
                .stdout(Stdio::null())
                .status()?;
            Ok(status.success())
        }
        Backend::Ufw => {
            // `ufw status numbered` lists rules; grep for `port/proto`.
            let out = Command::new("ufw").arg("status").output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let needle = format!("{port}/{}", proto_str(proto));
            Ok(text.contains(&needle))
        }
        Backend::Firewalld => {
            let out = Command::new("firewall-cmd")
                .args([&format!("--query-port={port}/{}", proto_str(proto))])
                .output()?;
            // firewall-cmd --query-port prints "yes" and exits 0 when present.
            Ok(out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "yes")
        }
        Backend::Nftables => {
            // Check if our marker rule is present in the ruleset dump.
            let out = Command::new("nft").args(["list", "ruleset"]).output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let needle = format!("{} dport {port} accept", proto_str(proto));
            Ok(text.contains(&needle))
        }
        Backend::Netsh => {
            // Look up by our stable rule name.
            let name = netsh_rule_name(proto, port);
            let out = Command::new("netsh")
                .args([
                    "advfirewall",
                    "firewall",
                    "show",
                    "rule",
                    &format!("name={name}"),
                ])
                .output()?;
            // netsh prints "No rules match" (localised!) and exits 1 when the
            // rule doesn't exist. Success == exists.
            Ok(out.status.success())
        }
    }
}

// ---------------------------------------------------------------------------
// Rule addition
// ---------------------------------------------------------------------------

fn add_rule(backend: Backend, proto: Protocol, port: u16) -> anyhow::Result<()> {
    let mut cmd = build_add_command(backend, proto, port);
    let out = cmd.output()?;
    if !out.status.success() {
        anyhow::bail!(
            "{} exited with status {}: {}",
            backend.name(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

fn build_add_command(backend: Backend, proto: Protocol, port: u16) -> Command {
    let p = proto_str(proto);
    match backend {
        Backend::Iptables => {
            let mut c = Command::new("iptables");
            c.args([
                "-A",
                "INPUT",
                "-p",
                p,
                "--dport",
                &port.to_string(),
                "-j",
                "ACCEPT",
            ]);
            c
        }
        Backend::Ufw => {
            let mut c = Command::new("ufw");
            c.args(["allow", &format!("{port}/{p}")]);
            c
        }
        Backend::Firewalld => {
            let mut c = Command::new("firewall-cmd");
            // --permanent survives reboots; then --reload for immediate effect.
            // We chain them via two Commands in add_rule if needed; for now the
            // single call gets us running until next reboot. Users who want
            // persistence can re-run with the config or add `--permanent`
            // themselves.
            c.args([&format!("--add-port={port}/{p}")]);
            c
        }
        Backend::Nftables => {
            // Insert into the inet filter input chain if it exists; users on
            // stock nftables setups typically have `table inet filter` with
            // chain `input`. If not, this will fail loudly and we log the hint.
            let mut c = Command::new("nft");
            c.args([
                "add",
                "rule",
                "inet",
                "filter",
                "input",
                p,
                "dport",
                &port.to_string(),
                "accept",
            ]);
            c
        }
        Backend::Netsh => {
            let name = netsh_rule_name(proto, port);
            let mut c = Command::new("netsh");
            c.args(["advfirewall", "firewall", "add", "rule"]);
            // The next 4 args have interior `=` so we push them as owned strs.
            c.arg(format!("name={name}"));
            c.arg("dir=in");
            c.arg("action=allow");
            c.arg(format!("protocol={}", p.to_uppercase()));
            c.arg(format!("localport={port}"));
            c
        }
    }
}

fn netsh_rule_name(proto: Protocol, port: u16) -> String {
    format!("FerrumProxy-{}-{port}", proto_str(proto))
}

// ---------------------------------------------------------------------------
// Human-friendly manual command hints
// ---------------------------------------------------------------------------

fn manual_add_command(backend: Backend, proto: Protocol, port: u16) -> String {
    let p = proto_str(proto);
    match backend {
        Backend::Iptables => format!("sudo iptables -A INPUT -p {p} --dport {port} -j ACCEPT"),
        Backend::Ufw => format!("sudo ufw allow {port}/{p}"),
        Backend::Firewalld => format!(
            "sudo firewall-cmd --add-port={port}/{p} --permanent && sudo firewall-cmd --reload"
        ),
        Backend::Nftables => format!("sudo nft add rule inet filter input {p} dport {port} accept"),
        Backend::Netsh => {
            let name = netsh_rule_name(proto, port);
            format!(
                "netsh advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol={} localport={port}",
                p.to_uppercase()
            )
        }
    }
}

fn emit_manual_commands(backend: Backend, rule: &ListenerRule) {
    if let Some(port) = rule.tcp {
        warn!("    {}", manual_add_command(backend, Protocol::Tcp, port));
    }
    if let Some(port) = rule.udp {
        warn!("    {}", manual_add_command(backend, Protocol::Udp, port));
    }
}
