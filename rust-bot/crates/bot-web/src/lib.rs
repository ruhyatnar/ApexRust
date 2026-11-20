//! Axum HTTP + WebSocket telemetry bridge allowing any WebApp frontend to
//! inspect live indicators, positions, and control circuit breakers.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, Request, State,
    },
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER},
        HeaderName, HeaderValue, Method, StatusCode,
    },
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bot_core::{
    normalize_symbol_list, EngineSnapshot, ExchangeVenue, OrderExecutionMethod, PairSelectionMode,
    Side, TrendingCategory,
};
use bot_engine::{EngineCommand, TradingEngine};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
pub struct WebState {
    pub engine: Arc<TradingEngine>,
    pub cmd_tx: mpsc::Sender<EngineCommand>,
    pub auth_token: Option<Arc<str>>,
    pub dedupe_cache: Arc<Mutex<HashMap<String, Instant>>>,
    auth_failures: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
    /// Single-use WebSocket tickets (browsers cannot send an Authorization header on upgrade).
    ws_tickets: Arc<Mutex<HashMap<String, Instant>>>,
}

impl WebState {
    pub fn new(
        engine: Arc<TradingEngine>,
        cmd_tx: mpsc::Sender<EngineCommand>,
        auth_token: Option<String>,
    ) -> Self {
        let resolved = auth_token
            .or_else(|| engine.config().web.resolved_auth_token())
            .filter(|s| !s.trim().is_empty())
            .map(|s| Arc::<str>::from(s.trim()));
        Self {
            engine,
            cmd_tx,
            auth_token: resolved,
            dedupe_cache: Arc::new(Mutex::new(HashMap::new())),
            auth_failures: Arc::new(Mutex::new(HashMap::new())),
            ws_tickets: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

const WS_TICKET_TTL: Duration = Duration::from_secs(30);
const WS_TICKET_MAX: usize = 256;

/// 128 bits derived from OS-seeded SipHash keys; unguessable enough for a 30s,
/// single-use handshake ticket without adding a random-number dependency.
fn random_ws_ticket() -> String {
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut first = std::collections::hash_map::RandomState::new().build_hasher();
    first.write_u128(nanos);
    first.write_u32(std::process::id());
    let a = first.finish();
    let mut second = std::collections::hash_map::RandomState::new().build_hasher();
    second.write_u64(a);
    second.write_u128(nanos.rotate_left(29));
    let b = second.finish();
    format!("{a:016x}{b:016x}{:016x}", a.rotate_left(31) ^ b)
}

async fn ws_ticket_handler(State(state): State<WebState>) -> impl IntoResponse {
    let now = Instant::now();
    let ticket = random_ws_ticket();
    if let Ok(mut guard) = state.ws_tickets.lock() {
        guard.retain(|_, expires_at| *expires_at > now);
        if guard.len() >= WS_TICKET_MAX {
            if let Some(oldest) = guard.keys().next().cloned() {
                guard.remove(&oldest);
            }
        }
        guard.insert(ticket.clone(), now + WS_TICKET_TTL);
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "ticket": ticket,
            "expires_in_ms": WS_TICKET_TTL.as_millis() as u64
        })),
    )
}

/// Constant-time token comparison using a bitwise XOR accumulator (no extra dependency).
pub fn constant_time_token_eq(candidate: &str, expected: &str) -> bool {
    let a = candidate.as_bytes();
    let b = expected.as_bytes();
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse and normalize a forwarded client IP. Rejects arbitrary strings so a
/// spoofed header cannot create unbounded limiter keys or dodge a lockout.
fn normalize_forwarded_ip(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    let candidate = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.split(']').next())
        .unwrap_or(trimmed);
    let parsed: std::net::IpAddr = candidate.parse().ok()?;
    Some(match parsed {
        std::net::IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(|v4| v4.to_string())
            .unwrap_or_else(|| parsed.to_string()),
        std::net::IpAddr::V4(v4) => v4.to_string(),
    })
}

fn client_rate_key(req: &Request) -> String {
    let peer_ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    // Only trust proxy forwarding headers when the direct TCP peer is loopback (e.g., server.ts or cloudflared).
    let trust_forwarded = peer_ip.is_none_or(|ip| ip.is_loopback());
    if trust_forwarded {
        if let Some(cf) = req
            .headers()
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(ip) = normalize_forwarded_ip(cf) {
                return format!("cf:{ip}");
            }
        }
        if let Some(xff) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
        {
            if let Some(ip) = normalize_forwarded_ip(xff) {
                return format!("xff:{ip}");
            }
        }
    }
    if let Some(ip) = peer_ip {
        return format!("ip:{ip}");
    }
    "default-client".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ControlAction {
    Pause,
    Resume,
    TripCb,
    ResetCb,
    FlattenAll,
    ClosePosition,
    BackupNow,
    ManualOrder,
}

#[derive(Debug, Deserialize)]
struct ControlRequest {
    action: ControlAction,
    reason: Option<String>,
    symbol: Option<String>,
    side: Option<Side>,
    notional_usdt: Option<f64>,
    order_method: Option<OrderExecutionMethod>,
    limit_price: Option<f64>,
    take_profit_price: Option<f64>,
    stop_loss_price: Option<f64>,
    #[serde(default)]
    reduce_only: Option<bool>,
    #[serde(default)]
    request_id: Option<String>,
}

