//! Manager-only certificate sources and revocable, least-privilege API credentials.
//! PEM material is read from the issuer's files on every request, never persisted here.
use crate::token_security::{generate_opaque_token, generate_salt, hash_token, tokens_equal};
use anyhow::{bail, Context, Result};
use chrono::{TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio_rustls::rustls;
use x509_parser::extensions::GeneralName;

const FILE_LIMIT: u64 = 256 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Data {
    salt: String,
    credentials: Vec<Credential>,
    certificates: Vec<CertificateSource>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    #[serde(default)]
    token_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificateSource {
    pub id: String,
    pub domain: String,
    pub certificate_path: PathBuf,
    pub private_key_path: PathBuf,
    pub advertise_host: Option<IpAddr>,
    pub advertise_port: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateBundle {
    pub id: String,
    pub domain: String,
    pub revision: String,
    pub expires_at: String,
    pub certificate_sha256: String,
    pub certificate_pem: String,
    pub private_key_pem: String,
    pub advertise_host: Option<IpAddr>,
    pub advertise_port: Option<u16>,
}

impl CertificateBundle {
    pub fn metadata(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"domain":self.domain,"revision":self.revision,
            "expiresAt":self.expires_at,"certificateSha256":self.certificate_sha256,
            "advertiseHost":self.advertise_host,"advertisePort":self.advertise_port})
    }
}

pub struct Store {
    path: PathBuf,
    config_directory: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(config_path: &Path) -> Self {
        let config_path = if config_path.is_absolute() {
            config_path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(config_path)
        };
        let mut filename = config_path.as_os_str().to_os_string();
        filename.push(".manager.json");
        Self {
            path: PathBuf::from(filename),
            config_directory: config_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<Data> {
        if !self.path.exists() {
            return Ok(Data::default());
        }
        serde_json::from_str(&read_bounded(&self.path)?).context("Cannot read manager state")
    }

    fn save(&self, data: &Data) -> Result<()> {
        let serialized = serde_json::to_vec_pretty(data)?;
        if serialized.len() as u64 > FILE_LIMIT {
            bail!("Manager state exceeds 256 KiB; remove unused credentials or sources");
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", generate_opaque_token("")));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<()> {
            let mut file = options.open(&temporary)?;
            file.write_all(&serialized)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.context("Cannot save manager state")
    }

    pub fn permits(&self, token: &str, scope: &str) -> Result<bool> {
        let _guard = self.lock.lock().unwrap();
        let data = self.load()?;
        let hash = hash_token(token, &data.salt);
        Ok(data.credentials.iter().any(|item| {
            tokens_equal(&item.token_hash, &hash)
                && item.scopes.iter().any(|allowed| allowed == scope)
                && item.expires_at.as_ref().is_none_or(|value| {
                    chrono::DateTime::parse_from_rfc3339(value)
                        .is_ok_and(|expiry| expiry > Utc::now())
                })
        }))
    }

    pub fn credentials(&self) -> Result<Vec<serde_json::Value>> {
        let _guard = self.lock.lock().unwrap();
        Ok(self.load()?.credentials.into_iter().map(|item| serde_json::json!({
            "id":item.id,"name":item.name,"scopes":item.scopes,"createdAt":item.created_at,"expiresAt":item.expires_at
        })).collect())
    }

    pub fn issue(
        &self,
        name: &str,
        scopes: Vec<String>,
        expires_in: Option<i64>,
    ) -> Result<serde_json::Value> {
        let _guard = self.lock.lock().unwrap();
        let mut data = self.load()?;
        if name.trim().is_empty() || name.len() > 80 {
            bail!("name must be 1-80 characters");
        }
        if scopes.is_empty() || scopes.len() > 32 {
            bail!("Provide 1-32 explicit scopes");
        }
        for scope in &scopes {
            if scope == "health:read" || scope == "performance:read" {
                continue;
            }
            let Some(id) = scope.strip_prefix("certificates:read:") else {
                bail!("Unsupported credential scope");
            };
            if !data.certificates.iter().any(|source| source.id == id) {
                bail!("Certificate scope must name a registered certificate");
            }
        }
        let now = Utc::now();
        let expires_at = expires_in
            .map(|seconds| {
                if seconds <= 0 {
                    bail!("expiresIn must be positive");
                }
                now.checked_add_signed(
                    TimeDelta::try_seconds(seconds).context("expiresIn is too large")?,
                )
                .map(|value| value.to_rfc3339())
                .context("expiresIn is too large")
            })
            .transpose()?;
        if data.salt.is_empty() {
            data.salt = generate_salt();
        }
        let raw = generate_opaque_token("fpc_");
        let credential = Credential {
            id: generate_opaque_token("cred_"),
            name: name.trim().to_owned(),
            scopes,
            created_at: now.to_rfc3339(),
            expires_at,
            token_hash: hash_token(&raw, &data.salt),
        };
        let response = serde_json::json!({"id":credential.id,"token":raw,"scopes":credential.scopes,"expiresAt":credential.expires_at});
        data.credentials.push(credential);
        self.save(&data)?;
        Ok(response)
    }

    pub fn revoke(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut data = self.load()?;
        data.credentials.retain(|item| item.id != id);
        self.save(&data)
    }

    pub fn sources(&self) -> Result<Vec<CertificateSource>> {
        let _guard = self.lock.lock().unwrap();
        Ok(self.load()?.certificates)
    }

    pub fn register(&self, mut source: CertificateSource) -> Result<serde_json::Value> {
        if !valid_id(&source.id) {
            bail!("id must contain 1-64 ASCII letters, digits, underscores or hyphens");
        }
        source.domain = source
            .domain
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if !valid_domain(&source.domain) {
            bail!("domain must be a DNS hostname");
        }
        if source
            .advertise_host
            .is_some_and(|ip| ip.is_unspecified() || ip.is_multicast())
            || source.advertise_port == Some(0)
        {
            bail!("Invalid advertised UDP endpoint");
        }
        if source.advertise_host.is_some() != source.advertise_port.is_some() {
            bail!("advertiseHost and advertisePort must be provided together");
        }
        source.certificate_path = self.resolve(&source.certificate_path)?;
        source.private_key_path = self.resolve(&source.private_key_path)?;
        let metadata = read_bundle(&source)?.metadata();
        let _guard = self.lock.lock().unwrap();
        let mut data = self.load()?;
        data.certificates.retain(|item| item.id != source.id);
        data.certificates.push(source);
        self.save(&data)?;
        Ok(metadata)
    }

    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.config_directory.join(path)
        };
        // Keep the configured path, including Certbot's live/ symlinks. Canonicalizing
        // here would pin an archive generation and prevent future renewals being read.
        if !absolute.is_file() {
            bail!("Certificate source file is missing or inaccessible");
        }
        Ok(absolute)
    }

    pub fn remove_source(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut data = self.load()?;
        data.certificates.retain(|source| source.id != id);
        let scope = format!("certificates:read:{id}");
        // A removed certificate's credentials cannot gain access if its id is reused.
        for credential in &mut data.credentials {
            credential.scopes.retain(|value| value != &scope);
        }
        self.save(&data)
    }
}

fn read_bounded(path: &Path) -> Result<String> {
    let file = fs::File::open(path).context("Certificate source is inaccessible")?;
    if !file.metadata()?.is_file() {
        bail!("Certificate source must be a regular file");
    }
    let mut result = String::new();
    file.take(FILE_LIMIT + 1)
        .read_to_string(&mut result)
        .context("Source must contain UTF-8 PEM")?;
    if result.len() as u64 > FILE_LIMIT {
        bail!("Source exceeds 256 KiB");
    }
    Ok(result)
}

pub fn read_bundle(source: &CertificateSource) -> Result<CertificateBundle> {
    let certificate_pem = read_bounded(&source.certificate_path)?;
    let private_key_pem = read_bounded(&source.private_key_path)?;
    let certs = rustls_pemfile::certs(&mut certificate_pem.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("Invalid certificate PEM")?;
    let leaf = certs.first().context("Certificate PEM is empty")?;
    let (_, certificate) = x509_parser::parse_x509_certificate(leaf.as_ref())
        .map_err(|_| anyhow::anyhow!("Invalid X.509 certificate"))?;
    if !certificate.validity().is_valid() {
        bail!("Certificate is expired or not yet valid");
    }
    let san = certificate
        .subject_alternative_name()
        .map_err(|_| anyhow::anyhow!("Invalid certificate SAN"))?
        .context("Certificate has no DNS subject alternative name")?;
    if !san.value.general_names.iter().any(
        |name| matches!(name, GeneralName::DNSName(value) if domain_matches(value, &source.domain)),
    ) {
        bail!("Certificate does not cover the configured domain");
    }
    let key = rustls_pemfile::private_key(&mut private_key_pem.as_bytes())
        .context("Invalid private key PEM")?
        .context("Private key PEM is empty")?;
    rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs.clone(), key)
        .context("Certificate and private key do not match or are unsupported")?;
    let certificate_sha256 = format!("{:x}", Sha256::digest(leaf.as_ref()));
    let revision = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            source.id.as_str(),
            source.domain.as_str(),
            certificate_pem.as_str(),
            private_key_pem.as_str(),
            source.advertise_host,
            source.advertise_port
        ))?)
    );
    let expires_at =
        chrono::DateTime::from_timestamp(certificate.validity().not_after.timestamp(), 0)
            .context("Invalid certificate expiry")?
            .to_rfc3339();
    Ok(CertificateBundle {
        id: source.id.clone(),
        domain: source.domain.clone(),
        revision,
        expires_at,
        certificate_sha256,
        certificate_pem,
        private_key_pem,
        advertise_host: source.advertise_host,
        advertise_port: source.advertise_port,
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
pub fn domain_matches(pattern: &str, domain: &str) -> bool {
    let pattern = pattern.trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    pattern == domain
        || pattern.strip_prefix("*.").is_some_and(|suffix| {
            domain
                .split_once('.')
                .is_some_and(|(label, rest)| !label.is_empty() && rest == suffix)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wildcard_is_only_one_dns_label() {
        assert!(domain_matches("*.pexserver.com", "play.pexserver.com"));
        assert!(!domain_matches("*.pexserver.com", "a.play.pexserver.com"));
        assert!(!domain_matches("*.pexserver.com", "pexserver.com"));
        assert!(!domain_matches("other.pexserver.com", "play.pexserver.com"));
    }
    #[test]
    fn delegated_credentials_are_hashed_scoped_expiring_and_revocable() -> Result<()> {
        let directory = std::env::temp_dir().join(generate_opaque_token("ferrum-manager-"));
        fs::create_dir_all(&directory)?;
        let store = Store::new(&directory.join("config.yml"));
        let issued = store.issue("probe", vec!["health:read".to_string()], Some(60))?;
        let raw = issued["token"].as_str().unwrap();
        assert!(store.permits(raw, "health:read")?);
        assert!(!store.permits(raw, "performance:read")?);
        assert!(!store.permits("wrong", "health:read")?);
        assert!(!fs::read_to_string(&store.path)?.contains(raw));
        assert!(!store.credentials()?[0].to_string().contains("tokenHash"));
        assert!(store
            .issue("probe", vec!["health:read".to_string()], Some(i64::MAX))
            .is_err());
        assert!(store
            .issue("probe", vec!["certificates:read:missing".to_string()], None)
            .is_err());
        let mut data = store.load()?;
        data.credentials[0].expires_at = Some((Utc::now() - TimeDelta::seconds(1)).to_rfc3339());
        store.save(&data)?;
        assert!(!store.permits(raw, "health:read")?);
        store.revoke(issued["id"].as_str().unwrap())?;
        assert!(store.credentials()?.is_empty());
        fs::remove_dir_all(directory)?;
        Ok(())
    }
}
