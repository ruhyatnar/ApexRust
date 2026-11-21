use crate::{
    build_sdk_rest_config, extract_base_asset, get_or_fetch_symbol_filters,
    parse_ticker_24h_array, parse_tradable_symbols_from_exchange_info, to_binance_step_decimal,
    validate_exchange_filters, validate_live_safety, CancelOrderOutcome, ExchangeOrderStatus,
    LiveOrderAck, LiveOrderRequest, RestRateBudget, SymbolFilters,
};
use binance_sdk::spot::rest_api::{
    DeleteOpenOrdersParams, DeleteOrderListParams, DeleteOrderParams, GetAccountParams,
    GetOpenOrdersParams, GetOrderParams, NewOrderNewOrderRespTypeEnum, NewOrderParams,
    NewOrderSideEnum, NewOrderTimeInForceEnum, NewOrderTypeEnum, OrderListOcoAboveTypeEnum,
    OrderListOcoBelowTimeInForceEnum, OrderListOcoBelowTypeEnum, OrderListOcoParams,
    OrderListOcoSideEnum, OrderTestParams, OrderTestSideEnum, OrderTestTimeInForceEnum,
    OrderTestTypeEnum,
};
use binance_sdk::spot::SpotRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent,
    MarketTicker24h, OrderExecutionMethod, Result, Side, TransportMode,
};
use chrono::Utc;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, warn};

/// Official Binance Spot REST API wrapper (`binance_sdk::spot::SpotRestApi`)
/// used for historical kline warmup, REST fallback polling, and signed Spot orders / OCO brackets.
pub struct BinanceRestClient {
    cfg: ExchangeConfig,
    http: reqwest::Client,
    sdk_client: Option<binance_sdk::spot::rest_api::RestApi>,
    filter_cache: RwLock<HashMap<String, SymbolFilters>>,
    rate_budget: Arc<RestRateBudget>,
}

impl BinanceRestClient {
    fn resolve_base_url(cfg: &ExchangeConfig) -> &str {
        let trimmed = cfg.rest_base_url.trim();
        match (cfg.venue, cfg.environment) {
            (ExchangeVenue::Futures, ExchangeEnvironment::Production) => {
                if trimmed.is_empty()
                    || trimmed.contains("testnet")
                    || trimmed.contains("demo")
                    || trimmed.contains("binance.vision")
                    || trimmed.contains("api.binance.com")
                {
                    "https://fapi.binance.com"
                } else {
                    trimmed
                }
            }
            (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
                if trimmed.is_empty()
                    || trimmed.contains("fapi.binance.com")
                    || trimmed.contains("api.binance.com")
                {
                    "https://testnet.binancefuture.com"
                } else {
                    trimmed
                }
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
                if trimmed.is_empty()
                    || trimmed.contains("testnet")
                    || trimmed.contains("demo")
                    || trimmed.contains("fapi")
                    || trimmed.contains("binancefuture")
                {
                    "https://api.binance.com"
                } else {
                    trimmed
                }
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
                if trimmed.is_empty()
                    || trimmed.contains("api.binance.com")
                    || trimmed.contains("fapi")
                    || trimmed.contains("fstream")
                {
                    "https://testnet.binance.vision"
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
            rest_cfg.base_path = Some(Self::resolve_base_url(&cfg).to_string());
            Some(SpotRestApi::from_config(rest_cfg))
        } else {
            None
        };

        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| BotError::RestApi(format!("Failed to build Spot HTTP client: {e}")))?;

        Ok(Self {
            cfg,
            http,
            sdk_client,
            filter_cache: RwLock::new(HashMap::new()),
            rate_budget,
        })
    }

    fn effective_base_url(&self) -> &str {
        Self::resolve_base_url(&self.cfg)
    }

    /// Fetch historical klines via public Spot REST endpoint (`/api/v3/klines`).
    pub async fn fetch_klines(&self, symbol: &str, interval: &str, limit: usize) -> Result<Vec<Candle>> {
        let kline_path = match self.cfg.venue {
            ExchangeVenue::Spot => "/api/v3/klines",
            ExchangeVenue::Futures => "/fapi/v1/klines",
        };
        let url = format!(
            "{}{}?symbol={}&interval={}&limit={}",
            self.effective_base_url(),
            kline_path,
            symbol.to_uppercase(),
            interval,
            limit
        );
        debug!(%url, "Fetching Binance klines");
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("REST HTTP request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("REST HTTP status error: {e}")))?;

        let rows: Vec<Vec<serde_json::Value>> = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("REST JSON decode failed: {e}")))?;

        let now_ms = Utc::now().timestamp_millis();
        let mut candles = Vec::with_capacity(rows.len());
        for row in rows {
            if row.len() < 7 {
                continue;
            }
            let open_time_ms = row[0].as_i64().unwrap_or_default();
            let open = row[1].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let high = row[2].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let low = row[3].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let close = row[4].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let volume = row[5].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let close_time_ms = row[6].as_i64().unwrap_or_default();
            let is_closed = close_time_ms <= 0 || close_time_ms <= now_ms;
            candles.push(Candle {
                open_time_ms,
                open,
                high,
                low,
                close,
                volume,
                is_closed,
            });
        }
        Ok(candles)
    }