async fn pna_middleware(req: Request, next: Next) -> impl IntoResponse {
    let want_pna = req
        .headers()
        .get("access-control-request-private-network")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("true"));
    let mut resp = next.run(req).await;
    if want_pna {
        resp.headers_mut().insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }
    resp
}

async fn require_auth_middleware(
    State(state): State<WebState>,
    req: Request,
    next: Next,
) -> impl IntoResponse {
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    // WebSocket ticket path: consumed once, no failure counter (an expired ticket
    // during reconnect must not lock the client out of the whole API).
    if matches!(req.uri().path(), "/ws/telemetry" | "/ws/screener") {
        if let Some(ticket) = req.uri().query().and_then(|query| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("ticket="))
                .map(|value| percent_decode(value.trim()))
        }) {
            let valid = state
                .ws_tickets
                .lock()
                .ok()
                .and_then(|mut guard| guard.remove(&ticket))
                .is_some_and(|expires_at| expires_at > Instant::now());
            if valid {
                return next.run(req).await;
            }
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "Invalid or expired WebSocket ticket"
                })),
            )
                .into_response();
        }
    }

    if let Some(ref expected) = state.auth_token {
        // Validate credentials BEFORE consulting the failure limiter: a correct
        // token must never be locked out by earlier failures from the same IP.
        let mut authorized = false;

        if let Some(auth_val) = req
            .headers()
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
        {
            if let Some(bearer) = auth_val.strip_prefix("Bearer ") {
                if constant_time_token_eq(bearer.trim(), expected) {
                    authorized = true;
                }
            }
        }

        if !authorized {
            if let Some(hdr_tok) = req
                .headers()
                .get("x-apexrust-token")
                .and_then(|v| v.to_str().ok())
            {
                if constant_time_token_eq(hdr_tok.trim(), expected) {
                    authorized = true;
                }
            }
        }

        // Also allow ?token=<tok> (including percent-encoded values) for WebSocket upgrade handshakes
        if !authorized && matches!(req.uri().path(), "/ws/telemetry" | "/ws/screener") {
            if let Some(query) = req.uri().query() {
                for pair in query.split('&') {
                    if let Some(tok) = pair.strip_prefix("token=") {
                        let decoded = percent_decode(tok.trim());
                        if constant_time_token_eq(decoded.trim(), expected) {
                            authorized = true;
                            break;
                        }
                    }
                }
            }
        }

        if authorized {
            if let Ok(mut guard) = state.auth_failures.lock() {
                guard.remove(&client_rate_key(&req));
            }
            return next.run(req).await;
        }

        let rate_key = client_rate_key(&req);
        let now = Instant::now();
        let mut retry_after_ms: Option<u128> = None;
        if let Ok(mut guard) = state.auth_failures.lock() {
            if guard.len() > 256 {
                guard.retain(|_, (_, ts)| now.duration_since(*ts) < Duration::from_secs(300));
            }
            if let Some((count, first_ts)) = guard.get(&rate_key).copied() {
                let elapsed = now.duration_since(first_ts);
                if elapsed < Duration::from_secs(300) && count >= 10 {
                    retry_after_ms = Some((Duration::from_secs(300) - elapsed).as_millis());
                }
            }
            if retry_after_ms.is_none() {
                let entry = guard.entry(rate_key).or_insert((0, now));
                if now.duration_since(entry.1) >= Duration::from_secs(300) {
                    *entry = (1, now);
                } else {
                    entry.0 = entry.0.saturating_add(1);
                }
            }
        }

        if let Some(remaining_ms) = retry_after_ms {
            let retry_after_secs = remaining_ms.div_ceil(1000).max(1);
            let mut resp = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "Too many failed authentication attempts; try again later."
                })),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                resp.headers_mut().insert(RETRY_AFTER, value);
            }
            return resp;
        }

        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "ok": false,
                "error": "Unauthorized: missing or invalid bot-web auth token"
            })),
        )
            .into_response();
    }
    next.run(req).await
}

