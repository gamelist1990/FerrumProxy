use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

#[allow(unused_imports)]
use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tokio::task::JoinHandle;
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
use crate::runtime::{AppRuntime, PerformanceMetrics};
use crate::tcp_tuning::{apply_tcp_buffer_sizes, apply_tcp_keepalive, apply_tcp_nodelay};
use crate::tls_config::resolve_tls_acceptor;

const INITIAL_CLIENT_DATA_TIMEOUT_MSG: &str = "timed out waiting for initial client data";
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
        let tcp_ddos_permit = match runtime.ddos_guard.tcp_connection_opened(client_addr.ip()) {
            Ok(permit) => permit,
            Err(reason) => {
                warn!(
                    "DDoS guard dropped TCP connection from {client_addr}: {}",
                    reason.as_str()
                );
                continue;
            }
        };
        apply_tcp_nodelay(&client, "tcp listener client");
        apply_tcp_keepalive(&client, "tcp listener client");
        apply_tcp_buffer_sizes(&client, "tcp listener client");
        let rule = Arc::clone(&rule);
        let runtime = Arc::clone(&runtime);
        let tls_acceptor = tls_acceptor.clone();
        tokio::spawn(async move {
            let _tcp_ddos_permit = tcp_ddos_permit;
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
                let msg = format!("{err:#}");

                if is_benign_disconnect(&msg) {
                    debug!("TCP connection {client_addr} closed: {msg}");
                } else {
                    warn!("TCP connection {client_addr} ended: {msg}");
                }
            }
        });
    }
}

fn is_benign_disconnect(msg: &str) -> bool {
    msg.contains(INITIAL_CLIENT_DATA_TIMEOUT_MSG)
        || msg.contains("Connection reset by peer")
        || msg.contains("Broken pipe")
        || msg.contains("Connection refused")
        || msg.contains("Connection aborted")
        || msg.contains("An existing connection was forcibly closed")
        || msg.contains("An established connection was aborted")
        || msg.contains("forcibly closed by the remote host")
        || msg.contains("timed out")
}

