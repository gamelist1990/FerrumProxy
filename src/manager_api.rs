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
use crate::ip_block::{normalize_ip_str, FeedStats, IpBlockEntry};
use crate::manager_secrets::{read_bundle, CertificateSource, Store};
use crate::runtime::AppRuntime;
use crate::token_security::{generate_opaque_token, generate_salt, hash_token, tokens_equal};

struct ManagerState {
    config_path: PathBuf,
    manager_token: String,
    runtime: Arc<AppRuntime>,
    secrets: Store,
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
        secrets: Store::new(&config_path),
        config_path,
        manager_token,
        runtime,
    });
    let app = manager_router(state);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    info!("Manager API listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn manager_router(state: Arc<ManagerState>) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/performance", get(performance))
        .route("/api/v1/tokens", post(issue_token).get(list_tokens))
        .route("/api/v1/tokens/:id", delete(delete_token))
        .route("/api/v1/catalog", get(catalog))
        .route(
            "/api/v1/credentials",
            get(list_credentials).post(issue_credential),
        )
        .route("/api/v1/credentials/:id", delete(revoke_credential))
        .route(
            "/api/v1/certificates",
            get(list_certificates).post(register_certificate),
        )
        .route(
            "/api/v1/certificates/:id",
            get(get_certificate).delete(delete_certificate),
        )
        .route("/api/v1/ip-block", get(get_ip_block).post(update_ip_block))
        .route("/api/v1/ip-block/ips", post(add_ip_block_ip))
        .route("/api/v1/ip-block/ips/:ip", delete(remove_ip_block_ip))
        .route("/api/v1/ip-block/cidrs", post(add_ip_block_cidr))
        .route("/api/v1/ip-block/cidrs/:cidr", delete(remove_ip_block_cidr))
        .layer(axum::middleware::from_fn(manager_response_headers))
        .with_state(state)
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
    if !tokens_equal(token, &state.manager_token) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Invalid manager token" })),
        )
            .into_response());
    }
    Ok(())
}

async fn health(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize_scope(&headers, &state, "health:read") {
        return response;
    }
    Json(json!({ "ok": true })).into_response()
}

async fn performance(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize_scope(&headers, &state, "performance:read") {
        return response;
    }
    Json(state.runtime.metrics.snapshot()).into_response()
}

async fn manager_response_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}

fn authorize_scope(headers: &HeaderMap, state: &ManagerState, scope: &str) -> Result<(), Response> {
    if authorize(headers, state).is_ok() {
        return Ok(());
    }
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    match token {
        Some(token) if state.secrets.permits(token, scope).unwrap_or(false) => Ok(()),
        _ => authorize(headers, state),
    }
}

