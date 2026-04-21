use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, info, warn};

use crate::discord::{
    player_join_embed, player_login_embed, player_logout_embed, send_discord_webhook,
};
use crate::runtime::AppRuntime;

#[derive(Debug, Deserialize)]
struct PlayerEvent {
    timestamp: i64,
    username: String,
}

#[derive(Debug, Serialize)]
struct PlayersResponse {
    players: Vec<crate::runtime::PlayerEntry>,
    count: usize,
}

pub async fn start_management_api(port: u16, runtime: Arc<AppRuntime>) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/players", get(players))
        .route("/api/performance", get(performance))
        .with_state(runtime)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    info!("Management API listening on http://0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn login(
    State(runtime): State<Arc<AppRuntime>>,
    Json(event): Json<PlayerEvent>,
) -> impl IntoResponse {
    runtime
        .player_mapper
        .register_login(event.timestamp, event.username.clone())
        .await;

    let matched = runtime
        .connection_buffer
        .process_for_timestamp(event.timestamp)
        .await;
    let mut grouped: HashMap<(String, &'static str), Vec<u16>> = HashMap::new();

    for pending in &matched {
        debug!(
            "[{}] {}:{} [{}] => {}",
            pending.protocol, pending.ip, pending.port, event.username, pending.target
        );
        runtime
            .player_ip_mapper
            .register_player_ip(&event.username, pending.ip.clone(), pending.protocol)
            .await;
        grouped
            .entry((pending.ip.clone(), pending.protocol))
            .or_default()
            .push(pending.port);
    }

    if runtime.use_rest_api {
        if matched.is_empty() {
            for webhook in &runtime.webhooks {
                if let Err(err) = send_discord_webhook(
                    &runtime.http_client,
                    webhook,
                    player_login_embed(&event.username),
                )
                .await
                {
                    warn!("failed to send login webhook: {err:#}");
                }
            }
        } else {
            for ((ip, protocol), ports) in grouped {
                for webhook in &runtime.webhooks {
                    if let Err(err) = send_discord_webhook(
                        &runtime.http_client,
                        webhook,
                        player_join_embed(&event.username, &ip, &ports, protocol),
                    )
                    .await
                    {
                        warn!("failed to send join webhook: {err:#}");
                    }
                }
            }
        }
    }

    Json(json!({
        "success": true,
        "message": format!("Player {} login registered", event.username),
        "timestamp": event.timestamp,
        "timestampStr": chrono::DateTime::from_timestamp_millis(event.timestamp).map(|dt| dt.to_rfc3339()),
    }))
}

async fn logout(
    State(runtime): State<Arc<AppRuntime>>,
    Json(event): Json<PlayerEvent>,
) -> impl IntoResponse {
    runtime
        .player_mapper
        .register_logout(event.timestamp, &event.username)
        .await;

    if runtime.use_rest_api {
        if let Some(record) = runtime
            .player_ip_mapper
            .get_player_ips(&event.username)
            .await
        {
            for ip_info in record.ips {
                for webhook in &runtime.webhooks {
                    if let Err(err) = send_discord_webhook(
                        &runtime.http_client,
                        webhook,
                        player_logout_embed(
                            &event.username,
                            Some(&ip_info.ip),
                            None,
                            Some(&ip_info.protocol),
                        ),
                    )
                    .await
                    {
                        warn!("failed to send logout webhook: {err:#}");
                    }
                }
            }
        } else {
            for webhook in &runtime.webhooks {
                if let Err(err) = send_discord_webhook(
                    &runtime.http_client,
                    webhook,
                    player_logout_embed(&event.username, None, None, None),
                )
                .await
                {
                    warn!("failed to send logout webhook: {err:#}");
                }
            }
        }
    }

    Json(json!({
        "success": true,
        "message": format!("Player {} logout registered", event.username),
        "timestamp": event.timestamp,
        "timestampStr": chrono::DateTime::from_timestamp_millis(event.timestamp).map(|dt| dt.to_rfc3339()),
    }))
}

async fn players(State(runtime): State<Arc<AppRuntime>>) -> impl IntoResponse {
    let players = runtime.player_mapper.all_players().await;
    let response = PlayersResponse {
        count: players.len(),
        players,
    };
    Json(response)
}

async fn performance(State(runtime): State<Arc<AppRuntime>>) -> impl IntoResponse {
    Json(runtime.metrics.snapshot())
}
