import type {
  CircuitBreakerState,
  ClosedTrade,
  EngineSnapshot,
  ExchangeVenue,
  ExitReason,
  FeatureToggles,
  PairRuntimeState,
  Position,
  Side,
  TransportMode,
  VolatilitySpikeAlert,
} from './types';

interface RemoteVpsPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  unrealizedPnlUsdt: number;
  realizedPnlUsdt: number;
  highestFavorablePrice: number;
  initialStopLoss: number;
  currentStopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1Filled: boolean;
  breakEvenArmed: boolean;
  trailingActive: boolean;
  openedAtIso: string;
}

interface RemoteVpsPairSnapshot {
  symbol: string;
  lastPrice: number;
  dailyPnlUsdt: number;
  dailyPnlPct: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  atr: number | null;
  adx: number | null;
  vwap: number | null;
  openPosition: RemoteVpsPosition | null;
}

interface RemoteVpsClosedTrade {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsdt: number;
  rMultiple: number;
  reason: ExitReason;
  closedAtIso: string;
}

interface RemoteVpsRiskStatus {
  state: CircuitBreakerState;
  tripReason: string | null;
  startingDailyEquity: number;
  currentEquity: number;
  dailyPnlUsdt: number;
  dailyPnlPct: number;
  winStreak: number;
  loseStreak: number;
  quarantinedPairs: string[];
}

export interface RemoteVpsEngineSnapshot {
  running: boolean;
  venue: ExchangeVenue;
  transportMode: TransportMode;
  failoverCount: number;
  lastWsAgeMs: number;
  risk: RemoteVpsRiskStatus;
  pairs: RemoteVpsPairSnapshot[];
  recentTrades: RemoteVpsClosedTrade[];
  recentVolatilityAlerts: VolatilitySpikeAlert[];
  updatedAtIso: string;
}

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toOptNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Converts a raw Rust `EngineSnapshot` JSON payload (snake_case from `bot-web` `/api/snapshot`)
 * into a strongly typed camelCase `RemoteVpsEngineSnapshot` for the Desktop UI.
 */
