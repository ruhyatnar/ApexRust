//! Exchange gateway built around the official Binance Rust Connector SDK
//! (`binance-sdk`), prioritizing WebSocket Streams & WebSocket API with
//! transparent REST API fallback.
//!
//! Reference: https://developers.binance.com/en/docs/sdks-tools/connectors/rust

pub mod binance_futures;
pub mod binance_rest;
pub mod binance_ws;
pub mod failover;

pub use binance_futures::{BinanceFuturesClient, FuturesOrderTicket};
pub use binance_rest::BinanceRestClient;
pub use binance_ws::BinanceWsDriver;
pub use failover::{FailoverGateway, FailoverHealth};