async fn handle_client(
    mut client: BoxedStream,
    client_addr: SocketAddr,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
) -> Result<()> {
    let mut first_buf = vec![0u8; BUFFER_SIZE];
    let first_len = timeout(
        runtime.timeouts.initial_client_data,
        client.read(&mut first_buf),
    )
    .await
    .context(INITIAL_CLIENT_DATA_TIMEOUT_MSG)??;
    if first_len == 0 {
        return Ok(());
    }
    first_buf.truncate(first_len);
    // Only active rewriting needs a request line for routing. Passive diagnostics
    // must not wait for headers (the first bytes may be a TLS handshake).
    if !rule.uses_raknet_udp()
        && rule.nethernet_advertise_host.is_some()
        && [b"GET".as_slice(), b"POST".as_slice()]
            .iter()
            .any(|method| first_buf.starts_with(method) || method.starts_with(&first_buf))
    {
        timeout(runtime.timeouts.initial_client_data, async {
            while !first_buf.contains(&b'\n') {
                if first_buf.len() >= 4096 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "signaling headers too large",
                    ));
                }
                let mut buf = [0; 4096];
                let n = client.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                first_buf.extend_from_slice(&buf[..n]);
            }
            Ok::<_, io::Error>(())
        })
        .await
        .context(INITIAL_CLIENT_DATA_TIMEOUT_MSG)??;
    }

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

        match connect_target(&target, target_addr, runtime.timeouts.connect).await {
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
                    if !rule.uses_raknet_udp() {
                        rule.nethernet_advertise_host
                            .zip(rule.nethernet_advertise_port.or(rule.udp))
                    } else {
                        None
                    },
                    rule.nethernet_diagnostics && !rule.uses_raknet_udp(),
                )
                .await;
            }
            Err(err) => {
                last_error = Some(err);
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

#[allow(clippy::too_many_arguments)]
async fn copy_bidirectional(
    client: BoxedStream,
    target: BoxedStream,
    client_addr: SocketAddr,
    target_addr: SocketAddr,
    target_config: ProxyTarget,
    runtime: Arc<AppRuntime>,
    forwarded_proto: &'static str,
    initial_client_payload: Vec<u8>,
    advertise: Option<(std::net::IpAddr, u16)>,
    diagnostics: bool,
) -> Result<()> {
    let (client_read, client_write) = tokio::io::split(client);
    let (target_read, target_write) = tokio::io::split(target);

    let rewrite_signaling = advertise.is_some()
        && http_request_path(&initial_client_payload)
            .is_some_and(|p| p == "/v1/join" || p.starts_with("/v1/join/"));
    let signaling = rewrite_signaling || (diagnostics && target_config.url_protocol.is_none());
    let context = crate::nethernet_diagnostics::Context {
        client: client_addr,
        backend: target_addr,
    };
    let (client_to_target, target_to_client) = if signaling {
        if diagnostics {
            context.emit(
                "tcp_start",
                serde_json::json!({"advertise":advertise.map(|(ip,p)| format!("{ip}:{p}"))}),
            );
        }
        let c2t = if diagnostics {
            tokio::spawn(crate::nethernet_diagnostics::relay(
                client_read,
                target_write,
                initial_client_payload,
                false,
                context,
                runtime.metrics.clone(),
            ))
        } else {
            tokio::spawn(pump(
                client_read,
                target_write,
                initial_client_payload,
                runtime.metrics.clone(),
                Direction::ClientToTarget,
            ))
        };
        let t2c = if let Some(endpoint) = advertise.filter(|_| rewrite_signaling) {
            tokio::spawn(crate::nethernet_signaling::relay_answers(
                target_read,
                client_write,
                endpoint,
                runtime.metrics.clone(),
                diagnostics.then_some(context),
            ))
        } else {
            tokio::spawn(crate::nethernet_diagnostics::relay(
                target_read,
                client_write,
                Vec::new(),
                true,
                context,
                runtime.metrics.clone(),
            ))
        };
        (c2t, t2c)
    } else if target_config.url_protocol.is_none() {
        let c2t = tokio::spawn(pump(
            client_read,
            target_write,
            initial_client_payload,
            runtime.metrics.clone(),
            Direction::ClientToTarget,
        ));
        let t2c = tokio::spawn(pump(
            target_read,
            client_write,
            Vec::new(),
            runtime.metrics.clone(),
            Direction::TargetToClient,
        ));
        (c2t, t2c)
    } else {
        spawn_rewrite_relay(
            client_read,
            client_write,
            target_read,
            target_write,
            target_config,
            runtime.metrics.clone(),
            forwarded_proto,
            initial_client_payload,
            client_addr,
            target_addr,
        )
    };

    let result = run_relay(client_to_target, target_to_client).await;
    if signaling && diagnostics {
        context.emit("tcp_end",serde_json::json!({"success":result.is_ok(),"errorKind":if result.is_err() {"relay_error"} else {"none"}}));
    }
    let (sent, recv) = result?;
    debug!("TCP closed {client_addr} => {target_addr} sent={sent} recv={recv}");
    Ok(())
}

#[derive(Clone, Copy)]
enum Direction {
    ClientToTarget,
    TargetToClient,
}

fn record_bytes(metrics: &PerformanceMetrics, direction: Direction, bytes: usize) {
    match direction {
        Direction::ClientToTarget => metrics.tcp_client_to_target_bytes(bytes),
        Direction::TargetToClient => metrics.tcp_target_to_client_bytes(bytes),
    }
}

async fn pump<R, W>(
    mut reader: R,
    mut writer: W,
    initial: Vec<u8>,
    metrics: PerformanceMetrics,
    direction: Direction,
) -> io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut total = 0u64;

    if !initial.is_empty() {
        writer.write_all(&initial).await?;
        record_bytes(&metrics, direction, initial.len());
        total += initial.len() as u64;
    }

    let mut buf = vec![0u8; BUFFER_SIZE];
    loop {
        let len = reader.read(&mut buf).await?;
        if len == 0 {
            break;
        }
        writer.write_all(&buf[..len]).await?;
        record_bytes(&metrics, direction, len);
        total += len as u64;
    }

    let _ = writer.shutdown().await;
    Ok(total)
}

