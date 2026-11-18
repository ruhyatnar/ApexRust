use thiserror::Error;

pub type Result<T> = std::result::Result<T, BotError>;

/// Unified error hierarchy across exchange, strategy, risk, and runtime layers.
#[derive(Debug, Error)]
pub enum BotError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Exchange WebSocket error: {0}")]
    WebSocket(String),

    #[error("Exchange REST fallback error: {0}")]
    RestApi(String),

    #[error("Order rejected by risk manager: {0}")]
    RiskRejected(String),

    #[error("Circuit breaker active: {0}")]
    CircuitBreakerHalted(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}