pub fn router(state: WebState) -> Router {
    let origin_raw = state.engine.config().web.allowed_origin.trim().to_string();
    let origins: Vec<HeaderValue> = origin_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "*")
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();
    let allowed_headers = [
        CONTENT_TYPE,
        AUTHORIZATION,
        HeaderName::from_static("x-apexrust-token"),
        HeaderName::from_static("x-apexrust-client-id"),
        HeaderName::from_static("access-control-request-private-network"),
    ];
    // Never combine a wildcard origin with an auth token: any website could
    // then drive the trading API with stolen credentials. Fall back to the
    // localhost defaults instead of silently exposing the engine.
    let wildcard_with_auth = origin_raw == "*" && state.auth_token.is_some();
    if wildcard_with_auth {
        tracing::warn!(
            "allowed_origin=\"*\" ignored because web.auth_token is set; falling back to localhost origins"
        );
    }
    let cors = if origin_raw == "*" && !wildcard_with_auth {
        CorsLayer::new()
            .allow_origin(AllowOrigin::any())
            .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
            .allow_headers(allowed_headers)
    } else if !origins.is_empty() && !wildcard_with_auth {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
            .allow_headers(allowed_headers)
    } else {
        let local_defaults = [
            HeaderValue::from_static("http://localhost:3000"),
            HeaderValue::from_static("http://127.0.0.1:3000"),
            HeaderValue::from_static("http://localhost:5173"),
            HeaderValue::from_static("http://127.0.0.1:5173"),
        ];
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(local_defaults))
            .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
            .allow_headers(allowed_headers)
    };

    let protected = Router::new()
        .route("/api/config", get(config_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/market/screener", get(screener_handler))
        .route("/api/watchlist", post(watchlist_handler))
        .route(
            "/api/orders/history",
            get(orders_history_handler).delete(delete_orders_history_handler),
        )
        .route("/api/orders/orphans", get(orders_orphans_handler))
        .route("/api/control", post(control_handler))
        .route("/api/ws-ticket", post(ws_ticket_handler))
        .route("/ws/telemetry", get(ws_handler))
        .route("/ws/screener", get(ws_screener_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_auth_middleware,
        ));

    Router::new()
        .route("/api/health", get(health_handler))
        .merge(protected)
        .layer(cors)
        .layer(middleware::from_fn(pna_middleware))
        .with_state(state)
}

#[derive(Debug, Default, Deserialize)]
struct OrdersHistoryQuery {
    limit: Option<usize>,
    #[serde(default, alias = "lookbackDays", alias = "lookback_days")]
    lookback_days: Option<u32>,
    #[serde(default, alias = "accountMode", alias = "account_mode")]
    account_mode: Option<String>,
    symbol: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteOrdersRequest {
    #[serde(default, alias = "account_mode")]
    account_mode: Option<String>,
    symbol: Option<String>,
    #[serde(default, alias = "older_than_days")]
    older_than_days: Option<u32>,
    #[serde(default, alias = "confirm_all")]
    confirm_all: Option<bool>,
}

async fn orders_history_handler(
    State(state): State<WebState>,
    Query(query): Query<OrdersHistoryQuery>,
) -> Json<serde_json::Value> {
    let limit = query.limit.unwrap_or(500).clamp(1, 5000);
    let lookback_days = query.lookback_days.filter(|&d| d > 0);
    let acct_filter = query
        .account_mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
        .map(ToOwned::to_owned);
    let sym_filter = query
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
        .map(|s| s.to_uppercase());
    let engine = Arc::clone(&state.engine);
    let (logs, summary) = tokio::task::spawn_blocking(move || {
        let fetch_limit = if lookback_days.is_some() || acct_filter.is_some() || sym_filter.is_some() {
            5000
        } else {
            limit
        };
        let mut rows = engine
            .order_store()
            .query_logs(fetch_limit)
            .unwrap_or_default();
        if let Some(days) = lookback_days {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            let cutoff_ms = now_ms - i64::from(days) * 86_400_000;
            rows.retain(|r| r.timestamp_ms >= cutoff_ms);
        }
        if let Some(ref acct) = acct_filter {
            rows.retain(|r| r.account_mode.eq_ignore_ascii_case(acct));
        }
        if let Some(ref sym) = sym_filter {
            rows.retain(|r| r.symbol.eq_ignore_ascii_case(sym));
        }
        rows.truncate(limit);
        let sum = engine.order_store().summary().ok();
        (rows, sum)
    })
    .await
    .unwrap_or_default();

    Json(serde_json::json!({
        "ok": true,
        "total": logs.len(),
        "logs": logs,
        "dbSummary": summary,
    }))
}

async fn delete_orders_history_handler(
    State(state): State<WebState>,
    Query(query): Query<DeleteOrdersRequest>,
    body: Option<Json<DeleteOrdersRequest>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let body_req = body.map(|b| b.0).unwrap_or_default();
    let account_mode = body_req
        .account_mode
        .or(query.account_mode)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let symbol = body_req
        .symbol
        .or(query.symbol)
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty());
    let older_than_days = body_req.older_than_days.or(query.older_than_days);
    let confirm_all = body_req.confirm_all.or(query.confirm_all).unwrap_or(false);

    let is_unfiltered_wipe = account_mode
        .as_deref()
        .is_none_or(|m| m.eq_ignore_ascii_case("ALL"))
        && symbol.is_none()
        && older_than_days.is_none();
    if is_unfiltered_wipe && !confirm_all {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": "Refusing unfiltered DELETE without accountMode (Paper|Live), symbol, olderThanDays, or confirmAll=true"
            })),
        );
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let engine = Arc::clone(&state.engine);
    let (deleted, summary) = tokio::task::spawn_blocking(move || {
        let del = engine
            .order_store()
            .delete_logs(
                account_mode.as_deref(),
                symbol.as_deref(),
                older_than_days,
                now_ms,
            )
            .unwrap_or(0);
        let sum = engine.order_store().summary().ok();
        (del, sum)
    })
    .await
    .unwrap_or((0, None));

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "deleted": deleted,
            "dbSummary": summary,
        })),
    )
}

