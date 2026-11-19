use crate::{
    build_sdk_rest_config, get_or_fetch_symbol_filters, parse_ticker_24h_array,
    parse_tradable_symbols_from_exchange_info, to_binance_step_decimal, validate_exchange_filters,
    validate_live_safety, CancelOrderOutcome, ExchangeOpenPosition, ExchangeOrderStatus,
    LiveOrderAck, LiveOrderRequest, RestRateBudget, SymbolFilters,
};
use binance_sdk::derivatives_trading_usds_futures::rest_api::{
    CancelAlgoOrderParams, CancelAllAlgoOpenOrdersParams, CancelAllOpenOrdersParams,
    CancelOrderParams, ChangeInitialLeverageParams, ChangeMarginTypeMarginTypeEnum,
    ChangeMarginTypeParams, CurrentAllAlgoOpenOrdersParams, GetCurrentPositionModeParams,
    NewAlgoOrderAlgoTypeEnum, NewAlgoOrderClosePositionEnum, NewAlgoOrderParams,
    NewAlgoOrderPriceProtectEnum, NewAlgoOrderSideEnum, NewAlgoOrderTypeEnum,
    NewAlgoOrderWorkingTypeEnum, NewOrderNewOrderRespTypeEnum, NewOrderParams,
    NewOrderReduceOnlyEnum, NewOrderSideEnum, NewOrderTimeInForceEnum, NewOrderTypeEnum,
    PositionInformationV2Params, PositionInformationV3Params, QueryAlgoOrderParams,
    QueryOrderParams,
    TestOrderNewOrderRespTypeEnum, TestOrderParams, TestOrderPositionSideEnum,
    TestOrderReduceOnlyEnum, TestOrderSideEnum, TestOrderTimeInForceEnum, TestOrderTypeEnum,
};
use binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarginType, MarketEvent,
    MarketTicker24h, OrderExecutionMethod, Result, Side, TransportMode,
};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
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
/// - Two-sided Long & Short execution (One-Way & Hedge Mode) with Isolated/Crossed margin & configurable leverage
/// - Market, Limit (`GTC`/`IOC`/`FOK`), Post-Only (`GTX`), and `/fapi/v1/algoOrder` TP/SL brackets
pub struct BinanceFuturesClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<binance_sdk::derivatives_trading_usds_futures::rest_api::RestApi>,
    filter_cache: RwLock<HashMap<String, SymbolFilters>>,
    dual_side_mode: RwLock<Option<bool>>,
    rate_budget: Arc<RestRateBudget>,
}

impl BinanceFuturesClient {
    fn resolve_rest_base_url(cfg: &ExchangeConfig) -> &str {
        let trimmed = cfg.rest_base_url.trim();
        match cfg.environment {
            ExchangeEnvironment::Production => {
                if trimmed.is_empty()
                    || trimmed.contains("testnet")
                    || trimmed.contains("demo")
                    || trimmed.contains("binancefuture")
                    || trimmed.contains("binance.vision")
                    || trimmed.contains("api.binance.com")
                {
                    "https://fapi.binance.com"
                } else {
                    trimmed
                }
            }
            ExchangeEnvironment::Testnet => {
                if trimmed.is_empty()
                    || trimmed.contains("fapi.binance.com")
                    || trimmed.contains("api.binance.com")
                    || trimmed.contains("binance.vision")
                {
                    "https://testnet.binancefuture.com"
                } else {
                    trimmed
                }
            }
        }
    }

