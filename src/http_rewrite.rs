use crate::config::ProxyTarget;

const HTTP_METHODS: &[&str] = &[
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT",
];

pub fn is_likely_http_request(buf: &[u8]) -> bool {
    let head_end = header_end(buf).unwrap_or(buf.len().min(128));
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let first_line = head.split("\r\n").next().unwrap_or_default();
    let method = first_line.split(' ').next().unwrap_or_default();
    HTTP_METHODS.contains(&method)
}

pub fn http_request_path(buf: &[u8]) -> Option<String> {
    let head_end = header_end(buf).unwrap_or(buf.len().min(1024));
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let request_line = head.lines().next().unwrap_or_default();
    let parts = request_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/1.") {
        return None;
    }

    if parts[1].starts_with("http://") || parts[1].starts_with("https://") {
        return url::Url::parse(parts[1])
            .ok()
            .map(|parsed| parsed.path().to_string());
    }

    let path = parts[1].split_once('?').map_or(parts[1], |(path, _)| path);
    path.starts_with('/').then(|| path.to_string())
}

/// Parse a complete HTTP/1 header, rejecting ambiguous Host/absolute-form authority.
pub fn http_request_host(buf: &[u8]) -> anyhow::Result<Option<String>> {
    let end = header_end(buf).ok_or_else(|| anyhow::anyhow!("incomplete HTTP headers"))?;
    let text = std::str::from_utf8(&buf[..end])?;
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or_default();
    let mut host = None;
    for line in lines {
        anyhow::ensure!(
            !line.starts_with([' ', '\t']),
            "folded headers are not accepted for host routing"
        );
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("invalid HTTP header"))?;
        anyhow::ensure!(name.trim() == name, "invalid header name");
        if name.eq_ignore_ascii_case("host") {
            anyhow::ensure!(host.is_none(), "multiple Host headers");
            host = Some(normalize_http_authority(value.trim())?);
        }
    }
    if let Some(target) = line
        .split_whitespace()
        .nth(1)
        .filter(|target| target.starts_with("http://") || target.starts_with("https://"))
    {
        let url = url::Url::parse(target)?;
        let authority = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("missing authority"))?
            .trim_end_matches('.')
            .to_ascii_lowercase();
        anyhow::ensure!(
            host.as_ref() == Some(&authority),
            "absolute-form authority differs from Host"
        );
    }
    Ok(host)
}
fn normalize_http_authority(value: &str) -> anyhow::Result<String> {
    anyhow::ensure!(!value.is_empty() && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':' | b'[' | b']')), "invalid Host header");
    let parsed = url::Url::parse(&format!("http://{value}/"))?;
    Ok(parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("missing host"))?
        .trim_end_matches('.')
        .to_ascii_lowercase())
}

pub fn rewrite_http_request(buf: &[u8], target: &ProxyTarget, forwarded_proto: &str) -> Vec<u8> {
    let Some(head_end) = header_end(buf) else {
        return buf.to_vec();
    };

    let head = String::from_utf8_lossy(&buf[..head_end]);
    let body = &buf[head_end + 4..];
    let mut lines = head.split("\r\n");
    let Some(request_line) = lines.next() else {
        return buf.to_vec();
    };

    let parts = request_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/1.") {
        return buf.to_vec();
    }

    let rewritten_target = normalize_proxy_path(
        target.url_base_path.as_deref(),
        parts[1],
        target.mount_path.as_deref(),
    );
    let mut rewritten = vec![format!("{} {} {}", parts[0], rewritten_target, parts[2])];
    let mut host_seen = false;
    let mut original_host = None;

    for line in lines {
        if line.to_ascii_lowercase().starts_with("host:") {
            host_seen = true;
            original_host = Some(line[5..].trim().to_string());
            rewritten.push(format!("Host: {}", target.host));
        } else {
            rewritten.push(line.to_string());
        }
    }

    if !host_seen {
        rewritten.push(format!("Host: {}", target.host));
    }
    if let Some(host) = original_host {
        if !rewritten
            .iter()
            .any(|line| line.to_ascii_lowercase().starts_with("x-forwarded-host:"))
        {
            rewritten.push(format!("X-Forwarded-Host: {host}"));
        }
    }
    if !rewritten
        .iter()
        .any(|line| line.to_ascii_lowercase().starts_with("x-forwarded-proto:"))
    {
        rewritten.push(format!("X-Forwarded-Proto: {forwarded_proto}"));
    }

    let mut out = rewritten.join("\r\n").into_bytes();
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
    out
}

