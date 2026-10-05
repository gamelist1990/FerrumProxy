//! Opt-in HTTP signaling answer rewriting. Never touches identity or fingerprints.
use crate::runtime::PerformanceMetrics;
use std::{io, net::IpAddr};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADER: usize = 64 * 1024;
fn invalid(s: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, s)
}

async fn line<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return if out.is_empty() {
                Ok(out)
            } else {
                Err(invalid("truncated HTTP line"))
            };
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |n| n + 1);
        if out.len() + n > MAX_HEADER {
            return Err(invalid("signaling header too large"));
        }
        out.extend_from_slice(&buf[..n]);
        r.consume(n);
        if out.ends_with(b"\n") {
            return Ok(out);
        }
    }
}
fn header<'a>(lines: &'a [String], name: &str) -> Option<&'a str> {
    lines.iter().skip(1).find_map(|l| {
        l.split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim())
    })
}

pub async fn relay_answers<R, W>(
    reader: R,
    mut writer: W,
    endpoint: (IpAddr, u16),
    metrics: PerformanceMetrics,
    diagnostics: Option<crate::nethernet_diagnostics::Context>,
) -> io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut r = BufReader::new(reader);
    let mut total = 0;
    loop {
        let first = line(&mut r).await?;
        if first.is_empty() {
            break;
        }
        let mut raw = first;
        if !raw.starts_with(b"HTTP/1.") {
            return Err(invalid("expected HTTP signaling response"));
        }
        loop {
            let l = line(&mut r).await?;
            if l.is_empty() {
                return Err(invalid("truncated signaling headers"));
            }
            raw.extend_from_slice(&l);
            if raw.len() > MAX_HEADER {
                return Err(invalid("signaling headers too large"));
            }
            if l == b"\r\n" {
                break;
            }
        }
        let text = std::str::from_utf8(&raw).map_err(|_| invalid("invalid HTTP header"))?;
        let lines: Vec<String> = text
            .trim_end_matches("\r\n")
            .split("\r\n")
            .map(str::to_owned)
            .collect();
        let status = lines[0]
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .ok_or_else(|| invalid("invalid HTTP status"))?;
        let sdp = (200..300).contains(&status)
            && header(&lines, "content-type").is_some_and(|s| {
                s.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/sdp")
            });
        if sdp
            && header(&lines, "content-encoding")
                .is_some_and(|s| !s.eq_ignore_ascii_case("identity"))
        {
            if let Some(context) = diagnostics {
                context.emit(
                    "rewrite_error",
                    serde_json::json!({"status":status,"reason":"encoded_sdp"}),
                );
            }
            return Err(invalid(
                "compressed NetherNet SDP is unsupported; disable signaling compression",
            ));
        }
        let mut body = Vec::new();
        let mut wire_body = Vec::new();
        let mut close_delimited = false;
        if (100..200).contains(&status) || status == 204 || status == 304 {
            // No response body.
        } else if let Some(te) = header(&lines, "transfer-encoding") {
            if !te.eq_ignore_ascii_case("chunked") {
                return Err(invalid("unsupported signaling transfer encoding"));
            }
            loop {
                let size_line = line(&mut r).await?;
                let n = std::str::from_utf8(&size_line)
                    .ok()
                    .and_then(|s| usize::from_str_radix(s.trim().split(';').next()?, 16).ok())
                    .ok_or_else(|| invalid("invalid chunk size"))?;
                if n > MAX_BODY - body.len() {
                    return Err(invalid("signaling body too large"));
                }
                wire_body.extend_from_slice(&size_line);
                if n == 0 {
                    let start = wire_body.len();
                    loop {
                        let trailer = line(&mut r).await?;
                        if trailer.is_empty() {
                            return Err(invalid("truncated chunk trailer"));
                        }
                        wire_body.extend_from_slice(&trailer);
                        if wire_body.len() - start > MAX_HEADER {
                            return Err(invalid("trailers too large"));
                        }
                        if trailer == b"\r\n" {
                            break;
                        }
                    }
                    break;
                }
                let start = body.len();
                body.resize(start + n, 0);
                r.read_exact(&mut body[start..]).await?;
                wire_body.extend_from_slice(&body[start..]);
                let mut crlf = [0; 2];
                r.read_exact(&mut crlf).await?;
                if crlf != *b"\r\n" {
                    return Err(invalid("invalid chunk delimiter"));
                }
                wire_body.extend_from_slice(&crlf);
                if wire_body.len() > MAX_BODY * 4 {
                    return Err(invalid("chunk overhead too large"));
                }
            }
        } else if let Some(length) = header(&lines, "content-length") {
            let n = length
                .parse::<usize>()
                .map_err(|_| invalid("invalid content length"))?;
            if n > MAX_BODY {
                return Err(invalid("signaling body too large"));
            }
            body.resize(n, 0);
            r.read_exact(&mut body).await?;
            wire_body = body.clone();
        } else {
            close_delimited = true;
            (&mut r)
                .take((MAX_BODY + 1) as u64)
                .read_to_end(&mut body)
                .await?;
            if body.len() > MAX_BODY {
                return Err(invalid("signaling body too large"));
            }
            wire_body = body.clone();
        }
        let frame = if sdp {
            let rewritten = advertise_candidates(&body, endpoint).map_err(|error| {
                if let Some(context) = diagnostics {
                    context.emit(
                        "rewrite_error",
                        serde_json::json!({"status":status,"reason":"invalid_sdp_or_endpoint"}),
                    );
                }
                error
            })?;
            if let Some(context) = diagnostics {
                context.emit("signaling_response",serde_json::json!({"status":status,"rewritten":rewritten != body,"before":crate::nethernet_diagnostics::sdp_summary(&body),"after":crate::nethernet_diagnostics::sdp_summary(&rewritten)}));
            }
            let mut h: Vec<String> = lines
                .into_iter()
                .filter(|l| {
                    !l.split_once(':').is_some_and(|(k, _)| {
                        ["content-length", "transfer-encoding", "trailer"]
                            .iter()
                            .any(|n| k.eq_ignore_ascii_case(n))
                    })
                })
                .collect();
            h.push(format!("Content-Length: {}", rewritten.len()));
            let mut frame = h.join("\r\n").into_bytes();
            frame.extend_from_slice(b"\r\n\r\n");
            frame.extend_from_slice(&rewritten);
            frame
        } else {
            if let Some(context) = diagnostics {
                context.emit(
                    "signaling_response",
                    serde_json::json!({"status":status,"rewritten":false,"bytes":body.len()}),
                );
            }
            raw.extend_from_slice(&wire_body);
            raw
        };
        writer.write_all(&frame).await?;
        metrics.tcp_target_to_client_bytes(frame.len());
        total += frame.len() as u64;
        if close_delimited {
            break;
        }
    }
    writer.shutdown().await?;
    Ok(total)
}