    /// Single fallback poll yielding a `MarketEvent` tagged `TransportMode::RestFallback`.
    pub async fn fetch_spot_ticker_price(&self, symbol: &str) -> Result<f64> {
        let url = format!(
            "{}/api/v3/ticker/price?symbol={}",
            self.effective_base_url(),
            symbol.to_uppercase()
        );
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot ticker request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Spot ticker status error: {e}")))?;
        let val: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot ticker decode failed: {e}")))?;
        val.get("price")
            .and_then(|p| p.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|&p| p.is_finite() && p > 0.0)
            .ok_or_else(|| BotError::RestApi(format!("Invalid Spot ticker price for {symbol}")))
    }

    pub async fn poll_latest_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_klines(symbol, interval, 2).await?;
        let latest = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty klines for {symbol}")))?;
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

    fn spot_recv_window(&self) -> Decimal {
        Decimal::from(
            self.cfg
                .credentials
                .as_ref()
                .map(|c| c.recv_window_ms)
                .unwrap_or(5000),
        )
    }

    /// Execute a live Spot order (and optional `/api/v3/orderList/oco` exit bracket) via `binance-sdk`.
    /// Builds `order.place` params for the WebSocket API with Spot filters applied.
    pub(crate) async fn build_ws_order_params(
        &self,
        req: &LiveOrderRequest,
    ) -> Result<serde_json::Value> {
        let sym = req.symbol.trim().to_uppercase();
        let ref_px = req.limit_price.filter(|p| p.is_finite() && *p > 0.0).unwrap_or(1.0);
        let filters = get_or_fetch_symbol_filters(
            &self.http,
            &self.filter_cache,
            self.effective_base_url(),
            ExchangeVenue::Spot,
            &sym,
            ref_px,
            &self.rate_budget,
        )
        .await;
        let is_market = matches!(
            req.order_method,
            OrderExecutionMethod::Market | OrderExecutionMethod::Oco
        );
        let (step, dec) = if is_market {
            (filters.market_step_size, filters.market_step_decimals)
        } else {
            (filters.step_size, filters.step_decimals)
        };
        let qty_dec = to_binance_step_decimal(req.quantity, step, dec)?;
        let qty_num = qty_dec.to_string().parse::<f64>().unwrap_or(req.quantity);
        let limit_px_num = if is_market {
            None
        } else {
            Some(
                req.limit_price
                    .filter(|&p| p.is_finite() && p > 0.0)
                    .ok_or_else(|| {
                        BotError::RestApi("Spot WS LIMIT order missing positive price".into())
                    })?,
            )
        };
        validate_exchange_filters(
            &sym,
            &filters,
            limit_px_num,
            Some(qty_num),
            qty_num * limit_px_num.unwrap_or(ref_px),
            is_market,
            req.reduce_only,
        )?;
        let side = match req.side {
            Side::Long => "BUY",
            Side::Short => "SELL",
        };
        crate::ws_api::build_order_place_params(
            &sym,
            side,
            if is_market { "MARKET" } else { "LIMIT" },
            qty_num,
            limit_px_num.map(|px| (px, Some(req.time_in_force.as_str()))),
            req.reduce_only,
            None,
        )
    }

    pub async fn execute_spot_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
        let sym = req.symbol.to_uppercase();
        let ref_px = if let Some(px) = req.limit_price.filter(|&p| p.is_finite() && p > 0.0) {
            px
        } else if let Some(q) = req.quote_order_qty.filter(|&q| q.is_finite() && q > 0.0 && req.quantity > 0.0) {
            q / req.quantity
        } else {
            self.fetch_spot_ticker_price(&sym).await.unwrap_or(0.0)
        };
        validate_live_safety(&self.cfg, ExchangeVenue::Spot, req, ref_px)?;
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Spot SDK credentials not configured".into()))?;
        let recv_window = self.spot_recv_window();
        let require_preflight = self
            .cfg
            .credentials
            .as_ref()
            .is_some_and(|c| c.require_preflight_test_order);

