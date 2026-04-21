use anyhow::Result;
use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DiscordEmbed {
    pub title: String,
    pub description: String,
    pub color: u32,
    pub timestamp: String,
    pub fields: Vec<DiscordField>,
    pub footer: DiscordFooter,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscordField {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscordFooter {
    pub text: String,
}

#[derive(Debug, Serialize)]
struct DiscordMessage {
    embeds: Vec<DiscordEmbed>,
}

pub async fn send_discord_webhook(
    client: &reqwest::Client,
    webhook: &str,
    embed: DiscordEmbed,
) -> Result<()> {
    if webhook.trim().is_empty() {
        return Ok(());
    }

    client
        .post(webhook)
        .json(&DiscordMessage {
            embeds: vec![embed],
        })
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub fn grouped_connection_embed(
    target: &str,
    protocol: &str,
    groups: Vec<(String, Vec<u16>)>,
) -> DiscordEmbed {
    grouped_embed(
        "接続確立",
        "接続一覧",
        "通知",
        0x3498db,
        target,
        protocol,
        groups,
    )
}

pub fn grouped_disconnection_embed(
    target: &str,
    protocol: &str,
    groups: Vec<(String, Vec<u16>)>,
) -> DiscordEmbed {
    grouped_embed(
        "接続終了",
        "切断一覧",
        "通知",
        0xe74c3c,
        target,
        protocol,
        groups,
    )
}

pub fn player_join_embed(username: &str, ip: &str, ports: &[u16], protocol: &str) -> DiscordEmbed {
    DiscordEmbed {
        title: format!("{username} が参加しました"),
        description: format!("プレイヤーが接続しました（{protocol}）"),
        color: 0x00ff00,
        timestamp: Utc::now().to_rfc3339(),
        fields: vec![
            field("ユーザー名", username, true),
            field("IPアドレス", ip, true),
            field("ポート", &join_ports(ports), true),
            field("プロトコル", protocol, true),
        ],
        footer: footer(),
    }
}

pub fn player_login_embed(username: &str) -> DiscordEmbed {
    DiscordEmbed {
        title: format!("{username} がログインしました"),
        description: "サーバーからログイン通知を受信しました（Management API）".to_string(),
        color: 0x00ff00,
        timestamp: Utc::now().to_rfc3339(),
        fields: vec![
            field("ユーザー名", username, true),
            field("情報源", "Management API", true),
        ],
        footer: footer(),
    }
}

pub fn player_logout_embed(
    username: &str,
    ip: Option<&str>,
    ports: Option<&[u16]>,
    protocol: Option<&str>,
) -> DiscordEmbed {
    let mut fields = vec![field("ユーザー名", username, true)];
    if let Some(ip) = ip {
        fields.push(field("IPアドレス", ip, true));
    }
    if let Some(ports) = ports.filter(|ports| !ports.is_empty()) {
        fields.push(field("ポート", &join_ports(ports), true));
    }
    if let Some(protocol) = protocol {
        fields.push(field("プロトコル", protocol, true));
    }
    fields.push(field("情報源", "Management API", true));

    DiscordEmbed {
        title: format!("{username} がログアウトしました"),
        description: "サーバーからログアウト通知を受信しました".to_string(),
        color: 0xff0000,
        timestamp: Utc::now().to_rfc3339(),
        fields,
        footer: footer(),
    }
}

fn grouped_embed(
    title: &str,
    field_name: &str,
    description: &str,
    color: u32,
    target: &str,
    protocol: &str,
    groups: Vec<(String, Vec<u16>)>,
) -> DiscordEmbed {
    let lines = groups
        .into_iter()
        .map(|(ip, ports)| format!("[{protocol}] {ip}:{} => {target}", join_ports(&ports)))
        .collect::<Vec<_>>()
        .join("\n");

    DiscordEmbed {
        title: title.to_string(),
        description: format!("{description} ({protocol})"),
        color,
        timestamp: Utc::now().to_rfc3339(),
        fields: vec![field(field_name, &lines, false)],
        footer: footer(),
    }
}

fn field(name: &str, value: &str, inline: bool) -> DiscordField {
    DiscordField {
        name: name.to_string(),
        value: value.to_string(),
        inline: Some(inline),
    }
}

fn footer() -> DiscordFooter {
    DiscordFooter {
        text: "FerrumProxy".to_string(),
    }
}

fn join_ports(ports: &[u16]) -> String {
    ports
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}