fn advertise_candidates(body: &[u8], (ip, port): (IpAddr, u16)) -> io::Result<Vec<u8>> {
    if port == 0 || ip.is_unspecified() || ip.is_multicast() {
        return Err(invalid("invalid advertised NetherNet endpoint"));
    }
    let sdp = std::str::from_utf8(body).map_err(|_| invalid("invalid SDP UTF-8"))?;
    let mut output = String::new();
    let mut media = false;
    let mut candidate: Option<(String, String)> = None;
    let mut exists = false;
    let append = |out: &mut String, c: &Option<(String, String)>, exists: bool| {
        if !exists {
            if let Some((addr, related_port)) = c {
                let added = format!("a=candidate:80000000 1 UDP 1694498815 {ip} {port} typ srflx raddr {addr} rport {related_port}\r\n");
                let media_start = out.rfind("m=").unwrap_or(0);
                if let Some(pos) = out[media_start..].find("a=end-of-candidates\r\n") {
                    out.insert_str(media_start + pos, &added);
                } else {
                    out.push_str(&added);
                }
            }
        }
    };
    for l in sdp.lines() {
        if l.starts_with("m=") {
            if media {
                append(&mut output, &candidate, exists);
            }
            media = true;
            candidate = None;
            exists = false;
        }
        if media && l.starts_with("a=candidate:") {
            let p: Vec<&str> = l.split_whitespace().collect();
            if p.len() >= 8 && p[1] == "1" && p[2].eq_ignore_ascii_case("udp") {
                if p[4] == ip.to_string() && p[5] == port.to_string() {
                    exists = true;
                }
                if candidate.is_none()
                    && p[6] == "typ"
                    && p[7] == "host"
                    && p[4]
                        .parse::<IpAddr>()
                        .is_ok_and(|a| a.is_ipv4() == ip.is_ipv4())
                {
                    candidate = Some((p[4].to_owned(), p[5].to_owned()));
                }
            }
        }
        output.push_str(l);
        output.push_str("\r\n");
    }
    if media {
        append(&mut output, &candidate, exists);
    }
    Ok(output.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;
    fn sdp() -> String {
        "v=0\r\nc=IN IP4 100.83.127.8\r\nm=application 5001 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:unchanged\r\na=fingerprint:sha-256 KEEP\r\na=identity:KEEP\r\na=candidate:1 1 UDP 2114977535 100.83.127.8 5001 typ host\r\na=end-of-candidates\r\n".into()
    }
    fn endpoint() -> (IpAddr, u16) {
        ("132.145.118.98".parse().unwrap(), 19132)
    }
    #[test]
    fn public_candidate_preserves_security_and_maps_port() {
        let result = advertise_candidates(sdp().as_bytes(), endpoint()).unwrap();
        let text = String::from_utf8(result).unwrap();
        assert!(text.contains("132.145.118.98 19132 typ srflx raddr 100.83.127.8 rport 5001"));
        for l in sdp().lines() {
            assert!(text.contains(l));
        }
        assert!(
            text.find("a=candidate:80000000").unwrap() < text.find("a=end-of-candidates").unwrap()
        );
        assert_eq!(
            advertise_candidates(text.as_bytes(), endpoint()).unwrap(),
            text.as_bytes()
        );
    }
    async fn relay(input: Vec<u8>) -> io::Result<Vec<u8>> {
        let (mut upstream, reader) = duplex(128);
        let (writer, mut client) = duplex(128);
        let send = tokio::spawn(async move {
            for chunk in input.chunks(7) {
                upstream.write_all(chunk).await.unwrap();
            }
            upstream.shutdown().await.unwrap();
        });
        let task = tokio::spawn(relay_answers(
            reader,
            writer,
            endpoint(),
            crate::runtime::AppRuntime::new(
                false,
                false,
                vec![],
                crate::ddos_guard::DdosGuardSettings::default(),
            )
            .metrics,
            None,
        ));
        let mut result = Vec::new();
        client.read_to_end(&mut result).await?;
        send.await.unwrap();
        task.await.unwrap()?;
        Ok(result)
    }
    #[tokio::test]
    async fn fragmented_keepalive_get_then_chunked_sdp() {
        let get =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let s = sdp();
        let chunked = format!("HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nTransfer-Encoding: chunked\r\nTrailer: X-Test\r\n\r\n{:x};x=y\r\n{}\r\n0\r\nX-Test: yes\r\n\r\n",s.len(),s);
        let input = [get.as_slice(), chunked.as_bytes()].concat();
        let result = relay(input).await.unwrap();
        assert!(result.starts_with(get));
        let response = String::from_utf8(result[get.len()..].to_vec()).unwrap();
        assert!(!response.contains("Transfer-Encoding:"));
        assert!(!response.contains("Trailer:"));
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
        assert!(body.contains("132.145.118.98 19132 typ srflx"));
    }
    #[tokio::test]
    async fn content_length_close_delimited_and_non_success() {
        let s = sdp();
        for framing in [
            format!("Content-Length: {}\r\n", s.len()),
            "Connection: close\r\n".into(),
        ] {
            let result = relay(
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\n{framing}\r\n{s}")
                    .into_bytes(),
            )
            .await
            .unwrap();
            assert!(String::from_utf8(result)
                .unwrap()
                .contains("132.145.118.98 19132 typ srflx"));
        }
        let error = format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{s}",s.len()).into_bytes();
        assert_eq!(relay(error.clone()).await.unwrap(), error);
    }
    #[tokio::test]
    async fn truncated_and_compressed_sdp_are_rejected() {
        assert!(relay(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: 12\r\n\r\nv=0"
                .to_vec()
        )
        .await
        .is_err());
        assert!(relay(b"HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n".to_vec()).await.is_err());
    }
}