        let filters = get_or_fetch_symbol_filters(
            &self.http,
            &self.filter_cache,
            self.effective_base_url(),
            ExchangeVenue::Spot,
            &sym,
            ref_px,
            &self.rate_budget,
        )
        .await;
        let side_buy = match req.side {
            Side::Long => !req.reduce_only,
            Side::Short => req.reduce_only,
        };
        let is_market = matches!(
            req.order_method,
            OrderExecutionMethod::Market | OrderExecutionMethod::Oco
        );

        let qty_dec = if req.order_method == OrderExecutionMethod::Market
            && side_buy
            && req.quote_order_qty.is_some()
        {
            None
        } else {
            let (step, dec) = if is_market {
                (filters.market_step_size, filters.market_step_decimals)
            } else {
                (filters.step_size, filters.step_decimals)
            };
            Some(to_binance_step_decimal(req.quantity, step, dec)?)
        };
        let quote_dec = if req.order_method == OrderExecutionMethod::Market && side_buy {
            let quote_step = 10f64.powi(-(filters.quote_decimals as i32));
            req.quote_order_qty
                .map(|q| to_binance_step_decimal(q, quote_step, filters.quote_decimals))
                .transpose()?
        } else {
            None
        };

        let qty_num = qty_dec.and_then(|d| d.to_string().parse::<f64>().ok());
        let limit_px_num = if matches!(
            req.order_method,
            OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
        ) {
            let px = req
                .limit_price
                .filter(|&p| p.is_finite() && p > 0.0)
                .ok_or_else(|| BotError::RestApi("LIMIT order missing positive price".into()))?;
            let px_dec = to_binance_step_decimal(px, filters.tick_size, filters.tick_decimals)?;
            px_dec.to_string().parse::<f64>().ok()
        } else {
            None
        };
        let est_notional = if quote_dec.is_some() {
            req.quote_order_qty.unwrap_or(0.0)
        } else {
            let q = qty_num.unwrap_or(req.quantity);
            let p = limit_px_num.unwrap_or(ref_px);
            q * p
        };
        validate_exchange_filters(
            &sym,
            &filters,
            limit_px_num,
            qty_num,
            est_notional,
            is_market,
            req.reduce_only,
        )?;

        let tif = match req.time_in_force.as_str() {
            "IOC" => NewOrderTimeInForceEnum::Ioc,
            "FOK" => NewOrderTimeInForceEnum::Fok,
            _ => NewOrderTimeInForceEnum::Gtc,
        };

        if require_preflight {
            let mut test_builder = OrderTestParams::builder(
                sym.clone(),
                if side_buy {
                    OrderTestSideEnum::Buy
                } else {
                    OrderTestSideEnum::Sell
                },
                match req.order_method {
                    OrderExecutionMethod::Limit => OrderTestTypeEnum::Limit,
                    OrderExecutionMethod::LimitMaker => OrderTestTypeEnum::LimitMaker,
                    OrderExecutionMethod::Market | OrderExecutionMethod::Oco => {
                        OrderTestTypeEnum::Market
                    }
                },
            )
            .recv_window(recv_window);
            if let Some(q) = qty_dec {
                test_builder = test_builder.quantity(q);
            }
            if let Some(qq) = quote_dec {
                test_builder = test_builder.quote_order_qty(qq);
            }
            if matches!(
                req.order_method,
                OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
            ) {
                let px = req
                    .limit_price
                    .ok_or_else(|| BotError::RestApi("LIMIT order missing price".into()))?;
                test_builder = test_builder.price(to_binance_step_decimal(
                    px,
                    filters.tick_size,
                    filters.tick_decimals,
                )?);
                if req.order_method == OrderExecutionMethod::Limit {
                    test_builder = test_builder.time_in_force(match req.time_in_force.as_str() {
                        "IOC" => OrderTestTimeInForceEnum::Ioc,
                        "FOK" => OrderTestTimeInForceEnum::Fok,
                        _ => OrderTestTimeInForceEnum::Gtc,
                    });
                }
            }
            let test_params = test_builder
                .build()
                .map_err(|e| BotError::RestApi(format!("Spot test order params error: {e}")))?;
            sdk.order_test(test_params)
                .await
                .map_err(|e| BotError::RestApi(format!("Spot /api/v3/order/test failed: {e}")))?;
        }

