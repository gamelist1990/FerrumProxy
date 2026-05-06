use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tracing::info;

use crate::config::{ProxyConfig, SharedServiceConfig, SharedServiceLimits, SharedServiceToken};
use crate::runtime::AppRuntime;
use crate::token_security::{generate_opaque_token, generate_salt, hash_token};

#[derive(Clone)]
struct ManagerState {
    config_path: PathBuf,
    manager_token: String,
    runtime: Arc<AppRuntime>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueTokenRequest {
    name: String,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    issuer_id: Option<String>,
    #[serde(default)]
    priority: Option<u16>,
    #[serde(default)]
    fixed_port: Option<u16>,
    #[serde(default)]
    limits: Option<SharedServiceLimits>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IssueTokenResponse {
    id: String,
    token: String,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenListItem {
    id: String,
    name: String,
    scopes: Vec<String>,
    enabled: bool,
    fixed_port: Option<u16>,
    priority: u16,
    created_at: Option<String>,
    expires_at: Option<String>,
    last_used_at: Option<String>,
    issuer_id: Option<String>,
}

pub async fn start_manager_api(
    port: u16,
    config_path: PathBuf,
    manager_token: String,
    runtime: Arc<AppRuntime>,
) -> anyhow::Result<()> {
    let state = Arc::new(ManagerState {
        config_path,
        manager_token,
        runtime,
    });
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/performance", get(performance))
        .route("/api/v1/tokens", post(issue_token).get(list_tokens))
        .route("/api/v1/tokens/:id", delete(delete_token))
        .with_state(state);

    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    info!("Manager API listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn authorize(headers: &HeaderMap, state: &ManagerState) -> Result<(), Response> {
    let Some(value) = headers.get(axum::http::header::AUTHORIZATION) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing Authorization bearer token" })),
        )
            .into_response());
    };
    let Ok(value) = value.to_str() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid Authorization header" })),
        )
            .into_response());
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Authorization must use Bearer token" })),
        )
            .into_response());
    };
    if token != state.manager_token {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Invalid manager token" })),
        )
            .into_response());
    }
    Ok(())
}

async fn health(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    Json(json!({ "ok": true })).into_response()
}

async fn performance(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    Json(state.runtime.metrics.snapshot()).into_response()
}

async fn issue_token(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(payload): Json<IssueTokenRequest>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }

    match issue_token_inner(&state.config_path, payload) {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

fn issue_token_inner(
    config_path: &PathBuf,
    payload: IssueTokenRequest,
) -> Result<IssueTokenResponse, (StatusCode, String)> {
    let mut config = ProxyConfig::load(config_path)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    let shared = config
        .shared_service
        .get_or_insert_with(default_shared_service);

    let name = payload.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err((
            StatusCode::BAD_REQUEST,
            "name must be 1-80 characters".to_string(),
        ));
    }
    if shared.tokens.iter().any(|token| token.name == name) {
        return Err((
            StatusCode::CONFLICT,
            format!("token name {name:?} already exists"),
        ));
    }
    if let Some(fixed_port) = payload.fixed_port {
        if fixed_port < shared.port_range.start || fixed_port > shared.port_range.end {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "fixedPort must be inside sharedService.portRange ({}-{})",
                    shared.port_range.start, shared.port_range.end
                ),
            ));
        }
        if shared
            .tokens
            .iter()
            .any(|token| token.fixed_port == Some(fixed_port))
        {
            return Err((
                StatusCode::CONFLICT,
                format!("fixedPort {fixed_port} is already assigned"),
            ));
        }
    }

    if shared.server_salt.trim().is_empty() {
        shared.server_salt = generate_salt();
    }

    let raw_token = generate_opaque_token("fp_");
    let token_hash = hash_token(&raw_token, &shared.server_salt);
    let now = Utc::now();
    let expires_at = payload
        .expires_in
        .map(|seconds| {
            if seconds <= 0 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "expiresIn must be positive".to_string(),
                ));
            }
            Ok((now + Duration::seconds(seconds)).to_rfc3339())
        })
        .transpose()?;

    let id = generate_opaque_token("tok_");
    shared.tokens.push(SharedServiceToken {
        id: id.clone(),
        name: name.to_string(),
        token: String::new(),
        token_hash,
        scopes: if payload.scopes.is_empty() {
            vec!["proxy:write".to_string()]
        } else {
            payload.scopes
        },
        expires_at: expires_at.clone(),
        created_at: Some(now.to_rfc3339()),
        last_used_at: None,
        issuer_id: payload.issuer_id,
        enabled: true,
        fixed_port: payload.fixed_port,
        priority: payload.priority.unwrap_or_default(),
        limits: payload.limits.unwrap_or_default(),
    });

    config
        .save(config_path)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

    Ok(IssueTokenResponse {
        id,
        token: raw_token,
        expires_at,
    })
}

async fn list_tokens(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match ProxyConfig::load(&state.config_path) {
        Ok(config) => {
            let tokens = config
                .shared_service
                .map(|shared| shared.tokens)
                .unwrap_or_default()
                .into_iter()
                .map(|token| TokenListItem {
                    id: if token.id.is_empty() {
                        token.name.clone()
                    } else {
                        token.id
                    },
                    name: token.name,
                    scopes: token.scopes,
                    enabled: token.enabled,
                    fixed_port: token.fixed_port,
                    priority: token.priority,
                    created_at: token.created_at,
                    expires_at: token.expires_at,
                    last_used_at: token.last_used_at,
                    issuer_id: token.issuer_id,
                })
                .collect::<Vec<_>>();
            Json(tokens).into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn delete_token(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match ProxyConfig::load(&state.config_path) {
        Ok(mut config) => {
            let Some(shared) = config.shared_service.as_mut() else {
                return StatusCode::NO_CONTENT.into_response();
            };
            shared
                .tokens
                .retain(|token| token.id != id && token.name != id);
            match config.save(&state.config_path) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": err.to_string() })),
                )
                    .into_response(),
            }
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

fn default_shared_service() -> SharedServiceConfig {
    SharedServiceConfig {
        enabled: false,
        control_bind: "0.0.0.0:7000".to_string(),
        public_bind: "0.0.0.0".to_string(),
        public_host: String::new(),
        port_range: crate::config::SharedServicePortRange {
            start: 40000,
            end: 49999,
        },
        server_salt: String::new(),
        auth_tokens: Vec::new(),
        allow_anonymous: true,
        queue: crate::config::SharedServiceQueueConfig {
            enabled: true,
            max_size: 128,
        },
        tokens: Vec::new(),
        defaults: SharedServiceLimits::default(),
        maximums: SharedServiceLimits::default(),
    }
}
