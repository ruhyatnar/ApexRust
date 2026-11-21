//! Operational commands that talk to the running daemon via the `bot-web` bridge.

use crate::client::DaemonClient;
use crate::cmd_key::require_confirmation;
use crate::ui::{duration_ms, is_interactive, num, pct, Ui};
use anyhow::anyhow;
use bot_core::OrderExecutionMethod;
use serde_json::{json, Value};
use std::time::Duration;

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("-")
}

fn f64_at(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn opt_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

async fn fetch_health(client: &DaemonClient) -> anyhow::Result<Value> {
    client.get("/api/health").await
}

async fn fetch_snapshot(client: &DaemonClient) -> anyhow::Result<Value> {
    client.get("/api/snapshot").await
}

fn print_status(ui: Ui, health: &Value, snapshot: &Value, base: &str) {
    let risk = snapshot.get("risk").cloned().unwrap_or(Value::Null);
    ui.kv("Daemon", base);
    ui.kv(
        "Running",
        if health
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "yes"
        } else {
            "no"
        },
    );
    ui.kv(
        "Transport",
        &format!(
            "{} ({} failovers)",
            str_at(health, "transport_mode"),
            health
                .get("failover_count")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ),
    );
    ui.kv(
        "Last WS tick",
        &duration_ms(
            snapshot
                .get("last_ws_age_ms")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        ),
    );
    ui.kv(
        "Risk state",
        &format!(
            "{}{}",
            str_at(&risk, "state"),
            risk.get("halt_reason")
                .and_then(Value::as_str)
                .map(|r| format!(" — {r}"))
                .unwrap_or_default()
        ),
    );
    ui.kv(
        "Equity / PnL",
        &format!(
            "{} USDT / {} ({}%)",
            num(f64_at(&risk, "current_equity"), 2),
            num(f64_at(&risk, "cumulative_daily_pnl_usdt"), 2),
            num(f64_at(&risk, "cumulative_daily_pnl_pct"), 2)
        ),
    );
    let btc_guard = format!(
        "{} ({}m window, blocking={})",
        pct(f64_at(&risk, "btc_change_pct_window"), 2),
        risk.get("btc_window_minutes")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        risk.get("btc_guard_blocking")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    );
    ui.kv("BTC guard", &btc_guard);
    let pending = snapshot
        .get("pending_orders")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    ui.kv(
        "Pairs / pending",
        &format!(
            "{} / {}",
            snapshot
                .get("pairs")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0),
            pending
        ),
    );
}

