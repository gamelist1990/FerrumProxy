use std::net::IpAddr;

use anyhow::{bail, Result};

const SIGNATURE: &[u8; 12] = b"\r\n\r\n\0\r\nQUIT\n";
const VERSION_COMMAND_PROXY: u8 = 0x21;
const FAMILY_INET_STREAM: u8 = 0x11;
const FAMILY_INET_DGRAM: u8 = 0x12;
const FAMILY_INET6_STREAM: u8 = 0x21;
const FAMILY_INET6_DGRAM: u8 = 0x22;

#[derive(Debug, Clone)]
pub struct ProxyHeader {
    pub source_address: IpAddr,
    pub source_port: u16,
    pub destination_address: IpAddr,
    pub destination_port: u16,
}

#[derive(Debug, Clone)]
pub struct ParsedProxyChain {
    pub headers: Vec<ProxyHeader>,
    pub payload_offset: usize,
}

pub fn parse_proxy_chain(buf: &[u8]) -> Result<ParsedProxyChain> {
    let mut offset = 0;
    let mut headers = Vec::new();

    while buf.len().saturating_sub(offset) >= 16 && &buf[offset..offset + 12] == SIGNATURE {
        if buf[offset + 12] != VERSION_COMMAND_PROXY {
            bail!("unsupported PROXY protocol command");
        }

        let family = buf[offset + 13];
        let len = u16::from_be_bytes([buf[offset + 14], buf[offset + 15]]) as usize;
        let body_start = offset + 16;
        let body_end = body_start + len;
        if body_end > buf.len() {
            bail!("truncated PROXY protocol header");
        }

        let header = match family {
            FAMILY_INET_STREAM | FAMILY_INET_DGRAM => parse_ipv4(&buf[body_start..body_end])?,
            FAMILY_INET6_STREAM | FAMILY_INET6_DGRAM => parse_ipv6(&buf[body_start..body_end])?,
            _ => bail!("unsupported PROXY protocol family"),
        };
        headers.push(header);
        offset = body_end;
    }

    Ok(ParsedProxyChain {
        headers,
        payload_offset: offset,
    })
}

pub fn build_proxy_v2_header(
    source_address: IpAddr,
    source_port: u16,
    destination_address: IpAddr,
    destination_port: u16,
    datagram: bool,
) -> Vec<u8> {
    let mut header = Vec::with_capacity(52);
    header.extend_from_slice(SIGNATURE);
    header.push(VERSION_COMMAND_PROXY);

    match (source_address, destination_address) {
        (IpAddr::V4(src), IpAddr::V4(dst)) => {
            header.push(if datagram {
                FAMILY_INET_DGRAM
            } else {
                FAMILY_INET_STREAM
            });
            header.extend_from_slice(&12u16.to_be_bytes());
            header.extend_from_slice(&src.octets());
            header.extend_from_slice(&dst.octets());
        }
        (IpAddr::V6(src), IpAddr::V6(dst)) => {
            header.push(if datagram {
                FAMILY_INET6_DGRAM
            } else {
                FAMILY_INET6_STREAM
            });
            header.extend_from_slice(&36u16.to_be_bytes());
            header.extend_from_slice(&src.octets());
            header.extend_from_slice(&dst.octets());
        }
        (src, dst) => {
            let src = src.to_ipv6_mapped();
            let dst = dst.to_ipv6_mapped();
            header.push(if datagram {
                FAMILY_INET6_DGRAM
            } else {
                FAMILY_INET6_STREAM
            });
            header.extend_from_slice(&36u16.to_be_bytes());
            header.extend_from_slice(&src.octets());
            header.extend_from_slice(&dst.octets());
        }
    }

    header.extend_from_slice(&source_port.to_be_bytes());
    header.extend_from_slice(&destination_port.to_be_bytes());
    header
}

fn parse_ipv4(body: &[u8]) -> Result<ProxyHeader> {
    if body.len() < 12 {
        bail!("truncated IPv4 PROXY protocol body");
    }

    Ok(ProxyHeader {
        source_address: IpAddr::from([body[0], body[1], body[2], body[3]]),
        destination_address: IpAddr::from([body[4], body[5], body[6], body[7]]),
        source_port: u16::from_be_bytes([body[8], body[9]]),
        destination_port: u16::from_be_bytes([body[10], body[11]]),
    })
}

fn parse_ipv6(body: &[u8]) -> Result<ProxyHeader> {
    if body.len() < 36 {
        bail!("truncated IPv6 PROXY protocol body");
    }

    let mut src = [0u8; 16];
    let mut dst = [0u8; 16];
    src.copy_from_slice(&body[0..16]);
    dst.copy_from_slice(&body[16..32]);

    Ok(ProxyHeader {
        source_address: IpAddr::from(src),
        destination_address: IpAddr::from(dst),
        source_port: u16::from_be_bytes([body[32], body[33]]),
        destination_port: u16::from_be_bytes([body[34], body[35]]),
    })
}

trait IpAddrExt {
    fn to_ipv6_mapped(self) -> std::net::Ipv6Addr;
}

impl IpAddrExt for IpAddr {
    fn to_ipv6_mapped(self) -> std::net::Ipv6Addr {
        match self {
            IpAddr::V4(ip) => ip.to_ipv6_mapped(),
            IpAddr::V6(ip) => ip,
        }
    }
}
