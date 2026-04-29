use std::fmt::Write;

const RAKNET_OFFLINE_MESSAGE_ID: [u8; 16] = [
    0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
];

const UNCONNECTED_PING_ID: u8 = 0x01;
const UNCONNECTED_PING_OPEN_CONNECTIONS_ID: u8 = 0x02;
const UNCONNECTED_PONG_ID: u8 = 0x1c;
const UNCONNECTED_PONG_STRING_OFFSET: usize = 35;

pub fn is_offline_ping(payload: &[u8]) -> bool {
    if payload.len() < 25 {
        return false;
    }

    matches!(
        payload[0],
        UNCONNECTED_PING_ID | UNCONNECTED_PING_OPEN_CONNECTIONS_ID
    ) && payload[9..25] == RAKNET_OFFLINE_MESSAGE_ID
}

pub fn is_disconnect_notification(payload: &[u8]) -> bool {
    payload.first().copied() == Some(0x15)
}

pub fn describe_raknet_packet(payload: &[u8]) -> Option<String> {
    let packet_id = *payload.first()?;
    match packet_id {
        UNCONNECTED_PING_ID | UNCONNECTED_PING_OPEN_CONNECTIONS_ID => {
            describe_offline_ping(payload)
        }
        UNCONNECTED_PONG_ID => describe_unconnected_pong(payload),
        0x05 => describe_open_connection_request_1(payload),
        0x06 => describe_open_connection_reply_1(payload),
        0x07 => describe_open_connection_request_2(payload),
        0x08 => describe_open_connection_reply_2(payload),
        0x09 => describe_connection_request(payload),
        0x10 => Some(format!("Connection Request Accepted len={}", payload.len())),
        0x13 => Some(format!("New Incoming Connection len={}", payload.len())),
        0x15 => Some(format!("Disconnect Notification len={}", payload.len())),
        0x80..=0x8d => describe_frame_set(payload),
        _ => Some(format!(
            "RakNet packet id=0x{packet_id:02x} len={}",
            payload.len()
        )),
    }
}

pub fn describe_offline_ping(payload: &[u8]) -> Option<String> {
    if !is_offline_ping(payload) {
        return None;
    }

    let timestamp = u64::from_be_bytes(payload[1..9].try_into().ok()?);
    let client_guid = if payload.len() >= 33 {
        Some(u64::from_be_bytes(payload[25..33].try_into().ok()?))
    } else {
        None
    };

    Some(format!(
        "id=0x{:02x} len={} timestamp={} client_guid={}",
        payload[0],
        payload.len(),
        timestamp,
        client_guid
            .map(|guid| guid.to_string())
            .unwrap_or_else(|| "missing".to_string())
    ))
}

pub fn is_unconnected_pong(payload: &[u8]) -> bool {
    parse_unconnected_pong(payload).is_some()
}

pub fn describe_unconnected_pong(payload: &[u8]) -> Option<String> {
    let parsed = parse_unconnected_pong(payload)?;
    let timestamp = u64::from_be_bytes(payload[1..9].try_into().ok()?);
    let server_guid = u64::from_be_bytes(payload[9..17].try_into().ok()?);
    let parts = parsed.motd.split(';').collect::<Vec<_>>();
    let mut description = format!(
        "id=0x{:02x} len={} timestamp={} server_guid={} string_len={} motd_fields={}",
        payload[0],
        payload.len(),
        timestamp,
        server_guid,
        parsed.string_end - UNCONNECTED_PONG_STRING_OFFSET,
        parts.len()
    );

    if parts.len() >= 12 {
        let _ = write!(
            description,
            " edition={} protocol={} version={} players={}/{} port_v4={} port_v6={} name=\"{}\"",
            parts[0],
            parts[2],
            parts[3],
            parts[4],
            parts[5],
            parts[10],
            parts[11],
            truncate_for_log(parts[1], 96)
        );
    } else {
        let _ = write!(
            description,
            " motd=\"{}\"",
            truncate_for_log(&parsed.motd, 160)
        );
    }

    Some(description)
}

fn describe_open_connection_request_1(payload: &[u8]) -> Option<String> {
    if payload.len() < 18 || payload[0] != 0x05 || payload[1..17] != RAKNET_OFFLINE_MESSAGE_ID {
        return None;
    }

    Some(format!(
        "Open Connection Request 1 len={} protocol={} mtu_probe={}",
        payload.len(),
        payload[17],
        payload.len() + 28
    ))
}

fn describe_open_connection_reply_1(payload: &[u8]) -> Option<String> {
    if payload.len() < 28 || payload[0] != 0x06 || payload[1..17] != RAKNET_OFFLINE_MESSAGE_ID {
        return None;
    }

    let server_guid = u64::from_be_bytes(payload[17..25].try_into().ok()?);
    let has_security = payload[25] != 0;
    let mtu = u16::from_be_bytes(payload[payload.len() - 2..].try_into().ok()?);
    Some(format!(
        "Open Connection Reply 1 len={} server_guid={} security={} mtu={}",
        payload.len(),
        server_guid,
        has_security,
        mtu
    ))
}