        let mut order_builder = NewOrderParams::builder(
            sym.clone(),
            if side_buy {
                NewOrderSideEnum::Buy
            } else {
                NewOrderSideEnum::Sell
            },
            match req.order_method {
                OrderExecutionMethod::Limit => NewOrderTypeEnum::Limit,
                OrderExecutionMethod::LimitMaker => NewOrderTypeEnum::LimitMaker,
                OrderExecutionMethod::Market | OrderExecutionMethod::Oco => {
                    NewOrderTypeEnum::Market
                }
            },
        )
        .recv_window(recv_window)
        .new_order_resp_type(NewOrderNewOrderRespTypeEnum::Full);
        if let Some(q) = qty_dec {
            order_builder = order_builder.quantity(q);
        }
        if let Some(qq) = quote_dec {
            order_builder = order_builder.quote_order_qty(qq);
        }
        if matches!(
            req.order_method,
            OrderExecutionMethod::Limit | OrderExecutionMethod::LimitMaker
        ) {
            let px = req
                .limit_price
                .ok_or_else(|| BotError::RestApi("LIMIT order missing price".into()))?;
            order_builder = order_builder.price(to_binance_step_decimal(
                px,
                filters.tick_size,
                filters.tick_decimals,
            )?);
            if req.order_method == OrderExecutionMethod::Limit {
                order_builder = order_builder.time_in_force(tif);
            }
        }