async fn orders_orphans_handler(State(state): State<WebState>) -> Json<serde_json::Value> {
    let cfg = state.engine.config().clone();
    let env_str = match cfg.exchange.environment {
        bot_core::ExchangeEnvironment::Testnet => "Testnet",
        bot_core::ExchangeEnvironment::Production => "Production",
    };
    let snap = state.engine.latest_snapshot_handle().read().await.clone();
    let mut active_pairs = cfg.trading.pairs.clone();
    for p in &snap.pairs {
        if !active_pairs.iter().any(|s| s.eq_ignore_ascii_case(&p.symbol)) {
            active_pairs.push(p.symbol.clone());
        }
    }
    let engine = Arc::clone(&state.engine);
    let (orphans, summary) = tokio::task::spawn_blocking(move || {
        let orp = engine
            .order_store()
            .detect_local_orphans(&active_pairs, cfg.exchange.venue, env_str)
            .unwrap_or_default();
        let sum = engine.order_store().summary().ok();
        (orp, sum)
    })
    .await
    .unwrap_or_default();

    Json(serde_json::json!({
        "ok": true,
        "venue": state.engine.config().exchange.venue,
        "environment": env_str,
        "orphans": orphans,
        "dbSummary": summary,
    }))
}

async fn config_handler(State(state): State<WebState>) -> Json<bot_core::BotConfig> {
    let mut cfg = state.engine.config().clone();
    cfg.exchange.credentials = None;
    cfg.web.auth_token.clear();
    Json(cfg)
}

async fn health_handler(State(state): State<WebState>) -> Json<serde_json::Value> {
    let snap = state.engine.latest_snapshot_handle().read().await.clone();
    Json(serde_json::json!({
        "status": "ok",
        "running": snap.running,
        "transport_mode": snap.transport_mode,
        "failover_count": snap.failover_count,
    }))
}

async fn snapshot_handler(State(state): State<WebState>) -> Json<EngineSnapshot> {
    let snap = state.engine.latest_snapshot_handle().read().await.clone();
    Json(snap)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenerQueryParams {
    category: Option<String>,
    #[serde(default, alias = "quote_asset")]
    quote_asset: Option<String>,
    #[serde(default, alias = "min_quote_volume_usdt")]
    min_quote_volume_usdt: Option<f64>,
    #[serde(default, alias = "only_tradable")]
    only_tradable: Option<bool>,
    limit: Option<usize>,
    q: Option<String>,
}

fn parse_trending_category(raw: Option<&str>) -> TrendingCategory {
    match raw.unwrap_or("hot_volume").trim().to_lowercase().as_str() {
        "top_gainers" => TrendingCategory::TopGainers,
        "top_losers" => TrendingCategory::TopLosers,
        "volatility_leaders" => TrendingCategory::VolatilityLeaders,
        _ => TrendingCategory::HotVolume,
    }
}

async fn screener_handler(
    State(state): State<WebState>,
    Query(query): Query<ScreenerQueryParams>,
) -> Json<serde_json::Value> {
    let cfg_t = &state.engine.config().trading;
    let cat = if query.category.is_some() {
        parse_trending_category(query.category.as_deref())
    } else {
        cfg_t.trending_category
    };
    let quote = query
        .quote_asset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| cfg_t.quote_asset.clone());
    let min_vol = query
        .min_quote_volume_usdt
        .unwrap_or(cfg_t.trending_min_quote_volume_usdt)
        .max(0.0);
    let only_trad = query.only_tradable.unwrap_or(true);
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let snap = state
        .engine
        .query_screener(cat, &quote, min_vol, only_trad, limit, query.q.as_deref())
        .await;
    let mut val = serde_json::to_value(&snap).unwrap_or_default();
    if let Some(obj) = val.as_object_mut() {
        obj.insert("ok".into(), serde_json::json!(true));
    }
    Json(val)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchlistUpdateRequest {
    #[serde(default, alias = "pair_selection_mode")]
    pair_selection_mode: Option<PairSelectionMode>,
    #[serde(default, alias = "pinned_pairs", alias = "pairs")]
    pinned_pairs: Option<Vec<String>>,
    #[serde(default, alias = "trending_category")]
    trending_category: Option<TrendingCategory>,
    #[serde(default, alias = "quote_asset")]
    quote_asset: Option<String>,
    #[serde(default, alias = "max_watchlist_pairs")]
    max_watchlist_pairs: Option<usize>,
    #[serde(default, alias = "trending_top_n")]
    trending_top_n: Option<usize>,
}

async fn watchlist_handler(
    State(state): State<WebState>,
    Json(req): Json<WatchlistUpdateRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let (reply_tx, reply_rx) = oneshot::channel();
    let pinned = req
        .pinned_pairs
        .map(|list| normalize_symbol_list(&list, &[]));
    let cmd = EngineCommand::UpdateWatchlist {
        pair_selection_mode: req.pair_selection_mode,
        pinned_pairs: pinned,
        trending_category: req.trending_category,
        quote_asset: req.quote_asset,
        max_watchlist_pairs: req.max_watchlist_pairs,
        trending_top_n: req.trending_top_n,
        reply: Some(reply_tx),
    };
    if state.cmd_tx.send(cmd).await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ok": false, "error": "Engine command channel closed" })),
        );
    }
    match tokio::time::timeout(Duration::from_secs(15), reply_rx).await {
        Ok(Ok(Ok(val))) => (StatusCode::OK, Json(val)),
        Ok(Ok(Err(err))) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": err })),
        ),
        Ok(Err(_)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ok": false, "error": "Engine dropped reply" })),
        ),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "ok": false, "error": "Watchlist update timed out" })),
        ),
    }
}

