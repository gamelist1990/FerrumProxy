//! Standards HTTP/3 termination with bounded streaming to HTTP/1.1 origins.
use crate::{
    config::{ListenerRule, Protocol},
    proxy_protocol::build_proxy_v2_header,
    runtime::AppRuntime,
    tls_config::{certificate_stamp, resolve_quic_config},
};
use anyhow::{ensure, Context, Result};
use bytes::{Buf, Bytes};
use http::{HeaderMap, HeaderValue, Request, Response, StatusCode};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use hyper_util::rt::TokioIo;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::{mpsc, Semaphore},
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;

pub async fn start_http3_proxy(rule: Arc<ListenerRule>, runtime: Arc<AppRuntime>) -> Result<()> {
    let tls = rule
        .https
        .as_ref()
        .context("HTTP/3 TLS configuration required")?;
    let address: SocketAddr = format!(
        "{}:{}",
        rule.bind,
        rule.tcp.context("HTTP/3 port required")?
    )
    .parse()?;
    let endpoint = quinn::Endpoint::server(resolve_quic_config(tls)?, address)?;
    let slots = Arc::new(Semaphore::new(256));
    let streams = Arc::new(Semaphore::new(512));
    let mut stamp = certificate_stamp(Some(tls));
    let mut reload = tokio::time::interval(Duration::from_secs(60));
    tracing::info!("HTTP/3 listening on UDP {address}; HTTPS TCP retained");
    loop {
        let incoming = tokio::select! {
            incoming = endpoint.accept() => match incoming { Some(incoming) => incoming, None => break },
            _ = reload.tick() => {
                let next = certificate_stamp(Some(tls));
                if next.is_some() && next != stamp {
                    match resolve_quic_config(tls) { Ok(config) => { endpoint.set_server_config(Some(config)); stamp=next; }, Err(e) => tracing::warn!("Keeping active HTTP/3 certificate: {e:#}") }
                }
                continue;
            }
        };
        let peer = incoming.remote_address();
        if runtime.ip_block.is_blocked(peer.ip()) {
            incoming.refuse();
            continue;
        }
        // Retry validates the source address before allocating a TLS handshake.
        if !incoming.remote_address_validated() {
            let _ = incoming.retry();
            continue;
        }
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            incoming.refuse();
            continue;
        };
        let Ok(guard) = runtime.ddos_guard.tcp_connection_opened(peer.ip()) else {
            incoming.refuse();
            continue;
        };
        let (rule, runtime, streams) = (rule.clone(), runtime.clone(), streams.clone());
        tokio::spawn(async move {
            let (_slot, _guard) = (slot, guard);
            let result: Result<()> = async {
                let connection = timeout(Duration::from_secs(10), incoming).await??;
                let mut h3 = h3::server::builder()
                    .max_field_section_size(16384)
                    .build(h3_quinn::Connection::new(connection))
                    .await?;
                let per_connection = Arc::new(Semaphore::new(16));
                while let Some(resolver) = h3.accept().await? {
                    let Ok(global) = streams.clone().try_acquire_owned() else {
                        break;
                    };
                    let Ok(local) = per_connection.clone().try_acquire_owned() else {
                        break;
                    };
                    let (rule, runtime) = (rule.clone(), runtime.clone());
                    tokio::spawn(async move {
                        let (_global, _local) = (global, local);
                        let result: Result<()> = async {
                            let (request, stream) =
                                timeout(Duration::from_secs(15), resolver.resolve_request())
                                    .await??;
                            forward(request, stream, peer, rule, runtime).await
                        }
                        .await;
                        if let Err(error) = result {
                            tracing::debug!("HTTP/3 stream from {peer}: {error:#}");
                        }
                    });
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                tracing::debug!("HTTP/3 connection from {peer}: {error:#}");
            }
        });
    }
    Ok(())
}
fn strip_hop_headers(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(|v| v.trim().to_owned()))
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "proxy-connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "te",
        "trailer",
        "proxy-authenticate",
        "proxy-authorization",
    ] {
        headers.remove(name);
    }
}
async fn forward(
    request: Request<()>,
    stream: h3::server::RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>,
    peer: SocketAddr,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
) -> Result<()> {
    let (mut send, mut recv) = stream.split();
    let authority = request
        .uri()
        .authority()
        .context("HTTP/3 authority required")?
        .as_str()
        .to_owned();
    let parsed: http::uri::Authority = authority.parse()?;
    let hostname = parsed.host().trim_end_matches('.').to_lowercase();
    let explicit = rule.http_mappings.iter().any(|mapping| {
        mapping
            .hostname
            .as_deref()
            .is_some_and(|host| host.eq_ignore_ascii_case(&hostname))
    });
    if !explicit || request.method() == http::Method::CONNECT {
        send.send_response(
            Response::builder()
                .status(StatusCode::MISDIRECTED_REQUEST)
                .body(())?,
        )
        .await?;
        send.finish().await?;
        return Ok(());
    }
    let target = rule
        .http_targets_for_request(Protocol::Tcp, Some(request.uri().path()), Some(&hostname))
        .into_iter()
        .next()
        .context("HTTP/3 route has no origin")?;
    // Only configured origins are contacted. A client URI never chooses an origin.
    ensure!(
        target.url_protocol.as_deref() != Some("https"),
        "HTTP/3 HTTPS origins not configured"
    );
    let mut socket = timeout(
        runtime.timeouts.connect,
        TcpStream::connect((target.host.as_str(), target.tcp.context("origin port")?)),
    )
    .await??;
    socket.set_nodelay(true)?;
    if rule.haproxy {
        let destination = socket.peer_addr()?;
        socket
            .write_all(&build_proxy_v2_header(
                peer.ip(),
                peer.port(),
                destination.ip(),
                destination.port(),
                false,
            ))
            .await?;
    }
    let (sender, receiver) = mpsc::channel::<std::result::Result<Frame<Bytes>, std::io::Error>>(2);
    let body = StreamBody::new(ReceiverStream::new(receiver));
    let (mut parts, _) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .context("request path")?
        .as_str()
        .to_owned();
    parts.uri = path.parse()?;
    parts.version = http::Version::HTTP_11;
    strip_hop_headers(&mut parts.headers);
    parts
        .headers
        .insert(http::header::HOST, HeaderValue::from_str(&authority)?);
    // Upstream EOF cannot be confused with the next request on a reused socket.
    parts
        .headers
        .insert(http::header::CONNECTION, HeaderValue::from_static("close"));
    let request = Request::from_parts(parts, body);
    let (mut client, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(socket)).await?;
    let pump = tokio::spawn(async move {
        let _ = connection.await;
    });
    let upload = tokio::spawn(async move {
        loop {
            let data = match timeout(Duration::from_secs(90), recv.recv_data()).await {
                Ok(Ok(Some(data))) => data,
                Ok(Ok(None)) => break,
                _ => {
                    let _ = sender
                        .send(Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "HTTP/3 upload interrupted",
                        )))
                        .await;
                    return;
                }
            };
            let mut data = data;
            while data.has_remaining() {
                let n = data.remaining().min(65536);
                if sender
                    .send(Ok(Frame::data(data.copy_to_bytes(n))))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let result: Result<()> = async {
        let response = timeout(Duration::from_secs(90), client.send_request(request)).await??;
        let (mut parts, mut body) = response.into_parts();
        strip_hop_headers(&mut parts.headers);
        parts.version = http::Version::HTTP_3;
        parts.headers.insert(
            "alt-svc",
            HeaderValue::from_str(&format!("h3=\":{}\"; ma=300", rule.tcp.unwrap()))?,
        );
        send.send_response(Response::from_parts(parts, ())).await?;
        while let Some(frame) = timeout(Duration::from_secs(90), body.frame()).await? {
            if let Ok(data) = frame?.into_data() {
                timeout(Duration::from_secs(90), send.send_data(data)).await??;
            }
        }
        send.finish().await?;
        Ok(())
    }
    .await;
    upload.abort();
    pump.abort();
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ddos_guard::DdosGuardSettings;
    use tokio::io::AsyncReadExt;
    #[tokio::test]
    async fn quic_streams_forward_proxy_identity_bodies_ranges_and_do_not_block_each_other(
    ) -> Result<()> {
        crate::install_rustls_crypto_provider();
        let dir = std::env::temp_dir().join(format!("ferrum-h3-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir)?;
        let cert = dir.join("cert.pem");
        let key = dir.join("key.pem");
        let generated = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
                "-addext",
                "basicConstraints=critical,CA:FALSE",
                "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()?;
        ensure!(
            generated.status.success(),
            "test certificate generation failed"
        );
        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let backend_port = backend.local_addr()?.port();
        let port = std::net::UdpSocket::bind("127.0.0.1:0")?
            .local_addr()?
            .port();
        let rule: ListenerRule=serde_yaml::from_str(&format!("bind: 127.0.0.1\ntcp: {port}\nhaproxy: true\nhttps:\n  enabled: true\n  http3: true\n  autoDetect: false\n  certPath: {}\n  keyPath: {}\nhttpMappings:\n  - hostname: localhost\n    path: /\n    target: {{host: 127.0.0.1, tcp: {backend_port}}}\n",cert.display(),key.display()))?;
        let release = Arc::new(tokio::sync::Notify::new());
        let release_backend = release.clone();
        let origin = tokio::spawn(async move {
            let mut jobs = tokio::task::JoinSet::new();
            for _ in 0..4 {
                let (mut socket, _) = backend.accept().await.unwrap();
                let release = release_backend.clone();
                jobs.spawn(async move {
                    let mut pp=[0;28];socket.read_exact(&mut pp).await.unwrap();
                    let identity=crate::proxy_protocol::parse_proxy_chain(&pp).unwrap();assert_eq!(identity.headers[0].source_address.to_string(),"127.0.0.1");
                    let mut header=Vec::new();while !header.ends_with(b"\r\n\r\n") {header.push(socket.read_u8().await.unwrap());}
                    let header=String::from_utf8(header).unwrap().to_lowercase();assert!(header.contains("host: localhost"));
                    let body=if header.starts_with("post ") { let mut body=Vec::new();
                        if header.contains("content-length: 11") { body.resize(11,0); socket.read_exact(&mut body).await.unwrap(); }
                        else {
                          assert!(header.contains("transfer-encoding: chunked"));
                          loop {
                            let mut line=Vec::new(); while !line.ends_with(b"\r\n") { line.push(socket.read_u8().await.unwrap()); }
                            let n=usize::from_str_radix(String::from_utf8(line).unwrap().trim(),16).unwrap();
                            if n==0 { let mut crlf=[0;2];socket.read_exact(&mut crlf).await.unwrap();break; }
                            let start=body.len();body.resize(start+n,0);socket.read_exact(&mut body[start..]).await.unwrap();let mut crlf=[0;2];socket.read_exact(&mut crlf).await.unwrap();assert_eq!(&crlf,b"\r\n");
                          }
                        }
                        assert_eq!(&body,b"hello quic!");body } else {b"OK".to_vec()};
                    if header.starts_with("get /slow ") {release.notified().await;}
                    if header.starts_with("get /fast ") {assert!(header.contains("range: bytes=0-1"));}
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nSet-Cookie: a=1; Secure\r\nSet-Cookie: b=2; Secure\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();socket.write_all(&body).await.unwrap();
                });
            }
            while let Some(result) = jobs.join_next().await {
                result.unwrap();
            }
        });
        let server = tokio::spawn(start_http3_proxy(
            Arc::new(rule),
            Arc::new(AppRuntime::new(
                false,
                false,
                vec![],
                DdosGuardSettings::default(),
            )),
        ));
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut std::io::BufReader::new(std::fs::File::open(&cert)?))
        {
            roots.add(cert?)?;
        }
        let mut tls = tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"h3".to_vec()];
        let mut endpoint = quinn::Endpoint::client("127.0.0.1:0".parse()?)?;
        endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(tls)?,
        )));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let connection = timeout(
            Duration::from_secs(5),
            endpoint.connect(format!("127.0.0.1:{port}").parse()?, "localhost")?,
        )
        .await??;
        let (mut driver, mut client) =
            h3::client::new(h3_quinn::Connection::new(connection)).await?;
        let drive = tokio::spawn(async move {
            std::future::poll_fn(|cx| driver.poll_close(cx)).await;
        });
        let mut slow = client
            .send_request(Request::builder().uri("https://localhost/slow").body(())?)
            .await?;
        slow.finish().await?;
        let mut fast = client
            .send_request(
                Request::builder()
                    .uri("https://localhost/fast")
                    .header("Range", "bytes=0-1")
                    .body(())?,
            )
            .await?;
        fast.finish().await?;
        let response = timeout(Duration::from_secs(3), fast.recv_response()).await??;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        release.notify_one();
        assert_eq!(
            timeout(Duration::from_secs(3), slow.recv_response())
                .await??
                .status(),
            200
        );
        let mut upload = client
            .send_request(
                Request::builder()
                    .method("POST")
                    .uri("https://localhost/upload")
                    .header("Content-Length", "11")
                    .body(())?,
            )
            .await?;
        upload.send_data(Bytes::from_static(b"hello ")).await?;
        upload.send_data(Bytes::from_static(b"quic!")).await?;
        upload.finish().await?;
        assert_eq!(upload.recv_response().await?.status(), 200);
        let mut received = Vec::new();
        while let Some(mut bytes) = upload.recv_data().await? {
            received.extend_from_slice(&bytes.copy_to_bytes(bytes.remaining()));
        }
        assert_eq!(received, b"hello quic!");
        let mut chunked = client
            .send_request(
                Request::builder()
                    .method("POST")
                    .uri("https://localhost/upload")
                    .body(())?,
            )
            .await?;
        chunked
            .send_data(Bytes::from_static(b"hello quic!"))
            .await?;
        chunked.finish().await?;
        assert_eq!(chunked.recv_response().await?.status(), 200);
        while chunked.recv_data().await?.is_some() {}
        let mut unknown = client
            .send_request(
                Request::builder()
                    .uri("https://unconfigured.example/")
                    .body(())?,
            )
            .await?;
        unknown.finish().await?;
        assert_eq!(unknown.recv_response().await?.status(), 421);
        origin.await?;
        server.abort();
        drive.abort();
        endpoint.close(0u32.into(), b"test done");
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
