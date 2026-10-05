//! Bounded, passive HTTP/SDP inspection. Only allowlisted metadata is emitted.
use crate::runtime::PerformanceMetrics;
use serde_json::{json, Value};
use std::{io, net::SocketAddr};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
const LIMIT: usize = 1024 * 1024;
const HEADER_LIMIT: usize = 64 * 1024;
#[derive(Clone, Copy)]
pub struct Context {
    pub client: SocketAddr,
    pub backend: SocketAddr,
}
impl Context {
    pub fn emit(self, event: &str, details: Value) {
        let value = json!({"version":1,"event":event,"client":self.client.to_string(),"backend":self.backend.to_string(),"details":details});
        tracing::info!(target: "ferrum_proxy::nethernet", "NETHER_DIAG {}", value);
    }
}
pub fn sdp_summary(body: &[u8]) -> Value {
    let text = String::from_utf8_lossy(body);
    let mut candidates = Vec::new();
    let mut identity = false;
    let mut fingerprints = 0;
    for l in text.lines() {
        if l.starts_with("a=identity:") {
            identity = true;
        }
        if l.starts_with("a=fingerprint:") {
            fingerprints += 1;
        }
        if l.starts_with("a=candidate:") && candidates.len() < 32 {
            let p: Vec<_> = l.split_whitespace().collect();
            if p.len() >= 8 {
                if let (Ok(ip), Ok(port)) = (p[4].parse::<std::net::IpAddr>(), p[5].parse::<u16>())
                {
                    let kind = match p[7] {
                        "host" | "srflx" | "prflx" | "relay" => p[7],
                        _ => "unknown",
                    };
                    let transport = if p[2].eq_ignore_ascii_case("udp") {
                        "UDP"
                    } else {
                        "other"
                    };
                    candidates.push(
                        json!({"ip":ip.to_string(),"port":port,"kind":kind,"transport":transport}),
                    );
                }
            }
        }
    }
    json!({"candidates":candidates,"identityPresent":identity,"fingerprintCount":fingerprints,"bytes":body.len()})
}
// Classification is observation, not proof that a WebRTC data channel opened.
pub fn udp_kind(p: &[u8]) -> (&'static str, usize) {
    const MAGIC: &[u8] = b"\0\xff\xff\0\xfe\xfe\xfe\xfe\xfd\xfd\xfd\xfd\x12\x34\x56\x78";
    if p.len() >= 9 + MAGIC.len() && matches!(p[0], 1 | 2) && &p[9..9 + MAGIC.len()] == MAGIC {
        return ("raknet_ping", 0);
    }
    if p.len() >= 1 + MAGIC.len() && p[0] == 5 && &p[1..1 + MAGIC.len()] == MAGIC {
        return ("raknet_open_request_1", 1);
    }
    if p.len() >= 20 && p[0] & 0xc0 == 0 && p[4..8] == [0x21, 0x12, 0xa4, 0x42] {
        return match u16::from_be_bytes([p[0], p[1]]) {
            1 => ("stun_binding_request", 2),
            0x101 => ("stun_binding_response", 3),
            0x111 => ("stun_binding_error", 4),
            _ => ("stun", 5),
        };
    }
    if p.len() >= 13 && (20..=25).contains(&p[0]) && p[1] == 0xfe && matches!(p[2], 0xfd | 0xff) {
        return ("dtls", 6);
    }
    ("unknown_udp", 7)
}

