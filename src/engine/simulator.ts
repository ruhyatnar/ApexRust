import { pricePrecisionDecimals } from './formatters';
import { IndicatorPipeline } from './indicators';
import {
  calculateQuantitativePositionSizeUsdt,
  computeExpectancyStats,
  computeKellySizingAnalytics,
  computePortfolioCorrelationMatrix,
} from './quantAnalytics';
import { RiskManager } from './risk';
import { DEFAULT_UTC_SESSION_WINDOWS, evaluateUtcSessionWindows } from './sessionWindows';
import {
  buildExitPlan,
  evaluateEntrySignal,
  evaluateOpenPositionDynamicAction,
  evaluatePendingOrderDynamicAction,
  managePositionTick,
} from './strategy';
import {
  hasCandleSequenceGap,
  normalizeSymbolList,
  resolveEffectiveWatchlist,
  type WatchlistDwellState,
} from './watchlist';
import type {
  BinanceExecutionRecord,
  BotConfig,
  Candle,
  ClosedTrade,
  EngineSnapshot,
  ExchangeVenue,
  ExecutionAccountMode,
  ExitReason,
  LiveAutoIntent,
  ManualOrderInput,
  MarketTicker24h,
  PairRuntimeState,
  PendingOrder,
  Position,
  Side,
  TakeProfitTarget,
  Timeframe,
  TimeInForce,
  TransportMode,
  VolatilitySpikeAlert,
} from './types';

export const DEFAULT_BOT_CONFIG: BotConfig = {
  trading: {
    venue: 'Spot',
    leverage: 3,
    maxLeverage: 3,
    marginType: 'ISOLATED',
    mode: 'scalping',
    timeframe: '5m',
    pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'],
    maxConcurrentPositions: 3,
    baseRiskPerTradePct: 0.75,
    positionSizingMode: 'fixed_usdt',
    initialEquityUsdt: 10000,
    takerFeeBps: 10,
    pairSelectionMode: 'hybrid',
    quoteAsset: 'USDT',
    maxWatchlistPairs: 20,
    trendingCategory: 'hot_volume',
    trendingTopN: 5,
    trendingMinQuoteVolumeUsdt: 10_000_000,
    trendingMinDwellMinutes: 15,
    trendingHysteresisRankBuffer: 3,
    rankingSource: 'auto',
    maxSameDirectionPositions: 2,
    ctsScreenerEnabled: false,
    ctsRvolWeight: 0.4,
    ctsMomentumWeight: 0.4,
    ctsVolumeWeight: 0.2,
    ctsMinRvol: 1.2,
  },
  indicators: {
    emaFast: 9,
    emaMid: 21,
    emaSlow: 50,
    emaMacro: 200,
    rsiPeriod: 14,
    rsiLongPullbackMin: 42,
    rsiLongPullbackMax: 58,
    rsiShortPullbackMin: 42,
    rsiShortPullbackMax: 58,
    adxPeriod: 14,
    adxMinTrend: 25,
    atrPeriod: 14,
    requireVwapAlignment: true,
    minVolumeExpansionMult: 1.5,
    volatilityAlertsEnabled: true,
    atrSpikePctThreshold: 0.45,
    atrExpansionRatioThreshold: 1.25,
    volatilityAlertCooldownSec: 60,
    minWarmupBars: 50,
    maxEmaMidExtensionAtr: 2.2,
    maxVwapExtensionAtr: 2.8,
    minCloseStrengthRatio: 0.55,
    minCandleBodyRatio: 0.3,
    requireRisingAdx: true,
    minDiSpread: 3.0,
    requireMacroEmaInScalping: true,
    maxSpreadBps: 20.0,
    donchianLookback: 20,
    atrExpansionFilterEnabled: false,
    atrExpansionMinRatio: 1.15,
    htfEmaPeriod: 200,
    obiLevels: 10,
    obiMinImbalance: 0.35,
  },
  exits: {
    atrSlMultiplier: 1.5,
    atrTp1Multiplier: 2.25,
    atrTp2Multiplier: 3.75,
    tp1CloseRatio: 0.5,
    breakEvenTriggerR: 1.0,
    breakEvenFeeBufferBps: 25,
    trailingActivationR: 1.2,
    atrTrailingMultiplier: 1.4,
  },
  risk: {
    maxDailyDrawdownPct: 3.0,
    maxPairDailyDrawdownPct: 1.25,
    maxDailyProfitPct: 5.0,
    maxWinStreak: 5,
    maxLoseStreak: 3,
    streakCooldownMinutes: 30,
    flattenOnCircuitBreaker: true,
    btcCrashGuardEnabled: true,
    btcCrashThresholdPct: 1.5,
    btcCrashWindowMinutes: 15,
    btcCrashMaxStalenessSec: 120,
  },
  automation: {
    enabled: true,
    strategyProfile: 'trend_pullback',
    directionPolicy: 'long_only',
    orderMethod: 'MARKET',
    limitOffsetBps: 5,
    timeInForce: 'GTC',
    signalCooldownBars: 2,
    autoOrderNotionalUsdt: 150,
    autoCloseOnExit: true,
    sessionWindows: structuredClone(DEFAULT_UTC_SESSION_WINDOWS),
    cancelPendingOnSignalReversal: true,
    cancelPendingOnExhaustion: true,
    maxPendingOrderBars: 6,
    maxPendingRunawayAtr: 1.8,
    applyDynamicCancelToManualOrders: false,
    exitPositionOnSignalReversal: true,
    tightenTrailingOnExhaustion: true,
    exhaustionMinProfitR: 1.0,
    exhaustionTrailFactor: 0.55,
    exhaustionRsiHigh: 76,
    exhaustionRsiLow: 24,
    autoFlipOnReversal: false,
  },
  features: {
    automatedTrading: true,
    manualTrading: true,
    signalGenerator: true,
    wsPrimaryFeed: true,
    restFallback: true,
    emaTrendFilter: true,
    rsiMomentumFilter: true,
    adxStrengthFilter: true,
    vwapBiasFilter: true,
    volumeConfirmationFilter: false,
    htfTrendFilter: false,
    obiEntryFilter: false,
    sessionWindowFilter: false,
    atrDynamicExits: true,
    takeProfitLadder: true,
    breakEvenStop: true,
    trailingStop: true,
    circuitBreaker: true,
    spotMarket: true,
    futuresMarket: true,
    gitAutoBackup: false,
  },
};

const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 91450,
  ETHUSDT: 3280,
  SOLUSDT: 214.5,
  BNBUSDT: 642.0,
  AVAXUSDT: 38.4,
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSeedCandles(symbol: string, count = 220, baseTimeMs = 1_763_280_000_000): Candle[] {
  const base = BASE_PRICES[symbol] ?? 100;
  const seed = symbol.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7);
  const rand = mulberry32(seed);
  const candles: Candle[] = [];

  let price = base * 0.975;
  for (let i = 0; i < count; i += 1) {
    // Realistic trend wave with periodic 2-3 bar pullbacks so ADX ~26-44 and RSI ~44-68
    const cycle = Math.sin(i / 8) * 0.0028 + Math.sin(i / 23) * 0.0014;
    const pullback = i % 11 === 0 || i % 11 === 1 ? -0.0032 : 0.00045;
    const noise = (rand() - 0.5) * 0.0056;
    const open = price;
    const close = Math.max(0.01, open * (1 + cycle + pullback + noise));
    const wickUp = Math.abs(rand()) * open * 0.0032;
    const wickDn = Math.abs(rand()) * open * 0.0032;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDn;
    const volume = (420 + rand() * 1100) * (base > 1000 ? 18 : 240);

    candles.push({
      openTimeMs: baseTimeMs - (count - i) * 300_000,
      open,
      high,
      low,
      close,
      volume,
      isClosed: true,
    });
    price = close;
  }

  return candles;
}

export class SimulationRuntime {
  public config: BotConfig;
  private riskManager: RiskManager;
  private pipelines = new Map<string, IndicatorPipeline>();
  private rngMap = new Map<string, () => number>();
  private lastSignalBarIndex = new Map<string, number>();
  private closedBarCounts = new Map<string, number>();
  private syncedLiveBalance: { free: number; locked: number } | null = null;
  private lastVolatilityAlertAtMs = new Map<string, number>();
  private trailingTightenFactor = new Map<string, number>();
  private reversalBypassCooldownSide = new Map<string, Side>();
  private watchlistDwellState: WatchlistDwellState = { enteredAtMs: new Map() };
  private htfTrends = new Map<string, { close: number; emaMacro: number; updatedAtMs: number }>();
  private obiBySymbol = new Map<string, number>();
  private lastScreenerTickers: MarketTicker24h[] = [];
  private tradableSymbolsSet = new Set<string>();
  private pendingLiveIntents: LiveAutoIntent[] = [];
  private pendingVolatilityAlerts: VolatilitySpikeAlert[] = [];
  private lastClockMs: number;
  private nextTradeSeq = 804120;
  private nextOrderSeq = 510940;
  public snapshot: EngineSnapshot;