async fn catalog(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    Json(json!({"version":1,"endpoints":[
        {"method":"GET","path":"/api/v1/health","scope":"health:read"},
        {"method":"GET","path":"/api/v1/performance","scope":"performance:read"},
        {"method":"GET","path":"/api/v1/tokens","scope":"manager"},
        {"method":"POST","path":"/api/v1/tokens","scope":"manager"},
        {"method":"DELETE","path":"/api/v1/tokens/{id}","scope":"manager"},
        {"method":"GET","path":"/api/v1/credentials","scope":"manager"},
        {"method":"POST","path":"/api/v1/credentials","scope":"manager"},
        {"method":"DELETE","path":"/api/v1/credentials/{id}","scope":"manager"},
        {"method":"GET","path":"/api/v1/certificates","scope":"manager"},
        {"method":"POST","path":"/api/v1/certificates","scope":"manager"},
        {"method":"GET","path":"/api/v1/certificates/{id}","scope":"certificates:read:{id}"},
        {"method":"DELETE","path":"/api/v1/certificates/{id}","scope":"manager"}
    ]}))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssueCredentialRequest {
    name: String,
    scopes: Vec<String>,
    expires_in: Option<i64>,
}

fn secret_error(status: StatusCode, error: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error":error.to_string()}))).into_response()
}

async fn issue_credential(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(request): Json<IssueCredentialRequest>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state
        .secrets
        .issue(&request.name, request.scopes, request.expires_in)
    {
        Ok(result) => (StatusCode::CREATED, Json(result)).into_response(),
        Err(error) => secret_error(StatusCode::BAD_REQUEST, error),
    }
}
async fn list_credentials(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state.secrets.credentials() {
        Ok(result) => Json(result).into_response(),
        Err(error) => secret_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}
async fn revoke_credential(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state.secrets.revoke(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => secret_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}
async fn register_certificate(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(source): Json<CertificateSource>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state.secrets.register(source) {
        Ok(result) => (StatusCode::CREATED, Json(result)).into_response(),
        Err(error) => secret_error(StatusCode::BAD_REQUEST, error),
    }
}
async fn list_certificates(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state.secrets.sources() {
        Ok(sources) => Json(sources.into_iter().map(|source| {
            let mut result = read_bundle(&source).map(|bundle|bundle.metadata()).unwrap_or_else(|error|
                json!({"id":source.id,"domain":source.domain,"error":error.to_string()}));
            result["certificatePath"] = json!(source.certificate_path);
            result["privateKeyPath"] = json!(source.private_key_path);
            result
        }).collect::<Vec<_>>()).into_response(),
        Err(error) => secret_error(StatusCode::INTERNAL_SERVER_ERROR,error),
    }
}
async fn get_certificate(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize_scope(&headers, &state, &format!("certificates:read:{id}")) {
        return response;
    }
    let source = match state.secrets.sources() {
        Ok(sources) => sources.into_iter().find(|source| source.id == id),
        Err(error) => return secret_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let Some(source) = source else {
        return secret_error(StatusCode::NOT_FOUND, "Certificate source not found");
    };
    match read_bundle(&source) {
        Ok(bundle) => {
            let etag = format!("\"{}\"", bundle.revision);
            let mut response = if headers
                .get(axum::http::header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok())
                == Some(etag.as_str())
            {
                StatusCode::NOT_MODIFIED.into_response()
            } else {
                Json(bundle).into_response()
            };
            response
                .headers_mut()
                .insert(axum::http::header::ETAG, etag.parse().unwrap());
            response
        }
        Err(error) => secret_error(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}
async fn delete_certificate(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match state.secrets.remove_source(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => secret_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateIpBlockRequest {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    block_vpn: Option<bool>,
    #[serde(default)]
    block_datacenter: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddIpRequest {
    ip: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddCidrRequest {
    cidr: String,
}

async fn get_ip_block(State(state): State<Arc<ManagerState>>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    match ProxyConfig::load(&state.config_path) {
        Ok(config) => {
            let stats = state.runtime.ip_block.feed_stats();
            Json(json!({
                "enabled": config.ip_block.enabled,
                "blockVpn": config.ip_block.block_vpn,
                "blockDatacenter": config.ip_block.block_datacenter,
                "vpnFeedUrl": config.ip_block.vpn_feed_url,
                "datacenterFeedUrl": config.ip_block.datacenter_feed_url,
                "feedRefreshIntervalSeconds": config.ip_block.feed_refresh_interval_seconds,
                "blockedIps": config.ip_block.blocked_ips,
                "blockedCidrs": config.ip_block.blocked_cidrs,
                "feedStats": stats,
            }))
            .into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn update_ip_block(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(req): Json<UpdateIpBlockRequest>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    let mut config = match ProxyConfig::load(&state.config_path) {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    if let Some(v) = req.enabled {
        config.ip_block.enabled = v;
        state.runtime.ip_block.set_enabled(v);
    }
    if let Some(v) = req.block_vpn {
        config.ip_block.block_vpn = v;
        state.runtime.ip_block.set_block_vpn(v);
    }
    if let Some(v) = req.block_datacenter {
        config.ip_block.block_datacenter = v;
        state.runtime.ip_block.set_block_datacenter(v);
    }
    match config.save(&state.config_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn add_ip_block_ip(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(req): Json<AddIpRequest>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    let ip = match normalize_ip_str(&req.ip) {
        Some(ip) => ip,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid IP address: {:?}", req.ip) })),
            )
                .into_response()
        }
    };
    let mut config = match ProxyConfig::load(&state.config_path) {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    let ip_str = ip.to_string();
    if config.ip_block.blocked_ips.iter().any(|e| e.ip == ip_str) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("IP {ip_str} is already blocked") })),
        )
            .into_response();
    }
    config.ip_block.blocked_ips.push(IpBlockEntry {
        ip: ip_str,
        reason: req.reason,
    });
    state.runtime.ip_block.add_ip(ip);
    match config.save(&state.config_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn remove_ip_block_ip(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(raw_ip): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    let ip = match normalize_ip_str(&raw_ip) {
        Some(ip) => ip,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid IP address: {:?}", raw_ip) })),
            )
                .into_response()
        }
    };
    let mut config = match ProxyConfig::load(&state.config_path) {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    let ip_str = ip.to_string();
    let before = config.ip_block.blocked_ips.len();
    config.ip_block.blocked_ips.retain(|e| e.ip != ip_str);
    if config.ip_block.blocked_ips.len() == before {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("IP {ip_str} is not in the block list") })),
        )
            .into_response();
    }
    state.runtime.ip_block.remove_ip(ip);
    match config.save(&state.config_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn add_ip_block_cidr(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Json(req): Json<AddCidrRequest>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    if !state.runtime.ip_block.add_cidr(&req.cidr) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("invalid CIDR: {:?}", req.cidr) })),
        )
            .into_response();
    }
    let mut config = match ProxyConfig::load(&state.config_path) {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    if !config.ip_block.blocked_cidrs.contains(&req.cidr) {
        config.ip_block.blocked_cidrs.push(req.cidr);
    }
    match config.save(&state.config_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn remove_ip_block_cidr(
    State(state): State<Arc<ManagerState>>,
    headers: HeaderMap,
    Path(cidr): Path<String>,
) -> Response {
    if let Err(response) = authorize(&headers, &state) {
        return response;
    }
    let mut config = match ProxyConfig::load(&state.config_path) {
        Ok(c) => c,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    let before = config.ip_block.blocked_cidrs.len();
    config.ip_block.blocked_cidrs.retain(|c| *c != cidr);
    if config.ip_block.blocked_cidrs.len() == before {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("CIDR {:?} is not in the block list", cidr) })),
        )
            .into_response();
    }
    state.runtime.ip_block.remove_cidr(&cidr);
    match config.save(&state.config_path) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[tokio::test]
    async fn certificate_api_enforces_scope_revocation_and_reads_renewed_files() -> Result<()> {
        crate::install_rustls_crypto_provider();
        let directory = std::env::temp_dir().join(generate_opaque_token("ferrum-api-test-"));
        std::fs::create_dir_all(&directory)?;
        let cert_path = directory.join("fullchain.pem");
        let key_path = directory.join("privkey.pem");
        std::fs::write(
            &cert_path,
            include_str!("../FerrumGeyser/src/test/resources/fixtures/rsa-cert.pem"),
        )?;
        std::fs::write(
            &key_path,
            include_str!("../FerrumGeyser/src/test/resources/fixtures/rsa-key.pem"),
        )?;
        let config_path = directory.join("config.yml");
        let state = Arc::new(ManagerState {
            secrets: Store::new(&config_path),
            config_path,
            manager_token: "test-root-only".to_string(),
            runtime: Arc::new(AppRuntime::new(false, false, vec![], Default::default())),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let app = manager_router(state);
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        let client = reqwest::Client::new();
        let root = "test-root-only";
        let missing = client
            .get(format!("{base}/api/v1/certificates/geyser"))
            .send()
            .await?;
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        let registration = client.post(format!("{base}/api/v1/certificates")).bearer_auth(root).json(&json!({
            "id":"geyser", "domain":"play.pexserver.com", "certificatePath":cert_path,"privateKeyPath":key_path,
            "advertiseHost":"132.145.118.98", "advertisePort":19132
        })).send().await?;
        assert_eq!(registration.status(), StatusCode::CREATED);
        let issued: serde_json::Value = client
            .post(format!("{base}/api/v1/credentials"))
            .bearer_auth(root)
            .json(&json!({
                "name":"Geyser", "scopes":["certificates:read:geyser"], "expiresIn":60
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let delegated = issued["token"].as_str().unwrap();
        for path in [
            "/api/v1/catalog",
            "/api/v1/health",
            "/api/v1/credentials",
            "/api/v1/certificates/other",
        ] {
            assert_eq!(
                client
                    .get(format!("{base}{path}"))
                    .bearer_auth(delegated)
                    .send()
                    .await?
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            client
                .delete(format!("{base}/api/v1/certificates/geyser"))
                .bearer_auth(delegated)
                .send()
                .await?
                .status(),
            StatusCode::FORBIDDEN
        );
        let response = client
            .get(format!("{base}/api/v1/certificates/geyser"))
            .bearer_auth(delegated)
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        let etag = response.headers()["etag"].to_str()?.to_owned();
        let bundle: serde_json::Value = response.json().await?;
        assert!(bundle["privateKeyPem"]
            .as_str()
            .unwrap()
            .contains("BEGIN PRIVATE KEY"));
        assert_eq!(
            client
                .get(format!("{base}/api/v1/certificates/geyser"))
                .bearer_auth(delegated)
                .header("If-None-Match", &etag)
                .send()
                .await?
                .status(),
            StatusCode::NOT_MODIFIED
        );
        let metadata = client
            .get(format!("{base}/api/v1/certificates"))
            .bearer_auth(root)
            .send()
            .await?
            .text()
            .await?;
        assert!(!metadata.contains("BEGIN") && !metadata.contains("privateKeyPem"));
        std::fs::write(
            &cert_path,
            include_str!("../FerrumGeyser/src/test/resources/fixtures/rotated-cert.pem"),
        )?;
        // Certbot updates its files separately: never hand out a mismatched pair.
        assert_eq!(
            client
                .get(format!("{base}/api/v1/certificates/geyser"))
                .bearer_auth(delegated)
                .send()
                .await?
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        std::fs::write(
            &key_path,
            include_str!("../FerrumGeyser/src/test/resources/fixtures/rotated-key.pem"),
        )?;
        let renewed = client
            .get(format!("{base}/api/v1/certificates/geyser"))
            .bearer_auth(delegated)
            .header("If-None-Match", &etag)
            .send()
            .await?;
        assert_eq!(renewed.status(), StatusCode::OK);
        assert_ne!(renewed.headers()["etag"], etag);
        assert_eq!(
            client
                .delete(format!(
                    "{base}/api/v1/credentials/{}",
                    issued["id"].as_str().unwrap()
                ))
                .bearer_auth(root)
                .send()
                .await?
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            client
                .get(format!("{base}/api/v1/certificates/geyser"))
                .bearer_auth(delegated)
                .send()
                .await?
                .status(),
            StatusCode::FORBIDDEN
        );
        task.abort();
        let _ = task.await;
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
}