async fn run_relay(
    mut client_to_target: JoinHandle<io::Result<u64>>,
    mut target_to_client: JoinHandle<io::Result<u64>>,
) -> Result<(u64, u64)> {
    let mut sent = 0u64;
    let mut recv = 0u64;
    let mut c2t_done = false;
    let mut t2c_done = false;

    while !(c2t_done && t2c_done) {
        tokio::select! {
            result = &mut client_to_target, if !c2t_done => {
                c2t_done = true;
                match result {
                    Ok(Ok(bytes)) => sent = bytes,
                    Ok(Err(err)) => {
                        target_to_client.abort();
                        return Err(err.into());
                    }
                    Err(join_err) => {
                        target_to_client.abort();
                        return Err(anyhow::anyhow!("client->target relay task failed: {join_err}"));
                    }
                }
            }
            result = &mut target_to_client, if !t2c_done => {
                t2c_done = true;
                match result {
                    Ok(Ok(bytes)) => recv = bytes,
                    Ok(Err(err)) => {
                        client_to_target.abort();
                        return Err(err.into());
                    }
                    Err(join_err) => {
                        client_to_target.abort();
                        return Err(anyhow::anyhow!("target->client relay task failed: {join_err}"));
                    }
                }
            }
        }
    }

    Ok((sent, recv))
}

#[allow(clippy::too_many_arguments)]
fn spawn_rewrite_relay(
    mut client_read: ReadHalf<BoxedStream>,
    mut client_write: WriteHalf<BoxedStream>,
    mut target_read: ReadHalf<BoxedStream>,
    mut target_write: WriteHalf<BoxedStream>,
    target_config: ProxyTarget,
    metrics: PerformanceMetrics,
    forwarded_proto: &'static str,
    initial_client_payload: Vec<u8>,
    client_addr: SocketAddr,
    target_addr: SocketAddr,
) -> (JoinHandle<io::Result<u64>>, JoinHandle<io::Result<u64>>) {
    let request_target_config = target_config.clone();
    let response_target_config = target_config;
    let request_metrics = metrics.clone();
    let response_metrics = metrics;

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

        let _ = target_write.shutdown().await;
        Ok::<u64, io::Error>(total)
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

        let _ = client_write.shutdown().await;
        Ok::<u64, io::Error>(total)
    });

    (client_to_target, target_to_client)
}