fn describe_open_connection_request_2(payload: &[u8]) -> Option<String> {
    if payload.len() < 34 || payload[0] != 0x07 || payload[1..17] != RAKNET_OFFLINE_MESSAGE_ID {
        return None;
    }

    let mtu = u16::from_be_bytes(
        payload[payload.len() - 10..payload.len() - 8]
            .try_into()
            .ok()?,
    );
    let client_guid = u64::from_be_bytes(payload[payload.len() - 8..].try_into().ok()?);
    Some(format!(
        "Open Connection Request 2 len={} mtu={} client_guid={} raw_tail={}",
        payload.len(),
        mtu,
        client_guid,
        hex_prefix(&payload[payload.len().saturating_sub(16)..], 16)
    ))
}

fn describe_open_connection_reply_2(payload: &[u8]) -> Option<String> {
    if payload.len() < 35 || payload[0] != 0x08 || payload[1..17] != RAKNET_OFFLINE_MESSAGE_ID {
        return None;
    }

    let server_guid = u64::from_be_bytes(payload[17..25].try_into().ok()?);
    let mtu = u16::from_be_bytes(
        payload[payload.len() - 3..payload.len() - 1]
            .try_into()
            .ok()?,
    );
    let security = payload[payload.len() - 1] != 0;
    Some(format!(
        "Open Connection Reply 2 len={} server_guid={} mtu={} security={} raw_tail={}",
        payload.len(),
        server_guid,
        mtu,
        security,
        hex_prefix(&payload[payload.len().saturating_sub(16)..], 16)
    ))
}

fn describe_connection_request(payload: &[u8]) -> Option<String> {
    if payload.len() < 18 || payload[0] != 0x09 {
        return None;
    }

    let client_guid = u64::from_be_bytes(payload[1..9].try_into().ok()?);
    let timestamp = u64::from_be_bytes(payload[9..17].try_into().ok()?);
    let secure = payload[17] != 0;
    Some(format!(
        "Connection Request len={} client_guid={} timestamp={} secure={}",
        payload.len(),
        client_guid,
        timestamp,
        secure
    ))
}

fn describe_frame_set(payload: &[u8]) -> Option<String> {
    let sequence = read_u24_le(payload, 1)?;
    let mut offset = 4;
    let mut frames = Vec::new();

    while offset + 3 <= payload.len() && frames.len() < 8 {
        let frame_start = offset;
        let flags = payload[offset];
        offset += 1;

        let bit_length = u16::from_be_bytes(payload[offset..offset + 2].try_into().ok()?);
        offset += 2;
        let body_length = (usize::from(bit_length) + 7) / 8;
        let reliability = flags >> 5;
        let split = flags & 0x10 != 0;

        if matches!(reliability, 2 | 3 | 4 | 6 | 7) {
            offset += 3;
        }
        if matches!(reliability, 1 | 4) {
            offset += 3;
        }
        if matches!(reliability, 1 | 3 | 4 | 7) {
            offset += 4;
        }
        if split {
            offset += 10;
        }
        if offset > payload.len() {
            frames.push(format!(
                "#{} truncated flags=0x{flags:02x} reliability={reliability} bit_len={bit_length}",
                frames.len()
            ));
            break;
        }

        let body_start = offset;
        let body_end = body_start.saturating_add(body_length);
        if body_end > payload.len() {
            frames.push(format!(
                "#{} truncated_body flags=0x{flags:02x} reliability={reliability} bit_len={bit_length} body_start={body_start}",
                frames.len()
            ));
            break;
        }

        let body = &payload[body_start..body_end];
        let body_id = body.first().copied();
        frames.push(format!(
            "#{} offset={} flags=0x{flags:02x} reliability={reliability} split={} bit_len={} body_len={} body_id={}{}",
            frames.len(),
            frame_start,
            split,
            bit_length,
            body_length,
            body_id
                .map(|id| format!("0x{id:02x}"))
                .unwrap_or_else(|| "missing".to_string()),
            body_id
                .and_then(frame_body_name)
                .map(|name| format!(" ({name})"))
                .unwrap_or_default()
        ));
        offset = body_end;
    }

    let suffix = if offset < payload.len() {
        format!(" trailing={}B", payload.len() - offset)
    } else {
        String::new()
    };

    Some(format!(
        "Frame Set id=0x{:02x} len={} sequence={} frames=[{}]{}",
        payload[0],
        payload.len(),
        sequence,
        frames.join("; "),
        suffix
    ))
}

