//! Axum HTTP + WebSocket telemetry bridge allowing any WebApp frontend to
//! inspect live indicators, positions, and control circuit breakers.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bot_core::EngineSnapshot;
use bot_engine::{EngineCommand, TradingEngine};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

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
}

#[derive(Debug, Deserialize)]
pub struct ControlRequest {
    pub action: ControlAction,
    pub reason: Option<String>,
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/snapshot", get(snapshot_handler))
        .route("/api/control", post(control_handler))
        .route("/ws/telemetry", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
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
    let cmd = match req.action {
        ControlAction::Pause => EngineCommand::Pause,
        ControlAction::Resume => EngineCommand::Resume,
        ControlAction::TripCb => {
            EngineCommand::TripCircuitBreaker(req.reason.unwrap_or_else(|| "Manual WebApp panic".into()))
        }
        ControlAction::ResetCb => EngineCommand::ResetCircuitBreaker,
        ControlAction::FlattenAll => EngineCommand::FlattenAll,
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
        let _ = socket.send(Message::Text(json.into())).await;
    }

    while let Ok(snap) = rx.recv().await {
        if let Ok(json) = serde_json::to_string(&snap) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    }
}
