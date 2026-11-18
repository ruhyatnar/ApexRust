//! Axum HTTP + WebSocket telemetry bridge allowing any WebApp frontend to
//! inspect live indicators, positions, and control circuit breakers.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header::CONTENT_TYPE, HeaderValue, Method},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bot_core::{EngineSnapshot, OrderExecutionMethod, Side};
use bot_engine::{EngineCommand, TradingEngine};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Clone)]
pub struct WebState {
    pub engine: Arc<TradingEngine>,
    pub cmd_tx: mpsc::Sender<EngineCommand>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Pause,
    Resume,
    TripCb,
    ResetCb,
    FlattenAll,
    BackupNow,
    ManualOrder,
}

#[derive(Debug, Deserialize)]
pub struct ControlRequest {
    pub action: ControlAction,
    pub reason: Option<String>,
    pub symbol: Option<String>,
    pub side: Option<Side>,
    pub notional_usdt: Option<f64>,
    pub order_method: Option<OrderExecutionMethod>,
    pub limit_price: Option<f64>,
}

pub fn router(state: WebState) -> Router {
    let origin_raw = state.engine.config().web.allowed_origin.trim().to_string();
    let origins: Vec<HeaderValue> = origin_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect();
    let cors = if origin_raw.is_empty() || origin_raw == "*" {
        CorsLayer::new()
            .allow_origin(AllowOrigin::any())
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([CONTENT_TYPE])
    } else if !origins.is_empty() {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([CONTENT_TYPE])
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::exact(HeaderValue::from_static("http://localhost:3000")))
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([CONTENT_TYPE])
    };

    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/config", get(config_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/control", post(control_handler))
        .route("/ws/telemetry", get(ws_handler))
        .layer(cors)
        .with_state(state)
}

async fn config_handler(State(state): State<WebState>) -> Json<bot_core::BotConfig> {
    let mut cfg = state.engine.config().clone();
    cfg.exchange.credentials = None;
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

async fn control_handler(
    State(state): State<WebState>,
    Json(req): Json<ControlRequest>,
) -> Json<serde_json::Value> {
    if matches!(req.action, ControlAction::ManualOrder) {
        if let Some(n) = req.notional_usdt {
            if !n.is_finite() || n <= 0.0 {
                return Json(serde_json::json!({
                    "accepted": false,
                    "error": "notional_usdt must be finite and > 0"
                }));
            }
        }
        if let Some(lp) = req.limit_price {
            if !lp.is_finite() || lp <= 0.0 {
                return Json(serde_json::json!({
                    "accepted": false,
                    "error": "limit_price must be finite and > 0"
                }));
            }
        }
    }
    let cmd = match req.action {
        ControlAction::Pause => EngineCommand::Pause,
        ControlAction::Resume => EngineCommand::Resume,
        ControlAction::TripCb => {
            EngineCommand::TripCircuitBreaker(req.reason.unwrap_or_else(|| "Manual WebApp panic".into()))
        }
        ControlAction::ResetCb => EngineCommand::ResetCircuitBreaker,
        ControlAction::FlattenAll => EngineCommand::FlattenAll,
        ControlAction::BackupNow => EngineCommand::BackupNow,
        ControlAction::ManualOrder => EngineCommand::ManualOrder {
            symbol: req.symbol.unwrap_or_else(|| "BTCUSDT".into()).to_uppercase(),
            side: req.side.unwrap_or(Side::Long),
            notional_usdt: req.notional_usdt.unwrap_or(150.0),
            order_method: req.order_method.unwrap_or(OrderExecutionMethod::Market),
            limit_price: req.limit_price,
        },
    };
    let ok = state.cmd_tx.send(cmd).await.is_ok();
    Json(serde_json::json!({ "accepted": ok }))
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
