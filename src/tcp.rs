use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use tracing::{debug, info, warn};

use crate::config::{ListenerRule, Protocol, ProxyTarget};
use crate::http_rewrite::{
    http_request_path, is_likely_http_request, rewrite_http_request, rewrite_http_response,
};
use crate::proxy_protocol::{build_proxy_v2_header, parse_proxy_chain};
use crate::runtime::AppRuntime;
use crate::tls_config::resolve_tls_acceptor;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL_CLIENT_DATA_TIMEOUT: Duration = Duration::from_secs(30);
const BUFFER_SIZE: usize = 16 * 1024;

trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> AsyncStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
type BoxedStream = Box<dyn AsyncStream>;

pub async fn start_tcp_proxy(rule: Arc<ListenerRule>, runtime: Arc<AppRuntime>) -> Result<()> {
    let port = rule.tcp.context("TCP listener missing port")?;
    let bind = format!("{}:{port}", rule.bind);
    let listener = TcpListener::bind(&bind)
        .await
        .with_context(|| format!("failed to bind TCP listener {bind}"))?;
    let tls_acceptor = resolve_tls_acceptor(rule.https.as_ref())?;

    info!(
        "{} listening on {bind}",
        if tls_acceptor.is_some() {
            "HTTPS"
        } else {
            "TCP"
        }
    );

    loop {
        let (client, client_addr) = listener.accept().await?;
        let rule = Arc::clone(&rule);
        let runtime = Arc::clone(&runtime);
        let tls_acceptor = tls_acceptor.clone();
        tokio::spawn(async move {
            let client: Result<BoxedStream> = match tls_acceptor {
                Some(acceptor) => acceptor
                    .accept(client)
                    .await
                    .map(|stream| Box::new(stream) as BoxedStream)
                    .map_err(Into::into),
                None => Ok(Box::new(client) as BoxedStream),
            };
            let result = match client {
                Ok(client) => {
                    runtime.metrics.tcp_session_opened();
                    let result =
                        handle_client(client, client_addr, Arc::clone(&rule), Arc::clone(&runtime))
                            .await;
                    runtime.metrics.tcp_session_closed();
                    result
                }
                Err(err) => Err(err),
            };
            if let Err(err) = result {
                warn!("TCP connection {client_addr} ended: {err:#}");
            }
        });
    }
}

