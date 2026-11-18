use crate::{build_sdk_rest_config, to_binance_decimal, validate_live_safety, LiveOrderAck, LiveOrderRequest};
use binance_sdk::derivatives_trading_usds_futures::rest_api::{
    CancelAllAlgoOpenOrdersParams, ChangeInitialLeverageParams, ChangeMarginTypeMarginTypeEnum,
    ChangeMarginTypeParams, NewAlgoOrderAlgoTypeEnum, NewAlgoOrderClosePositionEnum,
    NewAlgoOrderParams, NewAlgoOrderPriceProtectEnum, NewAlgoOrderSideEnum, NewAlgoOrderTypeEnum,
    NewAlgoOrderWorkingTypeEnum, NewOrderNewOrderRespTypeEnum, NewOrderParams,
    NewOrderReduceOnlyEnum, NewOrderSideEnum, NewOrderTimeInForceEnum, NewOrderTypeEnum,
    TestOrderNewOrderRespTypeEnum, TestOrderParams, TestOrderReduceOnlyEnum, TestOrderSideEnum,
    TestOrderTimeInForceEnum, TestOrderTypeEnum,
};
use binance_sdk::derivatives_trading_usds_futures::DerivativesTradingUsdsFuturesRestApi;
use bot_core::{
    BotError, Candle, ExchangeConfig, ExchangeEnvironment, ExchangeVenue, MarginType, MarketEvent,
    OrderExecutionMethod, Result, Side, TransportMode,
};
use chrono::Utc;
use tracing::debug;

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

        Ok(Self {
            cfg,
            http: reqwest::Client::new(),
            sdk_client,
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
        validate_live_safety(&self.cfg, ExchangeVenue::Futures, req)?;
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
        let entry_buy = match req.side {
            Side::Long => !req.reduce_only,
            Side::Short => req.reduce_only,
        };
        let qty_dec = to_binance_decimal(req.quantity, 3)?;

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
                    if !msg.contains("-4046") {
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
                    .price(to_binance_decimal(px, 4)?)
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
                .price(to_binance_decimal(px, 4)?)
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
        let avg_price: f64 = resp
            .price
            .as_deref()
            .and_then(|s| s.parse().ok())
            .filter(|&p| p > 0.0)
            .unwrap_or_else(|| req.limit_price.unwrap_or(0.0));

        let mut algo_order_ids = Vec::new();
        if req.order_method == OrderExecutionMethod::Oco && exec_qty > 0.0 {
            let exit_side = if entry_buy {
                NewAlgoOrderSideEnum::Sell
            } else {
                NewAlgoOrderSideEnum::Buy
            };
            if let Some(tp) = req.take_profit_price {
                let tp_b = NewAlgoOrderParams::builder(
                    NewAlgoOrderAlgoTypeEnum::Conditional,
                    sym.clone(),
                    exit_side.clone(),
                    NewAlgoOrderTypeEnum::TakeProfitMarket,
                )
                .trigger_price(to_binance_decimal(tp, 4)?)
                .close_position(NewAlgoOrderClosePositionEnum::True)
                .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                .price_protect(NewAlgoOrderPriceProtectEnum::True)
                .recv_window(recv_window);
                if let Ok(tp_params) = tp_b.build() {
                    if let Ok(tp_resp) = sdk.new_algo_order(tp_params).await {
                        if let Ok(tp_data) = tp_resp.data().await {
                            if let Some(id) = tp_data.algo_id {
                                algo_order_ids.push(id);
                            }
                        }
                    }
                }
            }
            if let Some(sl) = req.stop_loss_price {
                let sl_b = NewAlgoOrderParams::builder(
                    NewAlgoOrderAlgoTypeEnum::Conditional,
                    sym,
                    exit_side,
                    NewAlgoOrderTypeEnum::StopMarket,
                )
                .trigger_price(to_binance_decimal(sl, 4)?)
                .close_position(NewAlgoOrderClosePositionEnum::True)
                .working_type(NewAlgoOrderWorkingTypeEnum::MarkPrice)
                .price_protect(NewAlgoOrderPriceProtectEnum::True)
                .recv_window(recv_window);
                if let Ok(sl_params) = sl_b.build() {
                    if let Ok(sl_resp) = sdk.new_algo_order(sl_params).await {
                        if let Ok(sl_data) = sl_resp.data().await {
                            if let Some(id) = sl_data.algo_id {
                                algo_order_ids.push(id);
                            }
                        }
                    }
                }
            }
        }

        Ok(LiveOrderAck {
            order_id: resp.order_id.map(|id| id.to_string()),
            order_list_id: None,
            algo_order_ids,
            executed_qty: exec_qty,
            avg_price,
        })
    }

    pub async fn cancel_futures_algo_orders(&self, symbol: &str) -> Result<()> {
        let Some(sdk) = self.sdk_client.as_ref() else {
            return Ok(());
        };
        let params = CancelAllAlgoOpenOrdersParams::builder(symbol.to_uppercase())
            .build()
            .map_err(|e| BotError::RestApi(format!("Cancel algo params error: {e}")))?;
        sdk.cancel_all_algo_open_orders(params)
            .await
            .map_err(|e| BotError::RestApi(format!("Futures cancel_all_algo_open_orders failed: {e}")))?;
        Ok(())
    }
}
