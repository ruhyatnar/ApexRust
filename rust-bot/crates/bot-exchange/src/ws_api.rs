//! Binance WebSocket API transport (`session.logon` + `order.place`).
//!
//! Binance exposes a JSON-RPC style WebSocket API where an Ed25519 (or HMAC)
//! signed `session.logon` upgrades the connection so subsequent requests do not
//! need a per-request signature. This module keeps one authenticated session per
//! venue and falls back to REST in the caller on any error.
//!
//! Important constraints:
//! - `session.logon` is only available for **Ed25519** keys. HMAC keys can still
//!   use signed `order.place` requests, which is implemented here as a supported
//!   (not latency-optimised) path.
//! - The client is deliberately single-flight: Binance expects ordered requests
//!   and the engine never needs concurrent order submission.

use bot_core::{BotError, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, Result};
use chrono::Utc;
use ed25519_dalek::{pkcs8::DecodePrivateKey, Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tracing::{info, warn};

type HmacSha256 = Hmac<Sha256>;
type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const RPC_TIMEOUT: Duration = Duration::from_secs(8);

/// Signing material resolved from `ExchangeConfig` + environment variables.
#[derive(Clone)]
pub enum WsApiSigner {
    Hmac(Vec<u8>),
    Ed25519(Box<SigningKey>),
}

#[derive(Clone)]
pub struct WsApiCredentials {
    pub api_key: String,
    pub signer: WsApiSigner,
}

impl std::fmt::Debug for WsApiCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsApiCredentials")
            .field("api_key", &mask_key(&self.api_key))
            .field(
                "auth",
                &match self.signer {
                    WsApiSigner::Hmac(_) => "HMAC-SHA256",
                    WsApiSigner::Ed25519(_) => "Ed25519",
                },
            )
            .finish()
    }
}

pub fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.len() <= 8 {
        return "****".into();
    }
    format!("{}…{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

impl WsApiCredentials {
    /// Resolves credentials using the same env conventions as the REST SDK.
    pub fn from_exchange_config(cfg: &ExchangeConfig) -> Result<Option<Self>> {
        let creds = match cfg.credentials.as_ref() {
            Some(c) => c,
            None => return Ok(None),
        };
        let Ok(api_key) = std::env::var(&creds.api_key_env) else {
            return Ok(None);
        };
        let api_key = api_key.trim().to_string();
        if api_key.is_empty() {
            return Ok(None);
        }

        let signer = match creds.auth_method {
            bot_core::AuthMethod::Ed25519 => {
                let pem = resolve_ed25519_pem(creds)?;
                let Some(pem) = pem else {
                    return Ok(None);
                };
                let key = SigningKey::from_pkcs8_pem(&pem).map_err(|e| {
                    BotError::Config(format!("Invalid Ed25519 PKCS#8 private key: {e}"))
                })?;
                WsApiSigner::Ed25519(Box::new(key))
            }
            bot_core::AuthMethod::HmacSha256 => {
                let Ok(secret) = std::env::var(&creds.api_secret_env) else {
                    return Ok(None);
                };
                if secret.trim().is_empty() {
                    return Ok(None);
                }
                WsApiSigner::Hmac(secret.trim().as_bytes().to_vec())
            }
        };

        Ok(Some(Self { api_key, signer }))
    }

    /// Base64 signature over the canonical query-string payload.
    pub fn sign(&self, payload: &str) -> String {
        match &self.signer {
            WsApiSigner::Ed25519(key) => {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(key.sign(payload.as_bytes()).to_bytes())
            }
            WsApiSigner::Hmac(secret) => {
                use base64::Engine as _;
                let mut mac = HmacSha256::new_from_slice(secret)
                    .expect("HMAC accepts keys of any length");
                mac.update(payload.as_bytes());
                base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
            }
        }
    }

    pub fn supports_session_logon(&self) -> bool {
        matches!(self.signer, WsApiSigner::Ed25519(_))
    }
}

fn resolve_ed25519_pem(creds: &bot_core::LiveCredentialsConfig) -> Result<Option<String>> {
    if let Some(path) = creds
        .ed25519_key_path
        .clone()
        .or_else(|| std::env::var("BINANCE_PRIVATE_KEY_PATH").ok())
    {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let pem = std::fs::read_to_string(trimmed).map_err(|e| {
                BotError::Config(format!("Failed to read Ed25519 key at {trimmed}: {e}"))
            })?;
            return Ok(Some(pem));
        }
    }
    if let Ok(pem) = std::env::var("BINANCE_ED25519_PRIVATE_KEY") {
        if !pem.trim().is_empty() {
            return Ok(Some(pem));
        }
    }
    Ok(None)
}

