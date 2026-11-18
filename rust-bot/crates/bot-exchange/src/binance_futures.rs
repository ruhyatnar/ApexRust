use crate::{
    build_sdk_rest_config, get_or_fetch_symbol_filters, to_binance_step_decimal,
    validate_live_safety, LiveOrderAck, LiveOrderRequest, SymbolFilters,
};
use binance_sdk::derivatives_trading_usds_futures::rest_api::{
    CancelAlgoOrderParams, CancelAllAlgoOpenOrdersParams, ChangeInitialLeverageParams,
    ChangeMarginTypeMarginTypeEnum, ChangeMarginTypeParams, NewAlgoOrderAlgoTypeEnum,
    NewAlgoOrderClosePositionEnum, NewAlgoOrderParams, NewAlgoOrderPriceProtectEnum,
    NewAlgoOrderSideEnum, NewAlgoOrderTypeEnum, NewAlgoOrderWorkingTypeEnum,
    NewOrderNewOrderRespTypeEnum, NewOrderParams, NewOrderReduceOnlyEnum, NewOrderSideEnum,
    NewOrderTimeInForceEnum, NewOrderTypeEnum, QueryOrderParams, TestOrderNewOrderRespTypeEnum,
    TestOrderParams, TestOrderReduceOnlyEnum, TestOrderSideEnum, TestOrderTimeInForceEnum,
    TestOrderTypeEnum,
};
use binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarginType, MarketEvent,
    OrderExecutionMethod, Result, Side, TransportMode,
};
use chrono::Utc;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, warn};

/// Official Binance USD-M Futures client built on top of
/// `binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi`
/// (https://developers.binance.com/en/docs/sdks-tools/connectors/rust).
///
/// Supports:
/// - USD-M Futures Testnet (`https://testnet.binancefuture.com`, `wss://stream.binancefuture.com/stream`)
/// - USD-M Futures Production (`https://fapi.binance.com`, `wss://fstream.binance.com/stream`)
/// - Two-sided Long & Short execution with Isolated/Crossed margin & configurable leverage
/// - Market, Limit (`GTC`/`IOC`/`FOK`), Post-Only (`GTX`), and `/fapi/v1/algoOrder` TP/SL brackets
pub struct BinanceFuturesClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<binance_sdk::derivatives_trading_usds_futures::rest_api::RestApi>,
    filter_cache: RwLock<HashMap<String, SymbolFilters>>,
}

impl BinanceFuturesClient {
    pub fn new(cfg: ExchangeConfig) -> Result<Self> {
        let sdk_client = if let Some(rest_cfg) = build_sdk_rest_config(&cfg)? {
            let client = match cfg.environment {
                ExchangeEnvironment::Production => {
                    DerivativesTradingUsdsFuturesRestApi::production(rest_cfg)
                }
                ExchangeEnvironment::Testnet => {
                    DerivativesTradingUsdsFuturesRestApi::testnet(rest_cfg)
                }
            };
            Some(client)
        } else {
            None
        };

        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| BotError::RestApi(format!("Failed to build Futures HTTP client: {e}")))?;