  constructor(
    config: BotConfig = DEFAULT_BOT_CONFIG,
    nowMs = Date.now(),
    options?: {
      accountMode?: ExecutionAccountMode;
      seedDemoData?: boolean;
      initialEquityOverride?: number;
      environment?: 'Testnet' | 'Production';
    }
  ) {
    const accountMode: ExecutionAccountMode = options?.accountMode ?? 'Paper';
    const seedDemoData = options?.seedDemoData ?? accountMode === 'Paper';
    const env = options?.environment ?? 'Testnet';

    this.config = structuredClone(config);
    if (typeof options?.initialEquityOverride === 'number') {
      this.config.trading.initialEquityUsdt = options.initialEquityOverride;
    } else if (accountMode === 'Live') {
      this.config.trading.initialEquityUsdt = 0;
    }

    this.lastClockMs = nowMs;
    this.riskManager = new RiskManager(this.config.risk, this.config.trading, nowMs);

    const pairs: PairRuntimeState[] = [];
    for (const symbol of this.config.trading.pairs) {
      const candles = generateSeedCandles(symbol, 220, nowMs);
      const pipe = new IndicatorPipeline(this.config.indicators);
      const indicatorHistory = candles.map((c) => pipe.update(c));
      this.pipelines.set(symbol, pipe);
      const seed = symbol.split('').reduce((acc, ch) => acc * 37 + ch.charCodeAt(0), 19);
      this.rngMap.set(symbol, mulberry32(seed));

      const firstClose = candles[0]?.close ?? 1;
      const lastClose = candles[candles.length - 1]?.close ?? 1;

      pairs.push({
        symbol,
        candles,
        indicatorHistory,
        lastPrice: lastClose,
        change24hPct: ((lastClose - firstClose) / firstClose) * 100,
        dailyPnlUsdt: 0,
        dailyPnlPct: 0,
        indicators: pipe.snapshot(),
        openPosition: null,
        lastSignalNote: null,
        sourceTag: 'pinned',
        tradableOnActiveVenue: true,
        barsWarmedUp: candles.length,
      });
    }

    const recentTrades: ClosedTrade[] = [];
    const executionHistory: BinanceExecutionRecord[] = [];
    const feeRate = this.config.trading.takerFeeBps / 10_000;

    if (seedDemoData) {
      // Seed realistic initial Paper position & historical paper trades without touching Live
      const btcPair = pairs.find((p) => p.symbol === 'BTCUSDT');
      if (btcPair && btcPair.indicators.atr) {
        const entryPx = btcPair.lastPrice * 0.996;
        const plan = buildExitPlan('Long', entryPx, btcPair.indicators.atr, this.config.exits);
        const auth = this.riskManager.authorizeEntry('BTCUSDT', entryPx, plan.initialStopLoss, 0, nowMs);
        if (auth.ok) {
          const openedAt = nowMs - 900_000;
          const pos: Position = {
            id: 'BTCUSDT-paper-1',
            symbol: 'BTCUSDT',
            side: 'Long',
            entryPrice: entryPx,
            quantity: auth.quantity,
            remainingQuantity: auth.quantity,
            lockedMarginUsdt: entryPx * auth.quantity * 0.25,
            unrealizedPnlUsdt: (btcPair.lastPrice - entryPx) * auth.quantity,
            realizedPnlUsdt: 0,
            highestFavorablePrice: Math.max(entryPx, btcPair.lastPrice),
            exitPlan: plan,
            openedAtMs: openedAt,
            rationale: 'Paper EMA stack · ADX 29.4 (+DI > -DI) · RSI curl 46.2 → 50.8',
          };
          managePositionTick(pos, btcPair.lastPrice, btcPair.indicators.atr, this.config.exits);
          btcPair.openPosition = pos;
          btcPair.lastSignalNote = pos.rationale;

          const quoteQty = entryPx * auth.quantity;
          const ordId = this.nextOrderSeq++;
          const trdId = this.nextTradeSeq++;
          executionHistory.push({
            id: `exec-seed-btc-entry`,
            tradeId: trdId,
            orderId: ordId,
            orderListId: 21045,
            clientOrderId: `apex_BTCUSDT_${ordId}`,
            symbol: 'BTCUSDT',
            venue: this.config.trading.venue,
            environment: env,
            accountMode,
            lifecycle: 'ENTRY',
            side: 'Long',
            binanceSide: 'BUY',
            positionSide: 'BOTH',
            orderType: 'MARKET',
            uiOrderType: 'OCO SELL',
            execType: 'TRADE',
            orderStatus: 'FILLED',
            timeInForce: 'GTC',
            price: entryPx,
            entryPrice: entryPx,
            origQty: auth.quantity,
            executedQty: auth.quantity,
            cummulativeQuoteQty: quoteQty,
            commission: quoteQty * feeRate,
            commissionAsset: 'USDT',
            isMaker: false,
            leverage: this.effectiveLeverage(),
            marginType: this.config.trading.marginType,
            realizedPnlUsdt: null,
            rMultiple: null,
            exitReason: null,
            strategyRationale: pos.rationale,
            transactTime: openedAt,
          });
        }
      }

      const seedTrades: Array<{ sym: string; side: Side; pnl: number; r: number; reason: ClosedTrade['reason']; agoMs: number }> = [
        { sym: 'SOLUSDT', side: 'Long', pnl: 142.8, r: 1.9, reason: 'TakeProfit2', agoMs: 2_400_000 },
        { sym: 'ETHUSDT', side: 'Long', pnl: 68.4, r: 0.91, reason: 'TrailingStop', agoMs: 4_800_000 },
        { sym: 'AVAXUSDT', side: 'Short', pnl: -52.1, r: -0.7, reason: 'StopLoss', agoMs: 7_200_000 },
      ];
      for (let i = 0; i < seedTrades.length; i += 1) {
        const t = seedTrades[i];
        this.riskManager.recordRealizedPnl(t.sym, t.pnl, nowMs - t.agoMs);
        const pairObj = pairs.find((p) => p.symbol === t.sym);
        const px = pairObj?.lastPrice ?? 100;
        const entryPx = px * 0.994;
        const qty = 1.5;
        const closedAt = nowMs - t.agoMs;
        const openedAt = closedAt - 1_200_000;
        recentTrades.push({
          id: `paper-seed-${i}`,
          symbol: t.sym,
          side: t.side,
          entryPrice: entryPx,
          exitPrice: px,
          quantity: qty,
          pnlUsdt: t.pnl,
          rMultiple: t.r,
          reason: t.reason,
          closedAtMs: closedAt,
        });

        const exitOrdId = this.nextOrderSeq++;
        const exitTrdId = this.nextTradeSeq++;
        const exitQuote = px * qty;
        executionHistory.push({
          id: `exec-seed-exit-${i}`,
          tradeId: exitTrdId,
          orderId: exitOrdId,
          orderListId: t.reason === 'TakeProfit2' ? 21030 + i : -1,
          clientOrderId: `apex_exit_${t.sym}_${exitOrdId}`,
          symbol: t.sym,
          venue: this.config.trading.venue,
          environment: env,
          accountMode,
          lifecycle: 'EXIT',
          side: t.side,
          binanceSide: t.side === 'Long' ? 'SELL' : 'BUY',
          positionSide: 'BOTH',
          orderType:
            t.reason === 'TakeProfit2'
              ? 'LIMIT_MAKER'
              : 'STOP_LOSS_LIMIT',
          uiOrderType: t.side === 'Long' ? 'OCO SELL' : 'OCO BUY',
          execType: 'TRADE',
          orderStatus: 'FILLED',
          timeInForce: 'GTC',
          price: px,
          entryPrice: entryPx,
          origQty: qty,
          executedQty: qty,
          cummulativeQuoteQty: exitQuote,
          commission: exitQuote * (t.reason === 'TakeProfit2' ? feeRate * 0.5 : feeRate),
          commissionAsset: 'USDT',
          isMaker: t.reason === 'TakeProfit2',
          leverage: this.effectiveLeverage(),
          marginType: this.config.trading.marginType,
          realizedPnlUsdt: t.pnl,
          rMultiple: t.r,
          exitReason: t.reason,
          strategyRationale: `ATR Exit (${t.reason}) · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`,
          transactTime: closedAt,
        });

        const entOrdId = this.nextOrderSeq++;
        const entTrdId = this.nextTradeSeq++;
        const entQuote = entryPx * qty;
        executionHistory.push({
          id: `exec-seed-entry-${i}`,
          tradeId: entTrdId,
          orderId: entOrdId,
          orderListId: 21020 + i,
          clientOrderId: `apex_entry_${t.sym}_${entOrdId}`,
          symbol: t.sym,
          venue: this.config.trading.venue,
          environment: env,
          accountMode,
          lifecycle: 'ENTRY',
          side: t.side,
          binanceSide: t.side === 'Long' ? 'BUY' : 'SELL',
          positionSide: 'BOTH',
          orderType: 'MARKET',
          uiOrderType: t.side === 'Long' ? 'OCO SELL' : 'OCO BUY',
          execType: 'TRADE',
          orderStatus: 'FILLED',
          timeInForce: 'GTC',
          price: entryPx,
          entryPrice: entryPx,
          origQty: qty,
          executedQty: qty,
          cummulativeQuoteQty: entQuote,
          commission: entQuote * feeRate,
          commissionAsset: 'USDT',
          isMaker: false,
          leverage: this.effectiveLeverage(),
          marginType: this.config.trading.marginType,
          realizedPnlUsdt: null,
          rMultiple: null,
          exitReason: null,
          strategyRationale: `Multi-pair trend signal (${this.config.automation.strategyProfile})`,
          transactTime: openedAt,
        });
      }

      executionHistory.sort((a, b) => b.transactTime - a.transactTime);

      for (const p of pairs) {
        const pPnl = this.riskManager.getPairDailyPnl(p.symbol);
        p.dailyPnlUsdt = pPnl;
        p.dailyPnlPct = (pPnl / Math.max(this.config.trading.initialEquityUsdt, 1)) * 100;
      }
    }

    const initRisk = this.riskManager.status();
    const locked = pairs.reduce((s, p) => s + (p.openPosition?.lockedMarginUsdt ?? 0), 0);

    this.snapshot = {
      accountMode,
      running: accountMode === 'Paper',
      tickCount: 0,
      transport: {
        mode: 'WsPrimary',
        environment: env,
        venue: this.config.trading.venue,
        feedSource: accountMode === 'Live' ? 'BinanceLive' : 'Simulated',
        failoverCount: 0,
        lastWsAgeMs: 42,
        wsHeartbeatTimeoutMs: 4500,
        restPollIntervalMs: 1500,
        wsEndpoint: SimulationRuntime.resolveEndpoints(env, this.config.trading.venue).wsEndpoint,
        restEndpoint: SimulationRuntime.resolveEndpoints(env, this.config.trading.venue).restEndpoint,
      },
      risk: initRisk,
      lockedBalanceUsdt: locked,
      availableBalanceUsdt: Math.max(0, initRisk.currentEquity - locked),
      pnlHistory: seedDemoData ? [0, 24, 18, 46, 82, 61, 95, 118, 102, 134, 159.1] : [0],
      pairs,
      pendingOrders: [],
      recentTrades,
      executionHistory,
      volatilityAlerts: [],
      autoStats: {
        scansRun: 0,
        signalsDetected: 0,
        autoOrdersDispatched: 0,
        lastScanAtMs: null,
        lastActionSummary: null,
      },
      eventLog: [
        {
          id: `${accountMode.toLowerCase()}-boot-1`,
          timestampMs: nowMs,
          level: accountMode === 'Live' ? 'warn' : 'info',
          message:
            accountMode === 'Live'
              ? 'Isolated LIVE account initialized (disarmed — verify credentials before live order dispatch)'
              : 'Isolated PAPER account initialized ($10,000.00 virtual equity · zero live funds at risk)',
        },
      ],
    };
  }

  syncLiveAccountBalance(usdtFree: number, usdtLocked: number): void {
    const safeFree = Math.max(0, usdtFree);
    const safeLocked = Math.max(0, usdtLocked);
    const totalUsdt = safeFree + safeLocked;
    this.syncedLiveBalance = { free: safeFree, locked: safeLocked };
    this.config.trading.initialEquityUsdt = totalUsdt;
    this.riskManager.setEquityBaseline(totalUsdt);
    this.snapshot.risk = this.riskManager.status();
    this.snapshot.lockedBalanceUsdt = safeLocked;
    this.snapshot.availableBalanceUsdt = safeFree;
    this.pushLog(
      'info',
      `Synced live Binance USDT balance: Avbl $${safeFree.toFixed(2)} · Locked $${safeLocked.toFixed(2)}`
    );
  }

  syncExternalLiveTrades(records: BinanceExecutionRecord[]): number {
    let added = 0;
    for (const rec of records) {
      const exists = this.snapshot.executionHistory.some(
        (existing) => existing.tradeId === rec.tradeId && existing.symbol === rec.symbol
      );
      if (!exists) {
        this.snapshot.executionHistory.push(rec);
        added += 1;
      }
    }
    if (added > 0) {
      this.snapshot.executionHistory.sort((a, b) => b.transactTime - a.transactTime);
      this.snapshot.executionHistory = this.snapshot.executionHistory.slice(0, 120);
      this.pushLog(
        'info',
        `Synced ${added} execution fill${added === 1 ? '' : 's'} from Binance ${this.config.trading.venue} user trades`
      );
    }
    return added;
  }

  private recordEntryExecution(params: {
    symbol: string;
    side: 'Long' | 'Short';
    uiOrderType: ManualOrderInput['orderType'];
    price: number;
    quantity: number;
    timeInForce?: TimeInForce;
    isMaker?: boolean;
    rationale: string;
    nowMs: number;
    externalOrderId?: string;
    externalOcoListId?: number;
    externalCommission?: number;
  }): BinanceExecutionRecord {
    this.nextTradeSeq += 1;
    this.nextOrderSeq += 1;
    const tradeId = this.nextTradeSeq;
    const parsedExternalOrderId = params.externalOrderId ? Number(params.externalOrderId) : NaN;
    const orderId =
      Number.isFinite(parsedExternalOrderId) && parsedExternalOrderId > 0
        ? parsedExternalOrderId
        : this.nextOrderSeq;
    const venue = this.config.trading.venue;
    const isOco = params.uiOrderType === 'OCO SELL' || params.uiOrderType === 'OCO BUY';
    const isMaker =
      params.isMaker ?? (params.uiOrderType === 'LIMIT MAKER' || params.uiOrderType === 'LIMIT');
    const orderType: BinanceExecutionRecord['orderType'] =
      params.uiOrderType === 'LIMIT MAKER'
        ? 'LIMIT_MAKER'
        : params.uiOrderType === 'LIMIT'
          ? 'LIMIT'
          : 'MARKET';
    const quoteQty = Number((params.price * params.quantity).toFixed(2));
    const feeRate = this.getFeeRate(isMaker);
    const commission =
      params.externalCommission !== undefined &&
      Number.isFinite(params.externalCommission) &&
      params.externalCommission >= 0
        ? Number(params.externalCommission.toFixed(6))
        : Number((quoteQty * feeRate).toFixed(4));
    const resolvedListId =
      params.externalOcoListId !== undefined && params.externalOcoListId > 0
        ? params.externalOcoListId
        : isOco
          ? 44000 + (orderId % 5000)
          : -1;
    const rec: BinanceExecutionRecord = {
      id: `exec-entry-${tradeId}-${params.nowMs}`,
      tradeId,
      orderId,
      orderListId: resolvedListId,
      clientOrderId: `apex_entry_${params.symbol.toLowerCase()}_${orderId}`,
      symbol: params.symbol,
      venue,
      environment: this.snapshot.transport.environment,
      accountMode: this.snapshot.accountMode,
      lifecycle: 'ENTRY',
      side: params.side,
      binanceSide: params.side === 'Long' ? 'BUY' : 'SELL',
      positionSide: venue === 'Futures' ? 'BOTH' : 'LONG',
      orderType,
      uiOrderType: params.uiOrderType,
      execType: 'TRADE',
      orderStatus: 'FILLED',
      timeInForce: params.uiOrderType === 'LIMIT MAKER' ? 'GTX' : params.timeInForce ?? 'GTC',
      price: params.price,
      entryPrice: params.price,
      origQty: params.quantity,
      executedQty: params.quantity,
      cummulativeQuoteQty: quoteQty,
      commission,
      commissionAsset: 'USDT',
      isMaker,
      leverage: venue === 'Futures' ? this.effectiveLeverage() : 1,
      marginType: this.config.trading.marginType,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      strategyRationale: params.rationale,
      transactTime: params.nowMs,
    };
    this.snapshot.executionHistory.unshift(rec);
    this.snapshot.executionHistory = this.snapshot.executionHistory.slice(0, 120);
    return rec;
  }

  private recordExitExecution(params: {
    symbol: string;
    side: 'Long' | 'Short';
    entryPrice: number;
    exitPrice: number;
    origQty: number;
    executedQty: number;
    pnlUsdt: number;
    rMultiple: number;
    reason: ExitReason;
    isPartial?: boolean;
    rationale?: string;
    nowMs: number;
    externalOrderId?: string;
  }): BinanceExecutionRecord {
    this.nextTradeSeq += 1;
    this.nextOrderSeq += 1;
    const tradeId = this.nextTradeSeq;
    const parsedExternalOrderId = params.externalOrderId ? Number(params.externalOrderId) : NaN;
    const orderId =
      Number.isFinite(parsedExternalOrderId) && parsedExternalOrderId > 0
        ? parsedExternalOrderId
        : this.nextOrderSeq;
    const venue = this.config.trading.venue;
    const isTpExit = params.reason === 'TakeProfit1' || params.reason === 'TakeProfit2';
    const isSlExit =
      params.reason === 'StopLoss' ||
      params.reason === 'TrailingStop' ||
      params.reason === 'BreakEvenStop';
    const orderType: BinanceExecutionRecord['orderType'] = isTpExit
      ? venue === 'Futures'
        ? 'TAKE_PROFIT_MARKET'
        : 'TAKE_PROFIT_LIMIT'
      : isSlExit
        ? venue === 'Futures'
          ? 'STOP_MARKET'
          : 'STOP_LOSS_LIMIT'
        : 'MARKET';
    const isMaker = isTpExit && venue === 'Spot';
    const quoteQty = Number((params.exitPrice * params.executedQty).toFixed(2));
    const feeRate = this.getFeeRate(isMaker);
    const commission = Number((quoteQty * feeRate).toFixed(4));
    const rec: BinanceExecutionRecord = {
      id: `exec-exit-${tradeId}-${params.nowMs}`,
      tradeId,
      orderId,
      orderListId: isTpExit || isSlExit ? 44000 + (orderId % 5000) : -1,
      clientOrderId: `apex_exit_${params.symbol.toLowerCase()}_${orderId}`,
      symbol: params.symbol,
      venue,
      environment: this.snapshot.transport.environment,
      accountMode: this.snapshot.accountMode,
      lifecycle: 'EXIT',
      side: params.side,
      binanceSide: params.side === 'Long' ? 'SELL' : 'BUY',
      positionSide: venue === 'Futures' ? 'BOTH' : 'LONG',
      orderType,
      uiOrderType: isTpExit ? 'OCO SELL' : 'MARKET',
      execType: 'TRADE',
      orderStatus: params.isPartial ? 'PARTIALLY_FILLED' : 'FILLED',
      timeInForce: isMaker ? 'GTC' : 'IOC',
      price: params.exitPrice,
      entryPrice: params.entryPrice,
      origQty: params.origQty,
      executedQty: params.executedQty,
      cummulativeQuoteQty: quoteQty,
      commission,
      commissionAsset: 'USDT',
      isMaker,
      leverage: venue === 'Futures' ? this.effectiveLeverage() : 1,
      marginType: this.config.trading.marginType,
      realizedPnlUsdt: params.pnlUsdt,
      rMultiple: params.rMultiple,
      exitReason: params.reason,
      strategyRationale:
        params.rationale ??
        `${params.reason} exit fill (${params.isPartial ? 'Partial Scale-Out' : 'Full Close'}) @ $${params.exitPrice.toFixed(2)}`,
      transactTime: params.nowMs,
    };
    this.snapshot.executionHistory.unshift(rec);
    this.snapshot.executionHistory = this.snapshot.executionHistory.slice(0, 120);
    return rec;
  }