struct Observer {
    pending: Vec<u8>,
    disabled: bool,
    response: bool,
    context: Context,
}
impl Observer {
    fn new(response: bool, context: Context) -> Self {
        Self {
            pending: Vec::new(),
            disabled: false,
            response,
            context,
        }
    }
    fn feed(&mut self, data: &[u8], eof: bool) {
        if self.disabled {
            return;
        }
        if self.pending.len().saturating_add(data.len()) > LIMIT + HEADER_LIMIT {
            self.disable("inspection_limit");
            return;
        }
        self.pending.extend_from_slice(data);
        loop {
            match self.frame(eof) {
                Ok(Some((n, details))) => {
                    self.context.emit(
                        if self.response {
                            "signaling_response"
                        } else {
                            "signaling_request"
                        },
                        details,
                    );
                    self.pending.drain(..n);
                    if self.pending.is_empty() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(reason) => {
                    self.disable(reason);
                    break;
                }
            }
        }
    }
    fn disable(&mut self, reason: &str) {
        self.context.emit(
            "inspection_skipped",
            json!({"reason":reason,"direction":if self.response {"response"} else {"request"}}),
        );
        self.pending.clear();
        self.disabled = true;
    }
    fn frame(&self, eof: bool) -> Result<Option<(usize, Value)>, &'static str> {
        let Some(end) = self.pending.windows(4).position(|w| w == b"\r\n\r\n") else {
            if self.pending.len() > HEADER_LIMIT {
                return Err("header_limit");
            }
            if eof && !self.pending.is_empty() {
                return Err("truncated_header");
            }
            return Ok(None);
        };
        if end > HEADER_LIMIT {
            return Err("header_limit");
        }
        let text = std::str::from_utf8(&self.pending[..end]).map_err(|_| "header_encoding")?;
        let mut lines = text.split("\r\n");
        let first: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
        let headers: Vec<_> = lines.filter_map(|l| l.split_once(':')).collect();
        let h = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.trim())
        };
        let mut details = if self.response {
            if first.len() < 2 || !first[0].starts_with("HTTP/1.") {
                return Err("non_http");
            }
            json!({"status":first[1].parse::<u16>().map_err(|_| "status")?})
        } else {
            if first.len() != 3 || !first[2].starts_with("HTTP/1.") {
                return Err("non_http");
            }
            // Never emit the arbitrary request target or query parameters.
            let method = match first[0] {
                "GET" => "GET",
                "POST" => "POST",
                _ => "other",
            };
            let path = if first[1].split('?').next() == Some("/v1/join") {
                "/v1/join"
            } else if first[1].starts_with("/v1/join/") {
                "/v1/join/{networkId}"
            } else {
                "other"
            };
            json!({"method":method,"path":path})
        };
        let start = end + 4;
        let status = details["status"].as_u64().unwrap_or(0);
        let no_body =
            self.response && ((100..200).contains(&status) || status == 204 || status == 304);
        let (n, body) = if no_body {
            (start, Vec::new())
        } else if let Some(te) = h("transfer-encoding") {
            if !te.eq_ignore_ascii_case("chunked") {
                return Err("transfer_encoding");
            }
            let Some(result) = chunks(&self.pending, start)? else {
                if eof {
                    return Err("truncated_chunks");
                }
                return Ok(None);
            };
            result
        } else if let Some(cl) = h("content-length") {
            let size = cl.parse::<usize>().map_err(|_| "content_length")?;
            if size > LIMIT {
                return Err("body_limit");
            }
            if self.pending.len() < start + size {
                if eof {
                    return Err("truncated_body");
                }
                return Ok(None);
            }
            (start + size, self.pending[start..start + size].to_vec())
        } else if self.response {
            if !eof {
                return Ok(None);
            }
            (self.pending.len(), self.pending[start..].to_vec())
        } else {
            (start, Vec::new())
        };
        details["bytes"] = json!(body.len());
        let encoded = h("content-encoding").is_some_and(|v| !v.eq_ignore_ascii_case("identity"));
        details["encoded"] = json!(encoded);
        if !encoded
            && h("content-type").is_some_and(|v| {
                v.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/sdp")
            })
        {
            details["sdp"] = sdp_summary(&body);
        } else if self.response
            && !encoded
            && h("content-type").is_some_and(|v| v.starts_with("application/json"))
        {
            if let Ok(j) = serde_json::from_slice::<Value>(&body) {
                // Nonce, arbitrary names and authorization fields are intentionally excluded.
                for key in ["protocol", "onlineAuth", "selfSignedAuth", "transportLayer"] {
                    if j[key].is_boolean() || j[key].is_number() {
                        details[key] = j[key].clone();
                    }
                }
            }
        }
        Ok(Some((n, details)))
    }
}
fn chunks(buf: &[u8], mut pos: usize) -> Result<Option<(usize, Vec<u8>)>, &'static str> {
    let mut body = Vec::new();
    loop {
        let Some(end) = buf[pos..].windows(2).position(|w| w == b"\r\n") else {
            return Ok(None);
        };
        let text = std::str::from_utf8(&buf[pos..pos + end]).map_err(|_| "chunk_size")?;
        let size = usize::from_str_radix(text.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "chunk_size")?;
        pos += end + 2;
        if size == 0 {
            loop {
                let Some(end) = buf[pos..].windows(2).position(|w| w == b"\r\n") else {
                    return Ok(None);
                };
                pos += end + 2;
                if end == 0 {
                    return Ok(Some((pos, body)));
                }
            }
        }
        if size > LIMIT - body.len() {
            return Err("body_limit");
        }
        if buf.len() - pos < size + 2 {
            return Ok(None);
        }
        body.extend_from_slice(&buf[pos..pos + size]);
        pos += size;
        if &buf[pos..pos + 2] != b"\r\n" {
            return Err("chunk_delimiter");
        }
        pos += 2;
    }
}