        let order_params = order_builder
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot new order params error: {e}")))?;
        let resp = sdk
            .new_order(order_params)
            .await
            .map_err(|e| BotError::RestApi(format!("Spot new_order failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot new_order decode failed: {e}")))?;

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
        let cum_quote: f64 = resp
            .cummulative_quote_qty
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let avg_price = if exec_qty > 0.0 && cum_quote > 0.0 {
            cum_quote / exec_qty
        } else {
            resp.price
                .as_deref()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|&p| p > 0.0)
                .or(req.limit_price)
                .unwrap_or(ref_px)
        };

        let base_asset = extract_base_asset(&sym, &filters);
        let base_commission: f64 = resp
            .fills
            .as_ref()
            .map(|fills| {
                fills
                    .iter()
                    .filter(|f| {
                        f.commission_asset
                            .as_deref()
                            .is_some_and(|a| a.eq_ignore_ascii_case(&base_asset))
                    })
                    .filter_map(|f| f.commission.as_deref()?.parse::<f64>().ok())
                    .sum()
            })
            .unwrap_or(0.0);
        let net_exec_qty = (exec_qty - base_commission).max(0.0);

        let mut order_list_id = None;
        let mut bracket_warning = None;
        if req.order_method == OrderExecutionMethod::Oco && side_buy && net_exec_qty > 0.0 {
            if let (Some(tp), Some(sl)) = (req.take_profit_price, req.stop_loss_price) {
                if !(tp > avg_price && avg_price > sl && sl > 0.0) {
                    bracket_warning = Some(format!(
                        "Spot OCO skipped: requires TP ({tp}) > fill ({avg_price}) > SL ({sl})"
                    ));
                } else {
                    let sl_limit = sl * 0.998;
                    let oco_qty_dec = to_binance_step_decimal(
                        net_exec_qty,
                        filters.step_size,
                        filters.step_decimals,
                    );
                    let tp_dec =
                        to_binance_step_decimal(tp, filters.tick_size, filters.tick_decimals);
                    let sl_dec =
                        to_binance_step_decimal(sl, filters.tick_size, filters.tick_decimals);
                    let sl_lim_dec = to_binance_step_decimal(
                        sl_limit,
                        filters.tick_size,
                        filters.tick_decimals,
                    );
                    match (oco_qty_dec, tp_dec, sl_dec, sl_lim_dec) {
                        (Ok(oco_qty), Ok(tp_dec), Ok(sl_dec), Ok(sl_lim_dec)) => {
                            let qf = oco_qty.to_string().parse::<f64>().unwrap_or(net_exec_qty);
                            let tpf = tp_dec.to_string().parse::<f64>().unwrap_or(tp);
                            let slf = sl_lim_dec.to_string().parse::<f64>().unwrap_or(sl_limit);
                            let tp_check = validate_exchange_filters(
                                &sym,
                                &filters,
                                Some(tpf),
                                Some(qf),
                                qf * tpf,
                                false,
                                false,
                            );
                            let sl_check = validate_exchange_filters(
                                &sym,
                                &filters,
                                Some(slf),
                                Some(qf),
                                qf * slf,
                                false,
                                false,
                            );
                            if let Err(e) = tp_check.and(sl_check) {
                                bracket_warning =
                                    Some(format!("Spot OCO blocked by exchange filters: {e}"));
                            } else {
                                let oco_res = OrderListOcoParams::builder(
                                    sym.clone(),
                                    OrderListOcoSideEnum::Sell,
                                    oco_qty,
                                    OrderListOcoAboveTypeEnum::LimitMaker,
                                    OrderListOcoBelowTypeEnum::StopLossLimit,
                                )
                                .above_price(tp_dec)
                                .below_stop_price(sl_dec)
                                .below_price(sl_lim_dec)
                                .below_time_in_force(OrderListOcoBelowTimeInForceEnum::Gtc)
                                .recv_window(recv_window)
                                .build();

                                match oco_res {
                                    Ok(oco_params) => match sdk.order_list_oco(oco_params).await {
                                        Ok(r) => match r.data().await {
                                            Ok(oco_data) => order_list_id = oco_data.order_list_id,
                                            Err(e) => {
                                                bracket_warning = Some(format!(
                                                    "Spot OCO decode failed: {e}"
                                                ));
                                            }
                                        },
                                        Err(e) => {
                                            bracket_warning = Some(format!(
                                                "Spot /api/v3/orderList/oco failed: {e}"
                                            ));
                                        }
                                    },
                                    Err(e) => {
                                        bracket_warning =
                                            Some(format!("Spot OCO params error: {e}"));
                                    }
                                }
                            }
                        }
                        _ => {
                            bracket_warning =
                                Some("Spot OCO rounding error after entry fill".into());
                        }
                    }
                }
            }
        }
        if let Some(ref w) = bracket_warning {
            warn!(%w, "Entry filled on Spot, using local exit management");
        }

        Ok(LiveOrderAck {
            order_id: resp.order_id.map(|id| id.to_string()),
            order_list_id,
            algo_order_ids: Vec::new(),
            bracket_warning,
            status,
            filled,
            // For Spot BUY orders, report post-commission net base quantity so subsequent
            // protective exit SELLs never hit Binance -2010 Insufficient Balance.
            executed_qty: if side_buy { net_exec_qty } else { exec_qty },
            avg_price,
        })
    }

    pub async fn cancel_spot_oco(&self, symbol: &str, order_list_id: i64) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let params = DeleteOrderListParams::builder(symbol.to_uppercase())
            .order_list_id(order_list_id)
            .recv_window(self.spot_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Cancel OCO params error: {e}")))?;
        match sdk.delete_order_list(params).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("-2011") {
                    Ok(())
                } else {
                    Err(BotError::RestApi(format!(
                        "Spot delete_order_list failed: {msg}"
                    )))
                }
            }
        }
    }

    pub async fn cancel_spot_open_orders(&self, symbol: &str) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let params = DeleteOpenOrdersParams::builder(symbol.to_uppercase())
            .recv_window(self.spot_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot cancel open orders params error: {e}")))?;
        match sdk.delete_open_orders(params).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("-2011") {
                    Ok(())
                } else {
                    Err(BotError::RestApi(format!(
                        "Spot delete_open_orders failed: {msg}"
                    )))
                }
            }
        }
    }

    pub async fn query_spot_order_status(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<ExchangeOrderStatus> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Spot SDK credentials not configured".into()))?;
        let params = GetOrderParams::builder(symbol.to_uppercase())
            .order_id(order_id)
            .recv_window(self.spot_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot get_order params error: {e}")))?;
        let data = sdk
            .get_order(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_order failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_order decode failed: {e}")))?;
        let executed_qty = data
            .executed_qty
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let cum_quote = data
            .cummulative_quote_qty
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let avg_price = if executed_qty > 0.0 && cum_quote > 0.0 {
            cum_quote / executed_qty
        } else {
            data.price
                .as_deref()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
        };
        Ok(ExchangeOrderStatus {
            order_id: data.order_id.unwrap_or(order_id).to_string(),
            status: data.status.unwrap_or_else(|| "UNKNOWN".to_string()).to_uppercase(),
            executed_qty,
            avg_price,
        })
    }

    pub async fn get_spot_open_orders(
        &self,
        symbol: Option<&str>,
    ) -> Result<Vec<ExchangeOrderStatus>> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Spot SDK credentials not configured".into()))?;
        let mut builder = GetOpenOrdersParams::builder().recv_window(self.spot_recv_window());
        if let Some(sym) = symbol {
            builder = builder.symbol(sym.to_uppercase());
        }
        let params = builder
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot open orders params error: {e}")))?;
        let rows = sdk
            .get_open_orders(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_open_orders failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_open_orders decode failed: {e}")))?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let executed_qty = r
                    .executed_qty
                    .as_deref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                let cum_quote = r
                    .cummulative_quote_qty
                    .as_deref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                let avg_price = if executed_qty > 0.0 && cum_quote > 0.0 {
                    cum_quote / executed_qty
                } else {
                    r.price
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0)
                };
                ExchangeOrderStatus {
                    order_id: r.order_id.unwrap_or_default().to_string(),
                    status: r.status.unwrap_or_else(|| "NEW".to_string()).to_uppercase(),
                    executed_qty,
                    avg_price,
                }
            })
            .collect())
    }

    pub async fn get_spot_free_balance(&self, asset: &str) -> Result<f64> {
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Spot SDK credentials not configured".into()))?;
        let params = GetAccountParams::builder()
            .omit_zero_balances(true)
            .recv_window(self.spot_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot account params error: {e}")))?;
        let data = sdk
            .get_account(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_account failed: {e}")))?
            .data()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot get_account decode failed: {e}")))?;
        let free = data
            .balances
            .unwrap_or_default()
            .into_iter()
            .find(|b| {
                b.asset
                    .as_deref()
                    .is_some_and(|a| a.eq_ignore_ascii_case(asset))
            })
            .and_then(|b| b.free.as_deref()?.parse::<f64>().ok())
            .unwrap_or(0.0);
        Ok(free)
    }

    pub async fn fetch_spot_tradable_symbols(&self) -> Result<HashSet<String>> {
        let url = format!("{}/api/v3/exchangeInfo", self.effective_base_url());
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot exchangeInfo request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Spot exchangeInfo status error: {e}")))?;
        let val: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot exchangeInfo decode failed: {e}")))?;
        Ok(parse_tradable_symbols_from_exchange_info(ExchangeVenue::Spot, &val))
    }

    pub async fn fetch_spot_ticker_24h_all(
        &self,
        custom_base_url: Option<&str>,
    ) -> Result<Vec<MarketTicker24h>> {
        let base = custom_base_url.unwrap_or_else(|| self.effective_base_url());
        let url = format!("{}/api/v3/ticker/24hr", base.trim_end_matches('/'));
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot ticker/24hr request failed: {e}")))?;
        self.rate_budget.report_response(resp.status(), resp.headers());
        let resp = resp
            .error_for_status()
            .map_err(|e| BotError::RestApi(format!("Spot ticker/24hr status error: {e}")))?;
        let rows: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| BotError::RestApi(format!("Spot ticker/24hr decode failed: {e}")))?;
        Ok(parse_ticker_24h_array(ExchangeVenue::Spot, &rows))
    }

    pub async fn cancel_spot_order(
        &self,
        symbol: &str,
        order_id: i64,
    ) -> Result<CancelOrderOutcome> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(CancelOrderOutcome::Canceled);
        };
        let params = DeleteOrderParams::builder(symbol.to_uppercase())
            .order_id(order_id)
            .recv_window(self.spot_recv_window())
            .build()
            .map_err(|e| BotError::RestApi(format!("Spot delete_order params error: {e}")))?;
        match sdk.delete_order(params).await {
            Ok(resp) => {
                if let Ok(data) = resp.data().await {
                    let exec_qty = data
                        .executed_qty
                        .as_deref()
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    if exec_qty > 0.0 {
                        let cum_quote = data
                            .cummulative_quote_qty
                            .as_deref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let avg_price = if cum_quote > 0.0 {
                            cum_quote / exec_qty
                        } else {
                            data.price
                                .as_deref()
                                .and_then(|s| s.parse::<f64>().ok())
                                .unwrap_or(0.0)
                        };
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
                    if let Ok(st) = self.query_spot_order_status(symbol, order_id).await {
                        if matches!(st.status.as_str(), "FILLED" | "PARTIALLY_FILLED")
                            && st.executed_qty > 0.0
                        {
                            return Ok(CancelOrderOutcome::AlreadyFilled(st));
                        }
                    }
                    Ok(CancelOrderOutcome::Canceled)
                } else {
                    Err(BotError::RestApi(format!("Spot delete_order failed: {msg}")))
                }
            }
        }
    }
}