  private recordCanceledPendingExecution(
    pending: PendingOrder,
    reason: string,
    nowMs = Date.now()
  ): void {
    this.nextOrderSeq += 1;
    const parsedOrdId = pending.exchangeOrderId ? Number(pending.exchangeOrderId) : NaN;
    const orderId =
      Number.isFinite(parsedOrdId) && parsedOrdId > 0 ? parsedOrdId : this.nextOrderSeq;
    const venue = pending.venue ?? this.config.trading.venue;
    const qty = pending.limitPrice > 0 ? pending.usdtAmount / pending.limitPrice : 0;
    const rec: BinanceExecutionRecord = {
      id: `exec-cancel-${pending.id}-${nowMs}`,
      tradeId: 0,
      orderId,
      orderListId: -1,
      clientOrderId: `apex_cancel_${pending.symbol.toLowerCase()}_${orderId}`,
      symbol: pending.symbol,
      venue,
      environment: this.snapshot.transport.environment,
      accountMode: this.snapshot.accountMode,
      lifecycle: 'CANCEL',
      side: pending.side,
      binanceSide: pending.side === 'Long' ? 'BUY' : 'SELL',
      positionSide: venue === 'Futures' ? 'BOTH' : 'LONG',
      orderType: pending.orderMethod === 'LIMIT_MAKER' ? 'LIMIT_MAKER' : 'LIMIT',
      uiOrderType: pending.orderType,
      execType: 'TRADE',
      orderStatus: 'CANCELED',
      timeInForce: pending.timeInForce,
      price: pending.limitPrice,
      entryPrice: pending.limitPrice,
      origQty: qty,
      executedQty: 0,
      cummulativeQuoteQty: 0,
      commission: 0,
      commissionAsset: 'USDT',
      isMaker: pending.orderMethod === 'LIMIT_MAKER',
      leverage: venue === 'Futures' ? this.effectiveLeverage() : 1,
      marginType: this.config.trading.marginType,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: 'Canceled',
      strategyRationale: reason,
      transactTime: nowMs,
    };
    this.snapshot.executionHistory.unshift(rec);
    this.snapshot.executionHistory = this.snapshot.executionHistory.slice(0, 120);
  }