/// Canonical payload signed by `session.logon`: `apiKey=…&timestamp=…` (+ recvWindow).
pub fn logon_payload(api_key: &str, timestamp_ms: i64, recv_window_ms: Option<u64>) -> String {
    match recv_window_ms {
        Some(window) => format!(
            "apiKey={api_key}&recvWindow={window}&timestamp={timestamp_ms}"
        ),
        None => format!("apiKey={api_key}&timestamp={timestamp_ms}"),
    }
}

/// Builds the `session.logon` params map.
pub fn build_logon_params(
    creds: &WsApiCredentials,
    timestamp_ms: i64,
    recv_window_ms: Option<u64>,
) -> Value {
    let payload = logon_payload(&creds.api_key, timestamp_ms, recv_window_ms);
    let signature = creds.sign(&payload);
    let mut params = json!({
        "apiKey": creds.api_key,
        "timestamp": timestamp_ms,
        "signature": signature,
    });
    if let Some(window) = recv_window_ms {
        params["recvWindow"] = json!(window);
    }
    params
}

/// Builds a `order.place` params map. `quantity` and the optional limit price
/// (with its time-in-force) must already be rounded to the symbol filters by the
/// caller. `None` for `limit` means a MARKET order.
pub fn build_order_place_params(
    symbol: &str,
    side: &str,
    order_type: &str,
    quantity: f64,
    limit: Option<(f64, Option<&str>)>,
    reduce_only: bool,
    client_order_id: Option<&str>,
) -> Result<Value> {
    if symbol.trim().is_empty() {
        return Err(BotError::RestApi("WS API order requires a symbol".into()));
    }
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(BotError::RestApi(
            "WS API order requires a positive quantity".into(),
        ));
    }
    let mut params = json!({
        "symbol": symbol.trim().to_uppercase(),
        "side": side.to_uppercase(),
        "type": order_type.to_uppercase(),
        "quantity": format_decimal(quantity),
        "newOrderRespType": "RESULT",
    });
    if let Some((px, time_in_force)) = limit {
        if !px.is_finite() || px <= 0.0 {
            return Err(BotError::RestApi("Invalid WS API limit price".into()));
        }
        params["price"] = json!(format_decimal(px));
        params["timeInForce"] = json!(time_in_force.unwrap_or("GTC").to_uppercase());
    }
    if reduce_only {
        params["reduceOnly"] = json!(true);
    }
    if let Some(cid) = client_order_id {
        params["newClientOrderId"] = json!(cid);
    }
    Ok(params)
}

fn format_decimal(value: f64) -> String {
    let mut s = format!("{value:.8}");
    while s.contains('.') && s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

/// Default WebSocket API endpoint for a venue/environment pair.
pub fn default_ws_api_url(venue: ExchangeVenue, environment: ExchangeEnvironment) -> &'static str {
    match (venue, environment) {
        (ExchangeVenue::Futures, ExchangeEnvironment::Production) => {
            "wss://ws-fapi.binance.com/ws-fapi/v1"
        }
        (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
            "wss://testnet.binancefuture.com/ws-fapi/v1"
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
            "wss://ws-api.binance.com:443/ws-api/v3"
        }
        (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
            "wss://ws-api.testnet.binance.vision/ws-api/v3"
        }
    }
}

struct Session {
    ws: WsStream,
    next_id: u64,
}

/// Single-flight authenticated WebSocket API session.
pub struct WsApiClient {
    url: String,
    creds: WsApiCredentials,
    recv_window_ms: u64,
    session: Mutex<Option<Session>>,
}

impl WsApiClient {
    pub fn new(url: impl Into<String>, creds: WsApiCredentials, recv_window_ms: u64) -> Self {
        Self {
            url: url.into(),
            creds,
            recv_window_ms: recv_window_ms.clamp(1_000, 60_000),
            session: Mutex::new(None),
        }
    }

