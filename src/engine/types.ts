export type TransportMode = 'WsPrimary' | 'RestFallback' | 'Reconnecting';

export type StrategyMode = 'scalping' | 'intraday';

export type StrategyProfile = 'trend_pullback' | 'ema_breakout' | 'vwap_reversion';

export type ExecutionOrderMethod = 'MARKET' | 'LIMIT' | 'LIMIT_MAKER' | 'OCO';

export type DirectionPolicy = 'long_only' | 'both';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h';

export type ExchangeVenue = 'Spot' | 'Futures';

export type MarginType = 'ISOLATED' | 'CROSSED';

export type Side = 'Long' | 'Short';

export type OrderType = 'OCO SELL' | 'OCO BUY' | 'LIMIT' | 'LIMIT MAKER' | 'MARKET' | 'ATR SCALP';

export interface TakeProfitTarget {
  id: string;
  pctOffset: number;
  allocationPct: number;
  targetPrice: number;
  hit: boolean;
}

export interface ManualOrderInput {
  symbol: string;
  orderType: OrderType;
  side: Side;
  usdtAmount: number;
  limitPrice?: number;
  timeInForce?: TimeInForce;
  stopLossMode: 'MARKET' | 'ATR' | 'LIMIT';
  stopLossPct: number;
  useBreakEven: boolean;
  useTrailingStop: boolean;
  targets: Array<{ pctOffset: number; allocationPct: number }>;
}

export interface LiveAutoIntent {
  id: string;
  kind: 'ENTRY' | 'EXIT';
  symbol: string;
  side: Side;
  binanceSide: 'BUY' | 'SELL';
  orderMethod: ExecutionOrderMethod;
  usdtAmount: number;
  quantity?: number;
  limitPrice?: number;
  timeInForce: TimeInForce;
  reason: string;
  input?: ManualOrderInput;
}

export type ExitReason =
  | 'StopLoss'
  | 'BreakEvenStop'
  | 'TrailingStop'
  | 'TakeProfit1'
  | 'TakeProfit2'
  | 'CircuitBreakerFlatten'
  | 'ManualClose';

export type CircuitBreakerState = 'Active' | 'Cooldown' | 'Halted';

export interface Candle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface IndicatorSnapshot {
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  emaMacro: number | null;
  rsi: number | null;
  prevRsi: number | null;
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  atr: number | null;
  vwap: number | null;
  volumeSma20?: number | null;
  volumeRatio?: number | null;
}

export type PositionSizingMode =
  | 'fixed_usdt'
  | 'fixed_risk_pct'
  | 'quarter_kelly'
  | 'half_kelly'
  | 'full_kelly';

export interface ExitPlan {
  initialStopLoss: number;
  activeStopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tpTargets?: TakeProfitTarget[];
  tp1Hit: boolean;
  breakEvenArmed: boolean;
  trailingActive: boolean;
  trailingEnabled?: boolean;
  riskDistanceR: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  lockedMarginUsdt: number;
  unrealizedPnlUsdt: number;
  realizedPnlUsdt: number;
  highestFavorablePrice: number;
  exitPlan: ExitPlan;
  openedAtMs: number;
  rationale: string;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsdt: number;
  rMultiple: number;
  reason: ExitReason;
  closedAtMs: number;
}

/**
 * Official Binance Spot (/api/v3/myTrades + executionReport) and
 * USD-M Futures (/fapi/v1/userTrades + ORDER_TRADE_UPDATE) execution fill record.
 */
export interface BinanceExecutionRecord {
  id: string;
  tradeId: number;
  orderId: number;
  orderListId: number; // -1 when not part of an OCO order list
  clientOrderId: string;
  symbol: string;
  venue: ExchangeVenue;
  environment: 'Testnet' | 'Production';
  accountMode: ExecutionAccountMode;
  lifecycle: 'ENTRY' | 'EXIT';
  side: Side;
  binanceSide: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  orderType:
    | 'MARKET'
    | 'LIMIT'
    | 'LIMIT_MAKER'
    | 'STOP_LOSS_LIMIT'
    | 'TAKE_PROFIT_LIMIT'
    | 'STOP_MARKET'
    | 'TAKE_PROFIT_MARKET';
  uiOrderType: OrderType;
  execType: 'TRADE';
  orderStatus: 'FILLED' | 'PARTIALLY_FILLED';
  timeInForce: TimeInForce | 'GTX';
  price: number;
  entryPrice: number;
  origQty: number;
  executedQty: number;
  cummulativeQuoteQty: number;
  commission: number;
  commissionAsset: string;
  isMaker: boolean;
  leverage: number;
  marginType: MarginType;
  realizedPnlUsdt: number | null;
  rMultiple: number | null;
  exitReason: ExitReason | null;
  strategyRationale: string;
  transactTime: number;
}

export interface EntrySignal {
  symbol: string;
  side: Side;
  entryPrice: number;
  atr: number;
  adx: number;
  rsi: number;
  rationale: string;
  timestampMs: number;
}

export interface TradingConfig {
  venue: ExchangeVenue;
  leverage: number;
  marginType: MarginType;
  mode: StrategyMode;
  timeframe: Timeframe;
  pairs: string[];
  maxConcurrentPositions: number;
  baseRiskPerTradePct: number;
  positionSizingMode?: PositionSizingMode;
  initialEquityUsdt: number;
  takerFeeBps: number;
}

