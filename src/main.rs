mod bedrock;
mod config;
mod ddos_guard;
mod discord;
mod firewall;
mod http_rewrite;
mod management_api;
mod manager_api;
mod proxy_protocol;
mod runtime;
mod shared_relay;
mod tcp;
mod tcp_tuning;
mod tls_config;
mod token_security;
mod udp;
mod webhook_queue;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use tokio::task::JoinSet;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "ferrum-proxy")]
#[command(about = "Low-latency Rust proxy for Minecraft Bedrock and HTTP/HTTPS forwarding")]
struct Args {
    #[arg(short, long, default_value = "config.yml")]
    config: PathBuf,
    #[arg(long)]
    manager_port: Option<u16>,
    #[arg(long, env = "FERRUMPROXY_MANAGER_TOKEN")]
    manager_token: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    install_rustls_crypto_provider();

    let args = Args::parse();
    let cfg = config::ProxyConfig::load(&args.config)?;
    let filter = if cfg.debug {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();
    tcp_tuning::tune_system_tcp();

    firewall::ensure_ports_open(&cfg.firewall, &cfg.listeners);

    let webhooks = cfg
        .listeners
        .iter()
        .filter_map(|rule| rule.webhook.clone())
        .filter(|webhook| !webhook.trim().is_empty())
        .collect::<Vec<_>>();
    let high_latency = cfg.high_latency.clone();
    if high_latency.enabled {
        info!(
            "High-latency mode ENABLED: initial_client_data={} ms, connect={} ms, udp_idle={} ms",
            high_latency.initial_client_data_timeout_ms,
            high_latency.connect_timeout_ms,
            high_latency.udp_session_idle_timeout_ms,
        );
    }
    let timeouts = runtime::TimeoutSettings {
        initial_client_data: high_latency.effective_initial_client_data_timeout(),
        connect: high_latency.effective_connect_timeout(),
        udp_session_idle: high_latency.effective_udp_session_idle_timeout(),
    };
    let runtime = Arc::new(runtime::AppRuntime::with_timeouts(
        cfg.use_rest_api,
        cfg.save_player_ip,
        webhooks,
        cfg.ddos_guard.to_settings(),
        timeouts,
    ));
    let mut tasks = JoinSet::new();

    info!(
        "FerrumProxy starting with {} listener(s), endpoint={}, rest_api={}, save_player_ip={}",
        cfg.listeners.len(),
        cfg.endpoint,
        cfg.use_rest_api,
        cfg.save_player_ip
    );

    if cfg.use_rest_api {
        let runtime = Arc::clone(&runtime);
        let endpoint = cfg.endpoint;
        tasks.spawn(async move {
            match management_api::start_management_api(endpoint, runtime).await {
                Ok(_) => {}
                Err(err) => {
                    if !err.to_string().contains("Address already in use") {
                        error!("Management API stopped: {err:#}");
                    }
                }
            }
        });
    }

    if let Some(manager_port) = args.manager_port {
        let Some(manager_token) = args
            .manager_token
            .clone()
            .filter(|token| !token.trim().is_empty())
        else {
            anyhow::bail!(
                "--manager-token or FERRUMPROXY_MANAGER_TOKEN is required when --manager-port is set"
            );
        };
        let runtime = Arc::clone(&runtime);
        let config_path = args.config.clone();
        tasks.spawn(async move {
            match manager_api::start_manager_api(manager_port, config_path, manager_token, runtime)
                .await
            {
                Ok(_) => {}
                Err(err) => {
                    if !err.to_string().contains("Address already in use") {
                        error!("Manager API stopped: {err:#}");
                    }
                }
            }
        });
    }

    if let Some(shared_service) = &cfg.shared_service {
        if shared_service.enabled {
            let enabled_tokens = shared_service
                .tokens
                .iter()
                .filter(|token| token.enabled && !token.token.is_empty())
                .count();
            let named_tokens = shared_service
                .tokens
                .iter()
                .filter(|token| !token.name.is_empty())
                .count();
            let best_priority = shared_service
                .tokens
                .iter()
                .filter(|token| token.enabled)
                .map(|token| token.priority)
                .max()
                .unwrap_or_default();
            let highest_token_bandwidth = shared_service
                .tokens
                .iter()
                .filter(|token| token.enabled)
                .map(|token| token.limits.max_bytes_per_second)
                .max()
                .unwrap_or_default();
            info!(
                "Shared service config enabled: control_bind={}, public_bind={}, public_host={}, port_range={}-{}, allow_anonymous={}, queue(enabled={}, max_size={}), defaults(max_bytes_per_second={}, idle_timeout_seconds={}, udp_session_timeout_seconds={}), maximums(max_bytes_per_second={}, idle_timeout_seconds={}, udp_session_timeout_seconds={}), legacy_tokens={}, tokens={}, enabled_tokens={}, named_tokens={}, best_priority={}, highest_token_bandwidth={}",
                shared_service.control_bind,
                shared_service.public_bind,
                shared_service.public_host,
                shared_service.port_range.start,
                shared_service.port_range.end,
                shared_service.allow_anonymous,
                shared_service.queue.enabled,
                shared_service.queue.max_size,
                shared_service.defaults.max_bytes_per_second,
                shared_service.defaults.idle_timeout_seconds,
                shared_service.defaults.udp_session_timeout_seconds,
                shared_service.maximums.max_bytes_per_second,
                shared_service.maximums.idle_timeout_seconds,
                shared_service.maximums.udp_session_timeout_seconds,
                shared_service.auth_tokens.len(),
                shared_service.tokens.len(),
                enabled_tokens,
                named_tokens,
                best_priority,
                highest_token_bandwidth,
            );

            let shared_config = shared_service.clone();
            let config_path = args.config.clone();
            let runtime = Arc::clone(&runtime);
            tasks.spawn(async move {
                if let Err(err) =
                    shared_relay::start_shared_relay(shared_config, Some(config_path), runtime)
                        .await
                {
                    error!("Shared relay stopped: {err:#}");
                }
            });
        }
    }

    for rule in cfg.listeners {
        if rule.tcp.is_some() && rule.has_targets_for(config::Protocol::Tcp) {
            let rule = Arc::new(rule.clone());
            let runtime = Arc::clone(&runtime);
            tasks.spawn(async move {
                if let Err(err) = tcp::start_tcp_proxy(rule, runtime).await {
                    error!("TCP listener stopped: {err:#}");
                }
            });
        }

        let udp_targets = rule.targets_for(config::Protocol::Udp);
        if rule.udp.is_some() && !udp_targets.is_empty() {
            let rule = Arc::new(rule);
            let runtime = Arc::clone(&runtime);
            tasks.spawn(async move {
                if let Err(err) = udp::start_udp_proxy(rule, runtime).await {
                    error!("UDP listener stopped: {err:#}");
                }
            });
        }
    }

    while let Some(result) = tasks.join_next().await {
        if let Err(err) = result {
            error!("listener task failed: {err}");
        }
    }

    Ok(())
}

fn install_rustls_crypto_provider() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
}