async fn connect_target(
    target: &ProxyTarget,
    target_addr: SocketAddr,
    connect_timeout: Duration,
) -> Result<BoxedStream> {
    let tcp = timeout(connect_timeout, TcpStream::connect(target_addr)).await??;
    apply_tcp_nodelay(&tcp, "tcp target");
    apply_tcp_keepalive(&tcp, "tcp target");
    apply_tcp_buffer_sizes(&tcp, "tcp target");

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
    runtime
        .connection_ip_mapper
        .register_connection(client_addr.ip().to_string(), "TCP")
        .await;
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
        let Some(webhook) = rule
            .webhook
            .as_deref()
            .filter(|webhook| !webhook.trim().is_empty())
        else {
            return;
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ddos_guard::DdosGuardSettings;
    use crate::runtime::{ip_tests, ConnectionIpMapper};

    #[tokio::test]
    async fn diagnostics_do_not_wait_for_http_headers_before_forwarding() {
        for diagnostics in [false, true] {
            for request in [
                b"\x16\x03\x01\0\x04abcd".as_slice(),
                b"GET /v1/join HTTP/1.1\nHost: example.com\n\n".as_slice(),
            ] {
                let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = backend.local_addr().unwrap().port();
                let expected = request.to_vec();
                let upstream = tokio::spawn(async move {
                    let (mut stream, _) = backend.accept().await.unwrap();
                    let mut received = vec![0; expected.len()];
                    stream.read_exact(&mut received).await.unwrap();
                    assert_eq!(received, expected);
                    stream.write_all(b"ACK").await.unwrap();
                    stream.shutdown().await.unwrap();
                });
                let rule: ListenerRule = serde_yaml::from_str(&format!("tcp: 19132\nudp: 19132\nbedrockTransport: nethernet\nnethernetDiagnostics: {diagnostics}\ntarget:\n  host: 127.0.0.1\n  tcp: {port}\n  udp: 19132\n")).unwrap();
                let (mut client, proxy) = tokio::io::duplex(1024);
                let task = tokio::spawn(handle_client(
                    Box::new(proxy),
                    "203.0.113.42:1234".parse().unwrap(),
                    Arc::new(rule),
                    Arc::new(AppRuntime::new(
                        false,
                        false,
                        vec![],
                        DdosGuardSettings::default(),
                    )),
                ));
                client.write_all(request).await.unwrap();
                let mut reply = [0; 3];
                let result =
                    timeout(Duration::from_millis(500), client.read_exact(&mut reply)).await;
                if result.is_err() {
                    task.abort();
                    upstream.abort();
                }
                assert!(
                    result.is_ok(),
                    "diagnostics={diagnostics} blocked the initial request"
                );
                assert_eq!(&reply, b"ACK");
                client.shutdown().await.unwrap();
                task.await.unwrap().unwrap();
                upstream.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn nethernet_fragmented_request_preserves_proxy_ip_and_rewrites_answer() {
        let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = backend.local_addr().unwrap().port();
        let rule: ListenerRule = serde_yaml::from_str(&format!(
            "tcp: 19132\nudp: 19132\nhaproxy: true\nbedrockTransport: nethernet\nnethernetAdvertiseHost: 132.145.118.98\ntarget:\n  host: 127.0.0.1\n  tcp: {port}\n  udp: 5001\n"
        )).unwrap();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = backend.accept().await.unwrap();
            let mut proxy = [0; 28];
            stream.read_exact(&mut proxy).await.unwrap();
            let parsed = parse_proxy_chain(&proxy).unwrap();
            assert_eq!(parsed.headers[0].source_address.to_string(), "203.0.113.42");
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"POST /v1/join/123 HTTP/1.1"));
            let body = "v=0\r\nm=application 5001 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 KEEP\r\na=candidate:1 1 UDP 2114977535 127.0.0.1 5001 typ host\r\n";
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{body}",body.len());
            for chunk in response.as_bytes().chunks(11) {
                stream.write_all(chunk).await.unwrap();
            }
            stream.shutdown().await.unwrap();
        });
        let (mut client, proxy) = tokio::io::duplex(64);
        let runtime = Arc::new(AppRuntime::new(
            false,
            false,
            vec![],
            DdosGuardSettings::default(),
        ));
        let task = tokio::spawn(handle_client(
            Box::new(proxy),
            "203.0.113.42:45678".parse().unwrap(),
            Arc::new(rule),
            runtime,
        ));
        let result = timeout(Duration::from_secs(5), async {
            for chunk in b"POST /v1/join/123 HTTP/1.1\r\nHost: play.pexserver.com\r\nContent-Length: 0\r\n\r\n".chunks(3) {
                client.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
            client.shutdown().await.unwrap();
            let mut bytes = Vec::new(); client.read_to_end(&mut bytes).await.unwrap(); bytes
        }).await.unwrap();
        let result = String::from_utf8(result).unwrap();
        assert!(result.contains("132.145.118.98 19132 typ srflx raddr 127.0.0.1 rport 5001"));
        assert!(result.contains("a=fingerprint:sha-256 KEEP"));
        upstream.await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn records_connections_without_webhook_or_login_callback() {
        for use_rest_api in [false, true] {
            let directory = ip_tests::temporary_directory();
            let path = directory.join("connectionIP.json");
            let mut runtime =
                AppRuntime::new(use_rest_api, false, vec![], DdosGuardSettings::default());
            runtime.connection_ip_mapper = ConnectionIpMapper::new(path.clone(), true);
            let rule: ListenerRule = serde_yaml::from_str(
                "bind: 127.0.0.1\ntcp: 5000\ntarget:\n  host: 127.0.0.1\n  tcp: 5001\n",
            )
            .unwrap();
            let target = rule.targets_for(Protocol::Tcp)[0].clone();
            let peer = "203.0.113.1:12345".parse().unwrap();
            maybe_notify_connect(&runtime, &rule, &target, peer).await;
            let records = ip_tests::read_connections(&path);
            assert_eq!(records[0].ip, "203.0.113.1");
            assert_eq!(records[0].protocol, "TCP");
            assert_eq!(records[0].connections, 1);
            let matched = runtime
                .connection_buffer
                .process_for_timestamp(crate::runtime::now_ms())
                .await;
            assert_eq!(matched.len(), usize::from(use_rest_api));
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
