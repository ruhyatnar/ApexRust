import type {
  CircuitBreakerState,
  ClosedTrade,
  EngineSnapshot,
  ExchangeVenue,
  ExitReason,
  FeatureToggles,
  PairRuntimeState,
  PairSelectionMode,
  PairSourceTag,
  PendingOrder,
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
  emaMid: number | null;
  emaSlow: number | null;
  emaMacro: number | null;
  prevEmaMid: number | null;
  rsi: number | null;
  prevRsi: number | null;
  atr: number | null;
  adx: number | null;
  prevAdx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  vwap: number | null;
  volumeRatio: number | null;
  hasBarGap?: boolean;
  openPosition: RemoteVpsPosition | null;
  sourceTag?: PairSourceTag;
  tradableOnActiveVenue?: boolean;
  quoteVolume24hUsdt?: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  spreadBps?: number | null;
  barsWarmupCount?: number;
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
  pendingOrders: PendingOrder[];
  pairSelectionMode?: PairSelectionMode;
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
    const srcRaw = String(p.source_tag ?? '').toLowerCase();
    const sourceTag: PairSourceTag | undefined =
      srcRaw === 'protected_position'
        ? 'protected_position'
        : srcRaw === 'trending'
          ? 'trending'
          : srcRaw === 'pinned'
            ? 'pinned'
            : undefined;
    const warmup = toOptNum(p.bars_warmed_up ?? ind.warmup_bars_count);
    return {
      symbol: String(p.symbol ?? 'BTCUSDT'),
      lastPrice: toNum(p.last_price),
      dailyPnlUsdt: toNum(p.daily_pnl_usdt),
      dailyPnlPct: toNum(p.daily_pnl_pct),
      emaFast: toOptNum(ind.ema_fast),
      emaMid: toOptNum(ind.ema_mid),
      emaSlow: toOptNum(ind.ema_slow),
      emaMacro: toOptNum(ind.ema_macro),
      prevEmaMid: toOptNum(ind.prev_ema_mid),
      rsi: toOptNum(ind.rsi),
      prevRsi: toOptNum(ind.prev_rsi),
      atr: toOptNum(ind.atr),
      adx: toOptNum(ind.adx),
      prevAdx: toOptNum(ind.prev_adx),
      plusDi: toOptNum(ind.plus_di),
      minusDi: toOptNum(ind.minus_di),
      vwap: toOptNum(ind.vwap),
      volumeRatio: toOptNum(ind.volume_ratio),
      hasBarGap: typeof ind.has_bar_gap === 'boolean' ? ind.has_bar_gap : undefined,
      openPosition,
      sourceTag,
      tradableOnActiveVenue:
        typeof p.tradable_on_active_venue === 'boolean' ? p.tradable_on_active_venue : undefined,
      quoteVolume24hUsdt: toOptNum(p.quote_volume_24h_usdt) ?? undefined,
      bestBid: toOptNum(p.best_bid),
      bestAsk: toOptNum(p.best_ask),
      spreadBps: toOptNum(p.spread_bps),
      barsWarmupCount: warmup !== null ? Math.round(warmup) : undefined,
    };
  });

  const pendingRaw = Array.isArray(obj.pending_orders)
    ? (obj.pending_orders as Array<Record<string, unknown>>)
    : [];
  const pendingOrders: PendingOrder[] = pendingRaw.map((po) => {
    const sideStr = String(po.side ?? 'long').toLowerCase();
    const methodRaw = String(po.order_method ?? 'LIMIT').toUpperCase();
    const orderMethod =
      methodRaw === 'LIMITMAKER' || methodRaw === 'LIMIT_MAKER' ? 'LIMIT_MAKER' : 'LIMIT';
    const limPx = toNum(po.limit_price);
    const qty = toNum(po.quantity);
    const createdMs = Date.parse(String(po.created_at ?? ''));
    const rationaleStr = typeof po.rationale === 'string' && po.rationale.trim() ? po.rationale.trim() : undefined;
    return {
      id: String(po.order_id ?? ''),
      symbol: String(po.symbol ?? 'BTCUSDT'),
      venue,
      side: sideStr === 'short' ? 'Short' : 'Long',
      orderType: orderMethod === 'LIMIT_MAKER' ? 'LIMIT MAKER' : 'LIMIT',
      orderMethod,
      usdtAmount: limPx * qty,
      limitPrice: limPx,
      timeInForce: 'GTC',
      stopLossMode: 'ATR',
      stopLossPct: 1.5,
      useBreakEven: true,
      useTrailingStop: true,
      targets: [],
      createdAtMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
      exchangeOrderId: String(po.order_id ?? ''),
      source: po.is_manual ? 'manual' : 'auto',
      createdBarIndex: toNum(po.created_bar_idx),
      ageBars: po.age_bars !== undefined && po.age_bars !== null ? Math.max(0, Math.round(toNum(po.age_bars))) : undefined,
      dynamicStatusNote: rationaleStr,
    };
  });
  const modeRaw = String(obj.pair_selection_mode ?? '').toLowerCase();
  const pairSelectionMode: PairSelectionMode | undefined =
    modeRaw === 'static' || modeRaw === 'dynamic' || modeRaw === 'hybrid'
      ? modeRaw
      : undefined;

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
    pendingOrders,
    pairSelectionMode,
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
    volumeConfirmationFilter: bool('volumeConfirmationFilter', 'volume_confirmation_filter', false),
    sessionWindowFilter: bool('sessionWindowFilter', 'session_window_filter', false),
    atrDynamicExits: bool('atrDynamicExits', 'atr_dynamic_exits'),
    takeProfitLadder: bool('takeProfitLadder', 'take_profit_ladder'),
    breakEvenStop: bool('breakEvenStop', 'break_even_stop'),
    trailingStop: bool('trailingStop', 'trailing_stop'),
    circuitBreaker: bool('circuitBreaker', 'circuit_breaker'),
    wsPrimaryFeed: bool('wsPrimaryFeed', 'ws_primary_feed'),
    restFallback: bool('restFallback', 'rest_fallback'),
    gitAutoBackup: bool('gitAutoBackup', 'git_auto_backup', false),
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

  const existingPairs = remote.pairs.length > 0
    ? base.pairs.filter((pair) => remotePairsBySymbol.has(pair.symbol))
    : base.pairs;
  const pairs: PairRuntimeState[] = existingPairs.map((pair) => {
    const rp = remotePairsBySymbol.get(pair.symbol);
    if (!rp) return pair;
    return {
      ...pair,
      lastPrice: rp.lastPrice > 0 ? rp.lastPrice : pair.lastPrice,
      dailyPnlUsdt: rp.dailyPnlUsdt,
      dailyPnlPct: rp.dailyPnlPct,
      sourceTag: rp.sourceTag ?? pair.sourceTag,
      tradableOnActiveVenue: rp.tradableOnActiveVenue ?? pair.tradableOnActiveVenue,
      quoteVolume24hUsdt: rp.quoteVolume24hUsdt ?? pair.quoteVolume24hUsdt,
      bestBid: rp.bestBid ?? pair.bestBid,
      bestAsk: rp.bestAsk ?? pair.bestAsk,
      spreadBps: rp.spreadBps ?? pair.spreadBps,
      barsWarmedUp: rp.barsWarmupCount ?? pair.barsWarmedUp,
      indicators: {
        ...pair.indicators,
        emaFast: rp.emaFast ?? pair.indicators.emaFast,
        emaMid: rp.emaMid ?? pair.indicators.emaMid,
        emaSlow: rp.emaSlow ?? pair.indicators.emaSlow,
        emaMacro: rp.emaMacro ?? pair.indicators.emaMacro,
        prevEmaMid: rp.prevEmaMid ?? pair.indicators.prevEmaMid,
        rsi: rp.rsi ?? pair.indicators.rsi,
        prevRsi: rp.prevRsi ?? pair.indicators.prevRsi,
        atr: rp.atr ?? pair.indicators.atr,
        adx: rp.adx ?? pair.indicators.adx,
        prevAdx: rp.prevAdx ?? pair.indicators.prevAdx,
        plusDi: rp.plusDi ?? pair.indicators.plusDi,
        minusDi: rp.minusDi ?? pair.indicators.minusDi,
        vwap: rp.vwap ?? pair.indicators.vwap,
        volumeRatio: rp.volumeRatio ?? pair.indicators.volumeRatio,
        warmupBarsCount: rp.barsWarmupCount ?? pair.indicators.warmupBarsCount,
        hasBarGap: rp.hasBarGap ?? pair.indicators.hasBarGap,
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
      sourceTag: rp.sourceTag,
      tradableOnActiveVenue: rp.tradableOnActiveVenue,
      quoteVolume24hUsdt: rp.quoteVolume24hUsdt,
      bestBid: rp.bestBid ?? undefined,
      bestAsk: rp.bestAsk ?? undefined,
      spreadBps: rp.spreadBps ?? undefined,
      barsWarmedUp: rp.barsWarmupCount,
      indicators: {
        emaFast: rp.emaFast,
        emaMid: rp.emaMid,
        emaSlow: rp.emaSlow,
        emaMacro: rp.emaMacro,
        prevEmaMid: rp.prevEmaMid,
        rsi: rp.rsi,
        prevRsi: rp.prevRsi,
        adx: rp.adx,
        prevAdx: rp.prevAdx,
        plusDi: rp.plusDi,
        minusDi: rp.minusDi,
        atr: rp.atr,
        vwap: rp.vwap,
        volumeRatio: rp.volumeRatio,
        warmupBarsCount: rp.barsWarmupCount,
        hasBarGap: rp.hasBarGap,
      },
      openPosition: mapRemotePos(rp.openPosition),
      lastSignalNote: null,
    });
  }

  const lockedBalanceUsdt = pairs.reduce(
    (sum, p) => sum + (p.openPosition?.lockedMarginUsdt ?? 0),
    0
  );
  const availableBalanceUsdt = Math.max(0, remote.risk.currentEquity - lockedBalanceUsdt);

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
    pendingOrders: remote.pendingOrders,
    recentTrades,
    volatilityAlerts:
      remote.recentVolatilityAlerts.length > 0
        ? remote.recentVolatilityAlerts
        : base.volatilityAlerts,
  };
}
