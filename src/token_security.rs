use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn generate_opaque_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!(
        "{prefix}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub fn generate_salt() -> String {
    generate_opaque_token("")
}

pub fn hash_token(token: &str, server_salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(server_salt.as_bytes());
    format!("{:x}", hasher.finalize())
}
