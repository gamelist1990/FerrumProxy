use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tracing::warn;

use crate::discord::{grouped_connection_embed, grouped_disconnection_embed, send_discord_webhook};

const GROUP_WINDOW: Duration = Duration::from_secs(3);

type GroupMap = HashMap<String, HashMap<String, HashSet<u16>>>;

#[derive(Clone)]
pub struct WebhookGroupNotifier {
    client: reqwest::Client,
    connects: Arc<Mutex<GroupMap>>,
    disconnects: Arc<Mutex<GroupMap>>,
}

impl WebhookGroupNotifier {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            connects: Arc::new(Mutex::new(HashMap::new())),
            disconnects: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_connect_group(
        &self,
        webhook: String,
        target: String,
        ip: String,
        port: u16,
        protocol: &'static str,
    ) {
        self.add(
            self.connects.clone(),
            webhook,
            target,
            ip,
            port,
            protocol,
            true,
        )
        .await;
    }

    pub async fn add_disconnect_group(
        &self,
        webhook: String,
        target: String,
        ip: String,
        port: u16,
        protocol: &'static str,
    ) {
        self.add(
            self.disconnects.clone(),
            webhook,
            target,
            ip,
            port,
            protocol,
            false,
        )
        .await;
    }

    async fn add(
        &self,
        groups: Arc<Mutex<GroupMap>>,
        webhook: String,
        target: String,
        ip: String,
        port: u16,
        protocol: &'static str,
        connect: bool,
    ) {
        let group_key = make_group_key(&webhook, protocol, &target);
        let should_spawn = {
            let mut guard = groups.lock().await;
            let should_spawn = !guard.contains_key(&group_key);
            guard
                .entry(group_key.clone())
                .or_default()
                .entry(ip)
                .or_default()
                .insert(port);
            should_spawn
        };

        if should_spawn {
            let client = self.client.clone();
            tokio::spawn(async move {
                tokio::time::sleep(GROUP_WINDOW).await;
                let map = groups.lock().await.remove(&group_key);
                let Some(map) = map else {
                    return;
                };
                let grouped = map
                    .into_iter()
                    .map(|(ip, ports)| {
                        let mut ports = ports.into_iter().collect::<Vec<_>>();
                        ports.sort_unstable();
                        (ip, ports)
                    })
                    .collect::<Vec<_>>();
                let embed = if connect {
                    grouped_connection_embed(&target, protocol, grouped)
                } else {
                    grouped_disconnection_embed(&target, protocol, grouped)
                };
                if let Err(err) = send_discord_webhook(&client, &webhook, embed).await {
                    warn!("failed to send webhook group: {err:#}");
                }
            });
        }
    }
}

fn make_group_key(webhook: &str, protocol: &str, target: &str) -> String {
    format!("{webhook}::{protocol}::{target}")
}
