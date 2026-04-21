mod bedrock;
mod config;
mod discord;
mod http_rewrite;
mod management_api;
mod proxy_protocol;
mod runtime;
mod tcp;
mod tls_config;
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

    let webhooks = cfg
        .listeners
        .iter()
        .filter_map(|rule| rule.webhook.clone())
        .filter(|webhook| !webhook.trim().is_empty())
        .collect::<Vec<_>>();
    let runtime = Arc::new(runtime::AppRuntime::new(
        cfg.use_rest_api,
        cfg.save_player_ip,
        webhooks,
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
            if let Err(err) = management_api::start_management_api(endpoint, runtime).await {
                error!("Management API stopped: {err:#}");
            }
        });
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