    pub fn from_config(cfg: &ExchangeConfig) -> Result<Option<Self>> {
        if !cfg.use_ws_api_orders {
            return Ok(None);
        }
        let Some(creds) = WsApiCredentials::from_exchange_config(cfg)? else {
            return Ok(None);
        };
        let url = if cfg.ws_api_url.trim().is_empty() {
            default_ws_api_url(cfg.venue, cfg.environment).to_string()
        } else {
            cfg.ws_api_url.trim().to_string()
        };
        let recv_window = cfg
            .credentials
            .as_ref()
            .map(|c| c.recv_window_ms)
            .unwrap_or(5_000);
        Ok(Some(Self::new(url, creds, recv_window)))
    }

    async fn connect(&self) -> Result<Session> {
        let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(&self.url))
            .await
            .map_err(|_| BotError::WebSocket("WS API connect timed out".into()))?
            .map_err(|e| BotError::WebSocket(format!("WS API connect failed: {e}")))?;
        let mut session = Session { ws, next_id: 1 };

        if self.creds.supports_session_logon() {
            let params = build_logon_params(&self.creds, Utc::now().timestamp_millis(), Some(self.recv_window_ms));
            let response = send_rpc(&mut session, "session.logon", params).await?;
            if response.get("status").and_then(Value::as_i64) != Some(200) {
                return Err(BotError::RestApi(format!(
                    "session.logon rejected: {}",
                    describe_error(&response)
                )));
            }
            info!(url = %self.url, api_key = %mask_key(&self.creds.api_key), "Binance WS API session.logon succeeded");
        }
        Ok(session)
    }

    /// Adds `timestamp` + `signature` for HMAC keys (which cannot use `session.logon`).
    fn sign_request_params(&self, params: Value) -> Value {
        if self.creds.supports_session_logon() {
            return params;
        }
        let mut object = params.as_object().cloned().unwrap_or_default();
        object.insert(
            "timestamp".into(),
            json!(Utc::now().timestamp_millis()),
        );
        object.insert("recvWindow".into(), json!(self.recv_window_ms));
        let mut keys: Vec<&String> = object.keys().collect();
        keys.sort();
        let payload = keys
            .iter()
            .filter_map(|key| {
                let value = object.get(*key)?;
                let rendered = match value {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => return None,
                };
                Some(format!("{key}={rendered}"))
            })
            .collect::<Vec<_>>()
            .join("&");
        object.insert("signature".into(), json!(self.creds.sign(&payload)));
        Value::Object(object)
    }

    /// Sends one authenticated JSON-RPC request, reconnecting once on failure.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let params = self.sign_request_params(params);
        let mut guard = self.session.lock().await;
        if guard.is_none() {
            *guard = Some(self.connect().await?);
        }
        let session = guard.as_mut().expect("session initialised above");
        let result = send_rpc(session, method, params.clone()).await;
        match result {
            Ok(value) => {
                if value.get("status").and_then(Value::as_i64) == Some(200) {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(BotError::RestApi(format!(
                        "{method} failed: {}",
                        describe_error(&value)
                    )))
                }
            }
            Err(first_err) => {
                warn!(%first_err, method, "WS API request failed; reconnecting once");
                *guard = None;
                let mut fresh = self.connect().await?;
                let retry = send_rpc(&mut fresh, method, params).await?;
                if retry.get("status").and_then(Value::as_i64) == Some(200) {
                    *guard = Some(fresh);
                    Ok(retry.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(BotError::RestApi(format!(
                        "{method} failed after reconnect: {}",
                        describe_error(&retry)
                    )))
                }
            }
        }
    }

    pub async fn place_order(&self, params: Value) -> Result<Value> {
        self.request("order.place", params).await
    }

    pub async fn cancel_order(&self, params: Value) -> Result<Value> {
        self.request("order.cancel", params).await
    }

    pub async fn logout(&self) {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_mut() {
            let _ = send_rpc(session, "session.logout", json!({})).await;
        }
        *guard = None;
    }
}

fn describe_error(value: &Value) -> String {
    if let Some(err) = value.get("error") {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
        let msg = err.get("msg").and_then(Value::as_str).unwrap_or("unknown error");
        format!("{msg} (code {code})")
    } else {
        value.to_string()
    }
}