        Ok(Self {
            cfg,
            http,
            sdk_client,
            filter_cache: RwLock::new(HashMap::new()),
        })
    }

    pub fn rest_base_url(&self) -> &'static str {
        match self.cfg.environment {
            ExchangeEnvironment::Production => "https://fapi.binance.com",
            ExchangeEnvironment::Testnet => "https://testnet.binancefuture.com",
        }
    }

    /// Fetch USD-M Futures klines (`/fapi/v1/klines`) for warmup or REST fallback.
    pub async fn fetch_futures_klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
    ) -> Result<Vec<Candle>> {
        let url = format!(
            "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
            self.rest_base_url(),
            symbol.to_uppercase(),
            interval,
            limit
        );
        debug!(%url, "Fetching USD-M Futures klines");

        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures REST request failed: {e}")))?
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Futures REST HTTP status error: {e}")))?;

        let rows: Vec<Vec<serde_json::Value>> = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures JSON decode failed: {e}")))?;

        let now_ms = Utc::now().timestamp_millis();
        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 7 {
                continue;
            }
            let close_time_ms = row[6].as_i64().unwrap_or_default();
            let is_closed = close_time_ms <= 0 || close_time_ms <= now_ms;
            candles.push(Candle {
                open_time_ms: row[0].as_i64().unwrap_or_default(),
                open: row[1].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                high: row[2].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                low: row[3].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                close: row[4].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                volume: row[5].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
                is_closed,
            });
        }
        Ok(candles)
    }

    pub async fn poll_latest_futures_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_futures_klines(symbol, interval, 2).await?;
        let latest = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty Futures klines for {symbol}")))?;
        let candle = if !latest.is_closed && !bars.is_empty() {
            bars.pop().unwrap_or(latest)
        } else {
            latest
        };
        Ok(MarketEvent {
            symbol: symbol.to_uppercase(),
            price: candle.close,
            candle,
            source: TransportMode::RestFallback,
            received_at: Utc::now(),
        })
    }

    /// Execute a live USD-M Futures order (and optional `/fapi/v1/algoOrder` TP/SL brackets)
    /// via `binance-sdk`. Skips margin/leverage updates on `reduce_only` exits to prevent `-4048`.
    pub async fn execute_futures_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
        let ref_px = req
            .limit_price
            .filter(|&p| p > 0.0)
            .or_else(|| req.quote_order_qty.map(|q| q / req.quantity.max(1e-9)))
            .unwrap_or(100.0);
        validate_live_safety(&self.cfg, ExchangeVenue::Futures, req, ref_px)?;
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let recv_window = self
            .cfg
            .credentials
            .as_ref()
            .map(|c| c.recv_window_ms as i64)
            .unwrap_or(5000);
        let require_preflight = self
            .cfg
            .credentials
            .as_ref()
            .is_some_and(|c| c.require_preflight_test_order);

        let sym = req.symbol.to_uppercase();
        let filters = get_or_fetch_symbol_filters(
            &self.http,
            &self.filter_cache,
            self.rest_base_url(),
            ExchangeVenue::Futures,
            &sym,
            ref_px,
        )
        .await;
        let entry_buy = match req.side {
            Side::Long => !req.reduce_only,
            Side::Short => req.reduce_only,
        };
        let (step, dec) = if matches!(req.order_method, OrderExecutionMethod::Market | OrderExecutionMethod::Oco) {
            (filters.market_step_size, filters.market_step_decimals)
        } else {
            (filters.step_size, filters.step_decimals)
        };
        let qty_dec = to_binance_step_decimal(req.quantity, step, dec)?;

        if !req.reduce_only {
            let margin_enum = match self.cfg.margin_type {
                MarginType::Isolated => ChangeMarginTypeMarginTypeEnum::Isolated,
                MarginType::Crossed => ChangeMarginTypeMarginTypeEnum::Crossed,
            };
            let m_builder = ChangeMarginTypeParams::builder(sym.clone(), margin_enum)
                .recv_window(recv_window);
            if let Ok(m_params) = m_builder.build() {
                if let Err(err) = sdk.change_margin_type(m_params).await {
                    let msg = err.to_string();
                    if !msg.contains("-4046") && !msg.contains("-4048") {
                        return Err(BotError::RestApi(format!("Futures marginType error: {msg}")));
                    }
                }
            }

            let l_params = ChangeInitialLeverageParams::builder(
                sym.clone(),
                i64::from(self.cfg.leverage.clamp(1, 20)),
            )
            .recv_window(recv_window)
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures leverage params error: {e}")))?;
            sdk.change_initial_leverage(l_params)
                .await
                .map_err(|e| BotError::RestApi(format!("Futures leverage error: {e}")))?;
        }

        let is_limit = matches!(
            req.order_method,
            OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
        );

        if require_preflight {
            let mut tb = TestOrderParams::builder(
                sym.clone(),
                if entry_buy {
                    TestOrderSideEnum::Buy
                } else {
                    TestOrderSideEnum::Sell
                },
                if is_limit {
                    TestOrderTypeEnum::Limit
                } else {
                    TestOrderTypeEnum::Market
                },
            )
            .quantity(qty_dec)
            .new_order_resp_type(TestOrderNewOrderRespTypeEnum::Result)
            .recv_window(recv_window);
            if req.reduce_only {
                tb = tb.reduce_only(TestOrderReduceOnlyEnum::True);
            }
            if is_limit {
                let px = req
                    .limit_price
                    .ok_or_else(|| BotError::RestApi("Futures LIMIT order missing price".into()))?;
                tb = tb
                    .price(to_binance_step_decimal(
                        px,
                        filters.tick_size,
                        filters.tick_decimals,
                    )?)
                    .time_in_force(if req.order_method == OrderExecutionMethod::LimitMaker {
                        TestOrderTimeInForceEnum::Gtx
                    } else {
                        match req.time_in_force.as_str() {
                            "IOC" => TestOrderTimeInForceEnum::Ioc,
                            "FOK" => TestOrderTimeInForceEnum::Fok,
                            _ => TestOrderTimeInForceEnum::Gtc,
                        }
                    });
            }
            let t_params = tb
                .build()
                .map_err(|e| BotError::RestApi(format!("Futures test_order params error: {e}")))?;
            sdk.test_order(t_params)
                .await
                .map_err(|e| BotError::RestApi(format!("Futures /fapi/v1/order/test failed: {e}")))?;
        }

        let mut ob = NewOrderParams::builder(
            sym.clone(),
            if entry_buy {
                NewOrderSideEnum::Buy
            } else {
                NewOrderSideEnum::Sell
            },
            if is_limit {
                NewOrderTypeEnum::Limit
            } else {
                NewOrderTypeEnum::Market
            },
        )
        .quantity(qty_dec)
        .new_order_resp_type(NewOrderNewOrderRespTypeEnum::Result)
        .recv_window(recv_window);
        if req.reduce_only {
            ob = ob.reduce_only(NewOrderReduceOnlyEnum::True);
        }
        if is_limit {
            let px = req
                .limit_price
                .ok_or_else(|| BotError::RestApi("Futures LIMIT order missing price".into()))?;
            ob = ob
                .price(to_binance_step_decimal(
                    px,
                    filters.tick_size,
                    filters.tick_decimals,
                )?)
                .time_in_force(if req.order_method == OrderExecutionMethod::LimitMaker {
                    NewOrderTimeInForceEnum::Gtx
                } else {
                    match req.time_in_force.as_str() {
                        "IOC" => NewOrderTimeInForceEnum::Ioc,
                        "FOK" => NewOrderTimeInForceEnum::Fok,
                        _ => NewOrderTimeInForceEnum::Gtc,
                    }
                });
        }

        let params = ob
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures new_order params error: {e}")))?;
        let resp = sdk
            .new_order(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures new_order failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures new_order decode failed: {e}")))?;

        let exec_qty: f64 = resp
            .executed_qty
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(req.quantity);
        let mut avg_price: f64 = resp
            .price
            .as_deref()
            .and_then(|s| s.parse().ok())
            .filter(|&p| p > 0.0)
            .unwrap_or(0.0);

        if avg_price <= 0.0 && exec_qty > 0.0 {
            if let Some(oid) = resp.order_id {
                if let Ok(q_params) = QueryOrderParams::builder(sym.clone())
                    .order_id(oid)
                    .recv_window(recv_window)
                    .build()
                {
                    if let Ok(q_resp) = sdk.query_order(q_params).await {
                        if let Ok(q_data) = q_resp.data().await {
                            let queried_avg = q_data
                                .avg_price
                                .as_deref()
                                .and_then(|s| s.parse::<f64>().ok())
                                .filter(|&p| p > 0.0);
                            let cum_avg = q_data
                                .cum_quote
                                .as_deref()
                                .and_then(|s| s.parse::<f64>().ok())
                                .filter(|&c| c > 0.0)
                                .map(|c| c / exec_qty);
                            if let Some(p) = queried_avg.or(cum_avg) {
                                avg_price = p;
                            }
                        }
                    }
                }
            }
        }
        if avg_price <= 0.0 {
            avg_price = req.limit_price.unwrap_or(0.0);
        }

        let mut algo_order_ids = Vec::new();
        let mut bracket_warning = None;
        if req.order_method == OrderExecutionMethod::Oco && exec_qty > 0.0 {
            let exit_side = if entry_buy {
                NewAlgoOrderSideEnum::Sell
            } else {
                NewAlgoOrderSideEnum::Buy
            };
            if let Some(tp) = req.take_profit_price {
                match to_binance_step_decimal(tp, filters.tick_size, filters.tick_decimals)
                    .and_then(|tp_dec| {
                        NewAlgoOrderParams::builder(
                            NewAlgoOrderAlgoTypeEnum::Conditional,
                            sym.clone(),
                            exit_side.clone(),
                            NewAlgoOrderTypeEnum::TakeProfitMarket,
                        )
                        .trigger_price(tp_dec)
                        .close_position(NewAlgoOrderClosePositionEnum::True)
                        .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                        .price_protect(NewAlgoOrderPriceProtectEnum::True)
                        .recv_window(recv_window)
                        .build()
                        .map_err(|e| BotError::RestApi(format!("Futures TP algoOrder params error: {e}")))
                    }) {
                    Ok(tp_params) => match sdk.new_algo_order(tp_params).await {
                        Ok(r) => match r.data().await {
                            Ok(tp_data) => {
                                if let Some(id) = tp_data.algo_id {
                                    algo_order_ids.push(id);
                                }
                            }
                            Err(e) => bracket_warning = Some(format!("Futures TP algoOrder decode failed: {e}")),
                        },
                        Err(e) => bracket_warning = Some(format!("Futures TP algoOrder failed: {e}")),
                    },
                    Err(e) => bracket_warning = Some(e.to_string()),
                }
            }
            if let Some(sl) = req.stop_loss_price {
                match to_binance_step_decimal(sl, filters.tick_size, filters.tick_decimals)
                    .and_then(|sl_dec| {
                        NewAlgoOrderParams::builder(
                            NewAlgoOrderAlgoTypeEnum::Conditional,
                            sym.clone(),
                            exit_side,
                            NewAlgoOrderTypeEnum::StopMarket,
                        )
                        .trigger_price(sl_dec)
                        .close_position(NewAlgoOrderClosePositionEnum::True)
                        .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                        .price_protect(NewAlgoOrderPriceProtectEnum::True)
                        .recv_window(recv_window)
                        .build()
                        .map_err(|e| BotError::RestApi(format!("Futures SL algoOrder params error: {e}")))
                    }) {
                    Ok(sl_params) => match sdk.new_algo_order(sl_params).await {
                        Ok(r) => match r.data().await {
                            Ok(sl_data) => {
                                if let Some(id) = sl_data.algo_id {
                                    algo_order_ids.push(id);
                                }
                            }
                            Err(e) => {
                                bracket_warning = Some(format!("Futures SL algoOrder decode failed: {e}"));
                            }
                        },
                        Err(e) => {
                            bracket_warning = Some(format!("Futures SL algoOrder failed: {e}"));
                        }
                    },
                    Err(e) => {
                        bracket_warning = Some(e.to_string());
                    }
                }
                if bracket_warning.is_some() && !algo_order_ids.is_empty() {
                    // Roll back the TP algo order so no unpaired closePosition trigger lingers
                    for id in algo_order_ids.drain(..) {
                        if let Ok(c_params) = CancelAlgoOrderParams::builder()
                            .algo_id(id)
                            .recv_window(recv_window)
                            .build()
                        {
                            if let Err(cancel_err) = sdk.cancel_algo_order(c_params).await {
                                warn!(algo_id = id, %cancel_err, "Failed to roll back TP algoOrder after SL error");
                            }
                        }
                    }
                }
            }
        }
        if let Some(ref w) = bracket_warning {
            warn!(%w, "Futures entry filled; local exit engine still manages stops/targets");
        }

        Ok(LiveOrderAck {
            order_id: resp.order_id.map(|id| id.to_string()),
            order_list_id: None,
            algo_order_ids,
            bracket_warning,
            executed_qty: exec_qty,
            avg_price,
        })
    }

    pub async fn cancel_futures_algo_orders(&self, symbol: &str) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let recv_window = self
            .cfg
            .credentials
            .as_ref()
            .map(|c| c.recv_window_ms as i64)
            .unwrap_or(5000);
        let params = CancelAllAlgoOpenOrdersParams::builder(symbol.to_uppercase())
            .recv_window(recv_window)
            .build()
            .map_err(|e| BotError::RestApi(format!("Cancel algo params error: {e}")))?;
        sdk.cancel_all_algo_open_orders(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures cancel_all_algo_open_orders failed: {e}")))?;
        Ok(())
    }
}
