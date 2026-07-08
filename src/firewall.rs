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

pub fn ensure_ports_open(cfg: &FirewallConfig, listeners: &[ListenerRule]) {
    if !cfg.enabled || cfg.mode == FirewallMode::Off {
        debug!("Firewall auto-config disabled by config; skipping");
        return;
    }

    let backend = match select_backend(cfg.mode) {
        Some(b) => b,
        None => {
            info!(
                "Firewall auto-config: no supported backend detected on this host. \
                 Ports are NOT auto-opened -- if you can't connect from outside, \
                 open the listener ports manually."
            );
            return;
        }
    };

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
    match Command::new("id").arg("-u").output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim() == "0",
        _ => false,
    }
}

fn ensure_port(backend: Backend, proto: Protocol, port: u16) {
    // nftables はホストごとにテーブル/チェーン構成が大きく異なる
    // (`inet filter input` があるとは限らず、iptables-nft 互換だと
    //  `ip filter INPUT` だったり、そもそも input フックのチェーンが無いこともある)。
    // ハードコードせず、実際の ruleset から input フックの base chain を検出して
    // そこに追加する。
    #[cfg(target_os = "linux")]
    if backend == Backend::Nftables {
        ensure_port_nftables(proto, port);
        return;
    }

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

#[cfg(target_os = "linux")]
fn is_ufw_active() -> bool {
    if !tool_exists("ufw") {
        return false;
    }
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
    match Command::new("nft").args(["list", "ruleset"]).output() {
        Ok(out) => out.status.success() && !out.stdout.is_empty(),
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct NftChain {
    family: String,
    table: String,
    chain: String,
}

/// 実行中の nftables ruleset から、input フックを持つ L3 base chain
/// (family が ip / ip6 / inet のもの) を列挙する。
///
/// これにより `inet filter input` をハードコードせず、ホストが実際に
/// 持っているチェーン (例: iptables-nft 互換の `ip filter INPUT`) を
/// 対象にできる。IPv4 と IPv6 でチェーンが分かれている場合は両方に追加する。
#[cfg(target_os = "linux")]
fn nft_input_chains() -> Vec<NftChain> {
    let out = match Command::new("nft").args(["-j", "list", "ruleset"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut chains = Vec::new();
    let Some(items) = json.get("nftables").and_then(|v| v.as_array()) else {
        return chains;
    };
    for item in items {
        let Some(chain) = item.get("chain") else {
            continue;
        };
        // base chain のみ "hook" フィールドを持つ (regular chain には無い)。
        if chain.get("hook").and_then(|h| h.as_str()) != Some("input") {
            continue;
        }
        let (Some(family), Some(table), Some(name)) = (
            chain.get("family").and_then(|v| v.as_str()),
            chain.get("table").and_then(|v| v.as_str()),
            chain.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        // L3 のみ対象 (netdev/bridge/arp の input フックは対象外)。
        if !matches!(family, "ip" | "ip6" | "inet") {
            continue;
        }
        chains.push(NftChain {
            family: family.to_string(),
            table: table.to_string(),
            chain: name.to_string(),
        });
    }
    chains
}

#[cfg(target_os = "linux")]
fn nft_rule_exists(c: &NftChain, proto: &str, port: u16) -> anyhow::Result<bool> {
    let out = Command::new("nft")
        .args(["list", "chain", &c.family, &c.table, &c.chain])
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "nft list chain {} {} {} failed: {}",
            c.family,
            c.table,
            c.chain,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!("{proto} dport {port} accept");
    Ok(text.contains(&needle))
}

#[cfg(target_os = "linux")]
fn ensure_port_nftables(proto: Protocol, port: u16) {
    let p = proto_str(proto);
    let chains = nft_input_chains();
    if chains.is_empty() {
        info!(
            "Firewall: nftables に input フックの base chain が無いため {p}/{port} は \
             input フィルタ対象外 (既に到達可能)。何もしません。"
        );
        return;
    }
    for c in &chains {
        // ドロップポリシー/末尾の drop ルールに負けないよう先頭に insert する。
        let manual = format!(
            "sudo nft insert rule {} {} {} {p} dport {port} accept",
            c.family, c.table, c.chain
        );
        match nft_rule_exists(c, p, port) {
            Ok(true) => info!(
                "Firewall: {p}/{port} は nftables ({} {} {}) に既に存在。そのまま。",
                c.family, c.table, c.chain
            ),
            Ok(false) => {
                let out = Command::new("nft")
                    .args([
                        "insert",
                        "rule",
                        &c.family,
                        &c.table,
                        &c.chain,
                        p,
                        "dport",
                        &port.to_string(),
                        "accept",
                    ])
                    .output();
                match out {
                    Ok(o) if o.status.success() => info!(
                        "Firewall: opened {p}/{port} via nftables ({} {} {})",
                        c.family, c.table, c.chain
                    ),
                    Ok(o) => warn!(
                        "Firewall: failed to open {p}/{port} in nftables ({} {} {}): {}. Run manually:\n    {manual}",
                        c.family,
                        c.table,
                        c.chain,
                        String::from_utf8_lossy(&o.stderr).trim()
                    ),
                    Err(err) => warn!(
                        "Firewall: failed to run nft for {p}/{port} ({} {} {}): {err}. Run manually:\n    {manual}",
                        c.family, c.table, c.chain
                    ),
                }
            }
            Err(err) => warn!(
                "Firewall: could not verify nftables rule for {p}/{port} in ({} {} {}): {err}. \
                 Skipping to avoid duplicates. Add manually if needed:\n    {manual}",
                c.family, c.table, c.chain
            ),
        }
    }
}

#[cfg(target_os = "linux")]
fn tool_exists(name: &str) -> bool {
    matches!(
        Command::new("which").arg(name).output(),
        Ok(out) if out.status.success()
    )
}

fn rule_exists(backend: Backend, proto: Protocol, port: u16) -> anyhow::Result<bool> {
    match backend {
        Backend::Iptables => {
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
            let out = Command::new("ufw").arg("status").output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let needle = format!("{port}/{}", proto_str(proto));
            Ok(text.contains(&needle))
        }
        Backend::Firewalld => {
            let out = Command::new("firewall-cmd")
                .args([&format!("--query-port={port}/{}", proto_str(proto))])
                .output()?;
            Ok(out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "yes")
        }
        Backend::Nftables => {
            let out = Command::new("nft").args(["list", "ruleset"]).output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let needle = format!("{} dport {port} accept", proto_str(proto));
            Ok(text.contains(&needle))
        }
        Backend::Netsh => {
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
            Ok(out.status.success())
        }
    }
}

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
            c.args([&format!("--add-port={port}/{p}")]);
            c
        }
        Backend::Nftables => {
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
