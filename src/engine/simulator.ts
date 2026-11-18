import { IndicatorPipeline } from './indicators';
import {
  calculateQuantitativePositionSizeUsdt,
  computeExpectancyStats,
  computeKellySizingAnalytics,
  computePortfolioCorrelationMatrix,
} from './quantAnalytics';
import { RiskManager } from './risk';
import { DEFAULT_UTC_SESSION_WINDOWS, evaluateUtcSessionWindows } from './sessionWindows';
import { buildExitPlan, evaluateEntrySignal, managePositionTick } from './strategy';
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
    marginType: 'ISOLATED',
    mode: 'scalping',
    timeframe: '5m',
    pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'],
    maxConcurrentPositions: 3,
    baseRiskPerTradePct: 0.75,
    positionSizingMode: 'fixed_usdt',
    initialEquityUsdt: 10000,
    takerFeeBps: 10,
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

export function generateSeedCandles(symbol: string, count = 220, baseTimeMs = 1_763_280_000_000): Candle[] {
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
  private lastSignalTick = new Map<string, number>();
  private lastVolatilityAlertAtMs = new Map<string, number>();
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
            leverage: this.config.trading.leverage,
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
          leverage: this.config.trading.leverage,
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
          leverage: this.config.trading.leverage,
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
    const totalUsdt = Math.max(0, usdtFree + usdtLocked);
    this.config.trading.initialEquityUsdt = totalUsdt;
    this.riskManager.setEquityBaseline(totalUsdt);
    this.snapshot.risk = this.riskManager.status();
    this.snapshot.lockedBalanceUsdt = Math.max(0, usdtLocked);
    this.snapshot.availableBalanceUsdt = Math.max(0, usdtFree);
    this.pushLog(
      'info',
      `Synced live Binance USDT balance: Avbl $${usdtFree.toFixed(2)} · Locked $${usdtLocked.toFixed(2)}`
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
    const feeRate =
      venue === 'Futures'
        ? isMaker
          ? 0.0002
          : 0.0004
        : isMaker
          ? 0.00075
          : 0.001;
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
      leverage: venue === 'Futures' ? this.config.trading.leverage : 1,
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
    const feeRate =
      venue === 'Futures'
        ? isMaker
          ? 0.0002
          : 0.0004
        : isMaker
          ? 0.00075
          : 0.001;
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
      leverage: venue === 'Futures' ? this.config.trading.leverage : 1,
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

  recordExternalLiveOrder(
    input: ManualOrderInput,
    note: string,
    nowMs = Date.now(),
    fillDetails?: {
      executedQty?: number;
      avgPrice?: number;
      commission?: number;
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
      input.stopLossMode === 'ATR'
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct) / 100);
    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const qty =
      fillDetails?.executedQty && fillDetails.executedQty > 0
        ? fillDetails.executedQty
        : input.usdtAmount / Math.max(entryPrice, 1e-6);
    const cleanTargets: TakeProfitTarget[] = input.targets
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

    pair.openPosition = {
      id: `${input.symbol}-live-${nowMs}`,
      symbol: input.symbol,
      side: input.side,
      entryPrice,
      quantity: qty,
      remainingQuantity: qty,
      lockedMarginUsdt:
        this.config.trading.venue === 'Futures'
          ? (entryPrice * qty) / Math.max(1, this.config.trading.leverage)
          : entryPrice * qty,
      unrealizedPnlUsdt: 0,
      realizedPnlUsdt: 0,
      feePaidUsdt:
        fillDetails?.commission !== undefined && fillDetails.commission > 0
          ? fillDetails.commission
          : entryRec.commission,
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
    nowMs = Date.now()
  ): void {
    const pending: PendingOrder = {
      id: `${input.symbol}-live-lim-${nowMs}`,
      symbol: input.symbol,
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
    };
    this.snapshot.pendingOrders.unshift(pending);
    this.pushLog('info', note);
    this.syncRiskToSnapshot();
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
    if (venue === 'Futures' && this.config.automation.directionPolicy === 'long_only') {
      this.config.automation.directionPolicy = 'both';
    }
    this.pushLog(
      'info',
      `Switched execution venue to Binance ${venue}${venue === 'Futures' ? ` (${this.config.trading.leverage}x ${this.config.trading.marginType})` : ''}`
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

  cancelPendingOrder(orderId: string): boolean {
    const idx = this.snapshot.pendingOrders.findIndex((o) => o.id === orderId);
    if (idx === -1) return false;
    const [removed] = this.snapshot.pendingOrders.splice(idx, 1);
    this.pushLog('info', `Cancelled resting ${removed.orderType} order on ${removed.symbol} @ $${removed.limitPrice.toFixed(2)}`);
    this.syncRiskToSnapshot();
    return true;
  }

  recordExternalLiveExit(
    symbol: string,
    closeRatio: number,
    exitPrice: number,
    reason: ClosedTrade['reason'],
    note: string,
    nowMs = Date.now(),
    externalOrderId?: string
  ): void {
    const pair = this.snapshot.pairs.find((p) => p.symbol === symbol);
    if (!pair?.openPosition) return;
    const pos = pair.openPosition;
    const ratio = Math.min(1, Math.max(0.05, closeRatio));
    const closeQty = ratio >= 0.999 ? pos.remainingQuantity : pos.remainingQuantity * ratio;
    const pnl =
      pos.side === 'Long'
        ? (exitPrice - pos.entryPrice) * closeQty
        : (pos.entryPrice - exitPrice) * closeQty;
    const rMult = pnl / Math.max(pos.exitPlan.riskDistanceR * pos.quantity, 1e-9);
    this.riskManager.recordRealizedPnl(symbol, pnl, nowMs);
    this.snapshot.recentTrades.unshift({
      id: `${pos.id}-live-exit-${nowMs}`,
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason,
      closedAtMs: nowMs,
    });
    this.recordExitExecution({
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      origQty: pos.quantity,
      executedQty: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason,
      isPartial: ratio < 0.999,
      rationale: note,
      nowMs,
      externalOrderId,
    });
    if (ratio >= 0.999) {
      pair.openPosition = null;
    } else {
      pos.remainingQuantity -= closeQty;
      pos.realizedPnlUsdt += pnl;
    }
    this.pushLog('info', note);
    this.syncRiskToSnapshot();
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

    const pair = this.snapshot.pairs.find((p) => p.symbol === input.symbol);
    if (!pair) {
      return { ok: false, reason: `Unknown pair ${input.symbol}` };
    }
    if (pair.openPosition) {
      return { ok: false, reason: `${input.symbol} already has an open position` };
    }
    if (!Number.isFinite(input.usdtAmount) || input.usdtAmount <= 0) {
      return { ok: false, reason: 'Order allocation must be greater than $0' };
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
      input.stopLossMode === 'ATR'
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct) / 100);

    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const openCount =
      this.snapshot.pairs.filter((p) => p.openPosition !== null).length +
      this.snapshot.pendingOrders.length;
    if (this.config.features.circuitBreaker) {
      const auth = this.riskManager.authorizeEntry(input.symbol, entryPrice, initialSl, openCount, nowMs);
      if (!auth.ok) {
        this.pushLog('warn', `Manual order rejected (${input.symbol}): ${auth.reason}`);
        return { ok: false, reason: auth.reason };
      }
    }

    const leverage = activeVenue === 'Futures' ? Math.max(1, this.config.trading.leverage) : 1;
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
        side: input.side,
        orderType: input.orderType,
        orderMethod: input.orderType === 'LIMIT MAKER' ? 'LIMIT_MAKER' : 'LIMIT',
        usdtAmount: cappedUsdt,
        limitPrice: requestedLimit,
        timeInForce: tif,
        stopLossMode: input.stopLossMode,
        stopLossPct: input.stopLossPct,
        useBreakEven: input.useBreakEven,
        useTrailingStop: input.useTrailingStop,
        targets: input.targets,
        createdAtMs: nowMs,
      };
      this.snapshot.pendingOrders.unshift(pending);
      this.pushLog(
        'info',
        `Resting ${input.orderType} (${pending.timeInForce}) ${input.symbol} ${input.side} $${cappedUsdt.toFixed(2)} @ $${requestedLimit.toFixed(2)}`
      );
      this.syncRiskToSnapshot();
      return { ok: true, pendingOrder: pending };
    }

    const fillPrice = isLimitOrder ? requestedLimit : pair.lastPrice;
    const pos = this.openPositionFromInput(pair, input, fillPrice, cappedUsdt, nowMs, false);
    this.syncRiskToSnapshot();
    return { ok: true, position: pos };
  }

  private computeExitCommission(exitPrice: number, closeQty: number, isMakerExit: boolean): number {
    const venue = this.config.trading.venue;
    const feeRate =
      venue === 'Futures'
        ? isMakerExit
          ? 0.0002
          : 0.0004
        : isMakerExit
          ? 0.00075
          : 0.001;
    return Number((exitPrice * closeQty * feeRate).toFixed(4));
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
      input.stopLossMode === 'ATR'
        ? atr * this.config.exits.atrSlMultiplier
        : entryPrice * (Math.max(0.2, input.stopLossPct) / 100);
    const initialSl = input.side === 'Long' ? entryPrice - slDist : entryPrice + slDist;
    const quantity = cappedUsdt / Math.max(entryPrice, 1e-6);

    const cleanTargets: TakeProfitTarget[] = input.targets
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

    const rationale = `${this.config.trading.venue === 'Futures' ? `FUTURES ${this.config.trading.leverage}x · ` : ''}${input.orderType} · $${cappedUsdt.toFixed(2)} · ${cleanTargets.length || 2} TP targets`;
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
          ? cappedUsdt / Math.max(1, this.config.trading.leverage)
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
    const closeQty = pos.remainingQuantity;
    const grossPnl =
      pos.side === 'Long'
        ? (pair.lastPrice - pos.entryPrice) * closeQty
        : (pos.entryPrice - pair.lastPrice) * closeQty;
    const entryFeePortion = (pos.feePaidUsdt ?? 0) * (closeQty / Math.max(pos.quantity, 1e-9));
    const exitFee = this.computeExitCommission(pair.lastPrice, closeQty, false);
    const pnl = grossPnl - entryFeePortion - exitFee;
    const rMult = pnl / Math.max(pos.exitPlan.riskDistanceR * closeQty, 1e-9);
    this.riskManager.recordRealizedPnl(symbol, pnl, nowMs);
    this.snapshot.recentTrades.unshift({
      id: `${pos.id}-manual`,
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: pair.lastPrice,
      quantity: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason: 'ManualClose',
      closedAtMs: nowMs,
    });
    this.recordExitExecution({
      symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: pair.lastPrice,
      origQty: pos.quantity,
      executedQty: closeQty,
      pnlUsdt: pnl,
      rMultiple: rMult,
      reason: 'ManualClose',
      isPartial: false,
      rationale: `Operator manual MARKET close on ${symbol} @ $${pair.lastPrice.toFixed(2)}`,
      nowMs,
    });
    pair.openPosition = null;
    this.pushLog('info', `Closed ${symbol} manually (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);
    this.syncRiskToSnapshot();
  }

  updateConfig(nextConfig: BotConfig): void {
    const prevVenue = this.config.trading.venue;
    this.config = structuredClone(nextConfig);
    this.config.automation.enabled = this.config.features.automatedTrading;
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
    this.riskManager.resetCircuitBreaker();
    this.snapshot.risk = this.riskManager.status();
    this.pushLog('info', 'Circuit Breaker reset by operator — engine returned to Active');
  }

  flattenAllPositions(nowMs = this.lastClockMs): void {
    for (const pair of this.snapshot.pairs) {
      if (pair.openPosition) {
        const pos = pair.openPosition;
        const closeQty = pos.remainingQuantity;
        const grossPnl =
          pos.side === 'Long'
            ? (pair.lastPrice - pos.entryPrice) * closeQty
            : (pos.entryPrice - pair.lastPrice) * closeQty;
        const entryFeePortion = (pos.feePaidUsdt ?? 0) * (closeQty / Math.max(pos.quantity, 1e-9));
        const exitFee = this.computeExitCommission(pair.lastPrice, closeQty, false);
        const pnl = grossPnl - entryFeePortion - exitFee;
        const rMult = pnl / Math.max(pos.exitPlan.riskDistanceR * closeQty, 1e-9);
        this.riskManager.recordRealizedPnl(pair.symbol, pnl, nowMs);
        this.snapshot.recentTrades.unshift({
          id: `${pos.id}-flat`,
          symbol: pair.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: pair.lastPrice,
          quantity: closeQty,
          pnlUsdt: pnl,
          rMultiple: rMult,
          reason: 'CircuitBreakerFlatten',
          closedAtMs: nowMs,
        });
        this.recordExitExecution({
          symbol: pair.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: pair.lastPrice,
          origQty: pos.quantity,
          executedQty: closeQty,
          pnlUsdt: pnl,
          rMultiple: rMult,
          reason: 'CircuitBreakerFlatten',
          isPartial: false,
          rationale: `Circuit Breaker emergency flatten on ${pair.symbol}`,
          nowMs,
        });
        pair.openPosition = null;
      }
    }
    this.snapshot.recentTrades = this.snapshot.recentTrades.slice(0, 60);
    this.syncRiskToSnapshot();
  }

  /**
   * Deterministic simulation step advancing all pairs by 1 bar (or applying an external live candle).
   */
  stepBar(nowMs = Date.now(), externalBar?: { symbol: string; candle: Candle }): void {
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
        const close = Math.max(0.01, open * (1 + wave + impulse));
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

      if (existingIdx !== -1) {
        const wasClosed = pair.candles[existingIdx].isClosed;
        const updatedCandles = pair.candles.slice();
        updatedCandles[existingIdx] = nextCandle;
        pair.candles = updatedCandles;
        if (nextCandle.isClosed && !wasClosed) {
          ind = pipe.update(nextCandle);
          const updatedHist = pair.indicatorHistory.slice();
          updatedHist[existingIdx] = ind;
          pair.indicatorHistory = updatedHist;
        }
      } else {
        pair.candles = [...pair.candles.slice(-219), nextCandle];
        // Never mutate stateful EMA/RSI/ATR/ADX/VWAP accumulators on unclosed forming bars
        ind = nextCandle.isClosed ? pipe.update(nextCandle) : pipe.snapshot();
        pair.indicatorHistory = [...pair.indicatorHistory.slice(-219), ind];
      }

      pair.indicators = ind;
      pair.lastPrice = nextCandle.close;
      const firstClose = pair.candles[0]?.close ?? nextCandle.close;
      pair.change24hPct = ((nextCandle.close - firstClose) / firstClose) * 100;

      // Monitor ATR volatility spikes only on confirmed closed candles
      if (nextCandle.isClosed) {
        this.evaluatePairVolatilitySpike(
          pair,
          nextCandle,
          prevCandle?.close ?? nextCandle.open,
          nowMs
        );
      }

      // 0. Check resting LIMIT / LIMIT_MAKER orders for Paper fills
      if (this.snapshot.accountMode === 'Paper' && !pair.openPosition) {
        const matchIdx = this.snapshot.pendingOrders.findIndex((o) => {
          if (o.symbol !== pair.symbol) return false;
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

      // 1. Manage existing open position (evaluates every price tick including forming bars)
      if (pair.openPosition) {
        const pos = pair.openPosition;
        const atrVal = ind.atr ?? pos.exitPlan.riskDistanceR;
        const action = managePositionTick(
          pos,
          nextCandle.close,
          atrVal,
          this.config.exits,
          this.config.features
        );

        if (this.snapshot.accountMode === 'Live') {
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
          const grossPnl =
            pos.side === 'Long'
              ? (action.exitPrice - pos.entryPrice) * closeQty
              : (pos.entryPrice - action.exitPrice) * closeQty;
          const entryFeePortion = (pos.feePaidUsdt ?? 0) * (closeQty / Math.max(pos.quantity, 1e-9));
          const exitFee = this.computeExitCommission(action.exitPrice, closeQty, true);
          const pnl = grossPnl - entryFeePortion - exitFee;
          const tp1RMult = pnl / Math.max(pos.exitPlan.riskDistanceR * closeQty, 1e-9);
          pos.remainingQuantity -= closeQty;
          pos.realizedPnlUsdt += pnl;
          this.riskManager.recordRealizedPnl(pair.symbol, pnl, nowMs);
          this.snapshot.recentTrades.unshift({
            id: `${pos.id}-tp1`,
            symbol: pair.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: action.exitPrice,
            quantity: closeQty,
            pnlUsdt: pnl,
            rMultiple: tp1RMult,
            reason: action.reason,
            closedAtMs: nowMs,
          });
          this.recordExitExecution({
            symbol: pair.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: action.exitPrice,
            origQty: pos.quantity,
            executedQty: closeQty,
            pnlUsdt: pnl,
            rMultiple: tp1RMult,
            reason: action.reason,
            isPartial: true,
            rationale: `${pair.symbol} TP1 partial scale-out (${Math.round(action.ratio * 100)}%) @ $${action.exitPrice.toFixed(2)}`,
            nowMs,
          });
          this.pushLog('info', `${pair.symbol} TP1 partial hit (+$${pnl.toFixed(2)} · ${tp1RMult.toFixed(2)}R)`);
        } else if (action.type === 'FullClose') {
          const closeQty = pos.remainingQuantity;
          const grossPnl =
            pos.side === 'Long'
              ? (action.exitPrice - pos.entryPrice) * closeQty
              : (pos.entryPrice - action.exitPrice) * closeQty;
          const entryFeePortion = (pos.feePaidUsdt ?? 0) * (closeQty / Math.max(pos.quantity, 1e-9));
          const isMakerExit = action.reason === 'TakeProfit1' || action.reason === 'TakeProfit2';
          const exitFee = this.computeExitCommission(action.exitPrice, closeQty, isMakerExit);
          const pnl = grossPnl - entryFeePortion - exitFee;
          const rMult = pnl / Math.max(pos.exitPlan.riskDistanceR * closeQty, 1e-9);
          this.riskManager.recordRealizedPnl(pair.symbol, pnl, nowMs);
          this.snapshot.recentTrades.unshift({
            id: `${pos.id}-exit`,
            symbol: pair.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: action.exitPrice,
            quantity: closeQty,
            pnlUsdt: pnl,
            rMultiple: rMult,
            reason: action.reason,
            closedAtMs: nowMs,
          });
          this.recordExitExecution({
            symbol: pair.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: action.exitPrice,
            origQty: pos.quantity,
            executedQty: closeQty,
            pnlUsdt: pnl,
            rMultiple: rMult,
            reason: action.reason,
            isPartial: false,
            rationale: `${pair.symbol} full exit (${action.reason}) @ $${action.exitPrice.toFixed(2)}`,
            nowMs,
          });
          this.pushLog(
            pnl >= 0 ? 'info' : 'warn',
            `${pair.symbol} closed (${action.reason}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${rMult.toFixed(2)}R)`
          );
          pair.openPosition = null;
          if (
            this.config.features.circuitBreaker &&
            this.riskManager.status().state === 'Halted' &&
            this.config.risk.flattenOnCircuitBreaker
          ) {
            this.flattenAllPositions(nowMs);
          }
        }
      } else if (autoActive && nextCandle.isClosed) {
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
    if (!this.config.features.signalGenerator) {
      this.pushLog('warn', 'Auto-scan skipped: Signal Generator is disabled in Feature Toggles.');
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

    const lastTick = this.lastSignalTick.get(pair.symbol) ?? -9999;
    if (!ignoreCooldown && this.snapshot.tickCount - lastTick < auto.signalCooldownBars) {
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
      }
    );

    if (!sig) return { signalDetected: false, dispatched: false };

    this.snapshot.autoStats.signalsDetected += 1;
    this.lastSignalTick.set(pair.symbol, this.snapshot.tickCount);

    const plan = buildExitPlan(sig.side, sig.entryPrice, sig.atr, this.config.exits);
    const openCount =
      this.snapshot.pairs.filter((p) => p.openPosition !== null).length +
      this.snapshot.pendingOrders.length;
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

    const leverage = activeVenue === 'Futures' ? Math.max(1, this.config.trading.leverage) : 1;
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

    const desiredNotional = Math.min(
      Math.max(10, quantSizing.notionalUsdt),
      Math.max(0, this.snapshot.availableBalanceUsdt * leverage)
    );
    if (desiredNotional < 10) {
      pair.lastSignalNote = 'Auto signal skipped: insufficient available USDT';
      return { signalDetected: true, dispatched: false };
    }

    const offsetFrac = Math.max(0, auto.limitOffsetBps) / 10_000;
    const limitPrice =
      sig.side === 'Long'
        ? Number((sig.entryPrice * (1 - offsetFrac)).toFixed(sig.entryPrice >= 100 ? 2 : 4))
        : Number((sig.entryPrice * (1 + offsetFrac)).toFixed(sig.entryPrice >= 100 ? 2 : 4));

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
      const pending: PendingOrder = {
        id: `${sig.symbol}-auto-lim-${nowMs}`,
        symbol: sig.symbol,
        side: sig.side,
        orderType,
        orderMethod: auto.orderMethod,
        usdtAmount: desiredNotional,
        limitPrice,
        timeInForce: auto.timeInForce,
        stopLossMode: 'ATR',
        stopLossPct: 1.5,
        useBreakEven: true,
        useTrailingStop: true,
        targets: autoInput.targets,
        createdAtMs: nowMs,
      };
      this.snapshot.pendingOrders.unshift(pending);
      this.pushLog(
        'info',
        `[AUTO · ${auto.strategyProfile}] Resting ${orderType} ${sig.symbol} ${sig.side} $${desiredNotional.toFixed(2)} @ $${limitPrice.toFixed(2)}`
      );
      this.snapshot.autoStats.lastActionSummary = `Paper ${orderType} ${sig.symbol} @ $${limitPrice.toFixed(2)}`;
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
    const entryPrice = Number((refPrice * 1.015).toFixed(2));
    const exitPrice = Number(refPrice.toFixed(2));
    const qty = Number((absLoss / Math.max(entryPrice - exitPrice, 0.01)).toFixed(4));
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
    const posLocked = this.snapshot.pairs.reduce(
      (sum, p) => sum + (p.openPosition?.lockedMarginUsdt ?? 0),
      0
    );
    const leverage =
      this.config.trading.venue === 'Futures' ? Math.max(1, this.config.trading.leverage) : 1;
    const pendingLocked = this.snapshot.pendingOrders.reduce(
      (sum, o) => sum + o.usdtAmount / leverage,
      0
    );
    const locked = posLocked + pendingLocked;
    this.snapshot.lockedBalanceUsdt = locked;
    this.snapshot.availableBalanceUsdt = Math.max(0, this.snapshot.risk.currentEquity - locked);

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