export function mapRustEngineSnapshot(raw: unknown): RemoteVpsEngineSnapshot {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const venueRaw = String(obj.venue ?? 'spot').toLowerCase();
  const venue: ExchangeVenue = venueRaw === 'futures' ? 'Futures' : 'Spot';
  const tmRaw = String(obj.transport_mode ?? obj.transportMode ?? 'WsPrimary');
  const transportMode: TransportMode =
    tmRaw === 'RestFallback' || tmRaw === 'Reconnecting' ? tmRaw : 'WsPrimary';

  const riskRaw = (
    typeof obj.risk === 'object' && obj.risk !== null ? obj.risk : {}
  ) as Record<string, unknown>;
  const stateRaw = String(riskRaw.state ?? 'Normal');
  const cbState: CircuitBreakerState =
    stateRaw === 'Halted' || stateRaw === 'Cooldown' ? stateRaw : 'Active';

  const pairsRaw = Array.isArray(obj.pairs) ? (obj.pairs as Array<Record<string, unknown>>) : [];
  const pairs: RemoteVpsPairSnapshot[] = pairsRaw.map((p) => {
    const ind = (
      typeof p.indicators === 'object' && p.indicators !== null ? p.indicators : {}
    ) as Record<string, unknown>;
    const posRaw =
      typeof p.open_position === 'object' && p.open_position !== null
        ? (p.open_position as Record<string, unknown>)
        : null;
    let openPosition: RemoteVpsPosition | null = null;
    if (posRaw) {
      const plan = (
        typeof posRaw.exit_plan === 'object' && posRaw.exit_plan !== null
          ? posRaw.exit_plan
          : {}
      ) as Record<string, unknown>;
      const sideStr = String(posRaw.side ?? 'long').toLowerCase();
      openPosition = {
        id: String(posRaw.id ?? ''),
        symbol: String(posRaw.symbol ?? p.symbol ?? 'BTCUSDT'),
        side: sideStr === 'short' ? 'Short' : 'Long',
        entryPrice: toNum(posRaw.entry_price),
        quantity: toNum(posRaw.quantity),
        remainingQuantity: toNum(posRaw.remaining_quantity),
        unrealizedPnlUsdt: toNum(posRaw.unrealized_pnl_usdt),
        realizedPnlUsdt: toNum(posRaw.realized_pnl_usdt),
        highestFavorablePrice: toNum(posRaw.highest_favorable_price),
        initialStopLoss: toNum(plan.initial_stop_loss),
        currentStopLoss: toNum(plan.active_stop_loss ?? plan.current_stop_loss),
        takeProfit1: toNum(plan.take_profit_1),
        takeProfit2: toNum(plan.take_profit_2),
        tp1Filled: Boolean(plan.tp1_hit ?? plan.tp1_filled),
        breakEvenArmed: Boolean(plan.break_even_armed),
        trailingActive: Boolean(plan.trailing_active),
        openedAtIso: String(posRaw.opened_at ?? new Date().toISOString()),
      };
    }
    return {
      symbol: String(p.symbol ?? 'BTCUSDT'),
      lastPrice: toNum(p.last_price),
      dailyPnlUsdt: toNum(p.daily_pnl_usdt),
      dailyPnlPct: toNum(p.daily_pnl_pct),
      emaFast: toOptNum(ind.ema_fast),
      emaSlow: toOptNum(ind.ema_slow),
      rsi: toOptNum(ind.rsi),
      atr: toOptNum(ind.atr),
      adx: toOptNum(ind.adx),
      vwap: toOptNum(ind.vwap),
      openPosition,
    };
  });

  const tradesRaw = Array.isArray(obj.recent_trades)
    ? (obj.recent_trades as Array<Record<string, unknown>>)
    : [];
  const recentTrades: RemoteVpsClosedTrade[] = tradesRaw.map((t) => {
    const sideStr = String(t.side ?? 'long').toLowerCase();
    return {
      id: String(t.id ?? ''),
      symbol: String(t.symbol ?? 'BTCUSDT'),
      side: sideStr === 'short' ? 'Short' : 'Long',
      entryPrice: toNum(t.entry_price),
      exitPrice: toNum(t.exit_price),
      quantity: toNum(t.quantity),
      pnlUsdt: toNum(t.pnl_usdt),
      rMultiple: toNum(t.r_multiple),
      reason: (String(t.reason ?? 'StopLoss') as ExitReason) || 'StopLoss',
      closedAtIso: String(t.closed_at ?? new Date().toISOString()),
    };
  });

  const alertsRaw = Array.isArray(obj.recent_volatility_alerts)
    ? (obj.recent_volatility_alerts as Array<Record<string, unknown>>)
    : [];
  const recentVolatilityAlerts: VolatilitySpikeAlert[] = alertsRaw.map((a) => {
    const tsIso = String(a.triggered_at ?? new Date().toISOString());
    const parsedMs = Date.parse(tsIso);
    const atrPctOfPrice = toNum(a.atr_pct ?? a.atrPctOfPrice ?? a.atrPct);
    const atrExpansionRatio = toNum(
      a.expansion_ratio ?? a.atrExpansionRatio ?? a.expansionRatio
    );
    return {
      id: String(a.id ?? ''),
      symbol: String(a.symbol ?? 'BTCUSDT'),
      price: toNum(a.price),
      atr: toNum(a.atr),
      atrPctOfPrice,
      atrExpansionRatio,
      candleRangePct: toNum(a.candle_range_pct ?? a.candleRangePct ?? atrPctOfPrice),
      severity: atrExpansionRatio >= 2.2 ? 'extreme' : 'elevated',
      message: String(a.message ?? ''),
      timestampMs: Number.isFinite(parsedMs) ? parsedMs : Date.now(),
    };
  });

  return {
    running: Boolean(obj.running ?? true),
    venue,
    transportMode,
    failoverCount: toNum(obj.failover_count),
    lastWsAgeMs: toNum(obj.last_ws_age_ms),
    risk: {
      state: cbState,
      tripReason:
        typeof (riskRaw.halt_reason ?? riskRaw.trip_reason) === 'string' &&
        (riskRaw.halt_reason ?? riskRaw.trip_reason)
          ? String(riskRaw.halt_reason ?? riskRaw.trip_reason)
          : null,
      startingDailyEquity: toNum(riskRaw.starting_daily_equity, 10_000),
      currentEquity: toNum(riskRaw.current_equity, 10_000),
      dailyPnlUsdt: toNum(riskRaw.cumulative_daily_pnl_usdt ?? riskRaw.daily_pnl_usdt),
      dailyPnlPct: toNum(riskRaw.cumulative_daily_pnl_pct ?? riskRaw.daily_pnl_pct),
      winStreak: toNum(riskRaw.win_streak),
      loseStreak: toNum(riskRaw.lose_streak),
      quarantinedPairs: Array.isArray(riskRaw.quarantined_pairs)
        ? (riskRaw.quarantined_pairs as unknown[]).map(String)
        : [],
    },
    pairs,
    recentTrades,
    recentVolatilityAlerts,
    updatedAtIso: String(obj.updated_at ?? new Date().toISOString()),
  };
}