pub async fn relay<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut reader: R,
    mut writer: W,
    initial: Vec<u8>,
    response: bool,
    context: Context,
    metrics: PerformanceMetrics,
) -> io::Result<u64> {
    let mut observer = Observer::new(response, context);
    let mut total = 0;
    let mut buffer = vec![0; 16 * 1024];
    let mut data = initial;
    loop {
        if !data.is_empty() {
            writer.write_all(&data).await?;
            if response {
                metrics.tcp_target_to_client_bytes(data.len())
            } else {
                metrics.tcp_client_to_target_bytes(data.len())
            }
            total += data.len() as u64;
            observer.feed(&data, false);
        }
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            observer.feed(&[], true);
            break;
        }
        data.clear();
        data.extend_from_slice(&buffer[..n]);
    }
    writer.shutdown().await?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() -> Context {
        Context {
            client: "203.0.113.42:1234".parse().unwrap(),
            backend: "100.83.127.8:19132".parse().unwrap(),
        }
    }
    #[test]
    fn metadata_does_not_include_auth_tokens() {
        let body = b"v=0\r\nm=application 19132 UDP/DTLS/SCTP webrtc-datachannel\r\na=identity:SECRET-TOKEN\r\na=ice-pwd:SECRET-PASSWORD\r\na=fingerprint:sha-256 SECRET-FINGERPRINT\r\na=candidate:1 1 UDP 42 100.83.127.8 19132 typ host\r\n";
        let result = sdp_summary(body).to_string();
        assert!(!result.contains("SECRET"));
        assert_eq!(sdp_summary(body)["candidates"][0]["ip"], "100.83.127.8");
        assert_eq!(sdp_summary(body)["identityPresent"], true);
    }
    #[test]
    fn reassembles_chunked_and_pipelined_responses_without_mutating_them() {
        let body = "v=0\r\na=identity:SECRET\r\n";
        let get =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let post = format!("HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",body.len(),body);
        let mut observer = Observer::new(true, context());
        observer.pending = [get.as_bytes(), post.as_bytes()].concat();
        let (n, first) = observer.frame(false).unwrap().unwrap();
        assert_eq!(first["status"], 200);
        assert_eq!(n, get.len());
        observer.pending.drain(..n);
        let (n, second) = observer.frame(false).unwrap().unwrap();
        assert_eq!(n, post.len());
        assert_eq!(second["sdp"]["identityPresent"], true);
        assert!(!second.to_string().contains("SECRET"));
        for chunk in post.as_bytes().chunks(3) {
            observer.pending = chunk.to_vec();
            assert!(observer.frame(false).unwrap().is_none());
        }
    }
    #[test]
    fn recognizes_udp_by_signatures_not_sizes() {
        let magic = b"\0\xff\xff\0\xfe\xfe\xfe\xfe\xfd\xfd\xfd\xfd\x12\x34\x56\x78";
        let rak = [&[5u8][..], &magic[..], &[11u8][..]].concat();
        assert_eq!(udp_kind(&rak).0, "raknet_open_request_1");
        let mut ping = vec![1; 9];
        ping.extend_from_slice(magic);
        assert_eq!(udp_kind(&ping).0, "raknet_ping");
        let mut stun = vec![0; 20];
        stun[1] = 1;
        stun[4..8].copy_from_slice(&[0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(udp_kind(&stun).0, "stun_binding_request");
        stun[0] = 1;
        assert_eq!(udp_kind(&stun).0, "stun_binding_response");
        let mut dtls = vec![0; 13];
        dtls[..3].copy_from_slice(&[22, 0xfe, 0xfd]);
        assert_eq!(udp_kind(&dtls).0, "dtls");
        assert_eq!(udp_kind(&vec![0; 1172]).0, "unknown_udp");
    }
    #[tokio::test]
    async fn observe_only_preserves_every_byte_even_when_inspection_fails() {
        use tokio::io::duplex;
        for data in [
            b"not HTTP but still forwarded".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: 3\r\n\r\nv=0"
                .to_vec(),
        ] {
            let (mut upstream, reader) = duplex(64);
            let (writer, mut client) = duplex(64);
            let expected = data.clone();
            let send = tokio::spawn(async move {
                for c in data.chunks(3) {
                    upstream.write_all(c).await.unwrap()
                }
                upstream.shutdown().await.unwrap()
            });
            let runtime = crate::runtime::AppRuntime::new(
                false,
                false,
                vec![],
                crate::ddos_guard::DdosGuardSettings::default(),
            );
            let task = tokio::spawn(relay(
                reader,
                writer,
                vec![],
                true,
                context(),
                runtime.metrics,
            ));
            let mut received = Vec::new();
            client.read_to_end(&mut received).await.unwrap();
            send.await.unwrap();
            task.await.unwrap().unwrap();
            assert_eq!(received, expected);
        }
    }
}