async fn control_handler(
    State(state): State<WebState>,
    Json(req): Json<ControlRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    // 120s request_id idempotency check to prevent duplicate manual_order / flatten_all on retry
    let dedupe_key = req
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    if let Some(ref trimmed) = dedupe_key {
        let now = Instant::now();
        if let Ok(mut guard) = state.dedupe_cache.lock() {
            guard.retain(|_, ts| now.duration_since(*ts) < Duration::from_secs(120));
            if guard.contains_key(trimmed) {
                return (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "accepted": true,
                        "deduplicated": true,
                        "request_id": trimmed
                    })),
                );
            }
            guard.insert(trimmed.clone(), now);
        }
    }

    let rollback_dedupe = |key: &Option<String>| {
        if let Some(ref k) = key {
            if let Ok(mut guard) = state.dedupe_cache.lock() {
                guard.remove(k);
            }
        }
    };

    let cfg = state.engine.config();
    let features = &cfg.features;

    match req.action {
        ControlAction::TripCb | ControlAction::ResetCb if !features.circuit_breaker => {
            rollback_dedupe(&dedupe_key);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "accepted": false,
                    "error": "Circuit Breaker is disabled in FeatureToggles"
                })),
            );
        }
        ControlAction::ManualOrder => {
            if !features.manual_trading {
                rollback_dedupe(&dedupe_key);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "accepted": false,
                        "error": "Manual Trading is disabled in FeatureToggles"
                    })),
                );
            }
            let venue_enabled = match cfg.exchange.venue {
                ExchangeVenue::Spot => features.spot_market,
                ExchangeVenue::Futures => features.futures_market,
            };
            if !venue_enabled {
                rollback_dedupe(&dedupe_key);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "accepted": false,
                        "error": format!("{:?} market venue is disabled in FeatureToggles", cfg.exchange.venue)
                    })),
                );
            }
            let reduce_only = req.reduce_only.unwrap_or(false);
            if cfg.exchange.venue == ExchangeVenue::Spot && req.side == Some(Side::Short) && !reduce_only {
                rollback_dedupe(&dedupe_key);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "accepted": false,
                        "error": "Short entries are disabled on Binance Spot"
                    })),
                );
            }
            if let Some(n) = req.notional_usdt {
                if !n.is_finite() || n <= 0.0 {
                    rollback_dedupe(&dedupe_key);
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "accepted": false,
                            "error": "notional_usdt must be finite and > 0"
                        })),
                    );
                }
            }
            if let Some(lp) = req.limit_price {
                if !lp.is_finite() || lp <= 0.0 {
                    rollback_dedupe(&dedupe_key);
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "accepted": false,
                            "error": "limit_price must be finite and > 0"
                        })),
                    );
                }
            }
            if let Some(tp) = req.take_profit_price {
                if !tp.is_finite() || tp <= 0.0 {
                    rollback_dedupe(&dedupe_key);
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "accepted": false,
                            "error": "take_profit_price must be finite and > 0"
                        })),
                    );
                }
            }
            if let Some(sl) = req.stop_loss_price {
                if !sl.is_finite() || sl <= 0.0 {
                    rollback_dedupe(&dedupe_key);
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "accepted": false,
                            "error": "stop_loss_price must be finite and > 0"
                        })),
                    );
                }
            }
        }
        ControlAction::ClosePosition
            if req.symbol.as_deref().map(str::trim).unwrap_or("").is_empty() =>
        {
            rollback_dedupe(&dedupe_key);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "accepted": false,
                    "error": "ClosePosition requires a symbol"
                })),
            );
        }
        _ => {}
    }

    let default_notional = if cfg.automation.auto_order_notional_usdt > 0.0 {
        cfg.automation.auto_order_notional_usdt
    } else {
        150.0
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    let cmd = match req.action {
        ControlAction::Pause => EngineCommand::Pause { reply: Some(reply_tx) },
        ControlAction::Resume => EngineCommand::Resume { reply: Some(reply_tx) },
        ControlAction::TripCb => EngineCommand::TripCircuitBreaker {
            reason: req.reason.unwrap_or_else(|| "Manual WebApp panic".into()),
            reply: Some(reply_tx),
        },
        ControlAction::ResetCb => EngineCommand::ResetCircuitBreaker { reply: Some(reply_tx) },
        ControlAction::FlattenAll => EngineCommand::FlattenAll { reply: Some(reply_tx) },
        ControlAction::ClosePosition => EngineCommand::ClosePosition {
            symbol: req.symbol.unwrap_or_default().trim().to_uppercase(),
            reply: Some(reply_tx),
        },
        ControlAction::BackupNow => EngineCommand::BackupNow { reply: Some(reply_tx) },
        ControlAction::ManualOrder => EngineCommand::ManualOrder {
            symbol: req.symbol.unwrap_or_else(|| "BTCUSDT".into()).trim().to_uppercase(),
            side: req.side.unwrap_or(Side::Long),
            notional_usdt: req.notional_usdt.unwrap_or(default_notional),
            order_method: req.order_method.unwrap_or(OrderExecutionMethod::Market),
            limit_price: req.limit_price,
            take_profit_price: req.take_profit_price,
            stop_loss_price: req.stop_loss_price,
            reduce_only: req.reduce_only.unwrap_or(false),
            reply: Some(reply_tx),
        },
    };
    if state.cmd_tx.send(cmd).await.is_err() {
        rollback_dedupe(&dedupe_key);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "accepted": false, "error": "Engine command channel closed" })),
        );
    }
    match tokio::time::timeout(Duration::from_secs(15), reply_rx).await {
        Ok(Ok(Ok(val))) => (StatusCode::OK, Json(val)),
        Ok(Ok(Err(err))) => {
            rollback_dedupe(&dedupe_key);
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "accepted": false, "error": err })),
            )
        }
        Ok(Err(_)) => {
            rollback_dedupe(&dedupe_key);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "accepted": false, "error": "Engine dropped command reply" })),
            )
        }
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "accepted": false, "error": "Engine command timed out" })),
        ),
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<WebState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: WebState) {
    let mut rx = state.engine.subscribe();
    let initial = state.engine.latest_snapshot_handle().read().await.clone();
    if let Ok(json) = serde_json::to_string(&initial) {
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    loop {
        match rx.recv().await {
            Ok(snap) => {
                if let Ok(json) = serde_json::to_string(&snap) {
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                // Skip missed intermediate snapshots without disconnecting the WebSocket client
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn ws_screener_handler(
    ws: WebSocketUpgrade,
    State(state): State<WebState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws_screener(socket, state))
}

async fn handle_ws_screener(mut socket: WebSocket, state: WebState) {
    let mut rx = state.engine.subscribe_screener();
    let initial = state.engine.latest_screener_handle().read().await.clone();
    if let Ok(json) = serde_json::to_string(&serde_json::json!({
        "type": "screener_snapshot",
        "data": initial,
    })) {
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    loop {
        match rx.recv().await {
            Ok(snap) => {
                if let Ok(json) = serde_json::to_string(&serde_json::json!({
                    "type": "screener_snapshot",
                    "data": snap,
                })) {
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bot_core::BotConfig;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn make_req(action: ControlAction) -> ControlRequest {
        ControlRequest {
            action,
            reason: None,
            symbol: None,
            side: None,
            notional_usdt: None,
            order_method: None,
            limit_price: None,
            take_profit_price: None,
            stop_loss_price: None,
            reduce_only: None,
            request_id: None,
        }
    }

    #[tokio::test]
    async fn control_handler_rejects_actions_when_feature_toggles_are_off() {
        std::env::set_var(
            "APEXRUST_ORDER_DB_PATH",
            std::env::temp_dir().join("apexrust-web-unit-test.sqlite"),
        );
        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.features.manual_trading = false;
        cfg.features.circuit_breaker = false;
        let engine = Arc::new(TradingEngine::new(cfg).unwrap());
        let (tx, mut rx) = mpsc::channel(8);
        let seen = Arc::new(AtomicUsize::new(0));
        let seen_clone = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                seen_clone.fetch_add(1, Ordering::SeqCst);
                if let EngineCommand::Pause { reply: Some(rtx) } = cmd {
                    let _ = rtx.send(Ok(serde_json::json!({ "accepted": true })));
                }
            }
        });
        let state = WebState::new(engine, tx, None);

        let mut manual_req = make_req(ControlAction::ManualOrder);
        manual_req.symbol = Some("BTCUSDT".into());
        manual_req.side = Some(Side::Long);
        manual_req.notional_usdt = Some(100.0);
        manual_req.order_method = Some(OrderExecutionMethod::Market);
        let (m_status, manual_resp) = control_handler(State(state.clone()), Json(manual_req)).await;
        assert_eq!(m_status, StatusCode::BAD_REQUEST);
        assert_eq!(manual_resp.0["accepted"], serde_json::json!(false));

        let mut cb_req = make_req(ControlAction::TripCb);
        cb_req.reason = Some("test".into());
        let (cb_status, cb_resp) = control_handler(State(state.clone()), Json(cb_req)).await;
        assert_eq!(cb_status, StatusCode::BAD_REQUEST);
        assert_eq!(cb_resp.0["accepted"], serde_json::json!(false));

        // Verify request_id deduplication and constant_time_token_eq
        let mut pause_req = make_req(ControlAction::Pause);
        pause_req.request_id = Some("req-idempotent-1".into());
        let (p_status, pause_first) = control_handler(State(state.clone()), Json(pause_req)).await;
        assert_eq!(p_status, StatusCode::OK);
        assert_eq!(pause_first.0["accepted"], serde_json::json!(true));
        assert_eq!(seen.load(Ordering::SeqCst), 1);

        let mut pause_dup_req = make_req(ControlAction::Pause);
        pause_dup_req.request_id = Some("req-idempotent-1".into());
        let (_dup_status, pause_dup) = control_handler(State(state), Json(pause_dup_req)).await;
        assert_eq!(pause_dup.0["accepted"], serde_json::json!(true));
        assert_eq!(pause_dup.0["deduplicated"], serde_json::json!(true));
        assert_eq!(seen.load(Ordering::SeqCst), 1, "Deduplicated command must not re-send to engine");

        assert!(constant_time_token_eq("0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"));
        assert!(!constant_time_token_eq("0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdee"));
        assert!(!constant_time_token_eq("", ""));
    }

    #[tokio::test]
    async fn http_router_enforces_token_cors_delete_guard_and_rate_limit() {
        let tmp_db = std::env::temp_dir().join("apexrust-web-auth-http-test.sqlite");
        let mut cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        cfg.web.auth_token = "0123456789abcdef+secret=token/xyz".into();
        std::env::set_var("APEXRUST_ORDER_DB_PATH", &tmp_db);
        let engine = Arc::new(TradingEngine::new(cfg).unwrap());
        let (tx, _rx) = mpsc::channel(8);
        let tok = "0123456789abcdef+secret=token/xyz";
        let app = router(WebState::new(engine, tx, Some(tok.into())));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = reqwest::Client::new();
        let health_resp = client
            .get(format!("http://{addr}/api/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(health_resp.status(), reqwest::StatusCode::OK);

        let unauth_resp = client
            .get(format!("http://{addr}/api/snapshot"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth_resp.status(), reqwest::StatusCode::UNAUTHORIZED);

        // Verify WS /ws/telemetry accepts percent-encoded ?token= query param
        let (ws_stream, ws_resp) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/ws/telemetry?token=0123456789abcdef%2Bsecret%3Dtoken%2Fxyz"
        ))
        .await
        .unwrap();
        assert_eq!(ws_resp.status(), reqwest::StatusCode::SWITCHING_PROTOCOLS);
        drop(ws_stream);

        // Empty allowed_origin defaults to loopback list, blocking evil origins on preflight
        let evil_cors = client
            .request(reqwest::Method::OPTIONS, format!("http://{addr}/api/snapshot"))
            .header("Origin", "https://evil.example")
            .header("Access-Control-Request-Method", "GET")
            .send()
            .await
            .unwrap();
        assert!(evil_cors.headers().get("access-control-allow-origin").is_none());

        // Chromium PNA header preserved on allowed localhost preflight
        let pna_resp = client
            .request(reqwest::Method::OPTIONS, format!("http://{addr}/api/snapshot"))
            .header("Origin", "http://localhost:3000")
            .header("Access-Control-Request-Method", "GET")
            .header("Access-Control-Request-Private-Network", "true")
            .send()
            .await
            .unwrap();
        assert!(pna_resp.status().is_success());
        assert_eq!(
            pna_resp
                .headers()
                .get("access-control-allow-private-network")
                .and_then(|v| v.to_str().ok()),
            Some("true")
        );

        // Unfiltered DELETE requires explicit filter or confirmAll=true
        let wipe_blocked = client
            .delete(format!("http://{addr}/api/orders/history"))
            .bearer_auth(tok)
            .send()
            .await
            .unwrap();
        assert_eq!(wipe_blocked.status(), reqwest::StatusCode::BAD_REQUEST);

        let filtered_del = client
            .delete(format!("http://{addr}/api/orders/history?accountMode=Paper"))
            .bearer_auth(tok)
            .send()
            .await
            .unwrap();
        assert_eq!(filtered_del.status(), reqwest::StatusCode::OK);

        // 10 bad auth attempts -> 429 rate limit
        for _ in 0..10 {
            let r = client
                .get(format!("http://{addr}/api/snapshot"))
                .bearer_auth("wrong-token")
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), reqwest::StatusCode::UNAUTHORIZED);
        }
        let limited = client
            .get(format!("http://{addr}/api/snapshot"))
            .bearer_auth("wrong-token")
            .send()
            .await
            .unwrap();
        assert_eq!(limited.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
        assert!(
            limited.headers().get("retry-after").is_some(),
            "429 response must advertise Retry-After"
        );

        // A valid token still wins while the IP is locked out by bad attempts
        let valid_while_locked = client
            .get(format!("http://{addr}/api/snapshot"))
            .bearer_auth(tok)
            .send()
            .await
            .unwrap();
        assert_eq!(valid_while_locked.status(), reqwest::StatusCode::OK);

        server.abort();
        let _ = std::fs::remove_file(&tmp_db);
    }

    #[test]
    fn control_request_accepts_lowercase_side_and_rate_key_ignores_spoofed_non_loopback_headers() {
        let req_long: ControlRequest = serde_json::from_str(
            r#"{"action":"manual_order","symbol":"BTCUSDT","side":"long","notional_usdt":100}"#,
        )
        .unwrap();
        assert_eq!(req_long.side, Some(Side::Long));

        let req_short: ControlRequest = serde_json::from_str(
            r#"{"action":"manual_order","symbol":"ETHUSDT","side":"SHORT","notional_usdt":50}"#,
        )
        .unwrap();
        assert_eq!(req_short.side, Some(Side::Short));

        // Non-loopback peer cannot spoof cf-connecting-ip / x-forwarded-for
        let mut spoofed_req = axum::http::Request::builder()
            .uri("/api/snapshot")
            .header("cf-connecting-ip", "1.2.3.4")
            .header("x-forwarded-for", "5.6.7.8")
            .body(axum::body::Body::empty())
            .unwrap();
        spoofed_req
            .extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from(([203, 0, 113, 5], 5000))));
        assert_eq!(client_rate_key(&spoofed_req), "ip:203.0.113.5");

        // Loopback reverse proxy peer IS trusted to forward cf-connecting-ip
        let mut proxied_req = axum::http::Request::builder()
            .uri("/api/snapshot")
            .header("cf-connecting-ip", "198.51.100.9")
            .body(axum::body::Body::empty())
            .unwrap();
        proxied_req
            .extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 5000))));
        assert_eq!(client_rate_key(&proxied_req), "cf:198.51.100.9");

        // Malformed forwarded values are ignored instead of becoming limiter keys
        let mut junk_req = axum::http::Request::builder()
            .uri("/api/snapshot")
            .header("cf-connecting-ip", "not-an-ip")
            .header("x-forwarded-for", "also$bad")
            .body(axum::body::Body::empty())
            .unwrap();
        junk_req
            .extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 5000))));
        assert_eq!(client_rate_key(&junk_req), "ip:127.0.0.1");
        assert_eq!(normalize_forwarded_ip("::ffff:203.0.113.9"), Some("203.0.113.9".into()));
        assert_eq!(normalize_forwarded_ip("[2001:db8::1]"), Some("2001:db8::1".into()));
        assert_eq!(normalize_forwarded_ip(""), None);
    }

    #[tokio::test]
    async fn orders_orphans_includes_dynamic_watchlist_pairs() {
        let tmp_db = std::env::temp_dir().join("apexrust-web-orphans-dynamic-test.sqlite");
        let _ = std::fs::remove_file(&tmp_db);
        std::env::set_var("APEXRUST_ORDER_DB_PATH", &tmp_db);
        let cfg = BotConfig::from_toml_file("../../config/bot.example.toml").unwrap();
        let engine = Arc::new(TradingEngine::new(cfg).unwrap());
        let now_ms: i64 = 1_763_280_000_000;

        let make_log = |id: &str, oid: &str, sym: &str, price: f64, qty: f64| -> bot_core::OrderExecutionLog {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "orderId": oid,
                "clientOrderId": format!("c-{oid}"),
                "symbol": sym,
                "venue": "Spot",
                "environment": "Testnet",
                "accountMode": "Live",
                "source": "live_proxy",
                "lifecycle": "ENTRY",
                "side": "Long",
                "binanceSide": "BUY",
                "orderType": "MARKET",
                "timeInForce": "GTC",
                "status": "FILLED",
                "price": price,
                "executedQty": qty,
                "origQty": qty,
                "quoteQty": price * qty,
                "realizedPnlUsdt": null,
                "rMultiple": null,
                "exitReason": null,
                "latencyMs": 5,
                "endpoint": "paper",
                "rationale": "unit test entry",
                "timestampMs": now_ms,
            }))
            .unwrap()
        };

        // Insert a DB log for a dynamically added trending pair (PEPEUSDT) and a truly orphaned pair (GHOSTUSDT)
        engine
            .order_store()
            .upsert_logs(&[
                make_log("dyn-pepe-1", "101", "PEPEUSDT", 0.000012, 1_000_000.0),
                make_log("ghost-1", "102", "GHOSTUSDT", 1.0, 20.0),
            ])
            .unwrap();

        // Simulate PEPEUSDT currently active in the live dynamic watchlist snapshot
        {
            let snap_handle = engine.latest_snapshot_handle();
            let mut snap = snap_handle.write().await;
            snap.pairs.push(bot_core::PairSnapshot {
                symbol: "PEPEUSDT".into(),
                last_price: 0.000012,
                daily_pnl_usdt: 0.0,
                daily_pnl_pct: 0.0,
                indicators: bot_core::IndicatorSnapshot::default(),
                open_position: None,
                source_tag: Some(bot_core::PairSourceTag::Trending),
                tradable_on_active_venue: Some(true),
                quote_volume_24h_usdt: Some(100_000_000.0),
                best_bid: None,
                best_ask: None,
                spread_bps: None,
                bars_warmed_up: Some(220),
            });
        }

        let (tx, _rx) = mpsc::channel(8);
        let state = WebState::new(engine, tx, None);
        let Json(resp) = orders_orphans_handler(State(state)).await;
        let orphans = resp["orphans"].as_array().unwrap();
        assert!(
            !orphans.iter().any(|o| o["symbol"] == "PEPEUSDT"),
            "Active dynamic watchlist pair PEPEUSDT must not be flagged as orphan: {resp}"
        );
        assert!(
            orphans.iter().any(|o| o["symbol"] == "GHOSTUSDT"),
            "Truly inactive GHOSTUSDT must still be flagged as orphan: {resp}"
        );
        let _ = std::fs::remove_file(&tmp_db);
    }
}