pub fn rewrite_unconnected_pong_timestamp(payload: &[u8], timestamp: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < UNCONNECTED_PONG_STRING_OFFSET
        || payload.first().copied() != Some(UNCONNECTED_PONG_ID)
        || timestamp.len() != 8
    {
        return None;
    }

    let mut out = payload.to_vec();
    out[1..9].copy_from_slice(timestamp);
    Some(out)
}

pub fn rewrite_unconnected_pong_ports(payload: &[u8], listener_port: u16) -> Option<Vec<u8>> {
    let parsed = parse_unconnected_pong(payload)?;
    let mut parts = parsed
        .motd
        .split(';')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.len() < 11 {
        return None;
    }

    let port = listener_port.to_string();
    let already_rewritten = parts.get(10).map_or(false, |value| value == &port)
        && parts.get(11).map_or(true, |value| value == &port);
    if already_rewritten {
        return None;
    }

    parts[10] = port.clone();
    if let Some(port_v6) = parts.get_mut(11) {
        *port_v6 = port;
    }

    let rewritten_motd = parts.join(";");
    let motd_bytes = rewritten_motd.as_bytes();
    if motd_bytes.len() > u16::MAX as usize {
        return None;
    }

    let mut out = Vec::with_capacity(payload.len() + motd_bytes.len());
    out.extend_from_slice(&payload[..33]);
    out.extend_from_slice(&(motd_bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(motd_bytes);
    out.extend_from_slice(&payload[parsed.string_end..]);
    Some(out)
}

struct ParsedPong {
    motd: String,
    string_end: usize,
}

fn parse_unconnected_pong(payload: &[u8]) -> Option<ParsedPong> {
    if payload.len() < UNCONNECTED_PONG_STRING_OFFSET || payload[0] != UNCONNECTED_PONG_ID {
        return None;
    }

    if payload[17..33] != RAKNET_OFFLINE_MESSAGE_ID {
        return None;
    }

    let string_length = u16::from_be_bytes([payload[33], payload[34]]) as usize;
    let string_end = UNCONNECTED_PONG_STRING_OFFSET.checked_add(string_length)?;
    if payload.len() < string_end {
        return None;
    }

    let motd = std::str::from_utf8(&payload[UNCONNECTED_PONG_STRING_OFFSET..string_end])
        .ok()?
        .to_string();

    Some(ParsedPong { motd, string_end })
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

fn read_u24_le(payload: &[u8], offset: usize) -> Option<u32> {
    if payload.len() < offset + 3 {
        return None;
    }
    Some(
        payload[offset] as u32
            | ((payload[offset + 1] as u32) << 8)
            | ((payload[offset + 2] as u32) << 16),
    )
}

fn hex_prefix(payload: &[u8], max_len: usize) -> String {
    let mut out = String::new();
    for (index, byte) in payload.iter().take(max_len).enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let _ = write!(out, "{byte:02x}");
    }
    if payload.len() > max_len {
        out.push_str(" ...");
    }
    out
}

fn frame_body_name(packet_id: u8) -> Option<&'static str> {
    match packet_id {
        0x00 => Some("Connected Ping"),
        0x03 => Some("Connected Pong"),
        0x09 => Some("Connection Request"),
        0x10 => Some("Connection Request Accepted"),
        0x13 => Some("New Incoming Connection"),
        0x15 => Some("Disconnect Notification"),
        0xfe => Some("Game Packet"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_unconnected_pong_ipv4_and_ipv6_ports() {
        let pong =
            bedrock_pong("MCPE;Dedicated Server;390;1.20.0;0;10;123;World;Survival;1;19132;19133;");
        let rewritten = rewrite_unconnected_pong_ports(&pong, 43211).expect("pong rewritten");
        let description = describe_unconnected_pong(&rewritten).expect("pong parsed");

        assert!(description.contains("port_v4=43211"));
        assert!(description.contains("port_v6=43211"));
    }

    #[test]
    fn rewrites_unconnected_pong_with_only_ipv4_port_field() {
        let pong = bedrock_pong("MCPE;Dedicated Server;390;1.20.0;0;10;123;World;Survival;1;19132");
        let rewritten = rewrite_unconnected_pong_ports(&pong, 43211).expect("pong rewritten");
        let parsed = parse_unconnected_pong(&rewritten).expect("pong parsed");

        assert_eq!(
            parsed.motd,
            "MCPE;Dedicated Server;390;1.20.0;0;10;123;World;Survival;1;43211"
        );
    }

    fn bedrock_pong(motd: &str) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(UNCONNECTED_PONG_ID);
        payload.extend_from_slice(&0u64.to_be_bytes());
        payload.extend_from_slice(&0u64.to_be_bytes());
        payload.extend_from_slice(&RAKNET_OFFLINE_MESSAGE_ID);
        payload.extend_from_slice(&(motd.len() as u16).to_be_bytes());
        payload.extend_from_slice(motd.as_bytes());
        payload
    }
}
