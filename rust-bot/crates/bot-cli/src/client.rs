//! Thin HTTP client for the running daemon (`bot-web` bridge).

use anyhow::{anyhow, Context};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct DaemonClient {
    base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl DaemonClient {
    pub fn new(base: &str, token: Option<String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("Failed to build HTTP client")?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            token: token.filter(|t| !t.trim().is_empty()),
            http,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base, path);
        let mut req = self.http.request(method, url);
        if let Some(token) = &self.token {
            req = req.header("x-apexrust-token", token);
        }
        req
    }

    pub async fn get(&self, path: &str) -> anyhow::Result<Value> {
        let resp = self
            .request(reqwest::Method::GET, path)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        self.decode(resp, path).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> anyhow::Result<Value> {
        let resp = self
            .request(reqwest::Method::POST, path)
            .json(body)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        self.decode(resp, path).await
    }

    async fn decode(&self, resp: reqwest::Response, path: &str) -> anyhow::Result<Value> {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let detail = parsed
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.trim().to_string());
            return Err(anyhow!(
                "Daemon menolak {} (HTTP {}): {}",
                path,
                status.as_u16(),
                if detail.is_empty() {
                    "-"
                } else {
                    detail.as_str()
                }
            ));
        }
        if parsed.is_null() && !text.trim().is_empty() {
            return Err(anyhow!(
                "Daemon membalas bukan JSON untuk {}: {}",
                path,
                text.chars().take(160).collect::<String>()
            ));
        }
        Ok(parsed)
    }

    fn unreachable(&self, err: reqwest::Error) -> anyhow::Error {
        anyhow!(
            "Daemon tidak dapat dihubungi di {}: {err}\n       Jalankan `apexrust run` (atau `./apexrust start bot`) lalu coba lagi.",
            self.base
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_base_url() {
        let client = DaemonClient::new("http://127.0.0.1:8080/", None).unwrap();
        assert_eq!(client.base(), "http://127.0.0.1:8080");
    }
}