    pub fn new_with_budget(
        cfg: ExchangeConfig,
        rate_budget: Arc<RestRateBudget>,
    ) -> Result<Self> {
        let sdk_client = if let Some(mut rest_cfg) = build_sdk_rest_config(&cfg)? {
            rest_cfg.base_path = Some(Self::resolve_rest_base_url(&cfg).to_string());
            Some(DerivativesTradingUsdsFuturesRestApi::from_config(rest_cfg))
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
            dual_side_mode: RwLock::new(None),
            rate_budget,
        })
    }

    pub fn rest_base_url(&self) -> &str {
        Self::resolve_rest_base_url(&self.cfg)
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
            .map_err(|e| BotError::RestApi(format!("Futures REST request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
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

    pub async fn fetch_futures_ticker_price(&self, symbol: &str) -> Result<f64> {
        let url = format!(
            "{}/fapi/v1/ticker/price?symbol={}",
            self.rest_base_url(),
            symbol.to_uppercase()
        );
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures ticker request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Futures ticker status error: {e}")))?;
        let val: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures ticker decode failed: {e}")))?;
        val.get("price")
            .and_then(|p| p.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|&p| p.is_finite() && p > 0.0)
            .ok_or_else(|| BotError::RestApi(format!("Invalid Futures ticker price for {symbol}")))
    }

    pub async fn poll_latest_futures_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_futures_klines(symbol, interval, 2).await?;
        let latest = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty Futures klines for {symbol}")))?;
        let live_price = latest.close;
        let candle = if !latest.is_closed && !bars.is_empty() {
            bars.pop().unwrap_or(latest)
        } else {
            latest
        };
        Ok(MarketEvent {
            symbol: symbol.to_uppercase(),
            price: live_price,
            candle,
            source: TransportMode::RestFallback,
            received_at: Utc::now(),
        })
    }

    fn futures_recv_window(&self) -> i64 {
        self.cfg
            .credentials
            .as_ref()
            .map(|c| c.recv_window_ms as i64)
            .unwrap_or(5000)
    }

    pub async fn is_hedge_mode(&self) -> bool {
        self.is_dual_side_position(self.futures_recv_window()).await
    }

    async fn is_dual_side_position(&self, recv_window: i64) -> bool {
        {
            let guard = self.dual_side_mode.read().await;
            if let Some(cached) = *guard {
                return cached;
            }
        }
        let Some(sdk) = self.sdk_client.as_ref() else {
            return false;
        };
        if let Ok(params) = GetCurrentPositionModeParams::builder()
            .recv_window(recv_window)
            .build()
        {
            if let Ok(resp) = sdk.get_current_position_mode(params).await {
                if let Ok(data) = resp.data().await {
                    let dual = data.dual_side_position.unwrap_or(false);
                    *self.dual_side_mode.write().await = Some(dual);
                    return dual;
                }
            }
        }
        false
    }

    /// Execute a live USD-M Futures order (and optional `/fapi/v1/algoOrder` TP/SL brackets)
    /// via `binance-sdk`. Skips margin/leverage updates on `reduce_only` exits to prevent `-4048`,
    /// runs preflight test orders before mutating margin/leverage, and honors Hedge vs One-Way mode.
    pub async fn execute_futures_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
        let sym = req.symbol.to_uppercase();
        let ref_px = if let Some(px) = req.limit_price.filter(|&p| p.is_finite() && p > 0.0) {
            px
        } else if let Some(q) = req
            .quote_order_qty
            .filter(|&q| q.is_finite() && q > 0.0 && req.quantity > 0.0)
        {
            q / req.quantity
        } else {
            self.fetch_futures_ticker_price(&sym).await.unwrap_or(0.0)
        };
        validate_live_safety(&self.cfg, ExchangeVenue::Futures, req, ref_px)?;
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let recv_window = self.futures_recv_window();
        let require_preflight = self
            .cfg
            .credentials
            .as_ref()
            .is_some_and(|c| c.require_preflight_test_order);

        let filters = get_or_fetch_symbol_filters(
            &self.http,
            &self.filter_cache,
            self.rest_base_url(),
            ExchangeVenue::Futures,
            &sym,
            ref_px,
            &self.rate_budget,
        )
        .await;
        let entry_buy = match req.side {
            Side::Long => !req.reduce_only,
            Side::Short => req.reduce_only,
        };
        let is_limit = matches!(
            req.order_method,
            OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
        );
        let (step, dec) = if !is_limit {
            (filters.market_step_size, filters.market_step_decimals)
        } else {
            (filters.step_size, filters.step_decimals)
        };
        let qty_dec = to_binance_step_decimal(req.quantity, step, dec)?;
        let qty_num = qty_dec.to_string().parse::<f64>().unwrap_or(req.quantity);
        let limit_px_dec = if is_limit {
            let px = req
                .limit_price
                .filter(|&p| p.is_finite() && p > 0.0)
                .ok_or_else(|| BotError::RestApi("Futures LIMIT order missing positive price".into()))?;
            Some(to_binance_step_decimal(
                px,
                filters.tick_size,
                filters.tick_decimals,
            )?)
        } else {
            None
        };
        let limit_px_num = limit_px_dec.and_then(|d| d.to_string().parse::<f64>().ok());
        let est_notional = qty_num * limit_px_num.unwrap_or(ref_px);
        validate_exchange_filters(
            &sym,
            &filters,
            limit_px_num,
            Some(qty_num),
            est_notional,
            !is_limit,
            req.reduce_only,
        )?;

        let dual_side = self.is_dual_side_position(recv_window).await;
        let hedge_pos_side = match req.side {
            Side::Long => "LONG",
            Side::Short => "SHORT",
        };
        let test_pos_enum = match req.side {
            Side::Long => TestOrderPositionSideEnum::Long,
            Side::Short => TestOrderPositionSideEnum::Short,
        };

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
            if dual_side {
                tb = tb.position_side(test_pos_enum);
            } else if req.reduce_only {
                tb = tb.reduce_only(TestOrderReduceOnlyEnum::True);
            }
            if let Some(px_dec) = limit_px_dec {
                tb = tb
                    .price(px_dec)
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
        if dual_side {
            ob = ob.position_side(hedge_pos_side.to_string());
        } else if req.reduce_only {
            ob = ob.reduce_only(NewOrderReduceOnlyEnum::True);
        }
        if let Some(px_dec) = limit_px_dec {
            ob = ob
                .price(px_dec)
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

        let status = resp
            .status
            .clone()
            .unwrap_or_else(|| "UNKNOWN".to_string())
            .to_uppercase();
        let exec_qty: f64 = resp
            .executed_qty
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let filled = status == "FILLED" || exec_qty > 0.0;
        let mut avg_price: f64 = 0.0;

        if exec_qty > 0.0 {
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
            avg_price = resp
                .price
                .as_deref()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|&p| p > 0.0)
                .or(req.limit_price)
                .unwrap_or(ref_px);
        }

        let mut algo_order_ids = Vec::new();
        let mut bracket_warning = None;
        if req.order_method == OrderExecutionMethod::Oco && exec_qty > 0.0 {
            let exit_side = if entry_buy {
                NewAlgoOrderSideEnum::Sell
            } else {
                NewAlgoOrderSideEnum::Buy
            };
            let bracket_valid = match (req.side, req.take_profit_price, req.stop_loss_price) {
                (Side::Long, Some(tp), Some(sl)) => tp > avg_price && avg_price > sl && sl > 0.0,
                (Side::Short, Some(tp), Some(sl)) => sl > avg_price && avg_price > tp && tp > 0.0,
                (Side::Long, Some(tp), None) => tp > avg_price,
                (Side::Short, Some(tp), None) => avg_price > tp && tp > 0.0,
                (Side::Long, None, Some(sl)) => avg_price > sl && sl > 0.0,
                (Side::Short, None, Some(sl)) => sl > avg_price,
                _ => false,
            };
            if !bracket_valid && (req.take_profit_price.is_some() || req.stop_loss_price.is_some())
            {
                bracket_warning = Some(format!(
                    "Futures algo bracket skipped: invalid TP/SL direction around fill {avg_price}"
                ));
            } else {
                if let Some(tp) = req.take_profit_price {
                    let tp_res = validate_exchange_filters(
                        &sym,
                        &filters,
                        Some(tp),
                        None,
                        0.0,
                        false,
                        true,
                    )
                    .and_then(|()| {
                        to_binance_step_decimal(tp, filters.tick_size, filters.tick_decimals)
                    })
                    .and_then(|tp_dec| {
                        let mut b = NewAlgoOrderParams::builder(
                            NewAlgoOrderAlgoTypeEnum::Conditional,
                            sym.clone(),
                            exit_side.clone(),
                            NewAlgoOrderTypeEnum::TakeProfitMarket,
                        )
                        .trigger_price(tp_dec)
                        .close_position(NewAlgoOrderClosePositionEnum::True)
                        .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                        .price_protect(NewAlgoOrderPriceProtectEnum::True)
                        .recv_window(recv_window);
                        if dual_side {
                            b = b.position_side(hedge_pos_side.to_string());
                        }
                        b.build().map_err(|e| {
                            BotError::RestApi(format!("Futures TP algoOrder params error: {e}"))
                        })
                    });
                    match tp_res {
                        Ok(tp_params) => match sdk.new_algo_order(tp_params).await {
                            Ok(r) => match r.data().await {
                                Ok(tp_data) => {
                                    if let Some(id) = tp_data.algo_id {
                                        algo_order_ids.push(id);
                                    }
                                }
                                Err(e) => {
                                    bracket_warning =
                                        Some(format!("Futures TP algoOrder decode failed: {e}"));
                                }
                            },
                            Err(e) => {
                                bracket_warning =
                                    Some(format!("Futures TP algoOrder failed: {e}"));
                            }
                        },
                        Err(e) => bracket_warning = Some(e.to_string()),
                    }
                }
                if bracket_warning.is_none() {
                    if let Some(sl) = req.stop_loss_price {
                        let sl_res = validate_exchange_filters(
                            &sym,
                            &filters,
                            Some(sl),
                            None,
                            0.0,
                            false,
                            true,
                        )
                        .and_then(|()| {
                            to_binance_step_decimal(sl, filters.tick_size, filters.tick_decimals)
                        })
                        .and_then(|sl_dec| {
                            let mut b = NewAlgoOrderParams::builder(
                                NewAlgoOrderAlgoTypeEnum::Conditional,
                                sym.clone(),
                                exit_side,
                                NewAlgoOrderTypeEnum::StopMarket,
                            )
                            .trigger_price(sl_dec)
                            .close_position(NewAlgoOrderClosePositionEnum::True)
                            .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                            .price_protect(NewAlgoOrderPriceProtectEnum::True)
                            .recv_window(recv_window);
                            if dual_side {
                                b = b.position_side(hedge_pos_side.to_string());
                            }
                            b.build().map_err(|e| {
                                BotError::RestApi(format!("Futures SL algoOrder params error: {e}"))
                            })
                        });
                        match sl_res {
                            Ok(sl_params) => match sdk.new_algo_order(sl_params).await {
                                Ok(r) => match r.data().await {
                                    Ok(sl_data) => {
                                        if let Some(id) = sl_data.algo_id {
                                            algo_order_ids.push(id);
                                        }
                                    }
                                    Err(e) => {
                                        bracket_warning = Some(format!(
                                            "Futures SL algoOrder decode failed: {e}"
                                        ));
                                    }
                                },
                                Err(e) => {
                                    bracket_warning =
                                        Some(format!("Futures SL algoOrder failed: {e}"));
                                }
                            },
                            Err(e) => {
                                bracket_warning = Some(e.to_string());
                            }
                        }
                    }
                }
                if bracket_warning.is_some() && !algo_order_ids.is_empty() {
                    for id in algo_order_ids.drain(..) {
                        if let Ok(c_params) = CancelAlgoOrderParams::builder()
                            .algo_id(id)
                            .recv_window(recv_window)
                            .build()
                        {
                            if let Err(cancel_err) = sdk.cancel_algo_order(c_params).await {
                                warn!(algo_id = id, %cancel_err, "Failed to roll back algoOrder after bracket error");
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
            status,
            filled,
            executed_qty: exec_qty,
            avg_price,
        })
    }

    pub async fn cancel_futures_algo_orders(&self, symbol: &str) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let params = CancelAllAlgoOpenOrdersParams::builder(symbol.to_uppercase())
            .recv_window(self.futures_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Cancel algo params error: {e}")))?;
        match sdk.cancel_all_algo_open_orders(params).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("-2011") {
                    Ok(())
                } else {
                    Err(BotError::RestApi(format!(
                        "Futures cancel_all_algo_open_orders failed: {msg}"
                    )))
                }
            }
        }
    }

    pub async fn cancel_futures_open_orders(&self, symbol: &str) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let params = CancelAllOpenOrdersParams::builder(symbol.to_uppercase())
            .recv_window(self.futures_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures cancel open orders params error: {e}")))?;
        match sdk.cancel_all_open_orders(params).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("-2011") {
                    Ok(())
                } else {
                    Err(BotError::RestApi(format!(
                        "Futures cancel_all_open_orders failed: {msg}"
                    )))
                }
            }
        }
    }

    pub async fn query_futures_order_status(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<ExchangeOrderStatus> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let params = QueryOrderParams::builder(symbol.to_uppercase())
            .order_id(order_id)
            .recv_window(self.futures_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures query_order params error: {e}")))?;
        let data = sdk
            .query_order(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures query_order failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures query_order decode failed: {e}")))?;
        let executed_qty = data
            .executed_qty
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let avg_price = data
            .avg_price
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|&p| p > 0.0)
            .or_else(|| {
                let cum = data.cum_quote.as_deref()?.parse::<f64>().ok()?;
                (executed_qty > 0.0 && cum > 0.0).then_some(cum / executed_qty)
            })
            .or_else(|| data.price.as_deref()?.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(ExchangeOrderStatus {
            order_id: data.order_id.unwrap_or(order_id).to_string(),
            status: data.status.unwrap_or_else(|| "UNKNOWN".to_string()).to_uppercase(),
            executed_qty,
            avg_price,
        })
    }

    pub async fn query_futures_algo_order_status(
        &self,
        algo_id: i64,
    ) -> Result<ExchangeOrderStatus> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let params = QueryAlgoOrderParams::builder()
            .algo_id(algo_id)
            .recv_window(self.futures_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures query_algo_order params error: {e}")))?;
        let data = sdk
            .query_algo_order(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures query_algo_order failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures query_algo_order decode failed: {e}")))?;
        let status = data
            .algo_status
            .unwrap_or_else(|| "UNKNOWN".to_string())
            .to_uppercase();
        let is_triggered_or_finished = matches!(status.as_str(), "FILLED" | "FINISHED" | "TRIGGERED");
        let executed_qty = data
            .actual_qty
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|&q| q > 0.0)
            .or_else(|| {
                if is_triggered_or_finished {
                    data.quantity.as_deref()?.parse::<f64>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0.0);
        let avg_price = data
            .actual_price
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|&p| p > 0.0)
            .or_else(|| data.trigger_price.as_deref()?.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(ExchangeOrderStatus {
            order_id: data.algo_id.unwrap_or(algo_id).to_string(),
            status,
            executed_qty,
            avg_price,
        })
    }

    pub async fn get_futures_positions(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<ExchangeOpenPosition>> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let mut b3 = PositionInformationV3Params::builder().recv_window(self.futures_recv_window());
        if let Some(sym) = symbol {
            b3 = b3.symbol(sym.to_uppercase());
        }
        if let Ok(params3) = b3.build() {
            if let Ok(resp3) = sdk.position_information_v3(params3).await {
                if let Ok(rows3) = resp3.data().await {
                    return Ok(rows3
                        .into_iter()
                        .filter_map(|p| {
                            let sym = p.symbol?;
                            let amt = p.position_amt.as_deref()?.parse::<f64>().ok()?;
                            if amt.abs() <= 1e-12 {
                                return None;
                            }
                            let pnl = p
                                .un_realized_profit
                                .as_deref()
                                .and_then(|s| s.parse::<f64>().ok())
                                .unwrap_or(0.0);
                            Some(ExchangeOpenPosition {
                                symbol: sym.to_uppercase(),
                                position_amt: amt,
                                unrealized_pnl: pnl,
                            })
                        })
                        .collect());
                }
            }
        }
        // Fallback to legacy v2 if an environment/mock rejects v3
        let mut builder = PositionInformationV2Params::builder().recv_window(self.futures_recv_window());
        if let Some(sym) = symbol {
            builder = builder.symbol(sym.to_uppercase());
        }
        let params = builder
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures position info params error: {e}")))?;
        let rows = sdk
            .position_information_v2(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures position_information_v2 failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures position decode failed: {e}")))?;
        Ok(rows
            .into_iter()
            .filter_map(|p| {
                let sym = p.symbol?;
                let amt = p.position_amt.as_deref()?.parse::<f64>().ok()?;
                if amt.abs() <= 1e-12 {
                    return None;
                }
                let pnl = p
                    .un_realized_profit
                    .as_deref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                Some(ExchangeOpenPosition {
                    symbol: sym.to_uppercase(),
                    position_amt: amt,
                    unrealized_pnl: pnl,
                })
            })
            .collect())
    }

    pub async fn get_futures_open_algo_orders(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<i64>> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Futures SDK credentials not configured".into()))?;
        let mut builder =
            CurrentAllAlgoOpenOrdersParams::builder().recv_window(self.futures_recv_window());
        if let Some(sym) = symbol {
            builder = builder.symbol(sym.to_uppercase());
        }
        let params = builder
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures algo open orders params error: {e}")))?;
        let rows = sdk
            .current_all_algo_open_orders(params)
            .await
            .map_err(|e| {
                BotError::RestApi(format!("Futures current_all_algo_open_orders failed: {e}"))
            })?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures algo open orders decode failed: {e}")))?;
        Ok(rows.into_iter().filter_map(|r| r.algo_id).collect())
    }

    pub async fn fetch_futures_tradable_symbols(&self) -> Result<HashSet<String>> {
        let url = format!("{}/fapi/v1/exchangeInfo", self.rest_base_url());
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures exchangeInfo request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Futures exchangeInfo status error: {e}")))?;
        let val: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures exchangeInfo decode failed: {e}")))?;
        Ok(parse_tradable_symbols_from_exchange_info(ExchangeVenue::Futures, &val))
    }

    pub async fn fetch_futures_ticker_24h_all(
        &self,
        custom_base_url: Option<&str>,
    ) -> Result<Vec<MarketTicker24h>> {
        let base = custom_base_url.unwrap_or_else(|| self.rest_base_url());
        let url = format!("{}/fapi/v1/ticker/24hr", base.trim_end_matches('/'));
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures ticker/24hr request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Futures ticker/24hr status error: {e}")))?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Futures ticker/24hr decode failed: {e}")))?;
        Ok(parse_ticker_24h_array(ExchangeVenue::Futures, &rows))
    }

    pub async fn cancel_futures_order(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<CancelOrderOutcome> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(CancelOrderOutcome::Canceled);
        };
        let params = CancelOrderParams::builder(symbol.to_uppercase())
            .order_id(order_id)
            .recv_window(self.futures_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Futures cancel_order params error: {e}")))?;
        match sdk.cancel_order(params).await {
            Ok(resp) => {
                if let Ok(data) = resp.data().await {
                    let exec_qty = data
                        .executed_qty
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    if exec_qty > 0.0 {
                        if let Ok(st) = self.query_futures_order_status(symbol, order_id).await {
                            if st.executed_qty > 0.0 {
                                return Ok(CancelOrderOutcome::AlreadyFilled(st));
                            }
                        }
                        let avg_price = data
                            .price
                            .as_deref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        return Ok(CancelOrderOutcome::AlreadyFilled(ExchangeOrderStatus {
                            order_id: data.order_id.unwrap_or(order_id).to_string(),
                            status: "PARTIALLY_FILLED".to_string(),
                            executed_qty: exec_qty,
                            avg_price,
                        }));
                    }
                }
                Ok(CancelOrderOutcome::Canceled)
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("-2011") {
                    if let Ok(st) = self.query_futures_order_status(symbol, order_id).await {
                        if matches!(st.status.as_str(), "FILLED" | "PARTIALLY_FILLED")
                            && st.executed_qty > 0.0
                        {
                            return Ok(CancelOrderOutcome::AlreadyFilled(st));
                        }
                    }
                    Ok(CancelOrderOutcome::Canceled)
                } else {
                    Err(BotError::RestApi(format!("Futures cancel_order failed: {msg}")))
                }
            }
        }
    }
}