  recordExternalLiveOrder(
    input: ManualOrderInput,
    note: string,
    nowMs = Date.now(),
    fillDetails?: {
      executedQty?: number;
      avgPrice?: number;
      commission?: number;
      baseCommission?: number;
      commissionAsset?: string;
      orderId?: string;
      ocoOrderListId?: number;
      algoOrderIds?: string[];
    }
  ): void {
    const pair = this.snapshot.pairs.find((p) => p.symbol === input.symbol);
    if (!pair) return;
    const entryPrice =
      fillDetails?.avgPrice && fillDetails.avgPrice > 0 ? fillDetails.avgPrice : pair.lastPrice;
    const atr = pair.indicators.atr ?? entryPrice * 0.01;
    const slDist =
      input.stopLossMode === 'ATR' && this.config.features.atrDynamicExits
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct ?? 2.0) / 100);
    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const rawQty =
      fillDetails?.executedQty && fillDetails.executedQty > 0
        ? fillDetails.executedQty
        : input.usdtAmount / Math.max(entryPrice, 1e-9);
    const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'BNB', 'ETH', 'BTC'];
    const upperSym = input.symbol.toUpperCase();
    const matchedQuote = knownQuotes.find((q) => upperSym.length > q.length && upperSym.endsWith(q));
    const baseAsset = matchedQuote ? upperSym.slice(0, upperSym.length - matchedQuote.length) : upperSym;
    const commAssetUpper = fillDetails?.commissionAsset?.trim().toUpperCase();
    const baseCommissionDeducted =
      this.config.trading.venue === 'Spot'
        ? typeof fillDetails?.baseCommission === 'number' && fillDetails.baseCommission > 0
          ? fillDetails.baseCommission
          : commAssetUpper === baseAsset &&
              typeof fillDetails?.commission === 'number' &&
              fillDetails.commission > 0
            ? fillDetails.commission
            : 0
        : 0;
    const qty = rawQty;
    const remainingQuantity = Math.max(0, rawQty - baseCommissionDeducted);
    const cleanTargets: TakeProfitTarget[] = (Array.isArray(input.targets) ? input.targets : [])
      .filter((t) => t.pctOffset > 0 && t.allocationPct > 0)
      .map((t, idx) => ({
        id: `live-tp-${idx + 1}`,
        pctOffset: t.pctOffset,
        allocationPct: t.allocationPct,
        targetPrice:
          input.side === 'Long'
            ? entryPrice * (1 + t.pctOffset / 100)
            : entryPrice * (1 - t.pctOffset / 100),
        hit: false,
      }));
    const tp1 =
      cleanTargets[0]?.targetPrice ??
      (input.side === 'Long' ? entryPrice + slDist * 1.5 : entryPrice - slDist * 1.5);
    const tp2 =
      cleanTargets[cleanTargets.length - 1]?.targetPrice ??
      (input.side === 'Long' ? entryPrice + slDist * 2.5 : entryPrice - slDist * 2.5);

    const entryRec = this.recordEntryExecution({
      symbol: input.symbol,
      side: input.side,
      uiOrderType: input.orderType,
      price: entryPrice,
      quantity: qty,
      timeInForce: input.timeInForce,
      isMaker: input.orderType === 'LIMIT MAKER',
      rationale: note,
      nowMs,
      externalOrderId: fillDetails?.orderId,
      externalOcoListId: fillDetails?.ocoOrderListId,
      externalCommission: fillDetails?.commission,
    });

    const isUsdStableComm =
      !commAssetUpper ||
      commAssetUpper === 'USDT' ||
      commAssetUpper === 'USDC' ||
      commAssetUpper === 'FDUSD' ||
      commAssetUpper === 'BUSD' ||
      commAssetUpper === 'TUSD';
    let feePaidUsdt = entryRec.commission;
    if (baseCommissionDeducted > 0) {
      feePaidUsdt = baseCommissionDeducted * entryPrice;
    } else if (fillDetails?.commission !== undefined && fillDetails.commission > 0) {
      if (isUsdStableComm) {
        feePaidUsdt = fillDetails.commission;
      } else {
        const commPair = this.snapshot.pairs.find((p) => p.symbol === `${commAssetUpper}USDT`);
        feePaidUsdt =
          commPair && commPair.lastPrice > 0
            ? fillDetails.commission * commPair.lastPrice
            : entryRec.commission;
      }
    }

    pair.openPosition = {
      id: `${input.symbol}-live-${nowMs}`,
      symbol: input.symbol,
      side: input.side,
      entryPrice,
      quantity: qty,
      remainingQuantity,
      lockedMarginUsdt:
        this.config.trading.venue === 'Futures'
          ? (entryPrice * qty) / this.effectiveLeverage()
          : entryPrice * remainingQuantity,
      unrealizedPnlUsdt: 0,
      realizedPnlUsdt: 0,
      feePaidUsdt,
      commissionAsset: fillDetails?.commissionAsset ?? 'USDT',
      highestFavorablePrice: entryPrice,
      exitPlan: {
        initialStopLoss: initialSl,
        activeStopLoss: initialSl,
        takeProfit1: tp1,
        takeProfit2: tp2,
        tpTargets: cleanTargets.length > 0 ? cleanTargets : undefined,
        tp1Hit: false,
        breakEvenArmed: false,
        breakEvenEnabled: input.useBreakEven && this.config.features.breakEvenStop,
        trailingActive: false,
        trailingEnabled: input.useTrailingStop && this.config.features.trailingStop,
        riskDistanceR: slDist,
      },
      openedAtMs: nowMs,
      rationale: note,
      exchangeOrderId: fillDetails?.orderId,
      exchangeListId: fillDetails?.ocoOrderListId,
      exchangeAlgoIds: fillDetails?.algoOrderIds,
    };
    this.pushLog('info', note);
    this.syncRiskToSnapshot();
  }

  recordExternalLivePendingOrder(
    input: ManualOrderInput,
    limitPrice: number,
    exchangeOrderId: string | undefined,
    note: string,
    nowMs = Date.now(),
    source: 'auto' | 'manual' = 'manual'
  ): void {
    const pending: PendingOrder = {
      id: `${input.symbol}-live-lim-${nowMs}`,
      symbol: input.symbol,
      venue: this.config.trading.venue,
      side: input.side,
      orderType: input.orderType,
      orderMethod: input.orderType === 'LIMIT MAKER' ? 'LIMIT_MAKER' : 'LIMIT',
      usdtAmount: input.usdtAmount,
      limitPrice,
      timeInForce: input.timeInForce ?? 'GTC',
      stopLossMode: input.stopLossMode,
      stopLossPct: input.stopLossPct,
      useBreakEven: input.useBreakEven,
      useTrailingStop: input.useTrailingStop,
      targets: input.targets,
      createdAtMs: nowMs,
      exchangeOrderId,
      source,
      createdBarIndex: this.closedBarCounts.get(input.symbol) ?? 0,
    };
    this.snapshot.pendingOrders.unshift(pending);
    this.pushLog('info', note);
    this.syncRiskToSnapshot();
  }

  promoteExternalLivePendingOrder(
    pendingOrderId: string,
    fillPrice?: number,
    executedQty?: number,
    nowMs = Date.now()
  ): boolean {
    const idx = this.snapshot.pendingOrders.findIndex((o) => o.id === pendingOrderId);
    if (idx === -1) return false;
    const [pending] = this.snapshot.pendingOrders.splice(idx, 1);
    const resolvedPrice = fillPrice && fillPrice > 0 ? fillPrice : pending.limitPrice;
    const resolvedQty =
      executedQty && executedQty > 0
        ? executedQty
        : pending.usdtAmount / Math.max(resolvedPrice, 1e-6);

    this.recordExternalLiveOrder(
      {
        symbol: pending.symbol,
        orderType: pending.orderType,
        side: pending.side,
        usdtAmount: resolvedPrice * resolvedQty,
        limitPrice: pending.limitPrice,
        timeInForce: pending.timeInForce,
        stopLossMode: pending.stopLossMode,
        stopLossPct: pending.stopLossPct,
        useBreakEven: pending.useBreakEven,
        useTrailingStop: pending.useTrailingStop,
        targets: pending.targets,
      },
      `Live ${this.config.trading.venue} resting ${pending.orderType} filled @ $${resolvedPrice.toFixed(resolvedPrice >= 100 ? 2 : 4)}`,
      nowMs,
      {
        executedQty: resolvedQty,
        avgPrice: resolvedPrice,
        orderId: pending.exchangeOrderId,
      }
    );
    return true;
  }

  private static resolveEndpoints(
    env: 'Production' | 'Testnet',
    venue: ExchangeVenue
  ): { wsEndpoint: string; restEndpoint: string } {
    if (venue === 'Futures') {
      return env === 'Production'
        ? {
            wsEndpoint: 'wss://fstream.binance.com/stream',
            restEndpoint: 'https://fapi.binance.com/fapi/v1',
          }
        : {
            wsEndpoint: 'wss://stream.binancefuture.com/stream',
            restEndpoint: 'https://testnet.binancefuture.com/fapi/v1',
          };
    }
    return env === 'Production'
      ? {
          wsEndpoint: 'wss://stream.binance.com:9443/stream',
          restEndpoint: 'https://api.binance.com/api/v3',
        }
      : {
          wsEndpoint: 'wss://stream.testnet.binance.vision/stream',
          restEndpoint: 'https://testnet.binance.vision/api/v3',
        };
  }

  setEnvironment(env: 'Production' | 'Testnet'): void {
    this.snapshot.transport.environment = env;
    const ep = SimulationRuntime.resolveEndpoints(env, this.config.trading.venue);
    this.snapshot.transport.wsEndpoint = ep.wsEndpoint;
    this.snapshot.transport.restEndpoint = ep.restEndpoint;
    this.pushLog('info', `Switched Binance ${this.config.trading.venue} SDK environment to ${env}`);
  }

  setVenue(venue: ExchangeVenue): void {
    this.config.trading.venue = venue;
    this.snapshot.transport.venue = venue;
    const ep = SimulationRuntime.resolveEndpoints(this.snapshot.transport.environment, venue);
    this.snapshot.transport.wsEndpoint = ep.wsEndpoint;
    this.snapshot.transport.restEndpoint = ep.restEndpoint;
    if (venue === 'Spot') {
      this.config.automation.directionPolicy = 'long_only';
      this.config.automation.autoFlipOnReversal = false;
    } else if (venue === 'Futures' && this.config.automation.directionPolicy === 'long_only') {
      this.config.automation.directionPolicy = 'both';
    }
    this.pushLog(
      'info',
      `Switched execution venue to Binance ${venue}${venue === 'Futures' ? ` (${this.effectiveLeverage()}x ${this.config.trading.marginType})` : ' (Long-Only Enforced)'}`
    );
  }

  setTimeframe(tf: Timeframe): void {
    this.config.trading.timeframe = tf;
    this.pushLog('info', `Switched primary stream interval to ${tf}`);
  }

  consumeLiveIntents(): LiveAutoIntent[] {
    const out = this.pendingLiveIntents.slice();
    this.pendingLiveIntents = [];
    return out;
  }

  confirmLiveAutoDispatch(summary: string): void {
    this.snapshot.autoStats.autoOrdersDispatched += 1;
    this.snapshot.autoStats.lastActionSummary = summary;
    this.syncRiskToSnapshot();
  }

  reportLiveAutoRejected(summary: string): void {
    this.snapshot.autoStats.lastActionSummary = summary;
    this.pushLog('warn', summary);
    this.syncRiskToSnapshot();
  }

  consumePendingVolatilityAlerts(): VolatilitySpikeAlert[] {
    const out = this.pendingVolatilityAlerts.slice();
    this.pendingVolatilityAlerts = [];
    return out;
  }

  private evaluatePairVolatilitySpike(
    pair: PairRuntimeState,
    candle: Candle,
    prevClose: number,
    nowMs: number,
    forceTrigger = false
  ): VolatilitySpikeAlert | null {
    if (this.config.indicators.volatilityAlertsEnabled === false) {
      return null;
    }
    const atr = pair.indicators.atr;
    if (atr === null || atr <= 0 || pair.lastPrice <= 0) {
      return null;
    }

    const cooldownMs = Math.max(0, (this.config.indicators.volatilityAlertCooldownSec ?? 60) * 1000);
    const lastAlertMs = this.lastVolatilityAlertAtMs.get(pair.symbol) ?? -1e15;
    if (!forceTrigger && nowMs - lastAlertMs < cooldownMs) {
      return null;
    }

    const prevAtrValues = pair.indicatorHistory
      .slice(-12, -1)
      .map((h) => h.atr)
      .filter((v): v is number => v !== null && v > 0);
    const baselineAtr =
      prevAtrValues.length > 0
        ? prevAtrValues.reduce((acc, v) => acc + v, 0) / prevAtrValues.length
        : atr;

    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
    const atrPctOfPrice = (atr / pair.lastPrice) * 100;
    const candleRangePct = (trueRange / pair.lastPrice) * 100;
    const atrExpansionRatio =
      baselineAtr > 0 ? Math.max(atr / baselineAtr, trueRange / baselineAtr) : 1.0;

    const pctThreshold = this.config.indicators.atrSpikePctThreshold ?? 0.45;
    const ratioThreshold = this.config.indicators.atrExpansionRatioThreshold ?? 1.25;

    const spikeDetected =
      forceTrigger ||
      (atrPctOfPrice >= pctThreshold && atrExpansionRatio >= ratioThreshold) ||
      atrExpansionRatio >= ratioThreshold * 1.18;

    if (!spikeDetected) {
      return null;
    }

    this.lastVolatilityAlertAtMs.set(pair.symbol, nowMs);
    const severity: VolatilitySpikeAlert['severity'] =
      atrExpansionRatio >= ratioThreshold * 1.35 || atrPctOfPrice >= pctThreshold * 1.4
        ? 'extreme'
        : 'elevated';

    const decimals = pair.lastPrice >= 100 ? 2 : 4;
    const alert: VolatilitySpikeAlert = {
      id: `vol-spike-${pair.symbol}-${nowMs}-${Math.random().toString(36).slice(2, 6)}`,
      symbol: pair.symbol,
      price: pair.lastPrice,
      atr,
      atrPctOfPrice,
      atrExpansionRatio,
      candleRangePct,
      severity,
      message: `[ATR VOLATILITY SPIKE] ${pair.symbol} @ $${pair.lastPrice.toFixed(decimals)} · ATR $${atr.toFixed(decimals)} (${atrPctOfPrice.toFixed(2)}% of price · ${atrExpansionRatio.toFixed(2)}× expansion)`,
      timestampMs: nowMs,
    };

    if (!this.snapshot.volatilityAlerts) {
      this.snapshot.volatilityAlerts = [];
    }
    this.snapshot.volatilityAlerts.unshift(alert);
    this.snapshot.volatilityAlerts = this.snapshot.volatilityAlerts.slice(0, 25);
    this.pendingVolatilityAlerts.push(alert);
    this.pushLog('alert', alert.message);
    return alert;
  }

  simulateVolatilitySpike(symbol = 'BTCUSDT', nowMs = Date.now()): VolatilitySpikeAlert | null {
    if (this.config.indicators.volatilityAlertsEnabled === false) {
      this.pushLog('warn', 'Volatility spike test skipped: ATR Volatility Alerts are disabled.');
      return null;
    }
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol) ?? this.snapshot.pairs[0];
    if (!pair) return null;

    const prev = pair.candles[pair.candles.length - 1];
    const baseAtr = pair.indicators.atr ?? prev.close * 0.006;
    const open = prev.close;
    const close = open + baseAtr * 1.85;
    const high = close + baseAtr * 0.65;
    const low = open - baseAtr * 0.45;
    const spikeCandle: Candle = {
      openTimeMs: prev.openTimeMs + 300_000,
      open,
      high,
      low,
      close,
      volume: prev.volume * 2.15,
      isClosed: true,
    };

    const pipe = this.pipelines.get(pair.symbol)!;
    const nextInd = pipe.update(spikeCandle);
    pair.candles = [...pair.candles.slice(-219), spikeCandle];
    pair.indicatorHistory = [...pair.indicatorHistory.slice(-219), nextInd];
    pair.indicators = nextInd;
    pair.lastPrice = spikeCandle.close;
    const firstClose = pair.candles[0]?.close ?? spikeCandle.close;
    pair.change24hPct = ((spikeCandle.close - firstClose) / firstClose) * 100;

    const alert = this.evaluatePairVolatilitySpike(pair, spikeCandle, prev.close, nowMs, true);
    this.syncRiskToSnapshot();
    return alert;
  }

  cancelPendingOrder(orderId: string, reason?: string, nowMs = this.lastClockMs): boolean {
    const idx = this.snapshot.pendingOrders.findIndex((o) => o.id === orderId);
    if (idx === -1) return false;
    const [removed] = this.snapshot.pendingOrders.splice(idx, 1);
    const note =
      reason?.trim() ||
      `Cancelled resting ${removed.orderType} order on ${removed.symbol} @ $${removed.limitPrice.toFixed(2)}`;
    this.recordCanceledPendingExecution(removed, note, nowMs);
    this.pushLog('info', note);
    this.syncRiskToSnapshot();
    return true;
  }

  confirmLivePendingCanceled(pendingOrderId: string, reason: string, nowMs = Date.now()): boolean {
    return this.cancelPendingOrder(pendingOrderId, reason, nowMs);
  }

  private settleClosedExit(params: {
    pair: PairRuntimeState;
    pos: Position;
    closeQty: number;
    exitPrice: number;
    reason: ExitReason;
    isPartial: boolean;
    isMakerExit: boolean;
    rationale: string;
    logLevel?: 'info' | 'warn' | 'alert';
    logMessage?: string;
    tradeIdSuffix: string;
    nowMs: number;
    externalOrderId?: string;
  }): { pnl: number; rMult: number } {
    const { pair, pos, exitPrice, reason, isPartial, isMakerExit, nowMs } = params;
    const closeQty = Math.min(pos.remainingQuantity, Math.max(0, params.closeQty));
    const grossPnl =
      pos.side === 'Long'
        ? (exitPrice - pos.entryPrice) * closeQty
        : (pos.entryPrice - exitPrice) * closeQty;
    const entryFeePortion = (pos.feePaidUsdt ?? 0) * (closeQty / Math.max(pos.quantity, 1e-9));
    const exitFee = this.computeExitCommission(exitPrice, closeQty, isMakerExit);
    const pnl = grossPnl - entryFeePortion - exitFee;
    const rMult = pnl / Math.max(pos.exitPlan.riskDistanceR * closeQty, 1e-9);

    this.riskManager.recordRealizedPnl(pair.symbol, pnl, nowMs);
    this.snapshot.recentTrades.unshift({
      id: `${pos.id}-${params.tradeIdSuffix}`,
      symbol: pair.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason,
      closedAtMs: nowMs,
    });
    this.snapshot.recentTrades = this.snapshot.recentTrades.slice(0, 60);
    this.recordExitExecution({
      symbol: pair.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      origQty: pos.quantity,
      executedQty: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason,
      isPartial,
      rationale: params.rationale,
      nowMs,
      externalOrderId: params.externalOrderId,
    });

    if (isPartial && pos.remainingQuantity - closeQty > 1e-9) {
      pos.remainingQuantity -= closeQty;
      pos.realizedPnlUsdt += pnl;
    } else {
      pair.openPosition = null;
    }

    if (params.logMessage) {
      this.pushLog(params.logLevel ?? 'info', params.logMessage);
    }
    return { pnl, rMult };
  }

  recordExternalLiveExit(
    symbol: string,
    closeRatio: number,
    exitPrice: number,
    reason: ClosedTrade['reason'],
    note: string,
    nowMs = Date.now(),
    externalOrderId?: string,
    executedQtyOverride?: number
  ): void {
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol);
    if (!pair?.openPosition) return;
    const pos = pair.openPosition;
    const ratio = Math.min(1, Math.max(0.05, closeRatio));
    const closeQty =
      typeof executedQtyOverride === 'number' && Number.isFinite(executedQtyOverride) && executedQtyOverride > 0
        ? Math.min(pos.remainingQuantity, executedQtyOverride)
        : ratio >= 0.999
          ? pos.remainingQuantity
          : pos.remainingQuantity * ratio;
    const isPartial = ratio < 0.999 && pos.remainingQuantity - closeQty > 1e-9;
    if (reason === 'TakeProfit1') {
      pos.exitPlan.tp1Hit = true;
      if (pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0) {
        const nextUnhit = pos.exitPlan.tpTargets.find((t) => !t.hit);
        if (nextUnhit) {
          nextUnhit.hit = true;
        }
      }
      if (isPartial) {
        pos.exchangeListId = undefined;
      }
    }
    this.settleClosedExit({
      pair,
      pos,
      closeQty,
      exitPrice,
      reason,
      isPartial,
      isMakerExit: reason === 'TakeProfit1' || reason === 'TakeProfit2',
      rationale: note,
      logLevel: 'info',
      logMessage: note,
      tradeIdSuffix: `live-exit-${nowMs}`,
      nowMs,
      externalOrderId,
    });
    this.syncRiskToSnapshot();
  }

  authorizeManualEntry(
    symbol: string,
    entryPrice: number,
    stopLossPrice: number,
    nowMs = Date.now()
  ): { ok: true } | { ok: false; reason: string } {
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol);
    if (!pair) return { ok: false, reason: `Unknown pair ${symbol}` };
    if (pair.openPosition) return { ok: false, reason: `${symbol} already has an open position` };
    if (!this.config.features.circuitBreaker) return { ok: true };
    const openCount =
      this.snapshot.pairs.filter((p) => p.openPosition !== null).length +
      this.snapshot.pendingOrders.length;
    const auth = this.riskManager.authorizeEntry(symbol, entryPrice, stopLossPrice, openCount, nowMs);
    return auth.ok ? { ok: true } : { ok: false, reason: auth.reason };
  }

  submitManualOrder(
    input: ManualOrderInput,
    nowMs = this.lastClockMs
  ): { ok: true; position?: Position; pendingOrder?: PendingOrder } | { ok: false; reason: string } {
    if (!this.config.features.manualTrading) {
      return { ok: false, reason: 'Manual order execution is disabled in Feature Toggles.' };
    }
    const activeVenue = this.config.trading.venue;
    if (activeVenue === 'Spot' && !this.config.features.spotMarket) {
      return { ok: false, reason: 'Binance Spot market trading is toggled off in Feature Toggles.' };
    }
    if (activeVenue === 'Futures' && !this.config.features.futuresMarket) {
      return { ok: false, reason: 'Binance Futures market trading is toggled off in Feature Toggles.' };
    }
    if (activeVenue === 'Spot' && input.side === 'Short' && !input.reduceOnly) {
      return {
        ok: false,
        reason: 'Short entries are disabled on Binance Spot (Long-Only). Switch venue to USD-M Futures for Short orders.',
      };
    }

    const pair = this.snapshot.pairs.find((p) => p.symbol === input.symbol);
    if (!pair) {
      return { ok: false, reason: `Unknown pair ${input.symbol}` };
    }
    if (!Number.isFinite(input.usdtAmount) || input.usdtAmount <= 0) {
      return { ok: false, reason: 'Order allocation must be greater than $0' };
    }

    if (input.reduceOnly) {
      const existing = pair.openPosition;
      if (!existing) {
        return { ok: false, reason: `No open position to reduce on ${input.symbol}` };
      }
      const isOppositeDirection =
        (existing.side === 'Long' && input.side === 'Short') ||
        (existing.side === 'Short' && input.side === 'Long');
      if (!isOppositeDirection) {
        return {
          ok: false,
          reason: `Reduce-Only order on ${input.symbol} must be opposite to open ${existing.side} position`,
        };
      }
      const isLimitOrder = input.orderType === 'LIMIT' || input.orderType === 'LIMIT MAKER';
      const exitPx =
        isLimitOrder && typeof input.limitPrice === 'number' && input.limitPrice > 0
          ? input.limitPrice
          : pair.lastPrice;
      const requestedQty = exitPx > 0 ? input.usdtAmount / exitPx : existing.remainingQuantity;
      const closeQty = Math.min(existing.remainingQuantity, Math.max(0, requestedQty));
      const isPartial = existing.remainingQuantity - closeQty > 1e-9;
      this.settleClosedExit({
        pair,
        pos: existing,
        closeQty,
        exitPrice: exitPx,
        reason: 'ManualClose',
        isPartial,
        isMakerExit: input.orderType === 'LIMIT MAKER',
        rationale: `Manual Reduce-Only ${input.orderType} on ${input.symbol} @ $${exitPx.toFixed(pricePrecisionDecimals(exitPx))}`,
        tradeIdSuffix: 'reduce',
        nowMs,
      });
      this.syncRiskToSnapshot();
      return { ok: true, position: pair.openPosition ?? undefined };
    }

    if (pair.openPosition) {
      return { ok: false, reason: `${input.symbol} already has an open position` };
    }

    const isLimitOrder = input.orderType === 'LIMIT' || input.orderType === 'LIMIT MAKER';
    const requestedLimit =
      isLimitOrder && typeof input.limitPrice === 'number' && input.limitPrice > 0
        ? input.limitPrice
        : pair.lastPrice;

    if (input.orderType === 'LIMIT MAKER') {
      const crossesBook =
        input.side === 'Long'
          ? requestedLimit >= pair.lastPrice
          : requestedLimit <= pair.lastPrice;
      if (crossesBook) {
        return {
          ok: false,
          reason: `LIMIT MAKER (Post-Only) would cross market ($${pair.lastPrice.toFixed(2)}). Set a passive limit price.`,
        };
      }
    }

    const entryPrice = isLimitOrder ? requestedLimit : pair.lastPrice;
    const atr = pair.indicators.atr ?? entryPrice * 0.01;
    const slDist =
      input.stopLossMode === 'ATR' && this.config.features.atrDynamicExits
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct) / 100);

    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const openCount =
      this.snapshot.pairs.filter((p) => p.openPosition !== null).length +
      this.snapshot.pendingOrders.length;
    if (openCount >= this.config.trading.maxConcurrentPositions) {
      const reason = 'Max concurrent positions reached';
      this.pushLog('warn', `Manual order rejected (${input.symbol}): ${reason}`);
      return { ok: false, reason };
    }
    if (this.config.features.circuitBreaker) {
      const auth = this.riskManager.authorizeEntry(input.symbol, entryPrice, initialSl, openCount, nowMs);
      if (!auth.ok) {
        this.pushLog('warn', `Manual order rejected (${input.symbol}): ${auth.reason}`);
        return { ok: false, reason: auth.reason };
      }
    }

    const leverage = activeVenue === 'Futures' ? this.effectiveLeverage() : 1;
    const maxNotionalAllowed = this.snapshot.availableBalanceUsdt * leverage;
    const cappedUsdt = Math.min(input.usdtAmount, maxNotionalAllowed);
    if (cappedUsdt <= 1) {
      return { ok: false, reason: 'Insufficient available USDT balance' };
    }

    const shouldRestLimit =
      input.orderType === 'LIMIT MAKER' ||
      (isLimitOrder &&
        (input.side === 'Long'
          ? requestedLimit < pair.lastPrice * 0.9999
          : requestedLimit > pair.lastPrice * 1.0001));

    const tif = input.timeInForce ?? 'GTC';
    if (shouldRestLimit && isLimitOrder && input.orderType === 'LIMIT' && (tif === 'IOC' || tif === 'FOK')) {
      const reason = `${tif} LIMIT order on ${input.symbol} ($${requestedLimit.toFixed(2)}) did not cross market immediately ($${pair.lastPrice.toFixed(2)}) and expired.`;
      this.pushLog('warn', reason);
      return { ok: false, reason };
    }

    if (shouldRestLimit) {
      const pending: PendingOrder = {
        id: `${input.symbol}-lim-${nowMs}`,
        symbol: input.symbol,
        venue: this.config.trading.venue,
        side: input.side,
        orderType: input.orderType,
        orderMethod: input.orderType === 'LIMIT MAKER' ? 'LIMIT_MAKER' : 'LIMIT',
        usdtAmount: cappedUsdt,
        limitPrice: requestedLimit,
        timeInForce: tif,
        stopLossMode: input.stopLossMode ?? 'MARKET',
        stopLossPct: input.stopLossPct ?? 2.0,
        useBreakEven: input.useBreakEven ?? true,
        useTrailingStop: input.useTrailingStop ?? true,
        targets: Array.isArray(input.targets) ? input.targets : [],
        createdAtMs: nowMs,
        source: 'manual',
        createdBarIndex: this.closedBarCounts.get(input.symbol) ?? 0,
      };
      this.snapshot.pendingOrders.unshift(pending);
      this.pushLog(
        'info',
        `Resting ${input.orderType} (${pending.timeInForce}) ${input.symbol} ${input.side} $${cappedUsdt.toFixed(2)} @ $${requestedLimit.toFixed(2)}`
      );
      this.syncRiskToSnapshot();
      return { ok: true, pendingOrder: pending };
    }

    const fillPrice = pair.lastPrice;
    const pos = this.openPositionFromInput(pair, input, fillPrice, cappedUsdt, nowMs, false);
    this.syncRiskToSnapshot();
    return { ok: true, position: pos };
  }

  private getFeeRate(isMaker: boolean): number {
    const takerRate = Math.max(0, this.config.trading.takerFeeBps) / 10_000;
    if (this.config.trading.venue === 'Futures') {
      const futuresTaker = takerRate > 0 ? takerRate * 0.4 : 0.0004;
      return isMaker ? futuresTaker * 0.5 : futuresTaker;
    }
    return isMaker ? takerRate * 0.75 : takerRate;
  }

  private computeExitCommission(exitPrice: number, closeQty: number, isMakerExit: boolean): number {
    return Number((exitPrice * closeQty * this.getFeeRate(isMakerExit)).toFixed(4));
  }

  private openPositionFromInput(
    pair: PairRuntimeState,
    input: ManualOrderInput,
    entryPrice: number,
    cappedUsdt: number,
    nowMs: number,
    isMakerFill = false
  ): Position {
    const atr = pair.indicators.atr ?? entryPrice * 0.01;
    const slDist =
      input.stopLossMode === 'ATR' && this.config.features.atrDynamicExits
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct ?? 2.0) / 100);
    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const quantity = cappedUsdt / Math.max(entryPrice, 1e-9);

    const cleanTargets: TakeProfitTarget[] = (Array.isArray(input.targets) ? input.targets : [])
      .filter((t) => t.pctOffset > 0 && t.allocationPct > 0)
      .map((t, idx) => ({
        id: `tp-${idx + 1}`,
        pctOffset: t.pctOffset,
        allocationPct: t.allocationPct,
        targetPrice:
          input.side === 'Long'
            ? entryPrice * (1 + t.pctOffset / 100)
            : entryPrice * (1 - t.pctOffset / 100),
        hit: false,
      }));

    const tp1Price =
      cleanTargets[0]?.targetPrice ??
      (input.side === 'Long' ? entryPrice + slDist * 1.5 : entryPrice - slDist * 1.5);
    const tp2Price =
      cleanTargets[cleanTargets.length - 1]?.targetPrice ??
      (input.side === 'Long' ? entryPrice + slDist * 2.5 : entryPrice - slDist * 2.5);

    const rationale = `${this.config.trading.venue === 'Futures' ? `FUTURES ${this.effectiveLeverage()}x · ` : ''}${input.orderType} · $${cappedUsdt.toFixed(2)} · ${cleanTargets.length || 2} TP targets`;
    const entryRec = this.recordEntryExecution({
      symbol: input.symbol,
      side: input.side,
      uiOrderType: input.orderType,
      price: entryPrice,
      quantity,
      timeInForce: input.timeInForce,
      isMaker: isMakerFill || input.orderType === 'LIMIT MAKER',
      rationale,
      nowMs,
    });

    const pos: Position = {
      id: `${input.symbol}-ord-${nowMs}`,
      symbol: input.symbol,
      side: input.side,
      entryPrice,
      quantity,
      remainingQuantity: quantity,
      lockedMarginUsdt:
        this.config.trading.venue === 'Futures'
          ? cappedUsdt / this.effectiveLeverage()
          : cappedUsdt,
      unrealizedPnlUsdt: 0,
      realizedPnlUsdt: 0,
      feePaidUsdt: entryRec.commission,
      highestFavorablePrice: entryPrice,
      exitPlan: {
        initialStopLoss: initialSl,
        activeStopLoss: initialSl,
        takeProfit1: tp1Price,
        takeProfit2: tp2Price,
        tpTargets: cleanTargets.length > 0 ? cleanTargets : undefined,
        tp1Hit: false,
        breakEvenArmed: false,
        breakEvenEnabled: input.useBreakEven && this.config.features.breakEvenStop,
        trailingActive: false,
        trailingEnabled: input.useTrailingStop && this.config.features.trailingStop,
        riskDistanceR: slDist,
      },
      openedAtMs: nowMs,
      rationale,
    };

    pair.openPosition = pos;
    pair.lastSignalNote = pos.rationale;
    this.pushLog(
      'info',
      `Filled ${input.orderType} (${input.side}) ${input.symbol} $${cappedUsdt.toFixed(2)} @ $${entryPrice.toFixed(2)}`
    );
    return pos;
  }

  closePositionBySymbol(symbol: string, nowMs = this.lastClockMs): void {
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol);
    if (!pair?.openPosition) return;
    const pos = pair.openPosition;
    const { pnl } = this.settleClosedExit({
      pair,
      pos,
      closeQty: pos.remainingQuantity,
      exitPrice: pair.lastPrice,
      reason: 'ManualClose',
      isPartial: false,
      isMakerExit: false,
      rationale: `Operator manual MARKET close on ${symbol} @ $${pair.lastPrice.toFixed(2)}`,
      tradeIdSuffix: 'manual',
      nowMs,
    });
    this.pushLog('info', `Closed ${symbol} manually (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);
    this.syncRiskToSnapshot();
  }

  /** Leverage after the configurable hard ceiling; never exceeds 20. */
  effectiveLeverage(): number {
    const ceiling = Math.max(1, Math.min(20, Math.round(this.config.trading.maxLeverage ?? 3)));
    const requested = Math.max(1, Math.round(Number(this.config.trading.leverage) || 1));
    return Math.min(ceiling, requested);
  }

  /** Stores the latest closed 1h trend read used by the HTF entry gate. */
  setHtfTrend(symbol: string, close: number, emaMacro: number, updatedAtMs = Date.now()): void {
    const clean = symbol.trim().toUpperCase();
    if (!clean || !Number.isFinite(close) || !Number.isFinite(emaMacro) || close <= 0 || emaMacro <= 0) {
      return;
    }
    this.htfTrends.set(clean, { close, emaMacro, updatedAtMs });
  }

  getHtfTrend(symbol: string): { close: number; emaMacro: number; updatedAtMs: number } | null {
    return this.htfTrends.get(symbol.trim().toUpperCase()) ?? null;
  }

  /** Stores the latest depth-10 order-book imbalance in [-1, 1]. */
  updateOrderBookImbalance(symbol: string, obi: number): void {
    const clean = symbol.trim().toUpperCase();
    if (!clean || !Number.isFinite(obi)) return;
    const pair = this.snapshot.pairs.find((p) => p.symbol === clean);
    const bounded = Math.max(-1, Math.min(1, obi));
    this.obiBySymbol.set(clean, bounded);
    if (pair) {
      pair.indicators = { ...pair.indicators, obi: bounded };
    }
  }

  /** Feeds a BTCUSDT reference price into the risk crash guard. */
  setBtcReferencePrice(price: number, nowMs = Date.now()): void {
    this.riskManager.observeBtcPrice(price, nowMs);
  }

  private decorateIndicators(symbol: string, ind: PairRuntimeState['indicators']): PairRuntimeState['indicators'] {
    const htf = this.htfTrends.get(symbol);
    return {
      ...ind,
      htfClose: htf?.close ?? null,
      htfEmaMacro: htf?.emaMacro ?? null,
      obi: this.obiBySymbol.get(symbol) ?? null,
    };
  }

  updatePairBookTicker(symbol: string, bestBid: number, bestAsk: number): void {
    const clean = symbol.trim().toUpperCase();
    const pair = this.snapshot.pairs.find((p) => p.symbol === clean);
    if (!pair || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) return;
    const mid = (bestBid + bestAsk) * 0.5;
    pair.bestBid = bestBid;
    pair.bestAsk = bestAsk;
    pair.spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;
  }

  hydrateSymbolCandles(
    symbol: string,
    candles: Candle[],
    options?: { resetPipeline?: boolean }
  ): void {
    const clean = symbol.trim().toUpperCase();
    const pair = this.snapshot.pairs.find((p) => p.symbol === clean);
    if (!pair || candles.length === 0) return;

    const sorted = candles
      .slice()
      .sort((a, b) => a.openTimeMs - b.openTimeMs)
      .slice(-240);
    const pipe =
      options?.resetPipeline !== false
        ? new IndicatorPipeline(this.config.indicators)
        : this.pipelines.get(clean) ?? new IndicatorPipeline(this.config.indicators);

    const hist: PairRuntimeState['indicatorHistory'] = [];
    let closedCount = 0;
    let prevOpenMs: number | null = null;
    for (const c of sorted) {
      if (c.isClosed) {
        const gap = hasCandleSequenceGap(prevOpenMs, c.openTimeMs, this.config.trading.timeframe);
        hist.push(pipe.update(c, gap));
        prevOpenMs = c.openTimeMs;
        closedCount += 1;
      } else {
        hist.push(pipe.snapshot());
      }
    }
    this.pipelines.set(clean, pipe);
    this.closedBarCounts.set(clean, closedCount);
    const firstClose = sorted[0]?.close ?? pair.lastPrice;
    const latestClose = sorted[sorted.length - 1]?.close ?? pair.lastPrice;
    pair.candles = sorted;
    pair.indicatorHistory = hist;
    pair.indicators = pipe.snapshot();
    pair.barsWarmedUp = pipe.snapshot().warmupBarsCount ?? closedCount;
    if (latestClose > 0) {
      pair.lastPrice = latestClose;
      pair.change24hPct = firstClose > 0 ? ((latestClose - firstClose) / firstClose) * 100 : 0;
    }
  }

  syncWatchlistPairs(
    screenerTickers: MarketTicker24h[] = this.lastScreenerTickers,
    tradableSymbols: string[] = Array.from(this.tradableSymbolsSet),
    nowMs = Date.now()
  ): { addedSymbols: string[]; removedSymbols: string[]; activeSymbols: string[] } {
    if (screenerTickers.length > 0) {
      this.lastScreenerTickers = screenerTickers;
    }
    if (tradableSymbols.length > 0) {
      this.tradableSymbolsSet = new Set(tradableSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean));
    }
    const mode = this.config.trading.pairSelectionMode ?? 'hybrid';
    const pinnedPairs = normalizeSymbolList(this.config.trading.pairs, []);
    const protectedSymbols = Array.from(
      new Set([
        ...this.snapshot.pairs.filter((p) => p.openPosition !== null).map((p) => p.symbol),
        ...this.snapshot.pendingOrders.map((o) => o.symbol),
      ])
    );
    const currentTrending = this.snapshot.pairs
      .filter((p) => p.sourceTag === 'trending')
      .map((p) => p.symbol);

    const resolved = resolveEffectiveWatchlist({
      mode,
      pinnedPairs,
      trendingTickers: this.lastScreenerTickers,
      protectedSymbols,
      currentlyActiveTrending: currentTrending,
      dwellState: this.watchlistDwellState,
      tradableVenueSymbols: this.tradableSymbolsSet.size > 0 ? this.tradableSymbolsSet : undefined,
      tradingCfg: this.config.trading,
      nowMs,
    });

    const tickerBySym = new Map<string, MarketTicker24h>();
    for (const t of this.lastScreenerTickers) {
      tickerBySym.set(t.symbol, t);
    }
    const existingBySym = new Map<string, PairRuntimeState>();
    for (const p of this.snapshot.pairs) {
      existingBySym.set(p.symbol, p);
    }

    const addedSymbols: string[] = [];
    const nextPairs: PairRuntimeState[] = [];
    for (const entry of resolved) {
      const ticker = tickerBySym.get(entry.symbol);
      const existing = existingBySym.get(entry.symbol);
      if (existing) {
        existing.sourceTag = entry.sourceTag;
        existing.tradableOnActiveVenue =
          this.tradableSymbolsSet.size === 0 || this.tradableSymbolsSet.has(entry.symbol);
        if (ticker) {
          existing.quoteVolume24hUsdt = ticker.quoteVolume;
        }
        nextPairs.push(existing);
      } else {
        addedSymbols.push(entry.symbol);
        const isLiveOrRealTicker =
          this.snapshot.transport.feedSource === 'BinanceLive' ||
          this.snapshot.accountMode === 'Live' ||
          Boolean(ticker);
        const candles = isLiveOrRealTicker
          ? []
          : generateSeedCandles(entry.symbol, 220, nowMs);
        const pipe = new IndicatorPipeline(this.config.indicators);
        const indicatorHistory = candles.map((c) => pipe.update(c));
        this.pipelines.set(entry.symbol, pipe);
        if (!this.rngMap.has(entry.symbol)) {
          const seed = entry.symbol.split('').reduce((acc, ch) => acc * 37 + ch.charCodeAt(0), 19);
          this.rngMap.set(entry.symbol, mulberry32(seed));
        }
        const seedPx = ticker?.lastPrice ?? candles[candles.length - 1]?.close ?? 0;
        nextPairs.push({
          symbol: entry.symbol,
          candles,
          indicatorHistory,
          lastPrice: seedPx,
          change24hPct: ticker?.priceChangePercent ?? 0,
          dailyPnlUsdt: this.riskManager.getPairDailyPnl(entry.symbol),
          dailyPnlPct:
            (this.riskManager.getPairDailyPnl(entry.symbol) /
              Math.max(1, this.snapshot.risk.startingDailyEquity)) *
            100,
          indicators: pipe.snapshot(),
          openPosition: null,
          lastSignalNote: isLiveOrRealTicker ? 'Warming up 220 historical bars…' : null,
          sourceTag: entry.sourceTag,
          tradableOnActiveVenue:
            this.tradableSymbolsSet.size === 0 || this.tradableSymbolsSet.has(entry.symbol),
          quoteVolume24hUsdt: ticker?.quoteVolume,
          barsWarmedUp: candles.length,
        });
      }
    }

    const activeSet = new Set(nextPairs.map((p) => p.symbol));
    const removedSymbols = this.snapshot.pairs
      .map((p) => p.symbol)
      .filter((s) => !activeSet.has(s));

    this.snapshot.pairs = nextPairs;
    this.syncRiskToSnapshot();
    return {
      addedSymbols,
      removedSymbols,
      activeSymbols: resolved.map((e) => e.symbol),
    };
  }

  updateConfig(nextConfig: BotConfig): void {
    const prevVenue = this.config.trading.venue;
    const prevPairs = JSON.stringify(this.config.trading.pairs);
    const prevMode = this.config.trading.pairSelectionMode ?? 'hybrid';
    const prevTopN = this.config.trading.trendingTopN;
    const prevCat = this.config.trading.trendingCategory;
    this.config = structuredClone(nextConfig);
    this.config.automation.enabled = this.config.features.automatedTrading;
    if (this.config.trading.venue === 'Spot') {
      this.config.automation.directionPolicy = 'long_only';
      this.config.automation.autoFlipOnReversal = false;
    }
    this.riskManager.updateConfigs(this.config.risk, this.config.trading);
    if (prevVenue !== this.config.trading.venue) {
      this.snapshot.transport.venue = this.config.trading.venue;
      const ep = SimulationRuntime.resolveEndpoints(
        this.snapshot.transport.environment,
        this.config.trading.venue
      );
      this.snapshot.transport.wsEndpoint = ep.wsEndpoint;
      this.snapshot.transport.restEndpoint = ep.restEndpoint;
    }
    if (
      prevPairs !== JSON.stringify(this.config.trading.pairs) ||
      prevMode !== (this.config.trading.pairSelectionMode ?? 'hybrid') ||
      prevTopN !== this.config.trading.trendingTopN ||
      prevCat !== this.config.trading.trendingCategory ||
      prevVenue !== this.config.trading.venue
    ) {
      this.syncWatchlistPairs(this.lastScreenerTickers, Array.from(this.tradableSymbolsSet));
    }
    this.snapshot.risk = this.riskManager.status();
  }

  setRunning(running: boolean): void {
    this.snapshot.running = running;
    this.pushLog('info', running ? 'Trading engine resumed' : 'Trading engine paused by operator');
  }

  setTransportMode(mode: TransportMode, reason?: string): void {
    if (mode === 'RestFallback' && !this.config.features.restFallback) {
      this.pushLog('warn', 'REST fallback failover blocked because REST Fallback is toggled off');
      return;
    }
    if (mode === 'WsPrimary' && !this.config.features.wsPrimaryFeed) {
      this.pushLog('warn', 'WebSocket primary promotion blocked because WS Primary Feed is toggled off');
      return;
    }
    if (this.snapshot.transport.mode !== mode) {
      if (mode === 'RestFallback') {
        this.snapshot.transport.failoverCount += 1;
        this.snapshot.transport.lastWsAgeMs = this.snapshot.transport.wsHeartbeatTimeoutMs + 180;
        this.pushLog('warn', reason ?? `WebSocket heartbeat timeout -> engaged ${this.config.trading.venue} REST fallback`);
      } else if (mode === 'WsPrimary') {
        this.snapshot.transport.lastWsAgeMs = 38;
        this.pushLog('info', reason ?? 'WebSocket primary stream recovered -> promoted back to WsPrimary');
      }
      this.snapshot.transport.mode = mode;
    }
  }

  tripCircuitBreaker(reason: string): void {
    if (!this.config.features.circuitBreaker) {
      this.pushLog('warn', 'Circuit Breaker trip ignored because Circuit Breaker is toggled off');
      return;
    }
    this.riskManager.tripCircuitBreaker(reason);
    this.pushLog('alert', `Circuit Breaker Tripped: ${reason}`);
    if (this.config.risk.flattenOnCircuitBreaker) {
      this.flattenAllPositions(this.lastClockMs);
    }
    this.syncRiskToSnapshot();
  }

  resetCircuitBreaker(): void {
    if (!this.config.features.circuitBreaker) {
      this.pushLog('warn', 'Circuit Breaker reset ignored because Circuit Breaker is toggled off');
      return;
    }
    this.riskManager.resetCircuitBreaker();
    this.snapshot.risk = this.riskManager.status();
    this.pushLog('info', 'Circuit Breaker reset by operator — engine returned to Active');
  }

  flattenAllPositions(nowMs = this.lastClockMs): void {
    const canceledList = this.snapshot.pendingOrders.splice(0, this.snapshot.pendingOrders.length);
    if (canceledList.length > 0) {
      for (const pending of canceledList) {
        this.recordCanceledPendingExecution(
          pending,
          `Circuit Breaker emergency flatten canceled resting ${pending.orderType} order on ${pending.symbol}`,
          nowMs
        );
      }
      this.pushLog(
        'warn',
        `Canceled ${canceledList.length} resting pending order(s) during emergency flatten`
      );
    }
    for (const pair of this.snapshot.pairs) {
      if (pair.openPosition) {
        this.settleClosedExit({
          pair,
          pos: pair.openPosition,
          closeQty: pair.openPosition.remainingQuantity,
          exitPrice: pair.lastPrice,
          reason: 'CircuitBreakerFlatten',
          isPartial: false,
          isMakerExit: false,
          rationale: `Circuit Breaker emergency flatten on ${pair.symbol}`,
          tradeIdSuffix: 'flat',
          nowMs,
        });
      }
    }
    this.syncRiskToSnapshot();
  }

  /**
   * Deterministic simulation step advancing all pairs by 1 bar (or applying an external live candle).
   */
  stepBar(nowMs = Date.now(), externalBar?: { symbol: string; candle: Candle }): void {
    this.lastClockMs = nowMs;
    this.snapshot.tickCount += 1;
    if (this.snapshot.transport.mode === 'WsPrimary') {
      this.snapshot.transport.lastWsAgeMs = 35 + (this.snapshot.tickCount % 55);
    }

    const targets = externalBar
      ? this.snapshot.pairs.filter((p) => p.symbol === externalBar.symbol)
      : this.snapshot.pairs;

    const autoActive =
      this.snapshot.running &&
      this.config.automation.enabled &&
      this.config.features.automatedTrading &&
      this.config.features.signalGenerator;

    const sessionCheck = autoActive
      ? evaluateUtcSessionWindows(
          nowMs,
          this.config.automation.sessionWindows,
          Boolean(this.config.features.sessionWindowFilter)
        )
      : { allowed: true, reason: '' };

    if (autoActive && !sessionCheck.allowed) {
      this.snapshot.autoStats.lastActionSummary = sessionCheck.reason;
      this.snapshot.autoStats.lastScanAtMs = nowMs;
    }

    let closedBarEvaluatedForScan = false;

    for (const pair of targets) {
      let nextCandle: Candle;
      if (externalBar) {
        nextCandle = externalBar.candle;
      } else {
        const prev = pair.candles[pair.candles.length - 1];
        const rand = this.rngMap.get(pair.symbol)!;
        const wave = Math.sin(this.snapshot.tickCount / 7 + pair.symbol.length) * 0.0024;
        const impulse = (rand() - 0.47) * 0.0052;
        const open = prev.close;
        const close = Math.max(1e-8, open * (1 + wave + impulse));
        const high = Math.max(open, close) + open * rand() * 0.0026;
        const low = Math.min(open, close) - open * rand() * 0.0026;
        nextCandle = {
          openTimeMs: prev.openTimeMs + 300_000,
          open,
          high,
          low,
          close,
          volume: prev.volume * (0.85 + rand() * 0.35),
          isClosed: true,
        };
      }

      const existingIdx = externalBar
        ? pair.candles.findIndex((c) => c.openTimeMs === nextCandle.openTimeMs)
        : -1;
      const prevCandle = pair.candles[pair.candles.length - 1];
      const pipe = this.pipelines.get(pair.symbol)!;
      let ind = pair.indicators;
      let isNewlyClosedBar = false;

      if (existingIdx !== -1) {
        const wasClosed = pair.candles[existingIdx].isClosed;
        const prevClosed = pair.candles.slice(0, existingIdx).reverse().find((c) => c.isClosed);
        const updatedCandles = pair.candles.slice();
        updatedCandles[existingIdx] = nextCandle;
        pair.candles = updatedCandles;
        if (nextCandle.isClosed && !wasClosed) {
          isNewlyClosedBar = true;
          const gap = hasCandleSequenceGap(
            prevClosed?.openTimeMs,
            nextCandle.openTimeMs,
            this.config.trading.timeframe
          );
          ind = pipe.update(nextCandle, gap);
          const updatedHist = pair.indicatorHistory.slice();
          updatedHist[existingIdx] = ind;
          pair.indicatorHistory = updatedHist;
        }
      } else {
        const prevClosed = [...pair.candles].reverse().find((c) => c.isClosed);
        pair.candles = [...pair.candles.slice(-219), nextCandle];
        // Never mutate stateful EMA/RSI/ATR/ADX/VWAP accumulators on unclosed forming bars
        if (nextCandle.isClosed) {
          isNewlyClosedBar = true;
          const gap =
            Boolean(externalBar) &&
            hasCandleSequenceGap(
              prevClosed?.openTimeMs,
              nextCandle.openTimeMs,
              this.config.trading.timeframe
            );
          ind = pipe.update(nextCandle, gap);
        } else {
          ind = pipe.snapshot();
        }
        pair.indicatorHistory = [...pair.indicatorHistory.slice(-219), ind];
      }

      if (isNewlyClosedBar) {
        this.closedBarCounts.set(pair.symbol, (this.closedBarCounts.get(pair.symbol) ?? 0) + 1);
      }

      ind = this.decorateIndicators(pair.symbol, ind);
      pair.indicators = ind;
      pair.barsWarmedUp = ind.warmupBarsCount ?? pair.barsWarmedUp ?? pair.candles.length;
      pair.lastPrice = nextCandle.close;
      if (pair.symbol.startsWith('BTC')) {
        this.riskManager.observeBtcPrice(nextCandle.close, nowMs);
      }
      const firstClose = pair.candles[0]?.close ?? nextCandle.close;
      pair.change24hPct = ((nextCandle.close - firstClose) / firstClose) * 100;

      // Monitor ATR volatility spikes only once per confirmed closed candle
      if (isNewlyClosedBar) {
        this.evaluatePairVolatilitySpike(
          pair,
          nextCandle,
          prevCandle?.close ?? nextCandle.open,
          nowMs
        );
      }

      // Compute opposite/reversal candidate signal on closed bars (with enforceVenueLongOnly=false strictly
      // so Spot Long positions/orders can exit/cancel on bearish reversal without ever opening Short).
      const closedBarIdx = this.closedBarCounts.get(pair.symbol) ?? 0;
      const oppSigClosed = isNewlyClosedBar
        ? evaluateEntrySignal(pair.symbol, nextCandle, ind, this.config.trading, this.config.indicators, nowMs, {
            strategyProfile: this.config.automation.strategyProfile,
            directionPolicy: 'both',
            recentCandles: pair.candles,
            features: this.config.features,
            spreadBps: pair.spreadBps,
            enforceVenueLongOnly: false,
          })
        : null;

      // Dynamic resting pending limit order management on closed bars
      if (isNewlyClosedBar) {
        const matchingPendings = this.snapshot.pendingOrders.filter(
          (o) => o.symbol === pair.symbol && (!o.venue || o.venue === this.config.trading.venue)
        );
        for (const pendingOrder of matchingPendings) {
          const dynPend = evaluatePendingOrderDynamicAction({
            pending: pendingOrder,
            candle: nextCandle,
            ind,
            automationCfg: this.config.automation,
            currentBarIndex: closedBarIdx,
            opposingSignal: oppSigClosed,
          });
          if (dynPend.type === 'Cancel') {
            if (dynPend.reason === 'SignalReversed') {
              this.reversalBypassCooldownSide.set(
                pair.symbol,
                pendingOrder.side === 'Long' ? 'Short' : 'Long'
              );
            }
            if (this.snapshot.accountMode === 'Live') {
              const alreadyQueued = this.pendingLiveIntents.some(
                (i) => i.kind === 'CANCEL_PENDING' && i.pendingOrderId === pendingOrder.id
              );
              if (!alreadyQueued) {
                this.pendingLiveIntents.push({
                  id: `live-cancel-pend-${pair.symbol}-${nowMs}`,
                  kind: 'CANCEL_PENDING',
                  symbol: pair.symbol,
                  side: pendingOrder.side,
                  binanceSide: pendingOrder.side === 'Long' ? 'BUY' : 'SELL',
                  orderMethod: pendingOrder.orderMethod,
                  usdtAmount: pendingOrder.usdtAmount,
                  timeInForce: pendingOrder.timeInForce,
                  reason: dynPend.rationale,
                  exchangeOrderId: pendingOrder.exchangeOrderId,
                  pendingOrderId: pendingOrder.id,
                });
              }
            } else {
              this.cancelPendingOrder(pendingOrder.id, dynPend.rationale, nowMs);
            }
          }
        }
      }

      // 0. Check resting LIMIT / LIMIT_MAKER orders for Paper fills
      if (this.snapshot.accountMode === 'Paper' && !pair.openPosition) {
        const matchIdx = this.snapshot.pendingOrders.findIndex((o) => {
          if (o.symbol !== pair.symbol || (o.venue && o.venue !== this.config.trading.venue)) {
            return false;
          }
          return o.side === 'Long' ? nextCandle.low <= o.limitPrice : nextCandle.high >= o.limitPrice;
        });
        if (matchIdx !== -1) {
          const [filledOrder] = this.snapshot.pendingOrders.splice(matchIdx, 1);
          this.openPositionFromInput(
            pair,
            {
              symbol: filledOrder.symbol,
              orderType: filledOrder.orderType,
              side: filledOrder.side,
              usdtAmount: filledOrder.usdtAmount,
              limitPrice: filledOrder.limitPrice,
              timeInForce: filledOrder.timeInForce,
              stopLossMode: filledOrder.stopLossMode,
              stopLossPct: filledOrder.stopLossPct,
              useBreakEven: filledOrder.useBreakEven,
              useTrailingStop: filledOrder.useTrailingStop,
              targets: filledOrder.targets,
            },
            filledOrder.limitPrice,
            filledOrder.usdtAmount,
            nowMs,
            true
          );
        }
      }

      // 1. Manage existing open position (evaluates every price tick 24/7 including outside session windows)
      if (pair.openPosition) {
        const pos = pair.openPosition;
        let handledEarlyExit = false;

        if (isNewlyClosedBar) {
          const dynPos = evaluateOpenPositionDynamicAction({
            pos,
            candle: nextCandle,
            ind,
            automationCfg: this.config.automation,
            opposingSignal: oppSigClosed,
          });
          if (dynPos.type === 'TightenTrailing') {
            this.trailingTightenFactor.set(pair.symbol, dynPos.factor);
            this.pushLog('info', `${pair.symbol}: ${dynPos.rationale}`);
          } else if (dynPos.type === 'EarlyReversalExit') {
            handledEarlyExit = true;
            const opp = dynPos.opposingSignal;
            const canAutoFlip =
              Boolean(this.config.automation.autoFlipOnReversal) &&
              sessionCheck.allowed &&
              this.config.trading.venue === 'Futures' &&
              (this.config.automation.directionPolicy === 'both' ||
                (this.config.automation.directionPolicy === 'long_only' && opp.side === 'Long') ||
                (this.config.automation.directionPolicy === 'short_only' && opp.side === 'Short'));

            if (this.snapshot.accountMode === 'Live') {
              if (
                this.config.automation.autoCloseOnExit &&
                !this.pendingLiveIntents.some((i) => i.kind === 'EXIT' && i.symbol === pair.symbol)
              ) {
                let flipAfterExit: LiveAutoIntent['flipAfterExit'];
                if (canAutoFlip) {
                  this.reversalBypassCooldownSide.set(pair.symbol, opp.side);
                  const flipPlan = buildExitPlan(opp.side, opp.entryPrice, opp.atr, this.config.exits, this.config.features);
                  const notional = Math.max(10, this.config.automation.autoOrderNotionalUsdt || 150);
                  const flipMethod = this.config.automation.orderMethod;
                  const flipOrderType: ManualOrderInput['orderType'] =
                    flipMethod === 'LIMIT_MAKER'
                      ? 'LIMIT MAKER'
                      : flipMethod === 'LIMIT'
                        ? 'LIMIT'
                        : 'MARKET';
                  const flipOffsetFrac = Math.max(0, this.config.automation.limitOffsetBps) / 10_000;
                  const flipDecimals = pricePrecisionDecimals(opp.entryPrice);
                  const flipLimitPrice =
                    flipMethod === 'LIMIT' || flipMethod === 'LIMIT_MAKER'
                      ? opp.side === 'Long'
                        ? Number((opp.entryPrice * (1 - flipOffsetFrac)).toFixed(flipDecimals))
                        : Number((opp.entryPrice * (1 + flipOffsetFrac)).toFixed(flipDecimals))
                      : undefined;
                  flipAfterExit = {
                    side: opp.side,
                    reason: `Futures auto-flip after SignalReversal (${opp.rationale})`,
                    input: {
                      symbol: pair.symbol,
                      orderType: flipOrderType,
                      side: opp.side,
                      usdtAmount: notional,
                      limitPrice: flipLimitPrice,
                      timeInForce: this.config.automation.timeInForce,
                      workingType: 'MARK_PRICE',
                      stopLossMode: 'ATR',
                      stopLossPct: opp.entryPrice > 0 ? Number(((flipPlan.riskDistanceR / opp.entryPrice) * 100).toFixed(3)) : 1.5,
                      useBreakEven: true,
                      useTrailingStop: true,
                      targets: [{ pctOffset: 2.25, allocationPct: 50 }, { pctOffset: 3.75, allocationPct: 50 }],
                    },
                  };
                }
                this.pendingLiveIntents.push({
                  id: `live-rev-exit-${pair.symbol}-${nowMs}`,
                  kind: 'EXIT',
                  symbol: pair.symbol,
                  side: pos.side,
                  binanceSide: pos.side === 'Long' ? 'SELL' : 'BUY',
                  orderMethod: 'MARKET',
                  usdtAmount: pos.remainingQuantity * nextCandle.close,
                  quantity: pos.remainingQuantity,
                  timeInForce: 'GTC',
                  reason: dynPos.reason,
                  flipAfterExit,
                });
              }
            } else {
              this.trailingTightenFactor.delete(pair.symbol);
              const { pnl, rMult } = this.settleClosedExit({
                pair,
                pos,
                closeQty: pos.remainingQuantity,
                exitPrice: nextCandle.close,
                reason: 'SignalReversal',
                isPartial: false,
                isMakerExit: false,
                rationale: dynPos.rationale,
                tradeIdSuffix: 'rev',
                nowMs,
              });
              this.pushLog('info', `${pair.symbol} SignalReversal exit ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${rMult.toFixed(2)}R)`);
              if (
                this.config.features.circuitBreaker &&
                this.config.risk.flattenOnCircuitBreaker &&
                this.riskManager.status().state === 'Halted'
              ) {
                this.flattenAllPositions(nowMs);
                break;
              }
              if (canAutoFlip) {
                this.reversalBypassCooldownSide.set(pair.symbol, opp.side);
                this.evaluateAutoPair(pair, nextCandle, ind, nowMs, true);
              }
            }
          }
        }

        if (!handledEarlyExit && pair.openPosition) {
          const atrVal = ind.atr ?? pos.exitPlan.riskDistanceR;
          const prevTp1Hit = pos.exitPlan.tp1Hit;
          const prevTargetHits = pos.exitPlan.tpTargets?.map((t) => t.hit);
          const tightenFactor = this.trailingTightenFactor.get(pair.symbol);
          const effectiveTrailOverride =
            tightenFactor !== undefined
              ? this.config.exits.atrTrailingMultiplier * tightenFactor
              : undefined;
          const action = managePositionTick(
            pos,
            nextCandle.close,
            atrVal,
            this.config.exits,
            this.config.features,
            effectiveTrailOverride
          );

        if (this.snapshot.accountMode === 'Live') {
          if (action.type === 'PartialClose' || action.type === 'FullClose') {
            // Do not permanently mutate TP hit flags until the exchange confirms the Live exit fill.
            pos.exitPlan.tp1Hit = prevTp1Hit;
            if (pos.exitPlan.tpTargets && prevTargetHits) {
              pos.exitPlan.tpTargets.forEach((t, idx) => {
                t.hit = prevTargetHits[idx] ?? false;
              });
            }
          }
          if (
            (action.type === 'PartialClose' || action.type === 'FullClose') &&
            this.config.automation.autoCloseOnExit
          ) {
            const closeQty =
              action.type === 'PartialClose'
                ? pos.remainingQuantity * action.ratio
                : pos.remainingQuantity;
            if (!this.pendingLiveIntents.some((i) => i.kind === 'EXIT' && i.symbol === pair.symbol)) {
              this.pendingLiveIntents.push({
                id: `live-exit-${pair.symbol}-${nowMs}`,
                kind: 'EXIT',
                symbol: pair.symbol,
                side: pos.side,
                binanceSide: pos.side === 'Long' ? 'SELL' : 'BUY',
                orderMethod: 'MARKET',
                usdtAmount: closeQty * nextCandle.close,
                quantity: closeQty,
                timeInForce: 'GTC',
                reason: action.reason,
              });
            }
          }
        } else if (action.type === 'PartialClose') {
          const closeQty = pos.remainingQuantity * action.ratio;
          const { pnl, rMult } = this.settleClosedExit({
            pair,
            pos,
            closeQty,
            exitPrice: action.exitPrice,
            reason: action.reason,
            isPartial: true,
            isMakerExit: true,
            rationale: `${pair.symbol} TP1 partial scale-out (${Math.round(action.ratio * 100)}%) @ $${action.exitPrice.toFixed(2)}`,
            tradeIdSuffix: 'tp1',
            nowMs,
          });
          this.pushLog('info', `${pair.symbol} TP1 partial hit (+$${pnl.toFixed(2)} · ${rMult.toFixed(2)}R)`);
        } else if (action.type === 'FullClose') {
          const closeQty = pos.remainingQuantity;
          const isMakerExit = action.reason === 'TakeProfit1' || action.reason === 'TakeProfit2';
          const { pnl, rMult } = this.settleClosedExit({
            pair,
            pos,
            closeQty,
            exitPrice: action.exitPrice,
            reason: action.reason,
            isPartial: false,
            isMakerExit,
            rationale: `${pair.symbol} full exit (${action.reason}) @ $${action.exitPrice.toFixed(2)}`,
            tradeIdSuffix: 'exit',
            nowMs,
          });
          this.trailingTightenFactor.delete(pair.symbol);
          this.pushLog(
            pnl >= 0 ? 'info' : 'warn',
            `${pair.symbol} closed (${action.reason}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${rMult.toFixed(2)}R)`
          );
          if (
            this.config.features.circuitBreaker &&
            this.riskManager.status().state === 'Halted' &&
            this.config.risk.flattenOnCircuitBreaker
          ) {
            this.flattenAllPositions(nowMs);
          }
        }
        }
      } else if (autoActive && isNewlyClosedBar) {
        if (sessionCheck.allowed) {
          closedBarEvaluatedForScan = true;
          this.evaluateAutoPair(pair, nextCandle, ind, nowMs);
        } else {
          pair.lastSignalNote = sessionCheck.reason;
        }
      }
    }

    if (autoActive && sessionCheck.allowed && closedBarEvaluatedForScan) {
      this.snapshot.autoStats.scansRun += 1;
      this.snapshot.autoStats.lastScanAtMs = nowMs;
    }

    this.snapshot.recentTrades = this.snapshot.recentTrades.slice(0, 60);
    this.syncRiskToSnapshot();
  }

  runAutoScanNow(nowMs = Date.now()): {
    scannedPairs: number;
    signalsDetected: number;
    dispatched: number;
  } {
    this.lastClockMs = nowMs;
    if (!this.config.features.automatedTrading) {
      this.pushLog('warn', 'Auto-scan skipped: Automated Trading Engine is disabled in Feature Toggles.');
      return { scannedPairs: 0, signalsDetected: 0, dispatched: 0 };
    }
    if (!this.config.features.signalGenerator) {
      this.pushLog('warn', 'Auto-scan skipped: Signal Generator is disabled in Feature Toggles.');
      return { scannedPairs: 0, signalsDetected: 0, dispatched: 0 };
    }
    const activeVenue = this.config.trading.venue;
    if (
      (activeVenue === 'Spot' && !this.config.features.spotMarket) ||
      (activeVenue === 'Futures' && !this.config.features.futuresMarket)
    ) {
      this.pushLog('warn', `Auto-scan skipped: ${activeVenue} market venue is disabled in Feature Toggles.`);
      return { scannedPairs: 0, signalsDetected: 0, dispatched: 0 };
    }
    const sessionCheck = evaluateUtcSessionWindows(
      nowMs,
      this.config.automation.sessionWindows,
      Boolean(this.config.features.sessionWindowFilter)
    );
    if (!sessionCheck.allowed) {
      this.snapshot.autoStats.lastActionSummary = sessionCheck.reason;
      this.snapshot.autoStats.lastScanAtMs = nowMs;
      this.pushLog('warn', `Auto-scan restricted: ${sessionCheck.reason}`);
      this.syncRiskToSnapshot();
      return { scannedPairs: 0, signalsDetected: 0, dispatched: 0 };
    }
    let signalsDetected = 0;
    let dispatched = 0;
    for (const pair of this.snapshot.pairs) {
      if (pair.openPosition) continue;
      const latestClosed =
        [...pair.candles].reverse().find((c) => c.isClosed) ??
        pair.candles[pair.candles.length - 1];
      if (!latestClosed) continue;
      const res = this.evaluateAutoPair(pair, latestClosed, pair.indicators, nowMs, true);
      if (res.signalDetected) signalsDetected += 1;
      if (res.dispatched) dispatched += 1;
    }
    this.snapshot.autoStats.scansRun += 1;
    this.snapshot.autoStats.lastScanAtMs = nowMs;
    this.syncRiskToSnapshot();
    return { scannedPairs: this.snapshot.pairs.length, signalsDetected, dispatched };
  }

  private evaluateAutoPair(
    pair: PairRuntimeState,
    candle: Candle,
    ind: PairRuntimeState['indicators'],
    nowMs: number,
    ignoreCooldown = false
  ): { signalDetected: boolean; dispatched: boolean } {
    if (!this.config.features.signalGenerator) {
      return { signalDetected: false, dispatched: false };
    }
    const sessionCheck = evaluateUtcSessionWindows(
      nowMs,
      this.config.automation.sessionWindows,
      Boolean(this.config.features.sessionWindowFilter)
    );
    if (!sessionCheck.allowed) {
      pair.lastSignalNote = sessionCheck.reason;
      this.snapshot.autoStats.lastActionSummary = sessionCheck.reason;
      return { signalDetected: false, dispatched: false };
    }
    const activeVenue = this.config.trading.venue;
    if (
      (activeVenue === 'Spot' && !this.config.features.spotMarket) ||
      (activeVenue === 'Futures' && !this.config.features.futuresMarket)
    ) {
      return { signalDetected: false, dispatched: false };
    }

    const auto = this.config.automation;
    const hasPending = this.snapshot.pendingOrders.some((o) => o.symbol === pair.symbol);
    if (hasPending) return { signalDetected: false, dispatched: false };

    const currentBarIdx = this.closedBarCounts.get(pair.symbol) ?? 0;
    const lastBarIdx = this.lastSignalBarIndex.get(pair.symbol) ?? -9999;
    const bypassSide = this.reversalBypassCooldownSide.get(pair.symbol);
    if (!ignoreCooldown && !bypassSide && currentBarIdx - lastBarIdx < auto.signalCooldownBars) {
      return { signalDetected: false, dispatched: false };
    }

    const sig = evaluateEntrySignal(
      pair.symbol,
      candle,
      ind,
      this.config.trading,
      this.config.indicators,
      nowMs,
      {
        strategyProfile: auto.strategyProfile,
        directionPolicy: auto.directionPolicy,
        recentCandles: pair.candles,
        features: this.config.features,
        spreadBps: pair.spreadBps,
        enforceVenueLongOnly: true,
      }
    );

    if (!sig) return { signalDetected: false, dispatched: false };

    if (
      !ignoreCooldown &&
      currentBarIdx - lastBarIdx < auto.signalCooldownBars &&
      bypassSide !== sig.side
    ) {
      return { signalDetected: false, dispatched: false };
    }
    if (bypassSide === sig.side) {
      this.reversalBypassCooldownSide.delete(pair.symbol);
    }

    const maxSameDir = this.config.trading.maxSameDirectionPositions ?? 2;
    if (maxSameDir > 0) {
      const sameDirCount =
        this.snapshot.pairs.filter((p) => p.openPosition?.side === sig.side).length +
        this.snapshot.pendingOrders.filter((o) => o.side === sig.side).length;
      if (sameDirCount >= maxSameDir) {
        pair.lastSignalNote = `Blocked: max ${maxSameDir} same-direction (${sig.side}) positions reached`;
        return { signalDetected: true, dispatched: false };
      }
    }

    this.snapshot.autoStats.signalsDetected += 1;
    this.lastSignalBarIndex.set(pair.symbol, currentBarIdx);

    const plan = buildExitPlan(
      sig.side,
      sig.entryPrice,
      sig.atr,
      this.config.exits,
      this.config.features
    );
    const openCount =
      this.snapshot.pairs.filter((p) => p.openPosition !== null).length +
      this.snapshot.pendingOrders.length;
    if (openCount >= this.config.trading.maxConcurrentPositions) {
      pair.lastSignalNote = 'Blocked: Max concurrent positions reached';
      return { signalDetected: true, dispatched: false };
    }
    if (this.config.features.circuitBreaker) {
      const auth = this.riskManager.authorizeEntry(
        sig.symbol,
        sig.entryPrice,
        plan.initialStopLoss,
        openCount,
        nowMs
      );
      if (!auth.ok) {
        pair.lastSignalNote = `Blocked: ${auth.reason}`;
        return { signalDetected: true, dispatched: false };
      }
    }

    const leverage = activeVenue === 'Futures' ? this.effectiveLeverage() : 1;
    const sizingMode = this.config.trading.positionSizingMode ?? 'fixed_usdt';
    const stopDistFrac =
      sig.entryPrice > 0
        ? Math.max(0.002, Math.abs(sig.entryPrice - plan.initialStopLoss) / sig.entryPrice)
        : 0.015;
    const expectancy = computeExpectancyStats(
      this.snapshot.recentTrades,
      this.config.trading.baseRiskPerTradePct
    );
    const kelly = computeKellySizingAnalytics(
      expectancy,
      this.snapshot.risk.currentEquity,
      stopDistFrac,
      this.config.trading.baseRiskPerTradePct
    );
    const corrMatrix = computePortfolioCorrelationMatrix(
      this.snapshot.pairs,
      kelly.halfKellyPct
    );
    const quantSizing = calculateQuantitativePositionSizeUsdt({
      mode: sizingMode,
      fixedUsdt: auto.autoOrderNotionalUsdt,
      equityUsdt: this.snapshot.risk.currentEquity,
      availableBalanceUsdt: this.snapshot.availableBalanceUsdt,
      baseRiskPerTradePct: this.config.trading.baseRiskPerTradePct,
      entryPrice: sig.entryPrice,
      stopLossPrice: plan.initialStopLoss,
      kelly,
      venue: activeVenue,
      leverage,
      diversificationMultiplier: corrMatrix.diversificationMultiplier,
    });

    if (quantSizing.blockedByNegativeKelly) {
      pair.lastSignalNote = `Blocked: Negative Kelly (f* ≤ 0, EV ≤ 0) — systematic filter halted entry`;
      this.pushLog(
        'warn',
        `[KELLY FILTER] Blocked ${sig.symbol} ${sig.side}: Negative Kelly fraction (${(kelly.rawFullKellyFraction * 100).toFixed(2)}% EV <= 0)`
      );
      return { signalDetected: true, dispatched: false };
    }

    if (quantSizing.notionalUsdt < 10) {
      this.pushLog(
        'warn',
        `[SIZING] Skipped ${sig.symbol} ${sig.side}: computed notional ($${quantSizing.notionalUsdt.toFixed(2)}) below $10 minimum`
      );
      return { signalDetected: true, dispatched: false };
    }

    const desiredNotional = Math.min(
      quantSizing.notionalUsdt,
      Math.max(0, this.snapshot.availableBalanceUsdt * leverage)
    );
    if (desiredNotional < 10) {
      pair.lastSignalNote = 'Auto signal skipped: insufficient available USDT';
      return { signalDetected: true, dispatched: false };
    }

    const offsetFrac = Math.max(0, auto.limitOffsetBps) / 10_000;
    const limitDecimals = pricePrecisionDecimals(sig.entryPrice);
    const limitPrice =
      sig.side === 'Long'
        ? Number((sig.entryPrice * (1 - offsetFrac)).toFixed(limitDecimals))
        : Number((sig.entryPrice * (1 + offsetFrac)).toFixed(limitDecimals));

    const orderType: ManualOrderInput['orderType'] =
      auto.orderMethod === 'LIMIT_MAKER'
        ? 'LIMIT MAKER'
        : auto.orderMethod === 'LIMIT'
          ? 'LIMIT'
          : auto.orderMethod === 'OCO'
            ? sig.side === 'Long'
              ? 'OCO SELL'
              : 'OCO BUY'
            : 'MARKET';

    const tp1PctOffset =
      sig.entryPrice > 0
        ? Number(((Math.abs(plan.takeProfit1 - sig.entryPrice) / sig.entryPrice) * 100).toFixed(3))
        : 2.25;
    const tp2PctOffset =
      sig.entryPrice > 0
        ? Number(((Math.abs(plan.takeProfit2 - sig.entryPrice) / sig.entryPrice) * 100).toFixed(3))
        : 3.75;
    const tp1Alloc = Math.round(Math.min(95, Math.max(5, this.config.exits.tp1CloseRatio * 100)));
    const tp2Alloc = Math.max(0, 100 - tp1Alloc);

    const autoInput: ManualOrderInput = {
      symbol: sig.symbol,
      orderType,
      side: sig.side,
      usdtAmount: desiredNotional,
      limitPrice:
        auto.orderMethod === 'LIMIT' || auto.orderMethod === 'LIMIT_MAKER'
          ? limitPrice
          : undefined,
      timeInForce: auto.timeInForce,
      workingType: 'MARK_PRICE',
      stopLossMode: 'ATR',
      stopLossPct:
        sig.entryPrice > 0
          ? Number(((plan.riskDistanceR / sig.entryPrice) * 100).toFixed(3))
          : 1.5,
      useBreakEven: true,
      useTrailingStop: true,
      targets:
        tp2Alloc > 0
          ? [
              { pctOffset: Math.max(0.1, tp1PctOffset), allocationPct: tp1Alloc },
              { pctOffset: Math.max(0.2, tp2PctOffset), allocationPct: tp2Alloc },
            ]
          : [{ pctOffset: Math.max(0.1, tp1PctOffset), allocationPct: 100 }],
    };

    if (this.snapshot.accountMode === 'Live') {
      this.pendingLiveIntents.push({
        id: `live-auto-${sig.symbol}-${nowMs}`,
        kind: 'ENTRY',
        symbol: sig.symbol,
        side: sig.side,
        binanceSide: sig.side === 'Long' ? 'BUY' : 'SELL',
        orderMethod: auto.orderMethod,
        usdtAmount: desiredNotional,
        limitPrice: autoInput.limitPrice,
        timeInForce: auto.timeInForce,
        reason: sig.rationale,
        input: autoInput,
      });
      this.snapshot.autoStats.lastActionSummary = `Queued Live ${auto.orderMethod} ${sig.side} ${sig.symbol} $${desiredNotional.toFixed(2)} (awaiting dispatch)`;
      pair.lastSignalNote = sig.rationale;
      return { signalDetected: true, dispatched: true };
    }

    // Paper execution
    if (auto.orderMethod === 'LIMIT' || auto.orderMethod === 'LIMIT_MAKER') {
      const shouldRestAutoLimit =
        auto.orderMethod === 'LIMIT_MAKER' ||
        (sig.side === 'Long'
          ? limitPrice < sig.entryPrice * 0.9999
          : limitPrice > sig.entryPrice * 1.0001);
      if (
        shouldRestAutoLimit &&
        auto.orderMethod === 'LIMIT' &&
        (auto.timeInForce === 'IOC' || auto.timeInForce === 'FOK')
      ) {
        const reason = `[AUTO · ${auto.strategyProfile}] ${auto.timeInForce} LIMIT ${sig.symbol} @ $${limitPrice.toFixed(2)} did not cross market ($${sig.entryPrice.toFixed(2)}) and expired`;
        this.pushLog('warn', reason);
        pair.lastSignalNote = reason;
        this.snapshot.autoStats.lastActionSummary = reason;
        return { signalDetected: true, dispatched: false };
      }
      if (shouldRestAutoLimit) {
        const pending: PendingOrder = {
          id: `${sig.symbol}-auto-lim-${nowMs}`,
          symbol: sig.symbol,
          venue: this.config.trading.venue,
          side: sig.side,
          orderType,
          orderMethod: auto.orderMethod,
          usdtAmount: desiredNotional,
          limitPrice,
          timeInForce: auto.timeInForce,
          stopLossMode: 'ATR',
          stopLossPct: autoInput.stopLossPct,
          useBreakEven: true,
          useTrailingStop: true,
          targets: autoInput.targets,
          createdAtMs: nowMs,
          source: 'auto',
          createdBarIndex: currentBarIdx,
        };
        this.snapshot.pendingOrders.unshift(pending);
        this.pushLog(
          'info',
          `[AUTO · ${auto.strategyProfile}] Resting ${orderType} ${sig.symbol} ${sig.side} $${desiredNotional.toFixed(2)} @ $${limitPrice.toFixed(2)}`
        );
        this.snapshot.autoStats.lastActionSummary = `Paper ${orderType} ${sig.symbol} @ $${limitPrice.toFixed(2)}`;
      } else {
        this.openPositionFromInput(pair, autoInput, sig.entryPrice, desiredNotional, nowMs, false);
        this.snapshot.autoStats.lastActionSummary = `Paper ${orderType} ${sig.side} ${sig.symbol} $${desiredNotional.toFixed(2)} (immediate fill)`;
      }
    } else {
      this.openPositionFromInput(pair, autoInput, sig.entryPrice, desiredNotional, nowMs, false);
      this.snapshot.autoStats.lastActionSummary = `Paper ${orderType} ${sig.side} ${sig.symbol} $${desiredNotional.toFixed(2)}`;
    }

    this.snapshot.autoStats.autoOrdersDispatched += 1;
    pair.lastSignalNote = sig.rationale;
    return { signalDetected: true, dispatched: true };
  }

  /**
   * Simulates a series of losing fills to let the user test streak cooldowns,
   * per-pair drawdown quarantine, and cumulative daily drawdown circuit breaker.
   */
  simulateLossStress(symbol: string, lossUsdt: number, nowMs = Date.now()): void {
    const absLoss = Math.abs(lossUsdt);
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol);
    const refPrice = pair?.lastPrice ?? 100;
    const dec = pricePrecisionDecimals(refPrice);
    const entryPrice = Number((refPrice * 1.015).toFixed(dec));
    const exitPrice = Number(refPrice.toFixed(dec));
    const qty = Number((absLoss / Math.max(entryPrice - exitPrice, 1e-8)).toFixed(4));
    this.riskManager.recordRealizedPnl(symbol, -absLoss, nowMs);
    this.snapshot.recentTrades.unshift({
      id: `stress-${nowMs}`,
      symbol,
      side: 'Long',
      entryPrice,
      exitPrice,
      quantity: qty,
      pnlUsdt: -absLoss,
      rMultiple: -1.0,
      reason: 'StopLoss',
      closedAtMs: nowMs,
    });
    this.recordExitExecution({
      symbol,
      side: 'Long',
      entryPrice,
      exitPrice,
      origQty: qty,
      executedQty: qty,
      pnlUsdt: -absLoss,
      rMultiple: -1.0,
      reason: 'StopLoss',
      isPartial: false,
      rationale: `Simulated stress stop-out (-$${absLoss.toFixed(2)}) on ${symbol}`,
      nowMs,
    });
    this.pushLog('warn', `Simulated -$${absLoss.toFixed(2)} stop-out on ${symbol}`);
    if (
      this.config.features.circuitBreaker &&
      this.riskManager.status().state === 'Halted' &&
      this.config.risk.flattenOnCircuitBreaker
    ) {
      this.flattenAllPositions(nowMs);
    }
    this.syncRiskToSnapshot();
  }

  private syncRiskToSnapshot(): void {
    this.snapshot.risk = this.riskManager.status();
    if (this.snapshot.accountMode === 'Live' && this.syncedLiveBalance) {
      this.snapshot.lockedBalanceUsdt = this.syncedLiveBalance.locked;
      this.snapshot.availableBalanceUsdt = this.syncedLiveBalance.free;
    } else {
      const posLocked = this.snapshot.pairs.reduce(
        (sum, p) => sum + (p.openPosition?.lockedMarginUsdt ?? 0),
        0
      );
      const leverage =
        this.config.trading.venue === 'Futures' ? this.effectiveLeverage() : 1;
      const pendingLocked = this.snapshot.pendingOrders.reduce(
        (sum, o) => sum + o.usdtAmount / leverage,
        0
      );
      const locked = posLocked + pendingLocked;
      this.snapshot.lockedBalanceUsdt = locked;
      this.snapshot.availableBalanceUsdt = Math.max(0, this.snapshot.risk.currentEquity - locked);
    }

    const lastHist = this.snapshot.pnlHistory[this.snapshot.pnlHistory.length - 1];
    const nextPnl = Number(this.snapshot.risk.cumulativeDailyPnlUsdt.toFixed(2));
    if (lastHist !== nextPnl) {
      this.snapshot.pnlHistory = [...this.snapshot.pnlHistory.slice(-23), nextPnl];
    }

    const base = Math.max(this.snapshot.risk.startingDailyEquity, 1);
    for (const p of this.snapshot.pairs) {
      const pPnl = this.riskManager.getPairDailyPnl(p.symbol);
      p.dailyPnlUsdt = pPnl;
      p.dailyPnlPct = (pPnl / base) * 100;
    }
  }

  private pushLog(level: 'info' | 'warn' | 'alert', message: string): void {
    this.snapshot.eventLog.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestampMs: Date.now(),
      level,
      message,
    });
    this.snapshot.eventLog = this.snapshot.eventLog.slice(0, 40);
  }
}