async fn send_rpc(session: &mut Session, method: &str, params: Value) -> Result<Value> {
    let id = session.next_id;
    session.next_id += 1;
    let envelope = json!({ "id": id.to_string(), "method": method, "params": params });
    session
        .ws
        .send(Message::Text(envelope.to_string().into()))
        .await
        .map_err(|e| BotError::WebSocket(format!("WS API send failed: {e}")))?;

    loop {
        let frame = tokio::time::timeout(RPC_TIMEOUT, session.ws.next())
            .await
            .map_err(|_| BotError::WebSocket(format!("WS API {method} timed out")))?;
        let frame = frame.ok_or_else(|| BotError::WebSocket("WS API stream closed".into()))?
            .map_err(|e| BotError::WebSocket(format!("WS API read failed: {e}")))?;
        match frame {
            Message::Text(txt) => {
                let value: Value = serde_json::from_str(&txt)
                    .map_err(|e| BotError::WebSocket(format!("WS API invalid JSON: {e}")))?;
                if value.get("id").and_then(Value::as_str) == Some(id.to_string().as_str()) {
                    return Ok(value);
                }
            }
            Message::Ping(payload) => {
                session
                    .ws
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|e| BotError::WebSocket(format!("WS API pong failed: {e}")))?;
            }
            Message::Close(_) => {
                return Err(BotError::WebSocket("WS API closed by remote".into()));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn ed_cfg() -> WsApiCredentials {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        WsApiCredentials {
            api_key: "test-api-key-123456".into(),
            signer: WsApiSigner::Ed25519(Box::new(key)),
        }
    }

    #[test]
    fn logon_payload_is_canonical_and_signature_is_stable() {
        assert_eq!(
            logon_payload("key", 1_700_000_000_000, None),
            "apiKey=key&timestamp=1700000000000"
        );
        assert_eq!(
            logon_payload("key", 1_700_000_000_000, Some(5_000)),
            "apiKey=key&recvWindow=5000&timestamp=1700000000000"
        );

        let creds = ed_cfg();
        let params = build_logon_params(&creds, 1_700_000_000_000, Some(5_000));
        assert_eq!(params["apiKey"], "test-api-key-123456");
        assert_eq!(params["timestamp"], 1_700_000_000_000i64);
        assert_eq!(params["recvWindow"], 5_000);
        assert_eq!(
            params["signature"].as_str().unwrap(),
            creds.sign("apiKey=test-api-key-123456&recvWindow=5000&timestamp=1700000000000")
        );
        assert!(creds.supports_session_logon());
    }

    #[test]
    fn hmac_signer_matches_reference_mac() {
        let creds = WsApiCredentials {
            api_key: "k".into(),
            signer: WsApiSigner::Hmac(b"secret".to_vec()),
        };
        let mut mac = HmacSha256::new_from_slice(b"secret").unwrap();
        mac.update(b"apiKey=k&timestamp=1");
        use base64::Engine as _;
        let expected =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(creds.sign("apiKey=k&timestamp=1"), expected);
        assert!(!creds.supports_session_logon());
    }

    #[test]
    fn order_params_require_positive_quantity_and_format_decimals() {
        let params =
            build_order_place_params(
                "btcusdt",
                "buy",
                "limit",
                0.0015,
                Some((91_000.5, Some("gtc"))),
                true,
                Some("cid-1"),
            )
            .unwrap();
        assert_eq!(params["symbol"], "BTCUSDT");
        assert_eq!(params["side"], "BUY");
        assert_eq!(params["type"], "LIMIT");
        assert_eq!(params["quantity"], "0.0015");
        assert_eq!(params["price"], "91000.5");
        assert_eq!(params["timeInForce"], "GTC");
        assert_eq!(params["reduceOnly"], true);
        assert_eq!(params["newClientOrderId"], "cid-1");
        assert!(build_order_place_params("BTCUSDT", "BUY", "MARKET", 0.0, None, false, None).is_err());
        assert!(build_order_place_params("", "BUY", "MARKET", 1.0, None, false, None).is_err());
    }

    #[test]
    fn hmac_request_params_are_signed_over_sorted_query_string() {
        let creds = WsApiCredentials {
            api_key: "k".into(),
            signer: WsApiSigner::Hmac(b"secret".to_vec()),
        };
        let client = WsApiClient::new("wss://example.invalid", creds.clone(), 5_000);
        let signed = client.sign_request_params(json!({"symbol": "BTCUSDT", "quantity": "0.01"}));
        assert!(signed.get("signature").is_some());
        assert_eq!(signed["recvWindow"], 5_000);
        assert!(signed["timestamp"].as_i64().unwrap_or(0) > 0);
    }

    #[test]
    fn mask_key_never_leaks_the_middle() {
        assert_eq!(mask_key("1234567890abcdef"), "1234…cdef");
        assert_eq!(mask_key("short"), "****");
    }
}