async fn handle_client(
    mut client: BoxedStream,
    client_addr: SocketAddr,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
) -> Result<()> {
    let mut first_buf = vec![0u8; BUFFER_SIZE];
    let first_len = timeout(INITIAL_CLIENT_DATA_TIMEOUT, client.read(&mut first_buf))
        .await
        .context("timed out waiting for initial client data")??;
    if first_len == 0 {
        return Ok(());
    }
    first_buf.truncate(first_len);

    let mut original_client = client_addr;
    let parsed =
        parse_proxy_chain(&first_buf).unwrap_or_else(|_| crate::proxy_protocol::ParsedProxyChain {
            headers: Vec::new(),
            payload_offset: 0,
        });
    if let Some(first_header) = parsed.headers.first() {
        original_client = SocketAddr::new(first_header.source_address, first_header.source_port);
        debug!(
            "TCP incoming PROXY header original={} destination={}:{}",
            original_client, first_header.destination_address, first_header.destination_port
        );
    }
    let initial_payload = &first_buf[parsed.payload_offset..];
    let forwarded_proto = if rule.https.as_ref().is_some_and(|https| https.enabled) {
        "https"
    } else {
        "http"
    };

    let mapped_targets =
        rule.http_targets_for_path(Protocol::Tcp, http_request_path(initial_payload).as_deref());
    let targets = if mapped_targets.is_empty() {
        rule.targets_for(Protocol::Tcp)
    } else {
        mapped_targets
    };
    let mut last_error = None;

    for target in targets {
        let target_port = match target.tcp {
            Some(port) => port,
            None => continue,
        };

        let target_addr = match resolve_target_addr(&target.host, target_port).await {
            Ok(addr) => addr,
            Err(err) => {
                last_error = Some(err);
                continue;
            }
        };
        debug!("TCP connect {original_client} => {target_addr}");

        match connect_target(&target, target_addr).await {
            Ok(mut target_stream) => {
                let initial_payload = initial_payload.to_vec();

                if rule.haproxy {
                    let header = build_proxy_v2_header(
                        original_client.ip(),
                        original_client.port(),
                        target_addr.ip(),
                        target_port,
                        false,
                    );
                    target_stream.write_all(&header).await?;
                    runtime.metrics.tcp_client_to_target_bytes(header.len());
                }

                maybe_notify_connect(&runtime, &rule, &target, original_client).await;

                return copy_bidirectional(
                    client,
                    target_stream,
                    original_client,
                    target_addr,
                    target,
                    Arc::clone(&runtime),
                    forwarded_proto,
                    initial_payload,
                )
                .await;
            }
            Err(err) => {
                last_error = Some(err.into());
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("all TCP targets failed")))
}

async fn resolve_target_addr(host: &str, port: u16) -> Result<SocketAddr> {
    let mut addrs = lookup_host((host, port))
        .await
        .with_context(|| format!("failed to resolve {host}:{port}"))?;
    addrs
        .next()
        .with_context(|| format!("no addresses returned for {host}:{port}"))
}

async fn copy_bidirectional(
    client: BoxedStream,
    target: BoxedStream,
    client_addr: SocketAddr,
    target_addr: SocketAddr,
    target_config: ProxyTarget,
    runtime: Arc<AppRuntime>,
    forwarded_proto: &'static str,
    initial_client_payload: Vec<u8>,
) -> Result<()> {
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut target_read, mut target_write) = tokio::io::split(target);
    let request_target_config = target_config.clone();
    let response_target_config = target_config;
    let request_metrics = runtime.metrics.clone();
    let response_metrics = runtime.metrics.clone();

    let client_to_target = tokio::spawn(async move {
        let mut total = 0u64;
        let mut buf = vec![0u8; BUFFER_SIZE];
        let mut awaiting_initial_http_header = request_target_config.url_protocol.is_some();
        let mut pending_initial_http = Vec::new();

        let mut handle_chunk = |chunk: &[u8]| {
            if awaiting_initial_http_header {
                pending_initial_http.extend_from_slice(chunk);
                if pending_initial_http
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .is_none()
                {
                    return None;
                }

                awaiting_initial_http_header = false;
                let merged = std::mem::take(&mut pending_initial_http);
                return Some(if is_likely_http_request(&merged) {
                    rewrite_http_request(&merged, &request_target_config, forwarded_proto)
                } else {
                    merged
                });
            }

            Some(
                if request_target_config.url_protocol.is_some() && is_likely_http_request(chunk) {
                    rewrite_http_request(chunk, &request_target_config, forwarded_proto)
                } else {
                    chunk.to_vec()
                },
            )
        };

        if let Some(outgoing) = handle_chunk(&initial_client_payload) {
            target_write.write_all(&outgoing).await?;
            request_metrics.tcp_client_to_target_bytes(outgoing.len());
            total += outgoing.len() as u64;
        }

        loop {
            let len = client_read.read(&mut buf).await?;
            if len == 0 {
                break;
            }

            if let Some(outgoing) = handle_chunk(&buf[..len]) {
                target_write.write_all(&outgoing).await?;
                request_metrics.tcp_client_to_target_bytes(outgoing.len());
                total += outgoing.len() as u64;
            }
        }

        if !pending_initial_http.is_empty() {
            if awaiting_initial_http_header {
                warn!(
                    "TCP request from {} to {} closed before complete initial HTTP headers were received",
                    client_addr, target_addr
                );
            }
            target_write.write_all(&pending_initial_http).await?;
            request_metrics.tcp_client_to_target_bytes(pending_initial_http.len());
            total += pending_initial_http.len() as u64;
        }

        Ok::<u64, std::io::Error>(total)
    });

    let target_to_client = tokio::spawn(async move {
        let mut total = 0u64;
        let mut response_head_handled = response_target_config.url_protocol.is_none();
        let mut pending = Vec::new();
        let mut buf = vec![0u8; BUFFER_SIZE];

        loop {
            let len = target_read.read(&mut buf).await?;
            if len == 0 {
                break;
            }

            if response_head_handled {
                client_write.write_all(&buf[..len]).await?;
                response_metrics.tcp_target_to_client_bytes(len);
                total += len as u64;
                continue;
            }

            pending.extend_from_slice(&buf[..len]);
            if let Some(header_end) = pending.windows(4).position(|window| window == b"\r\n\r\n") {
                let _ = header_end;
                response_head_handled = true;
                let rewritten = rewrite_http_response(&pending, &response_target_config);
                client_write.write_all(&rewritten).await?;
                response_metrics.tcp_target_to_client_bytes(rewritten.len());
                total += rewritten.len() as u64;
                pending.clear();
            }
        }

        if !pending.is_empty() {
            client_write.write_all(&pending).await?;
            response_metrics.tcp_target_to_client_bytes(pending.len());
            total += pending.len() as u64;
        }

        Ok::<u64, std::io::Error>(total)
    });

    let mut client_to_target = client_to_target;
    let mut target_to_client = target_to_client;
    let (sent, recv) = tokio::select! {
        result = &mut client_to_target => {
            target_to_client.abort();
            (result??, 0)
        }
        result = &mut target_to_client => {
            client_to_target.abort();
            (0, result??)
        }
    };
    debug!("TCP closed {client_addr} => {target_addr} sent={sent} recv={recv}");
    Ok(())
}

async fn connect_target(target: &ProxyTarget, target_addr: SocketAddr) -> Result<BoxedStream> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(target_addr)).await??;
    tcp.set_nodelay(true)?;

    if target.url_protocol.as_deref() == Some("https") {
        let mut roots = RootCertStore::empty();
        let certs = rustls_native_certs::load_native_certs();
        for cert in certs.certs {
            roots.add(cert)?;
        }
        let mut config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let connector = TlsConnector::from(Arc::new(config));
        let server_name = ServerName::try_from(target.host.clone())?;
        let stream = connector.connect(server_name, tcp).await?;
        Ok(Box::new(stream) as BoxedStream)
    } else {
        Ok(Box::new(tcp) as BoxedStream)
    }
}

async fn maybe_notify_connect(
    runtime: &AppRuntime,
    rule: &ListenerRule,
    target: &ProxyTarget,
    client_addr: SocketAddr,
) {
    let Some(webhook) = rule
        .webhook
        .as_deref()
        .filter(|webhook| !webhook.trim().is_empty())
    else {
        return;
    };

    let target_key = format!("{}:{}", target.host, target.tcp.unwrap_or_default());
    if runtime.use_rest_api {
        runtime
            .connection_buffer
            .add_pending(
                client_addr.ip().to_string(),
                client_addr.port(),
                "TCP",
                target_key,
            )
            .await;
    } else {
        runtime
            .notifier
            .add_connect_group(
                webhook.to_string(),
                target_key,
                client_addr.ip().to_string(),
                client_addr.port(),
                "TCP",
            )
            .await;
    }
}