/**
 * Extracts `FeatureToggles` from a raw Rust `BotConfig` JSON payload (`/api/engine/config`).
 */
export function mapRustFeatureToggles(rawConfig: unknown): FeatureToggles | null {
  if (typeof rawConfig !== 'object' || rawConfig === null) return null;
  const f = (rawConfig as { features?: Record<string, unknown> }).features;
  if (!f || typeof f !== 'object') return null;
  const bool = (camel: string, snake: string, fallback = true): boolean => {
    if (typeof f[camel] === 'boolean') return f[camel] as boolean;
    if (typeof f[snake] === 'boolean') return f[snake] as boolean;
    return fallback;
  };
  return {
    spotMarket: bool('spotMarket', 'spot_market'),
    futuresMarket: bool('futuresMarket', 'futures_market'),
    automatedTrading: bool('automatedTrading', 'automated_trading'),
    manualTrading: bool('manualTrading', 'manual_trading'),
    signalGenerator: bool('signalGenerator', 'signal_generator'),
    emaTrendFilter: bool('emaTrendFilter', 'ema_trend_filter'),
    adxStrengthFilter: bool('adxStrengthFilter', 'adx_strength_filter'),
    rsiMomentumFilter: bool('rsiMomentumFilter', 'rsi_momentum_filter'),
    vwapBiasFilter: bool('vwapBiasFilter', 'vwap_bias_filter'),
    volumeConfirmationFilter: bool('volumeConfirmationFilter', 'volume_confirmation_filter'),
    sessionWindowFilter: bool('sessionWindowFilter', 'session_window_filter', false),
    atrDynamicExits: bool('atrDynamicExits', 'atr_dynamic_exits'),
    takeProfitLadder: bool('takeProfitLadder', 'take_profit_ladder'),
    breakEvenStop: bool('breakEvenStop', 'break_even_stop'),
    trailingStop: bool('trailingStop', 'trailing_stop'),
    circuitBreaker: bool('circuitBreaker', 'circuit_breaker'),
    wsPrimaryFeed: bool('wsPrimaryFeed', 'ws_primary_feed'),
    restFallback: bool('restFallback', 'rest_fallback'),
    gitAutoBackup: bool('gitAutoBackup', 'git_auto_backup'),
  };
}

/**
 * Overlays live Remote VPS Daemon state onto a browser `EngineSnapshot` so Trading Desk
 * reflects 24/7 VPS positions, risk state, and closed trades while keeping local candles intact.
 */
