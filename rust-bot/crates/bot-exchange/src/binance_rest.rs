use crate::{
    build_sdk_rest_config, get_or_fetch_symbol_filters, to_binance_step_decimal,
    validate_live_safety, LiveOrderAck, LiveOrderRequest, SymbolFilters,
};
use binance_sdk::spot::rest_api::{
    DeleteOrderListParams, NewOrderNewOrderRespTypeEnum, NewOrderParams, NewOrderSideEnum,
    NewOrderTimeInForceEnum, NewOrderTypeEnum, OrderListOcoAboveTypeEnum,
    OrderListOcoBelowTimeInForceEnum, OrderListOcoBelowTypeEnum, OrderListOcoParams,
    OrderListOcoSideEnum, OrderTestParams, OrderTestSideEnum, OrderTestTimeInForceEnum,
    OrderTestTypeEnum,
};
use binance_sdk::spot::SpotRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarketEvent,
    OrderExecutionMethod, Result, Side, TransportMode,
};
use chrono::Utc;
use rust_decimal::Decimal;
use std::collections::HashMap;
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
}

impl BinanceRestClient {
    pub fn new(cfg: ExchangeConfig) -> Result<Self> {
        let sdk_client = if let Some(rest_cfg) = build_sdk_rest_config(&cfg)? {
            let client = match cfg.environment {
                ExchangeEnvironment::Production => SpotRestApi::production(rest_cfg),
                ExchangeEnvironment::Testnet => SpotRestApi::testnet(rest_cfg),
            };
            Some(client)
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
        })
    }

    fn effective_base_url(&self) -> &str {
        match (self.cfg.venue, self.cfg.environment) {
            (ExchangeVenue::Futures, ExchangeEnvironment::Production) => "https://fapi.binance.com",
            (ExchangeVenue::Futures, ExchangeEnvironment::Testnet) => {
                "https://testnet.binancefuture.com"
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Production) => {
                if self.cfg.rest_base_url.trim().is_empty()
                    || self.cfg.rest_base_url.contains("testnet")
                    || self.cfg.rest_base_url.contains("fapi")
                {
                    "https://api.binance.com"
                } else {
                    &self.cfg.rest_base_url
                }
            }
            (ExchangeVenue::Spot, ExchangeEnvironment::Testnet) => {
                if self.cfg.rest_base_url.trim().is_empty()
                    || self.cfg.rest_base_url.contains("api.binance.com")
                    || self.cfg.rest_base_url.contains("fapi")
                {
                    "https://testnet.binance.vision"
                } else {
                    &self.cfg.rest_base_url
                }
            }
        }
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
            .map_err(|e| BotError::RestApi(format!("REST HTTP request failed: {e}")))?
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
    pub async fn poll_latest_bar(&self, symbol: &str, interval: &str) -> Result<MarketEvent> {
        let mut bars = self.fetch_klines(symbol, interval, 2).await?;
        let latest = bars
            .pop()
            .ok_or_else(|| BotError::RestApi(format!("Empty klines for {symbol}")))?;
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

    /// Execute a live Spot order (and optional `/api/v3/orderList/oco` exit bracket) via `binance-sdk`.
    pub async fn execute_spot_order(&self, req: &LiveOrderRequest) -> Result<LiveOrderAck> {
        let ref_px = req
            .limit_price
            .filter(|&p| p > 0.0)
            .or_else(|| req.quote_order_qty.map(|q| q / req.quantity.max(1e-9)))
            .unwrap_or(100.0);
        validate_live_safety(&self.cfg, ExchangeVenue::Spot, req, ref_px)?;
        let sdk = self
            .sdk_client
            .as_ref()
            .ok_or_else(|| BotError::RestApi("Spot SDK credentials not configured".into()))?;
        let recv_window = Decimal::from(
            self.cfg
                .credentials
                .as_ref()
                .map(|c| c.recv_window_ms)
                .unwrap_or(5000),
        );
        let require_preflight = self
            .cfg
            .credentials
            .as_ref()
            .is_some_and(|c| c.require_preflight_test_order);

        let sym = req.symbol.to_uppercase();
        let filters = get_or_fetch_symbol_filters(
            &self.http,
            &self.filter_cache,
            self.effective_base_url(),
            ExchangeVenue::Spot,
            &sym,
            ref_px,
        )
        .await;
        let side_buy = match req.side {
            Side::Long => !req.reduce_only,
            Side::Short => req.reduce_only,
        };

        let qty_dec = if req.order_method == OrderExecutionMethod::Market
            && side_buy
            && req.quote_order_qty.is_some()
        {
            None
        } else {
            let (step, dec) = if matches!(req.order_method, OrderExecutionMethod::Market | OrderExecutionMethod::Oco) {
                (filters.market_step_size, filters.market_step_decimals)
            } else {
                (filters.step_size, filters.step_decimals)
            };
            Some(to_binance_step_decimal(req.quantity, step, dec)?)
        };
        let quote_dec = if req.order_method == OrderExecutionMethod::Market && side_buy {
            req.quote_order_qty
                .map(|q| to_binance_step_decimal(q, 0.01, 2))
                .transpose()?
        } else {
            None
        };

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

        let exec_qty: f64 = resp
            .executed_qty
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(req.quantity);
        let cum_quote: f64 = resp
            .cummulative_quote_qty
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let avg_price = if exec_qty > 0.0 && cum_quote > 0.0 {
            cum_quote / exec_qty
        } else {
            req.limit_price.unwrap_or(0.0)
        };

        let base_asset = sym.strip_suffix("USDT").unwrap_or(&sym);
        let base_commission: f64 = resp
            .fills
            .as_ref()
            .map(|fills| {
                fills
                    .iter()
                    .filter(|f| {
                        f.commission_asset
                            .as_deref()
                            .is_some_and(|a| a.eq_ignore_ascii_case(base_asset))
                    })
                    .filter_map(|f| f.commission.as_deref()?.parse::<f64>().ok())
                    .sum()
            })
            .unwrap_or(0.0);
        let net_exec_qty = (exec_qty - base_commission).max(0.0);

        let mut order_list_id = None;
        let mut bracket_warning = None;
        if req.order_method == OrderExecutionMethod::Oco && net_exec_qty > 0.0 {
            if let (Some(tp), Some(sl)) = (req.take_profit_price, req.stop_loss_price) {
                match (
                    to_binance_step_decimal(net_exec_qty, filters.step_size, filters.step_decimals),
                    to_binance_step_decimal(tp, filters.tick_size, filters.tick_decimals),
                    to_binance_step_decimal(sl, filters.tick_size, filters.tick_decimals),
                    to_binance_step_decimal(sl * 0.998, filters.tick_size, filters.tick_decimals),
                ) {
                    (Ok(oco_qty), Ok(tp_dec), Ok(sl_dec), Ok(sl_lim_dec)) => {
                        let oco_res = OrderListOcoParams::builder(
                            sym,
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
                                    Err(e) => bracket_warning = Some(format!("Spot OCO decode failed: {e}")),
                                },
                                Err(e) => bracket_warning = Some(format!("Spot /api/v3/orderList/oco failed: {e}")),
                            },
                            Err(e) => bracket_warning = Some(format!("Spot OCO params error: {e}")),
                        }
                    }
                    _ => {
                        bracket_warning = Some("Spot OCO rounding error after entry fill".into());
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
            executed_qty: exec_qty,
            avg_price,
        })
    }

    pub async fn cancel_spot_oco(&self, symbol: &str, order_list_id: i64) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let recv_window = Decimal::from(
            self.cfg
                .credentials
                .as_ref()
                .map(|c| c.recv_window_ms)
                .unwrap_or(5000),
        );
        let params = DeleteOrderListParams::builder(symbol.to_uppercase())
            .order_list_id(order_list_id)
            .recv_window(recv_window)
            .build()
            .map_err(|e| BotError::RestApi(format!("Cancel OCO params error: {e}")))?;
        sdk.delete_order_list(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Spot delete_order_list failed: {e}")))?;
        Ok(())
    }
}
