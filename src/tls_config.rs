use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

use crate::config::ListenerHttpsConfig;

pub fn resolve_tls_acceptor(config: Option<&ListenerHttpsConfig>) -> Result<Option<TlsAcceptor>> {
    let Some(config) = config else {
        return Ok(None);
    };
    if !config.enabled {
        return Ok(None);
    }

    let (cert_path, key_path) = resolve_paths(config)?;
    let certs = load_certs(&cert_path)?;
    let key = load_private_key(&key_path)?;
    let mut server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("failed to build TLS server config")?;
    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Some(TlsAcceptor::from(Arc::new(server_config))))
}

fn resolve_paths(config: &ListenerHttpsConfig) -> Result<(PathBuf, PathBuf)> {
    let cert_path = config
        .cert_path
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty());
    let key_path = config
        .key_path
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty());

    if let (Some(cert), Some(key)) = (cert_path, key_path) {
        return Ok((normalize_path(cert), normalize_path(key)));
    }

    if !config.auto_detect {
        bail!(
            "HTTPS is enabled but certPath/keyPath are not configured and autoDetect is disabled"
        );
    }

    if !cfg!(target_os = "linux") {
        bail!(
            "HTTPS auto-detection is supported only on Linux. Configure certPath/keyPath manually"
        );
    }

    let Some(domain) = config
        .lets_encrypt_domain
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    else {
        bail!("HTTPS auto-detection requires letsEncryptDomain");
    };

    let live_dir = PathBuf::from("/etc/letsencrypt/live").join(domain);
    Ok((live_dir.join("fullchain.pem"), live_dir.join("privkey.pem")))
}

fn normalize_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    ensure_file(path, "cert")?;
    let file =
        File::open(path).with_context(|| format!("failed to open cert {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("failed to read cert {}", path.display()))?;
    if certs.is_empty() {
        bail!("no certificates found in {}", path.display());
    }
    Ok(certs)
}

fn load_private_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    ensure_file(path, "key")?;
    let file =
        File::open(path).with_context(|| format!("failed to open key {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut keys = rustls_pemfile::private_key(&mut reader)
        .with_context(|| format!("failed to read key {}", path.display()))?;
    keys.take()
        .context("no private key found")
        .with_context(|| format!("no private key found in {}", path.display()))
}

fn ensure_file(path: &Path, label: &str) -> Result<()> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to stat {label} {}", path.display()))?;
    if metadata.is_dir() {
        bail!(
            "{label} path {} is a directory, expected a PEM file",
            path.display()
        );
    }
    Ok(())
}