pub fn rewrite_http_response(buf: &[u8], target: &ProxyTarget) -> Vec<u8> {
    let Some(protocol) = target.url_protocol.as_deref() else {
        return buf.to_vec();
    };
    let Some(head_end) = header_end(buf) else {
        return buf.to_vec();
    };

    let head = String::from_utf8_lossy(&buf[..head_end]);
    let body = &buf[head_end + 4..];
    let origin = format!("{protocol}://{}", target.host);
    let base_path = target
        .url_base_path
        .as_deref()
        .filter(|path| *path != "/")
        .unwrap_or("");
    let mount_path = target
        .mount_path
        .as_deref()
        .filter(|path| *path != "/")
        .unwrap_or("");
    let origin_with_base = format!("{origin}{base_path}");

    let to_proxy_path = |path: &str| -> String {
        if mount_path.is_empty() {
            return path.to_string();
        }
        if path == "/" {
            return mount_path.to_string();
        }
        format!("{mount_path}{path}")
    };

    let rewritten_lines = head
        .split("\r\n")
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if !lower.starts_with("location:") {
                return line.to_string();
            }

            let location = line[9..].trim();
            if location == origin_with_base || location == format!("{origin_with_base}/") {
                return format!("Location: {}", to_proxy_path("/"));
            }
            if !base_path.is_empty() && location.starts_with(&format!("{origin_with_base}/")) {
                return format!(
                    "Location: {}",
                    to_proxy_path(&location[origin_with_base.len()..])
                );
            }
            if location == origin {
                return format!(
                    "Location: {}",
                    to_proxy_path(if base_path.is_empty() { "/" } else { base_path })
                );
            }
            format!("Location: {location}")
        })
        .collect::<Vec<_>>();

    let mut out = rewritten_lines.join("\r\n").into_bytes();
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
    out
}

fn normalize_proxy_path(
    base_path: Option<&str>,
    request_target: &str,
    mount_path: Option<&str>,
) -> String {
    if request_target.starts_with("http://") || request_target.starts_with("https://") {
        if let Ok(parsed) = url::Url::parse(request_target) {
            return normalize_proxy_path(
                base_path,
                &format!(
                    "{}{}",
                    parsed.path(),
                    parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
                ),
                mount_path,
            );
        }
    }

    let (path_part, query_part) = request_target
        .split_once('?')
        .map_or((request_target, None), |(path, query)| (path, Some(query)));
    if !path_part.starts_with('/') {
        return request_target.to_string();
    }

    let normalized_base = base_path
        .filter(|path| *path != "/")
        .map(|path| path.trim_end_matches('/'))
        .unwrap_or("");

    let mounted_path = strip_mount_path(path_part, mount_path);

    let rewritten_path = if !normalized_base.is_empty()
        && path_part != normalized_base
        && !path_part.starts_with(&format!("{normalized_base}/"))
    {
        if mounted_path == "/" {
            format!("{normalized_base}/")
        } else {
            format!("{normalized_base}{mounted_path}")
        }
    } else {
        mounted_path
    };

    match query_part {
        Some(query) => format!("{rewritten_path}?{query}"),
        None => rewritten_path,
    }
}

fn strip_mount_path(path_part: &str, mount_path: Option<&str>) -> String {
    let Some(mount_path) = mount_path.filter(|path| *path != "/") else {
        return path_part.to_string();
    };
    let normalized_mount = mount_path.trim_end_matches('/');
    if path_part == normalized_mount {
        return "/".to_string();
    }
    if let Some(stripped) = path_part.strip_prefix(&format!("{normalized_mount}/")) {
        return format!("/{stripped}");
    }
    path_part.to_string()
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}
#[cfg(test)]
mod host_routing_tests {
    use super::*;
    #[test]
    fn authority_is_canonical_and_ambiguous_headers_are_rejected() {
        assert_eq!(
            http_request_host(b"GET / HTTP/1.1\r\nHost: SHARE.PEXSERVER.COM.:443\r\n\r\n")
                .unwrap()
                .as_deref(),
            Some("share.pexserver.com")
        );
        for request in [
            "GET / HTTP/1.1\r\nHost: share.pexserver.com\r\nHost: play.pexserver.com\r\n\r\n",
            "GET / HTTP/1.1\r\nHost : share.pexserver.com\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: share.pexserver.com\r\n folded: value\r\n\r\n",
            "GET https://play.pexserver.com/ HTTP/1.1\r\nHost: share.pexserver.com\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: user@share.pexserver.com\r\n\r\n",
        ] {
            assert!(http_request_host(request.as_bytes()).is_err(), "{request}");
        }
    }
}
