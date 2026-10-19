//! TLS-verified, read-only deployment probe. Optional second argument selects the edge IP.
use anyhow::{ensure, Context, Result};
use bytes::Buf;
use std::{sync::Arc, time::Duration};
#[tokio::main]
async fn main() -> Result<()> {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let args: Vec<_> = std::env::args().collect();
    let uri: http::Uri = args
        .get(1)
        .context("usage: http3-probe https://host/path [edge-ip]")?
        .parse()?;
    ensure!(uri.scheme_str() == Some("https"), "HTTPS required");
    let host = uri.host().context("hostname required")?;
    let port = uri.port_u16().unwrap_or(443);
    let address = if let Some(ip) = args.get(2) {
        std::net::SocketAddr::new(ip.parse()?, port)
    } else {
        tokio::net::lookup_host((host, port))
            .await?
            .next()
            .context("DNS lookup empty")?
    };
    let mut roots = tokio_rustls::rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        roots.add(cert)?;
    }
    let mut tls = tokio_rustls::rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let mut endpoint = quinn::Endpoint::client(
        if address.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        }
        .parse()?,
    )?;
    endpoint.set_default_client_config(quinn::ClientConfig::new(Arc::new(
        quinn::crypto::rustls::QuicClientConfig::try_from(tls)?,
    )));
    let connection =
        tokio::time::timeout(Duration::from_secs(8), endpoint.connect(address, host)?).await??;
    let (mut driver, mut client) = h3::client::new(h3_quinn::Connection::new(connection)).await?;
    let drive = tokio::spawn(async move {
        std::future::poll_fn(|cx| driver.poll_close(cx)).await;
    });
    let result: Result<()> = async {
        let mut request = client
            .send_request(
                http::Request::builder()
                    .uri(uri.clone())
                    .header("Range", "bytes=0-1023")
                    .body(())?,
            )
            .await?;
        request.finish().await?;
        let response =
            tokio::time::timeout(Duration::from_secs(10), request.recv_response()).await??;
        let mut body = Vec::new();
        while let Some(mut data) =
            tokio::time::timeout(Duration::from_secs(10), request.recv_data()).await??
        {
            ensure!(
                body.len() + data.remaining() <= 1024 * 1024,
                "probe body too large"
            );
            body.extend_from_slice(&data.copy_to_bytes(data.remaining()));
        }
        println!(
            "HTTP/3 {} | {} | {} bytes | certificate verified",
            response.status(),
            uri,
            body.len()
        );
        ensure!(response.status().is_success(), "HTTP/3 request failed");
        Ok(())
    }
    .await;
    drive.abort();
    endpoint.close(0u32.into(), b"probe complete");
    result
}