export function mergeRemoteVpsSnapshot(
  base: EngineSnapshot,
  remote: RemoteVpsEngineSnapshot | null,
  leverage = 1
): EngineSnapshot {
  if (!remote) return base;
  const effLeverage = remote.venue === 'Futures' ? Math.max(1, leverage) : 1;
  const remotePairsBySymbol = new Map(remote.pairs.map((p) => [p.symbol, p]));

  const mapRemotePos = (p: RemoteVpsPosition | null): Position | null => {
    if (!p) return null;
    const markPx =
      remotePairsBySymbol.get(p.symbol)?.lastPrice ?? p.entryPrice;
    const riskDist = Math.abs(p.entryPrice - p.initialStopLoss) || p.entryPrice * 0.015;
    const lockedMargin =
      (p.entryPrice * p.remainingQuantity) / Math.max(1, effLeverage);
    const parsedOpen = Date.parse(p.openedAtIso);
    const unrealized =
      p.unrealizedPnlUsdt !== 0
        ? p.unrealizedPnlUsdt
        : (markPx - p.entryPrice) *
          p.remainingQuantity *
          (p.side === 'Long' ? 1 : -1);
    return {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      remainingQuantity: p.remainingQuantity,
      lockedMarginUsdt: lockedMargin,
      unrealizedPnlUsdt: unrealized,
      realizedPnlUsdt: p.realizedPnlUsdt,
      highestFavorablePrice: p.highestFavorablePrice,
      exitPlan: {
        initialStopLoss: p.initialStopLoss,
        activeStopLoss: p.currentStopLoss,
        takeProfit1: p.takeProfit1,
        takeProfit2: p.takeProfit2,
        tp1Hit: p.tp1Filled,
        breakEvenArmed: p.breakEvenArmed,
        trailingActive: p.trailingActive,
        riskDistanceR: riskDist,
      },
      openedAtMs: Number.isFinite(parsedOpen) ? parsedOpen : Date.now(),
      rationale: '24/7 Remote VPS Daemon',
    };
  };

  const pairs: PairRuntimeState[] = base.pairs.map((pair) => {
    const rp = remotePairsBySymbol.get(pair.symbol);
    if (!rp) return pair;
    return {
      ...pair,
      lastPrice: rp.lastPrice > 0 ? rp.lastPrice : pair.lastPrice,
      dailyPnlUsdt: rp.dailyPnlUsdt,
      dailyPnlPct: rp.dailyPnlPct,
      indicators: {
        ...pair.indicators,
        emaFast: rp.emaFast ?? pair.indicators.emaFast,
        emaSlow: rp.emaSlow ?? pair.indicators.emaSlow,
        rsi: rp.rsi ?? pair.indicators.rsi,
        atr: rp.atr ?? pair.indicators.atr,
        adx: rp.adx ?? pair.indicators.adx,
        vwap: rp.vwap ?? pair.indicators.vwap,
      },
      openPosition: mapRemotePos(rp.openPosition),
    };
  });

  for (const rp of remote.pairs) {
    if (pairs.some((p) => p.symbol === rp.symbol)) continue;
    pairs.push({
      symbol: rp.symbol,
      candles: [],
      indicatorHistory: [],
      lastPrice: rp.lastPrice,
      change24hPct: 0,
      dailyPnlUsdt: rp.dailyPnlUsdt,
      dailyPnlPct: rp.dailyPnlPct,
      indicators: {
        emaFast: rp.emaFast,
        emaMid: null,
        emaSlow: rp.emaSlow,
        emaMacro: null,
        rsi: rp.rsi,
        prevRsi: null,
        adx: rp.adx,
        plusDi: null,
        minusDi: null,
        atr: rp.atr,
        vwap: rp.vwap,
      },
      openPosition: mapRemotePos(rp.openPosition),
      lastSignalNote: null,
    });
  }

  const lockedBalanceUsdt = pairs.reduce(
    (sum, p) => sum + (p.openPosition?.lockedMarginUsdt ?? 0),
    0
  );
  const availableBalanceUsdt =
    base.availableBalanceUsdt > 0
      ? base.availableBalanceUsdt
      : Math.max(0, remote.risk.currentEquity - lockedBalanceUsdt);

  const recentTrades: ClosedTrade[] = remote.recentTrades.map((t) => {
    const closedMs = Date.parse(t.closedAtIso);
    return {
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      pnlUsdt: t.pnlUsdt,
      rMultiple: t.rMultiple,
      reason: t.reason,
      closedAtMs: Number.isFinite(closedMs) ? closedMs : Date.now(),
    };
  });

  return {
    ...base,
    running: remote.running,
    transport: {
      ...base.transport,
      mode: remote.transportMode,
      venue: remote.venue,
      failoverCount: remote.failoverCount,
      lastWsAgeMs: remote.lastWsAgeMs,
    },
    risk: {
      ...base.risk,
      state: remote.risk.state,
      haltReason: remote.risk.tripReason,
      startingDailyEquity: remote.risk.startingDailyEquity,
      currentEquity: remote.risk.currentEquity,
      cumulativeDailyPnlUsdt: remote.risk.dailyPnlUsdt,
      cumulativeDailyPnlPct: remote.risk.dailyPnlPct,
      winStreak: remote.risk.winStreak,
      loseStreak: remote.risk.loseStreak,
      quarantinedPairs: remote.risk.quarantinedPairs,
    },
    lockedBalanceUsdt,
    availableBalanceUsdt,
    pairs,
    recentTrades,
    volatilityAlerts:
      remote.recentVolatilityAlerts.length > 0
        ? remote.recentVolatilityAlerts
        : base.volatilityAlerts,
  };
}