export interface IndicatorConfig {
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  emaMacro: number;
  rsiPeriod: number;
  rsiLongPullbackMin: number;
  rsiLongPullbackMax: number;
  rsiShortPullbackMin: number;
  rsiShortPullbackMax: number;
  adxPeriod: number;
  adxMinTrend: number;
  atrPeriod: number;
  requireVwapAlignment: boolean;
  minVolumeExpansionMult?: number;
}

export interface ExitConfig {
  atrSlMultiplier: number;
  atrTp1Multiplier: number;
  atrTp2Multiplier: number;
  tp1CloseRatio: number;
  breakEvenTriggerR: number;
  breakEvenFeeBufferBps: number;
  trailingActivationR: number;
  atrTrailingMultiplier: number;
}

export interface RiskConfig {
  maxDailyDrawdownPct: number;
  maxPairDailyDrawdownPct: number;
  maxDailyProfitPct: number;
  maxWinStreak: number;
  maxLoseStreak: number;
  streakCooldownMinutes: number;
  flattenOnCircuitBreaker: boolean;
}

export interface AutomationConfig {
  enabled: boolean;
  strategyProfile: StrategyProfile;
  directionPolicy: DirectionPolicy;
  orderMethod: ExecutionOrderMethod;
  limitOffsetBps: number;
  timeInForce: TimeInForce;
  signalCooldownBars: number;
  autoOrderNotionalUsdt: number;
  autoCloseOnExit: boolean;
}

export interface FeatureToggles {
  automatedTrading: boolean;
  manualTrading: boolean;
  signalGenerator: boolean;
  wsPrimaryFeed: boolean;
  restFallback: boolean;
  emaTrendFilter: boolean;
  rsiMomentumFilter: boolean;
  adxStrengthFilter: boolean;
  vwapBiasFilter: boolean;
  volumeConfirmationFilter?: boolean;
  atrDynamicExits: boolean;
  takeProfitLadder: boolean;
  breakEvenStop: boolean;
  trailingStop: boolean;
  circuitBreaker: boolean;
  spotMarket: boolean;
  futuresMarket: boolean;
  gitAutoBackup: boolean;
}

export interface BotConfig {
  trading: TradingConfig;
  indicators: IndicatorConfig;
  exits: ExitConfig;
  risk: RiskConfig;
  automation: AutomationConfig;
  features: FeatureToggles;
}

export interface RiskStatus {
  state: CircuitBreakerState;
  haltReason: string | null;
  cooldownUntilMs: number | null;
  startingDailyEquity: number;
  currentEquity: number;
  cumulativeDailyPnlUsdt: number;
  cumulativeDailyPnlPct: number;
  winStreak: number;
  loseStreak: number;
  quarantinedPairs: string[];
}

export interface PairRuntimeState {
  symbol: string;
  candles: Candle[];
  indicatorHistory: IndicatorSnapshot[];
  lastPrice: number;
  change24hPct: number;
  dailyPnlUsdt: number;
  dailyPnlPct: number;
  indicators: IndicatorSnapshot;
  openPosition: Position | null;
  lastSignalNote: string | null;
}

export type ExecutionAccountMode = 'Paper' | 'Live';

export type BinanceAuthMethod = 'HMAC-SHA256' | 'Ed25519';

export interface LiveBalanceEntry {
  asset: string;
  free: number;
  locked: number;
}

export interface LiveCredentialStatus {
  configured: boolean;
  environment: 'Testnet' | 'Production';
  venue: ExchangeVenue;
  leverage: number;
  marginType: MarginType;
  authMethod: BinanceAuthMethod;
  apiKeyMasked: string | null;
  recvWindowMs: number;
  maxOrderNotionalUsdt: number;
  requirePreflightTestOrder: boolean;
  armedForLiveOrders: boolean;
  verificationStatus: 'unverified' | 'verified' | 'error';
  verificationMessage: string | null;
  lastVerifiedAt: string | null;
  canTrade: boolean;
  permissions: string[];
  latencyMs: number | null;
  syncedBalances: LiveBalanceEntry[];
}

export interface TransportHealth {
  mode: TransportMode;
  environment: 'Production' | 'Testnet';
  venue: ExchangeVenue;
  feedSource: 'Simulated' | 'BinanceLive';
  failoverCount: number;
  lastWsAgeMs: number;
  wsHeartbeatTimeoutMs: number;
  restPollIntervalMs: number;
  wsEndpoint: string;
  restEndpoint: string;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  orderMethod: ExecutionOrderMethod;
  usdtAmount: number;
  limitPrice: number;
  timeInForce: TimeInForce;
  stopLossMode: 'MARKET' | 'ATR' | 'LIMIT';
  stopLossPct: number;
  useBreakEven: boolean;
  useTrailingStop: boolean;
  targets: Array<{ pctOffset: number; allocationPct: number }>;
  createdAtMs: number;
  exchangeOrderId?: string;
}

export interface AutoTradingStats {
  scansRun: number;
  signalsDetected: number;
  autoOrdersDispatched: number;
  lastScanAtMs: number | null;
  lastActionSummary: string | null;
}

export interface EngineSnapshot {
  accountMode: ExecutionAccountMode;
  running: boolean;
  tickCount: number;
  transport: TransportHealth;
  risk: RiskStatus;
  lockedBalanceUsdt: number;
  availableBalanceUsdt: number;
  pnlHistory: number[];
  pairs: PairRuntimeState[];
  pendingOrders: PendingOrder[];
  recentTrades: ClosedTrade[];
  executionHistory: BinanceExecutionRecord[];
  autoStats: AutoTradingStats;
  eventLog: Array<{ id: string; timestampMs: number; level: 'info' | 'warn' | 'alert'; message: string }>;
}