fn pair_rows(snapshot: &Value) -> Vec<Vec<String>> {
    snapshot
        .get("pairs")
        .and_then(Value::as_array)
        .map(|pairs| {
            pairs
                .iter()
                .map(|pair| {
                    let ind = pair.get("indicators").cloned().unwrap_or(Value::Null);
                    let source = pair
                        .get("source_tag")
                        .and_then(Value::as_str)
                        .unwrap_or("-");
                    vec![
                        str_at(pair, "symbol").to_string(),
                        num(f64_at(pair, "last_price"), 4),
                        opt_f64(&ind, "rsi")
                            .map(|v| num(v, 1))
                            .unwrap_or_else(|| "-".into()),
                        opt_f64(&ind, "adx")
                            .map(|v| num(v, 1))
                            .unwrap_or_else(|| "-".into()),
                        opt_f64(&ind, "atr")
                            .map(|v| num(v, 2))
                            .unwrap_or_else(|| "-".into()),
                        pct(f64_at(pair, "daily_pnl_pct"), 2),
                        source.to_string(),
                    ]
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn status(ui: Ui, client: &DaemonClient, json_out: bool) -> anyhow::Result<()> {
    let health = fetch_health(client).await?;
    let snapshot = fetch_snapshot(client).await?;
    if json_out {
        println!(
            "{}",
            json!({ "ok": true, "health": health, "snapshot": snapshot })
        );
        return Ok(());
    }
    ui.title("ApexRust daemon status");
    print_status(ui, &health, &snapshot, client.base());
    Ok(())
}

pub async fn snapshot(ui: Ui, client: &DaemonClient, json_out: bool) -> anyhow::Result<()> {
    let snapshot = fetch_snapshot(client).await?;
    if json_out {
        println!("{snapshot}");
        return Ok(());
    }
    ui.title("Engine snapshot");
    let rows = pair_rows(&snapshot);
    ui.table(
        &["Symbol", "Price", "RSI", "ADX", "ATR", "Day PnL", "Source"],
        &rows,
    );
    let risk = snapshot.get("risk").cloned().unwrap_or(Value::Null);
    ui.section("Risk");
    ui.kv("State", str_at(&risk, "state"));
    ui.kv(
        "Quarantined",
        &risk
            .get("quarantined_pairs")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|v| v.as_str().unwrap_or("?").to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "none".to_string()),
    );
    ui.kv(
        "BTC window change",
        &pct(f64_at(&risk, "btc_change_pct_window"), 3),
    );

    if let Some(alerts) = snapshot
        .get("recent_volatility_alerts")
        .and_then(Value::as_array)
    {
        if !alerts.is_empty() {
            ui.section("Recent volatility alerts");
            for alert in alerts.iter().rev().take(5) {
                ui.kv(
                    &format!("{} {}", str_at(alert, "symbol"), str_at(alert, "kind")),
                    &format!(
                        "{} — {}",
                        pct(f64_at(alert, "atr_pct_of_price"), 2),
                        str_at(alert, "detected_at")
                    ),
                );
            }
        }
    }
    Ok(())
}

pub async fn watch(
    ui: Ui,
    client: &DaemonClient,
    interval_secs: u64,
    json_out: bool,
) -> anyhow::Result<()> {
    if json_out {
        let snapshot = fetch_snapshot(client).await?;
        println!("{snapshot}");
        return Ok(());
    }
    let interval = interval_secs.max(1);
    loop {
        let health = fetch_health(client).await?;
        let snapshot = fetch_snapshot(client).await?;
        if is_interactive() {
            print!("\x1b[2J\x1b[H");
        }
        ui.title(&format!(
            "ApexRust live — {} (Ctrl+C untuk keluar)",
            chrono::Local::now().format("%H:%M:%S")
        ));
        print_status(ui, &health, &snapshot, client.base());
        ui.section("Pairs");
        ui.table(
            &["Symbol", "Price", "RSI", "ADX", "ATR", "Day PnL", "Source"],
            &pair_rows(&snapshot),
        );
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

#[derive(Debug, Clone)]
pub struct ManualOrder {
    pub symbol: String,
    pub side: String,
    pub notional: f64,
    pub method: OrderExecutionMethod,
    pub limit_price: Option<f64>,
    pub take_profit_price: Option<f64>,
    pub stop_loss_price: Option<f64>,
}

pub fn manual_order_payload(order: &ManualOrder) -> anyhow::Result<Value> {
    if order.symbol.trim().is_empty() {
        return Err(anyhow!("--symbol wajib diisi (contoh: BTCUSDT)"));
    }
    if !order.notional.is_finite() || order.notional <= 0.0 {
        return Err(anyhow!("--notional harus > 0"));
    }
    let side = match order.side.trim().to_ascii_lowercase().as_str() {
        "long" | "buy" => "long",
        "short" | "sell" => "short",
        other => {
            return Err(anyhow!(
                "--side harus `long` atau `short` (diberikan: {other})"
            ))
        }
    };
    if matches!(
        order.method,
        OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
    ) && order.limit_price.is_none()
    {
        return Err(anyhow!(
            "--limit-price wajib untuk method LIMIT / LIMIT_MAKER"
        ));
    }
    if order.method == OrderExecutionMethod::Oco
        && (order.take_profit_price.is_none() || order.stop_loss_price.is_none())
    {
        return Err(anyhow!(
            "--take-profit-price dan --stop-loss-price wajib untuk method OCO"
        ));
    }

    let mut payload = json!({
        "action": "manual_order",
        "symbol": order.symbol.trim().to_ascii_uppercase(),
        "side": side,
        "notional_usdt": order.notional,
        "order_method": order.method,
        "request_id": format!("apexrust-{}", chrono::Utc::now().timestamp_millis()),
    });
    if let Some(price) = order.limit_price {
        payload["limit_price"] = json!(price);
    }
    if let Some(price) = order.take_profit_price {
        payload["take_profit_price"] = json!(price);
    }
    if let Some(price) = order.stop_loss_price {
        payload["stop_loss_price"] = json!(price);
    }
    Ok(payload)
}

pub async fn submit_manual_order(
    ui: Ui,
    client: &DaemonClient,
    order: ManualOrder,
    yes: bool,
    json_out: bool,
) -> anyhow::Result<()> {
    let payload = manual_order_payload(&order)?;
    if !json_out {
        ui.section("Manual order");
        ui.kv("Symbol", &order.symbol.to_uppercase());
        ui.kv("Side", &order.side.to_lowercase());
        ui.kv("Notional", &format!("{} USDT", num(order.notional, 2)));
        ui.kv("Method", &format!("{:?}", order.method).to_uppercase());
        if let Some(price) = order.limit_price {
            ui.kv("Limit price", &num(price, 4));
        }
    }
    if !require_confirmation(ui, "Kirim order ini?", yes)? {
        return Ok(());
    }
    let response = client.post("/api/control", &payload).await?;
    print_control_response(ui, &response, json_out);
    Ok(())
}

pub async fn flatten(
    ui: Ui,
    client: &DaemonClient,
    yes: bool,
    json_out: bool,
) -> anyhow::Result<()> {
    if !require_confirmation(
        ui,
        "Flatten SEMUA posisi terbuka? Tindakan ini tidak bisa dibatalkan.",
        yes,
    )? {
        return Ok(());
    }
    let payload = json!({ "action": "flatten_all" });
    let response = client.post("/api/control", &payload).await?;
    if !json_out {
        ui.ok("Permintaan flatten semua posisi dikirim.");
    }
    print_control_response(ui, &response, json_out);
    Ok(())
}

pub async fn risk_action(
    ui: Ui,
    client: &DaemonClient,
    action: &str,
    reason: Option<&str>,
    yes: bool,
    json_out: bool,
) -> anyhow::Result<()> {
    let normalized = action.trim().to_ascii_lowercase();
    let (wire, label, destructive) = match normalized.as_str() {
        "pause" => ("pause", "Pause automated entries", false),
        "resume" => ("resume", "Resume automated entries", false),
        "trip" | "trip-cb" | "trip_cb" => ("trip_cb", "Trip circuit breaker", true),
        "reset" | "reset-cb" | "reset_cb" => ("reset_cb", "Reset circuit breaker", false),
        other => {
            return Err(anyhow!(
                "Aksi risiko tidak dikenal: {other} (pilih pause|resume|trip|reset)"
            ))
        }
    };
    if destructive && !require_confirmation(ui, "Trip circuit breaker sekarang?", yes)? {
        return Ok(());
    }
    let mut payload = json!({ "action": wire });
    if let Some(reason) = reason {
        payload["reason"] = json!(reason);
    }
    let response = client.post("/api/control", &payload).await?;
    if json_out {
        println!("{response}");
    } else {
        ui.ok(label);
        print_control_response(ui, &response, false);
    }
    Ok(())
}

pub async fn backup(ui: Ui, client: &DaemonClient, json_out: bool) -> anyhow::Result<()> {
    let payload = json!({ "action": "backup_now" });
    let response = client.post("/api/control", &payload).await?;
    if json_out {
        println!("{response}");
    } else {
        ui.ok("Git backup dipicu.");
        print_control_response(ui, &response, false);
    }
    Ok(())
}

fn print_control_response(ui: Ui, response: &Value, json_out: bool) {
    if json_out {
        println!("{response}");
        return;
    }
    if let Some(accepted) = response.get("accepted").and_then(Value::as_bool) {
        ui.kv("Accepted", if accepted { "yes" } else { "no" });
    }
    for key in ["order_id", "status", "symbol", "side", "message", "error"] {
        if let Some(value) = response.get(key) {
            if !value.is_null() {
                let rendered = value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string());
                ui.kv(key, &rendered);
            }
        }
    }
    if response.get("accepted").and_then(Value::as_bool) == Some(false) {
        ui.hint("Lihat log daemon (`apexrust logs bot`) untuk alasan lengkap.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_order() -> ManualOrder {
        ManualOrder {
            symbol: "btcusdt".into(),
            side: "long".into(),
            notional: 15.0,
            method: OrderExecutionMethod::Market,
            limit_price: None,
            take_profit_price: None,
            stop_loss_price: None,
        }
    }

    #[test]
    fn manual_order_payload_normalizes_symbol_and_side() {
        let payload = manual_order_payload(&base_order()).unwrap();
        assert_eq!(payload["symbol"], "BTCUSDT");
        assert_eq!(payload["side"], "long");
        assert_eq!(payload["action"], "manual_order");
        assert_eq!(payload["order_method"], "MARKET");
        assert!(payload["request_id"]
            .as_str()
            .unwrap()
            .starts_with("apexrust-"));
    }

    #[test]
    fn manual_order_validation_is_friendly() {
        let mut order = base_order();
        order.notional = 0.0;
        assert!(manual_order_payload(&order)
            .unwrap_err()
            .to_string()
            .contains("--notional"));

        let mut order = base_order();
        order.side = "sideways".into();
        assert!(manual_order_payload(&order)
            .unwrap_err()
            .to_string()
            .contains("--side"));

        let mut order = base_order();
        order.method = OrderExecutionMethod::Limit;
        assert!(manual_order_payload(&order)
            .unwrap_err()
            .to_string()
            .contains("--limit-price"));

        let mut order = base_order();
        order.method = OrderExecutionMethod::Oco;
        order.limit_price = Some(1.0);
        assert!(manual_order_payload(&order)
            .unwrap_err()
            .to_string()
            .contains("OCO"));
    }

    #[test]
    fn pair_rows_handle_missing_indicators() {
        let snapshot = json!({
            "pairs": [
                {"symbol": "BTCUSDT", "last_price": 58000.5, "daily_pnl_pct": 1.25, "indicators": {}},
                {"symbol": "ETHUSDT", "last_price": 3000.0, "indicators": {"rsi": 55.5, "adx": 20.1, "atr": 12.5}}
            ]
        });
        let rows = pair_rows(&snapshot);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0], "BTCUSDT");
        assert_eq!(rows[0][2], "-");
        assert_eq!(rows[1][2], "55.5");
        assert_eq!(rows[1][3], "20.1");
    }
}
