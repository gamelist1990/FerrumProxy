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
    if parts.len() < 12 {
        return None;
    }

    let port = listener_port.to_string();
    if parts[10] == port && parts[11] == port {
        return None;
    }

    parts[10] = port.clone();
    parts[11] = port;

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
