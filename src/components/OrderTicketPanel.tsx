import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Plus, Save, ShieldCheck, Sliders, X, XCircle } from 'lucide-react';
import {
  calculateQuantitativePositionSizeUsdt,
  computeExpectancyStats,
  computeKellySizingAnalytics,
  computePortfolioCorrelationMatrix,
  evaluatePreTradeValidation,
} from '../engine/quantAnalytics';
import type {
  BotConfig,
  EngineSnapshot,
  ExchangeVenue,
  LiveCredentialStatus,
  ManualOrderInput,
  MarginType,
  OrderType,
  PairRuntimeState,
  PositionSizingMode,
  Side,
} from '../engine/types';

interface OrderTicketPanelProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  activePair: PairRuntimeState;
  liveStatus: LiveCredentialStatus;
  liveTicker?: { symbol: string; bid: number; ask: number; last: number } | null;
  isRemoteVpsDaemon?: boolean;
  onSelectSymbol: (symbol: string) => void;
  onSubmitOrder: (input: ManualOrderInput) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>;
  onToggleFeedSource: (source: 'Simulated' | 'BinanceLive') => void;
  onOpenLiveCredentials: () => void;
  onUpdateVenue: (venue: ExchangeVenue) => void;
  onUpdateFuturesSettings: (leverage: number, marginType: MarginType) => void;
}

interface TpDraft {
  id: string;
  pctOffset: number;
  allocationPct: number;
}

export const OrderTicketPanel: React.FC<OrderTicketPanelProps> = ({
  snapshot,
  config,
  activePair,
  liveStatus,
  liveTicker,
  isRemoteVpsDaemon = false,
  onSelectSymbol,
  onSubmitOrder,
  onToggleFeedSource,
  onOpenLiveCredentials,
  onUpdateVenue,
  onUpdateFuturesSettings,
}) => {
  const [orderType, setOrderType] = useState<OrderType>('OCO SELL');
  const [side, setSide] = useState<Side>('Long');
  const [amountUnit, setAmountUnit] = useState<'USDT' | '%'>('USDT');
  const [usdtAmount, setUsdtAmount] = useState<number>(250);
  const [allocPct, setAllocPct] = useState<number>(25);
  const [limitPriceInput, setLimitPriceInput] = useState<string>('');
  const [isCustomLimitPrice, setIsCustomLimitPrice] = useState<boolean>(false);
  const [timeInForce, setTimeInForce] = useState<'GTC' | 'IOC' | 'FOK'>('GTC');

  const [stopLossMode, setStopLossMode] = useState<'ATR' | 'MARKET' | 'LIMIT'>('ATR');
  const [stopLossPct, setStopLossPct] = useState<number>(1.5);
  const [useBreakEven, setUseBreakEven] = useState<boolean>(true);
  const [useTrailingStop, setUseTrailingStop] = useState<boolean>(true);

  const [tpMode, setTpMode] = useState<'MARKET' | 'ATR'>('MARKET');
  const [targets, setTargets] = useState<TpDraft[]>([
    { id: 't1', pctOffset: 2.5, allocationPct: 50 },
    { id: 't2', pctOffset: 3.6, allocationPct: 50 },
  ]);

  const activeVenue = config.trading.venue;
  const [sizingMode, setSizingMode] = useState<PositionSizingMode>(
    config.trading.positionSizingMode ?? 'fixed_usdt'
  );
  const [showNineStepChecklist, setShowNineStepChecklist] = useState(false);
  const [triggerRef, setTriggerRef] = useState<'LAST' | 'MARK'>(
    activeVenue === 'Futures' ? 'MARK' : 'LAST'
  );
  const [showAdvance, setShowAdvance] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    setSizingMode(config.trading.positionSizingMode ?? 'fixed_usdt');
  }, [config.trading.positionSizingMode]);

  React.useEffect(() => {
    if (activeVenue === 'Spot') {
      if (side === 'Short') setSide('Long');
      if (orderType === 'OCO BUY') setOrderType('OCO SELL');
    }
  }, [activeVenue, side, orderType]);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem('apexrust_ticket_preset');
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<{
        orderType: OrderType;
        side: Side;
        amountUnit: 'USDT' | '%';
        usdtAmount: number;
        allocPct: number;
        timeInForce: 'GTC' | 'IOC' | 'FOK';
        sizingMode: PositionSizingMode;
        stopLossMode: 'ATR' | 'MARKET' | 'LIMIT';
        stopLossPct: number;
        useBreakEven: boolean;
        useTrailingStop: boolean;
        tpMode: 'MARKET' | 'ATR';
        triggerRef: 'LAST' | 'MARK';
        targets: TpDraft[];
      }>;
      if (saved.orderType) setOrderType(saved.orderType);
      if (saved.side) setSide(saved.side);
      if (saved.amountUnit === 'USDT' || saved.amountUnit === '%') setAmountUnit(saved.amountUnit);
      if (typeof saved.usdtAmount === 'number' && saved.usdtAmount >= 0) setUsdtAmount(saved.usdtAmount);
      if (typeof saved.allocPct === 'number' && saved.allocPct >= 0) setAllocPct(saved.allocPct);
      if (saved.timeInForce === 'GTC' || saved.timeInForce === 'IOC' || saved.timeInForce === 'FOK') {
        setTimeInForce(saved.timeInForce);
      }
      if (saved.sizingMode) setSizingMode(saved.sizingMode);
      if (saved.stopLossMode) setStopLossMode(saved.stopLossMode);
      if (typeof saved.stopLossPct === 'number') setStopLossPct(saved.stopLossPct);
      if (typeof saved.useBreakEven === 'boolean') setUseBreakEven(saved.useBreakEven);
      if (typeof saved.useTrailingStop === 'boolean') setUseTrailingStop(saved.useTrailingStop);
      if (saved.tpMode) setTpMode(saved.tpMode);
      if (saved.triggerRef === 'LAST' || saved.triggerRef === 'MARK') setTriggerRef(saved.triggerRef);
      if (Array.isArray(saved.targets) && saved.targets.length > 0) setTargets(saved.targets);
    } catch {
      // Ignore invalid localStorage payload
    }
  }, []);

  const hasLiveBook =
    snapshot.transport.feedSource === 'BinanceLive' &&
    liveTicker != null &&
    liveTicker.symbol === activePair.symbol &&
    liveTicker.last > 0;
  const last = hasLiveBook ? liveTicker!.last : activePair.lastPrice;
  const priceDecimals = last >= 100 ? 2 : last >= 1 ? 4 : 6;
  const spread = last * 0.0002;
  const bid =
    hasLiveBook && liveTicker!.bid > 0
      ? liveTicker!.bid
      : (activePair.bestBid ?? 0) > 0
        ? activePair.bestBid!
        : last - spread;
  const ask =
    hasLiveBook && liveTicker!.ask > 0
      ? liveTicker!.ask
      : (activePair.bestAsk ?? 0) > 0
        ? activePair.bestAsk!
        : last + spread;
  const computedSpreadBps =
    (activePair.spreadBps ?? 0) > 0
      ? activePair.spreadBps!
      : bid > 0 && ask >= bid
        ? ((ask - bid) / bid) * 10000
        : 0;

  const atrExitsEnabled = config.features.atrDynamicExits;
  const tpLadderEnabled = config.features.takeProfitLadder;
  const breakEvenEnabled = config.features.breakEvenStop;
  const trailingEnabled = config.features.trailingStop;
  const effectiveOrderType: OrderType =
    !tpLadderEnabled &&
    (orderType === 'OCO SELL' || orderType === 'OCO BUY' || orderType === 'ATR SCALP')
      ? 'MARKET'
      : activeVenue === 'Spot' && orderType === 'OCO BUY'
        ? 'OCO SELL'
        : orderType;
  const effectiveStopLossMode = !atrExitsEnabled && stopLossMode === 'ATR' ? 'MARKET' : stopLossMode;
  const effectiveTpMode = !atrExitsEnabled && tpMode === 'ATR' ? 'MARKET' : tpMode;
  const effectiveUseBreakEven = breakEvenEnabled && useBreakEven;
  const effectiveUseTrailing = trailingEnabled && useTrailingStop;

  const isLimitOrderType = effectiveOrderType === 'LIMIT' || effectiveOrderType === 'LIMIT MAKER';
  const defaultLimitStr = (side === 'Long' ? bid : ask).toFixed(priceDecimals);
  const displayedLimitPrice = isCustomLimitPrice ? limitPriceInput : defaultLimitStr;

  const feedbackTimerRef = React.useRef<number | null>(null);
  const [tpCustomEdited, setTpCustomEdited] = useState(false);

  React.useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const scheduleClearFeedback = (ms: number) => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), ms);
  };

  // Reset custom limit price flag and manual TP override when symbol changes
  React.useEffect(() => {
    setIsCustomLimitPrice(false);
    setTpCustomEdited(false);
  }, [activePair.symbol]);

  // Keep TP targets dynamically scaled to ATR when effectiveTpMode === 'ATR' (unless user edited targets)
  React.useEffect(() => {
    if (effectiveTpMode !== 'ATR' || tpCustomEdited || last <= 0) return;
    const atr = activePair.indicators.atr ?? last * 0.01;
    const tp1Pct = Number((((atr * config.exits.atrTp1Multiplier) / last) * 100).toFixed(2));
    const tp2Pct = Number((((atr * config.exits.atrTp2Multiplier) / last) * 100).toFixed(2));
    const tp1Alloc = Math.round(config.exits.tp1CloseRatio * 100);
    const nextT1Pct = Math.max(0.2, tp1Pct);
    const nextT2Pct = Math.max(0.4, tp2Pct);
    const nextT1Alloc = Math.min(95, Math.max(5, tp1Alloc));
    const nextT2Alloc = Math.max(5, 100 - nextT1Alloc);
    setTargets((prev) => {
      if (
        prev.length === 2 &&
        prev[0]?.pctOffset === nextT1Pct &&
        prev[0]?.allocationPct === nextT1Alloc &&
        prev[1]?.pctOffset === nextT2Pct &&
        prev[1]?.allocationPct === nextT2Alloc
      ) {
        return prev;
      }
      return [
        { id: 't1', pctOffset: nextT1Pct, allocationPct: nextT1Alloc },
        { id: 't2', pctOffset: nextT2Pct, allocationPct: nextT2Alloc },
      ];
    });
  }, [
    effectiveTpMode,
    tpCustomEdited,
    activePair.symbol,
    activePair.indicators.atr,
    last,
    config.exits.atrTp1Multiplier,
    config.exits.atrTp2Multiplier,
    config.exits.tp1CloseRatio,
  ]);

  const entryReferencePrice = useMemo(() => {
    const parsedLim = Number(displayedLimitPrice);
    if (isLimitOrderType && Number.isFinite(parsedLim) && parsedLim > 0) {
      return parsedLim;
    }
    return last;
  }, [displayedLimitPrice, isLimitOrderType, last]);

  const computedStopLossPrice = useMemo(() => {
    const atr = activePair.indicators.atr ?? entryReferencePrice * 0.01;
    const dist =
      effectiveStopLossMode === 'ATR' && atrExitsEnabled
        ? atr * config.exits.atrSlMultiplier
        : entryReferencePrice * (Math.max(0.2, stopLossPct) / 100);
    return side === 'Long'
      ? Math.max(0.0001, entryReferencePrice - dist)
      : entryReferencePrice + dist;
  }, [
    activePair.indicators.atr,
    atrExitsEnabled,
    config.exits.atrSlMultiplier,
    effectiveStopLossMode,
    entryReferencePrice,
    side,
    stopLossPct,
  ]);

  const expectancyStats = useMemo(
    () => computeExpectancyStats(snapshot.recentTrades, config.trading.baseRiskPerTradePct),
    [snapshot.recentTrades, config.trading.baseRiskPerTradePct]
  );

  const stopDistFrac = useMemo(
    () =>
      entryReferencePrice > 0
        ? Math.max(0.002, Math.abs(entryReferencePrice - computedStopLossPrice) / entryReferencePrice)
        : 0.015,
    [entryReferencePrice, computedStopLossPrice]
  );

  const kellyStats = useMemo(
    () =>
      computeKellySizingAnalytics(
        expectancyStats,
        snapshot.risk.currentEquity,
        stopDistFrac,
        config.trading.baseRiskPerTradePct
      ),
    [expectancyStats, snapshot.risk.currentEquity, stopDistFrac, config.trading.baseRiskPerTradePct]
  );

  const portfolioCorr = useMemo(
    () => computePortfolioCorrelationMatrix(snapshot.pairs, kellyStats.halfKellyPct),
    [snapshot.pairs, kellyStats.halfKellyPct]
  );

  const manualBaseUsdt = useMemo(() => {
    if (amountUnit === '%') {
      return Number(((snapshot.availableBalanceUsdt * allocPct) / 100).toFixed(2));
    }
    return usdtAmount;
  }, [amountUnit, allocPct, usdtAmount, snapshot.availableBalanceUsdt]);

  const quantPositionSize = useMemo(
    () =>
      calculateQuantitativePositionSizeUsdt({
        mode: sizingMode,
        fixedUsdt: manualBaseUsdt,
        equityUsdt: snapshot.risk.currentEquity,
        availableBalanceUsdt: snapshot.availableBalanceUsdt,
        baseRiskPerTradePct: config.trading.baseRiskPerTradePct,
        entryPrice: entryReferencePrice,
        stopLossPrice: computedStopLossPrice,
        kelly: kellyStats,
        venue: config.trading.venue,
        leverage: config.trading.leverage,
        diversificationMultiplier: portfolioCorr.diversificationMultiplier,
      }),
    [
      sizingMode,
      manualBaseUsdt,
      snapshot.risk.currentEquity,
      snapshot.availableBalanceUsdt,
      config.trading.baseRiskPerTradePct,
      entryReferencePrice,
      computedStopLossPrice,
      kellyStats,
      config.trading.venue,
      config.trading.leverage,
      portfolioCorr.diversificationMultiplier,
    ]
  );

  const effectiveUsdt = quantPositionSize.notionalUsdt;

  const preTradeValidation = useMemo(() => {
    const tp1Pct = targets[0]?.pctOffset ?? 2.5;
    const tp2Pct = targets[targets.length - 1]?.pctOffset ?? 3.6;
    const tp1Price =
      side === 'Long'
        ? entryReferencePrice * (1 + tp1Pct / 100)
        : entryReferencePrice * (1 - tp1Pct / 100);
    const tp2Price =
      side === 'Long'
        ? entryReferencePrice * (1 + tp2Pct / 100)
        : entryReferencePrice * (1 - tp2Pct / 100);
    return evaluatePreTradeValidation({
      pair: activePair,
      side,
      entryPrice: entryReferencePrice,
      stopLossPrice: computedStopLossPrice,
      takeProfit1Price: tp1Price,
      takeProfit2Price: tp2Price,
      notionalUsdt: effectiveUsdt,
      equityUsdt: snapshot.risk.currentEquity,
      config,
    });
  }, [
    targets,
    side,
    entryReferencePrice,
    activePair,
    computedStopLossPrice,
    effectiveUsdt,
    snapshot.risk.currentEquity,
    config,
  ]);

  const handleSliderPct = (pct: number) => {
    setSizingMode('fixed_usdt');
    setAllocPct(pct);
    if (pct === 0) {
      setUsdtAmount(0);
      return;
    }
    const rawVal = Number(((snapshot.availableBalanceUsdt * pct) / 100).toFixed(2));
    setUsdtAmount(snapshot.availableBalanceUsdt >= 10 ? Math.max(10, rawVal) : rawVal);
  };

  const handleAddTarget = () => {
    if (targets.length >= 4) return;
    setTpCustomEdited(true);
    const prev = targets[targets.length - 1];
    setTargets([
      ...targets,
      {
        id: `t-${Date.now()}`,
        pctOffset: Number(((prev?.pctOffset ?? 2.0) + 1.2).toFixed(1)),
        allocationPct: 25,
      },
    ]);
  };

  const handleRemoveTarget = (id: string) => {
    if (targets.length <= 1) return;
    setTpCustomEdited(true);
    setTargets(targets.filter((t) => t.id !== id));
  };

  const handleSubmit = async () => {
    if (
      !manualAllowed ||
      submitting ||
      quantPositionSize.blockedByNegativeKelly ||
      effectiveUsdt < 10
    ) {
      return;
    }
    const parsedLimit = Number(displayedLimitPrice);
    setSubmitting(true);
    try {
      const res = await onSubmitOrder({
        symbol: activePair.symbol,
        orderType: effectiveOrderType,
        side: activeVenue === 'Spot' ? 'Long' : side,
        usdtAmount: effectiveUsdt,
        limitPrice:
          isLimitOrderType && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? parsedLimit
            : undefined,
        timeInForce: effectiveOrderType === 'LIMIT' ? timeInForce : 'GTC',
        stopLossMode: effectiveStopLossMode,
        stopLossPct,
        useBreakEven: effectiveUseBreakEven,
        useTrailingStop: effectiveUseTrailing,
        workingType:
          activeVenue === 'Futures'
            ? triggerRef === 'MARK'
              ? 'MARK_PRICE'
              : 'CONTRACT_PRICE'
            : undefined,
        targets: tpLadderEnabled
          ? targets.map((t) => ({
              pctOffset: t.pctOffset,
              allocationPct: t.allocationPct,
            }))
          : [],
      });

      if (res.ok) {
        setFeedback({
          type: 'ok',
          text: res.warning
            ? `${snapshot.accountMode} ${activePair.symbol} filled · Warning: ${res.warning}`
            : `${snapshot.accountMode} ${activePair.symbol} ${side} ${effectiveOrderType} submitted`,
        });
      } else {
        setFeedback({ type: 'err', text: res.reason });
      }
      scheduleClearFeedback(5000);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSavePreset = () => {
    try {
      window.localStorage.setItem(
        'apexrust_ticket_preset',
        JSON.stringify({
          orderType,
          side,
          amountUnit,
          usdtAmount,
          allocPct,
          timeInForce,
          sizingMode,
          stopLossMode,
          stopLossPct,
          useBreakEven,
          useTrailingStop,
          tpMode,
          triggerRef,
          targets,
        })
      );
    } catch {
      // Ignore storage quota errors
    }
    setFeedback({
      type: 'ok',
      text: `Saved ${orderType} preset (${targets.length} TP targets, ${stopLossMode} SL)`,
    });
    scheduleClearFeedback(3000);
  };

  const coinCode = activePair.symbol.replace('USDT', '');
  const leverage = config.trading.leverage;
  const marginType = config.trading.marginType;
  const requiredMargin =
    activeVenue === 'Futures' ? effectiveUsdt / Math.max(1, leverage) : effectiveUsdt;
  const manualAllowed =
    config.features.manualTrading &&
    (activeVenue === 'Spot' ? config.features.spotMarket : config.features.futuresMarket);

  return (
    <section
      aria-label="Order and ATR Strategy Ticket"
      className="flex flex-col justify-between rounded-xl border border-white/[0.06] bg-[#141820] p-4"
    >
      <div className="space-y-3.5">
        {/* Isolated Execution Mode Banner */}
        <div
          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${
            snapshot.accountMode === 'Live'
              ? liveStatus.armedForLiveOrders
                ? 'border-amber-400/40 bg-amber-950/35 text-amber-200'
                : 'border-rose-500/35 bg-rose-950/30 text-rose-200'
              : 'border-emerald-500/25 bg-emerald-950/25 text-[#7DF2AD]'
          }`}
        >
          <span>
            {snapshot.accountMode === 'Live'
              ? `${isRemoteVpsDaemon ? '☁️ REMOTE VPS · ' : '🖥️ LOCAL · '}LIVE · ${liveStatus.environment} (${liveStatus.armedForLiveOrders ? 'ARMED' : 'DISARMED'})`
              : 'PAPER SANDBOX · ISOLATED'}
          </span>
          {snapshot.accountMode === 'Live' ? (
            <button
              type="button"
              onClick={onOpenLiveCredentials}
              className="underline decoration-dotted hover:text-white"
            >
              {liveStatus.configured ? 'API Vault' : 'Setup Keys'}
            </button>
          ) : (
            <span className="font-mono text-[10px] text-slate-400">Virtual USDT</span>
          )}
        </div>

        {/* Binance Spot vs USD-M Futures Venue Switcher */}
        <div className="space-y-2">
          <div
            className="grid grid-cols-2 rounded-lg border border-white/[0.08] bg-[#0D1015] p-0.5"
            role="group"
            aria-label="Binance exchange venue"
          >
            <button
              type="button"
              onClick={() => onUpdateVenue('Spot')}
              disabled={!config.features.spotMarket}
              className={`rounded-md py-1.5 text-xs font-semibold transition whitespace-nowrap disabled:opacity-40 ${
                activeVenue === 'Spot'
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Binance Spot
            </button>
            <button
              type="button"
              onClick={() => onUpdateVenue('Futures')}
              disabled={!config.features.futuresMarket}
              className={`rounded-md py-1.5 text-xs font-semibold transition whitespace-nowrap disabled:opacity-40 ${
                activeVenue === 'Futures'
                  ? 'bg-amber-400 text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              USD-M Futures
            </button>
          </div>

          {activeVenue === 'Futures' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-2.5 py-1.5">
                <label htmlFor="ticket-leverage" className="text-[11px] text-slate-400">
                  Leverage
                </label>
                <select
                  id="ticket-leverage"
                  disabled={!config.features.futuresMarket}
                  value={leverage}
                  onChange={(e) => onUpdateFuturesSettings(Number(e.target.value), marginType)}
                  className="bg-transparent font-mono text-xs font-semibold text-amber-300 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {[1, 2, 3, 5, 10, 15, 20].map((lv) => (
                    <option key={lv} value={lv} className="bg-[#141820]">
                      {lv}x
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-2.5 py-1.5">
                <label htmlFor="ticket-margin-type" className="text-[11px] text-slate-400">
                  Margin
                </label>
                <select
                  id="ticket-margin-type"
                  disabled={!config.features.futuresMarket}
                  value={marginType}
                  onChange={(e) => onUpdateFuturesSettings(leverage, e.target.value as MarginType)}
                  className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <option value="ISOLATED" className="bg-[#141820]">ISOLATED</option>
                  <option value="CROSSED" className="bg-[#141820]">CROSSED</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Order Type Row */}
        <div className={`flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2 ${!manualAllowed ? 'opacity-50' : ''}`}>
          <label htmlFor="ticket-order-type" className="text-xs text-slate-400">
            Order
          </label>
          <div className="flex items-center gap-2">
            <select
              id="ticket-order-type"
              disabled={!manualAllowed}
              value={effectiveOrderType}
              onChange={(e) => {
                const next = e.target.value as OrderType;
                setOrderType(next);
                const nextSide =
                  next === 'OCO SELL' ? 'Long' : next === 'OCO BUY' ? 'Short' : side;
                setSide(nextSide);
                setIsCustomLimitPrice(false);
                if (next === 'LIMIT' || next === 'LIMIT MAKER') {
                  const defaultPx = nextSide === 'Long' ? bid : ask;
                  setLimitPriceInput(defaultPx.toFixed(priceDecimals));
                }
              }}
              className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none disabled:cursor-not-allowed"
            >
              <option value="OCO SELL" disabled={!tpLadderEnabled} className="bg-[#141820]">OCO SELL</option>
              <option value="OCO BUY" disabled={!tpLadderEnabled || activeVenue === 'Spot'} className="bg-[#141820]">OCO BUY</option>
              <option value="ATR SCALP" disabled={!tpLadderEnabled} className="bg-[#141820]">ATR SCALP</option>
              <option value="MARKET" className="bg-[#141820]">MARKET</option>
              <option value="LIMIT" className="bg-[#141820]">LIMIT</option>
              <option value="LIMIT MAKER" className="bg-[#141820]">LIMIT MAKER</option>
            </select>
            <button
              type="button"
              disabled={!manualAllowed || activeVenue === 'Spot'}
              title={activeVenue === 'Spot' ? 'Binance Spot supports Long entries only; switch to Futures for Short.' : 'Toggle Long / Short side'}
              onClick={() => {
                if (activeVenue === 'Spot') return;
                const nextSide = side === 'Long' ? 'Short' : 'Long';
                setSide(nextSide);
                setIsCustomLimitPrice(false);
                if (isLimitOrderType) {
                  const defaultPx = nextSide === 'Long' ? bid : ask;
                  setLimitPriceInput(defaultPx.toFixed(priceDecimals));
                }
              }}
              className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold transition disabled:cursor-not-allowed ${
                side === 'Long'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-rose-500/20 text-rose-300'
              }`}
            >
              {side.toUpperCase()}
            </button>
          </div>
        </div>

        {/* Interactive Limit Price + TIF Block when LIMIT / LIMIT MAKER selected */}
        {isLimitOrderType && (
          <div className={`space-y-2 rounded-lg border border-white/[0.06] bg-[#0D1015] p-2.5 ${!manualAllowed ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="ticket-limit-price" className="text-xs text-slate-400">
                Limit Price
              </label>
              <div className="flex items-center gap-1 font-mono text-[10px]">
                <button
                  type="button"
                  disabled={!manualAllowed}
                  onClick={() => {
                    setIsCustomLimitPrice(true);
                    setLimitPriceInput(bid.toFixed(priceDecimals));
                  }}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-emerald-300 hover:border-emerald-400/50 disabled:cursor-not-allowed"
                >
                  Bid
                </button>
                <button
                  type="button"
                  disabled={!manualAllowed}
                  onClick={() => {
                    setIsCustomLimitPrice(true);
                    setLimitPriceInput(last.toFixed(priceDecimals));
                  }}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-slate-300 hover:border-white/30 disabled:cursor-not-allowed"
                >
                  Last
                </button>
                <button
                  type="button"
                  disabled={!manualAllowed}
                  onClick={() => {
                    setIsCustomLimitPrice(true);
                    setLimitPriceInput(ask.toFixed(priceDecimals));
                  }}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-sky-300 hover:border-sky-400/50 disabled:cursor-not-allowed"
                >
                  Ask
                </button>
              </div>
            </div>
            <div className="flex items-stretch gap-2">
              <input
                id="ticket-limit-price"
                type="number"
                step={last >= 100 ? '0.01' : '0.0001'}
                min="0"
                disabled={!manualAllowed}
                value={displayedLimitPrice}
                onChange={(e) => {
                  setIsCustomLimitPrice(true);
                  setLimitPriceInput(e.target.value);
                }}
                className="w-full rounded border border-white/[0.08] bg-[#141820] px-2.5 py-1.5 font-mono text-xs font-semibold tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
              />
              {effectiveOrderType === 'LIMIT' ? (
                <select
                  aria-label="Time In Force"
                  disabled={!manualAllowed}
                  value={timeInForce}
                  onChange={(e) => setTimeInForce(e.target.value as 'GTC' | 'IOC' | 'FOK')}
                  className="rounded border border-white/[0.08] bg-[#141820] px-2 py-1.5 font-mono text-xs font-semibold text-slate-200 focus:outline-none disabled:cursor-not-allowed"
                >
                  <option value="GTC">GTC</option>
                  <option value="IOC">IOC</option>
                  <option value="FOK">FOK</option>
                </select>
              ) : (
                <span className="flex items-center rounded border border-white/[0.08] bg-[#141820] px-2 font-mono text-[10px] font-semibold text-[#7DF2AD] whitespace-nowrap">
                  {activeVenue === 'Futures' ? 'GTX (POST ONLY)' : 'POST ONLY'}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Market / Coin Selector */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <span className="text-xs text-slate-400">Market</span>
              <span className="font-mono text-xs font-semibold text-slate-100">
                {config.trading.quoteAsset || 'USDT'} ·{' '}
                <span className={activeVenue === 'Spot' ? 'text-[#7DF2AD]' : 'text-amber-300'}>
                  {activeVenue === 'Spot' ? 'LONG' : 'L/S'}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <label htmlFor="ticket-coin" className="text-xs text-slate-400">
                Coin
              </label>
              <select
                id="ticket-coin"
                value={activePair.symbol}
                onChange={(e) => onSelectSymbol(e.target.value)}
                className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none"
              >
                {snapshot.pairs.map((p) => (
                  <option key={p.symbol} value={p.symbol} className="bg-[#141820]">
                    {p.symbol.replace(/(USDT|USDC|FDUSD)$/, '')}
                    {p.sourceTag === 'trending'
                      ? ' ★'
                      : p.sourceTag === 'protected_position'
                        ? ' •'
                        : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between px-1 font-mono text-[10px] text-slate-400">
            <span>
              Source:{' '}
              <strong
                className={
                  activePair.sourceTag === 'trending'
                    ? 'text-amber-300'
                    : activePair.sourceTag === 'protected_position'
                      ? 'text-cyan-300'
                      : 'text-[#7DF2AD]'
                }
              >
                {activePair.sourceTag === 'trending'
                  ? 'Auto-Trending'
                  : activePair.sourceTag === 'protected_position'
                    ? 'Protected Position'
                    : 'Pinned Watchlist'}
              </strong>
            </span>
            <span>
              Spread:{' '}
              <strong
                className={
                  computedSpreadBps > (config.indicators.maxSpreadBps ?? 25)
                    ? 'text-amber-300'
                    : 'text-slate-300'
                }
              >
                {computedSpreadBps.toFixed(1)} bps
              </strong>
            </span>
          </div>
        </div>

        {/* Quantitative Position Sizing Mode Selector (§5 Briefing) */}
        <div className={`space-y-1.5 rounded-lg border border-white/[0.06] bg-[#0D1015] p-2.5 ${!manualAllowed ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ticket-sizing-mode" className="text-[11px] font-medium text-slate-400">
              Position Sizing Model
            </label>
            <select
              id="ticket-sizing-mode"
              disabled={!manualAllowed}
              value={sizingMode}
              onChange={(e) => setSizingMode(e.target.value as PositionSizingMode)}
              className="bg-transparent font-mono text-[11px] font-semibold text-[#7DF2AD] focus:outline-none disabled:cursor-not-allowed"
            >
              <option value="fixed_usdt" className="bg-[#141820]">Manual USDT / %</option>
              <option value="fixed_risk_pct" className="bg-[#141820]">
                Fixed Risk ({config.trading.baseRiskPerTradePct}% Equity)
              </option>
              <option value="quarter_kelly" className="bg-[#141820]">
                Quarter-Kelly (0.25f* · {kellyStats.quarterKellyPct.toFixed(1)}%)
              </option>
              <option value="half_kelly" className="bg-[#141820]">
                Half-Kelly (0.50f* · {kellyStats.halfKellyPct.toFixed(1)}%)
              </option>
              <option value="full_kelly" className="bg-[#141820]">
                Full Kelly (1.00f* · {kellyStats.fullKellyPct.toFixed(1)}%)
              </option>
            </select>
          </div>
          {sizingMode !== 'fixed_usdt' && (
            <div className="flex items-center justify-between border-t border-white/[0.05] pt-1.5 font-mono text-[10px] text-slate-400">
              <span>
                Dollar Risk: <strong className="text-amber-300">${quantPositionSize.dollarRiskUsdt.toFixed(2)}</strong> ({quantPositionSize.riskFractionPct.toFixed(2)}%)
              </span>
              <span>
                SL Dist: <strong className="text-slate-200">{quantPositionSize.stopDistancePct.toFixed(2)}%</strong>
              </span>
            </div>
          )}
        </div>

        {/* Amount Input + Mint % Toggle */}
        <div className={`flex items-stretch overflow-hidden rounded-lg border border-white/[0.06] bg-[#0D1015] ${!manualAllowed ? 'opacity-50' : ''}`}>
          <button
            type="button"
            disabled={!manualAllowed}
            onClick={() => {
              setSizingMode('fixed_usdt');
              setAmountUnit((u) => (u === 'USDT' ? '%' : 'USDT'));
            }}
            className="flex items-center border-r border-white/[0.06] px-3 text-xs font-medium text-slate-300 transition hover:text-white disabled:cursor-not-allowed"
          >
            <span>{amountUnit === 'USDT' ? 'USDT' : `${coinCode} %`}</span>
            <ChevronDown className="ml-1 h-3 w-3 text-slate-500" aria-hidden="true" />
          </button>
          <label htmlFor="ticket-usdt-input" className="sr-only">
            Order Allocation
          </label>
          <input
            id="ticket-usdt-input"
            type="number"
            disabled={!manualAllowed}
            min={sizingMode === 'fixed_usdt' && amountUnit === '%' ? 1 : 10}
            max={sizingMode === 'fixed_usdt' && amountUnit === '%' ? 100 : undefined}
            step={sizingMode === 'fixed_usdt' && amountUnit === '%' ? 5 : 10}
            value={sizingMode === 'fixed_usdt' ? (amountUnit === 'USDT' ? usdtAmount : allocPct) : effectiveUsdt}
            onChange={(e) => {
              const v = Math.max(0, Number(e.target.value) || 0);
              setSizingMode('fixed_usdt');
              if (amountUnit === 'USDT') setUsdtAmount(v);
              else setAllocPct(Math.min(100, v));
            }}
            className="w-full bg-transparent px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-100 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            disabled={!manualAllowed}
            onClick={() => {
              setSizingMode('fixed_usdt');
              setAmountUnit((u) => (u === 'USDT' ? '%' : 'USDT'));
            }}
            aria-label="Toggle allocation unit"
            className="bg-[#7DF2AD] px-3 font-mono text-xs font-bold text-[#0B0F17] transition hover:bg-[#9AF7BF] disabled:cursor-not-allowed"
          >
            {sizingMode === 'fixed_usdt' && amountUnit === '%' ? '%' : 'USDT'}
          </button>
        </div>

        {/* 5-Node Diamond Allocation Slider */}
        <div className={`px-1 pt-0.5 ${!manualAllowed ? 'opacity-50' : ''}`}>
          <div className="relative flex items-center justify-between">
            <div className="absolute left-1 right-1 h-0.5 bg-slate-700" aria-hidden="true" />
            {[0, 25, 50, 75, 100].map((pct) => {
              const active = allocPct === pct;
              return (
                <button
                  key={pct}
                  type="button"
                  disabled={!manualAllowed}
                  onClick={() => handleSliderPct(pct)}
                  aria-label={`Set allocation to ${pct}%`}
                  className={`relative z-10 h-3 w-3 rotate-45 border transition disabled:cursor-not-allowed ${
                    active
                      ? 'border-[#7DF2AD] bg-[#7DF2AD]'
                      : 'border-slate-400 bg-[#141820] hover:border-[#7DF2AD]'
                  }`}
                />
              );
            })}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-slate-500">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        {/* Stop Loss & Break-Even Row */}
        <div className={`space-y-2 border-t border-white/[0.06] pt-3 ${!manualAllowed ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <label htmlFor="ticket-sl-mode" className="text-xs text-slate-400">
                Stop Loss
              </label>
              <select
                id="ticket-sl-mode"
                disabled={!manualAllowed}
                value={effectiveStopLossMode}
                onChange={(e) => setStopLossMode(e.target.value as 'ATR' | 'MARKET' | 'LIMIT')}
                className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none disabled:cursor-not-allowed"
              >
                <option value="ATR" disabled={!atrExitsEnabled} className="bg-[#141820]">ATR ({config.exits.atrSlMultiplier}x)</option>
                <option value="MARKET" className="bg-[#141820]">MARKET</option>
                <option value="LIMIT" className="bg-[#141820]">LIMIT</option>
              </select>
            </div>
            <button
              type="button"
              disabled={!manualAllowed || !breakEvenEnabled}
              title={!breakEvenEnabled ? 'Automatic Break-Even Stop is disabled in Feature Toggles' : undefined}
              onClick={() => setUseBreakEven((b) => !b)}
              aria-pressed={effectiveUseBreakEven}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
                effectiveUseBreakEven
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'border border-white/[0.08] bg-[#0D1015] text-slate-300 hover:text-white'
              }`}
            >
              Break-Even
            </button>
          </div>

          <div className="flex items-stretch overflow-hidden rounded-lg border border-white/[0.06] bg-[#0D1015]">
            <span className="flex items-center px-3 text-xs text-slate-400">Stop:</span>
            <label htmlFor="ticket-sl-pct" className="sr-only">
              Stop Loss Distance Percent
            </label>
            <input
              id="ticket-sl-pct"
              type="number"
              step="0.1"
              min="0.2"
              max="25"
              disabled={!manualAllowed}
              value={stopLossPct}
              onChange={(e) => setStopLossPct(Math.max(0.2, Number(e.target.value) || 1.5))}
              className="w-full bg-transparent px-2 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-100 focus:outline-none disabled:cursor-not-allowed"
            />
            <span className="flex items-center px-2 font-mono text-[11px] text-slate-400">
              {effectiveStopLossMode === 'ATR' ? 'ATR%' : '%'}
            </span>
            <button
              type="button"
              disabled={!manualAllowed || !trailingEnabled}
              title={!trailingEnabled ? 'Monotonic ATR Trailing Stop is disabled in Feature Toggles' : 'Toggle ATR Trailing Stop'}
              onClick={() => setUseTrailingStop((t) => !t)}
              aria-pressed={effectiveUseTrailing}
              className={`px-2.5 font-mono text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
                effectiveUseTrailing
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {effectiveUseTrailing ? 'TRAIL ON' : 'TRAIL OFF'}
            </button>
          </div>
        </div>

        {/* Take Profit Multi-Target Ladder */}
        <div className={`space-y-2 border-t border-white/[0.06] pt-3 ${!manualAllowed || !tpLadderEnabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <label htmlFor="ticket-tp-mode" className="text-xs text-slate-400">
                Take Profit
              </label>
              <select
                id="ticket-tp-mode"
                disabled={!manualAllowed || !tpLadderEnabled}
                value={effectiveTpMode}
                onChange={(e) => {
                  const nextMode = e.target.value as 'MARKET' | 'ATR';
                  setTpMode(nextMode);
                  if (nextMode === 'ATR') setTpCustomEdited(false);
                }}
                className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none disabled:cursor-not-allowed"
              >
                <option value="MARKET" className="bg-[#141820]">MARKET</option>
                <option value="ATR" disabled={!atrExitsEnabled} className="bg-[#141820]">ATR SCALED</option>
              </select>
            </div>
            <button
              type="button"
              disabled={!manualAllowed || !tpLadderEnabled}
              onClick={handleAddTarget}
              className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-emerald-400/50 hover:text-white disabled:cursor-not-allowed whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add Target
            </button>
          </div>

          <div className="space-y-1.5">
            {targets.map((t, idx) => (
              <div key={t.id} className="grid grid-cols-12 items-center gap-1.5">
                <div className="col-span-6 flex items-stretch overflow-hidden rounded-lg border border-white/[0.06] bg-[#0D1015]">
                  <span className="flex items-center px-2 font-mono text-[11px] text-slate-400">
                    {idx + 1}:
                  </span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.2"
                    disabled={!manualAllowed || !tpLadderEnabled}
                    aria-label={`Take profit target ${idx + 1} percentage`}
                    value={t.pctOffset}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 0;
                      setTpCustomEdited(true);
                      setTargets((prev) =>
                        prev.map((item) => (item.id === t.id ? { ...item, pctOffset: val } : item))
                      );
                    }}
                    className="w-full bg-transparent px-1.5 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:outline-none disabled:cursor-not-allowed"
                  />
                  <span className="flex items-center bg-[#7DF2AD] px-2 font-mono text-[11px] font-bold text-[#0B0F17]">
                    %
                  </span>
                </div>

                <div className="col-span-5 flex items-stretch overflow-hidden rounded-lg border border-white/[0.06] bg-[#0D1015]">
                  <input
                    type="number"
                    step="5"
                    min="5"
                    max="100"
                    disabled={!manualAllowed || !tpLadderEnabled}
                    aria-label={`Take profit target ${idx + 1} size percentage`}
                    value={t.allocationPct}
                    onChange={(e) => {
                      const val = Math.min(100, Math.max(5, Number(e.target.value) || 0));
                      setTpCustomEdited(true);
                      setTargets((prev) =>
                        prev.map((item) =>
                          item.id === t.id ? { ...item, allocationPct: val } : item
                        )
                      );
                    }}
                    className="w-full bg-transparent px-2 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:outline-none disabled:cursor-not-allowed"
                  />
                  <span className="flex items-center px-2 font-mono text-[11px] text-slate-400">
                    %
                  </span>
                </div>

                <div className="col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleRemoveTarget(t.id)}
                    disabled={!manualAllowed || !tpLadderEnabled || targets.length <= 1}
                    aria-label={`Remove target ${idx + 1}`}
                    className="rounded p-1 text-rose-400 transition hover:bg-rose-950/50 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bid / Last / Ask Live Micro-Strip */}
        <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2 font-mono text-[11px] tabular-nums">
          <div className="flex items-center justify-between gap-2">
            <span>
              <span className="text-slate-500">Bid </span>
              <span className="text-emerald-400">{bid.toFixed(priceDecimals)}</span>
            </span>
            <span>
              <span className="text-slate-500">Last </span>
              <span className="text-rose-400">{last.toFixed(priceDecimals)}</span>
            </span>
            <span>
              <span className="text-slate-500">Ask </span>
              <span className="text-sky-400">{ask.toFixed(priceDecimals)}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
          <span>
            Avbl <strong className="text-slate-100">${snapshot.availableBalanceUsdt.toFixed(2)}</strong>
          </span>
          <span>
            {activeVenue === 'Futures' ? (
              <>
                Margin <strong className="text-amber-300">${requiredMargin.toFixed(2)}</strong>{' '}
                <span className="text-slate-500">(${effectiveUsdt.toFixed(0)} @ {leverage}x)</span>
              </>
            ) : (
              <>
                Cost <strong className="text-slate-100">${effectiveUsdt.toFixed(2)}</strong>
              </>
            )}
          </span>
        </div>

        {/* Demo Toggle + Triggers + Advance */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={
              snapshot.transport.feedSource === 'Simulated' &&
              !config.features.wsPrimaryFeed &&
              !config.features.restFallback
            }
            onClick={() =>
              onToggleFeedSource(
                snapshot.transport.feedSource === 'Simulated' ? 'BinanceLive' : 'Simulated'
              )
            }
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#0D1015] px-2.5 py-1.5 text-xs font-medium text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>{snapshot.transport.feedSource === 'Simulated' ? 'Demo' : 'Live WS'}</span>
            <span
              className={`inline-flex h-3.5 w-6 items-center rounded-full p-0.5 transition ${
                snapshot.transport.feedSource === 'Simulated' ? 'bg-emerald-500/40' : 'bg-sky-500/50'
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full bg-[#7DF2AD] transition-transform ${
                  snapshot.transport.feedSource === 'Simulated' ? 'translate-x-2.5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>

          <div className="flex items-center gap-1.5">
            {activeVenue === 'Futures' && (
              <button
                type="button"
                disabled={!manualAllowed}
                onClick={() => setTriggerRef((r) => (r === 'LAST' ? 'MARK' : 'LAST'))}
                className="rounded-md border border-white/[0.06] bg-[#0D1015] px-2 py-1.5 font-mono text-[11px] text-slate-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                title="Condition trigger price source (Futures workingType)"
              >
                {triggerRef}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowAdvance((a) => !a)}
              className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-[#0D1015] px-2 py-1.5 text-[11px] font-medium text-slate-300 hover:text-white"
            >
              <Sliders className="h-3 w-3" aria-hidden="true" />
              Advance
            </button>
          </div>
        </div>

        {showAdvance && (
          <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-2.5 text-[11px] text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">ATR Trailing Mult</span>
              <span className="font-mono text-emerald-300">{config.exits.atrTrailingMultiplier}× ATR</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Break-Even Trigger</span>
              <span className="font-mono text-emerald-300">
                +{config.exits.breakEvenTriggerR}R (+{config.exits.breakEvenFeeBufferBps} bps fee buffer)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Max Pair Drawdown</span>
              <span className="font-mono text-rose-300">-{config.risk.maxPairDailyDrawdownPct}%</span>
            </div>
          </div>
        )}

        {/* Pre-Trade Mandatory Checklist & 9-Step Signal Validation Protocol (§3 & Operational Takeaway) */}
        <div className="rounded-lg border border-white/[0.08] bg-[#0D1015] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <ShieldCheck
                className={`h-3.5 w-3.5 ${
                  preTradeValidation.allMandatoryPassed ? 'text-[#7DF2AD]' : 'text-amber-400'
                }`}
                aria-hidden="true"
              />
              <span className="text-[11px] font-semibold text-slate-200">
                Pre-Trade Checklist ({preTradeValidation.passedCount}/9 Steps)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowNineStepChecklist((v) => !v)}
              className="font-mono text-[10px] font-medium text-[#7DF2AD] hover:underline"
            >
              {showNineStepChecklist ? 'Hide 9-Step Audit' : '9-Step Audit'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] tabular-nums">
            <div className="rounded border border-white/[0.05] bg-[#141820] px-2 py-1">
              <div className="text-slate-500">1. Invalidation Price</div>
              <div className="font-semibold text-rose-300">
                ${computedStopLossPrice.toFixed(priceDecimals)}
              </div>
            </div>
            <div className="rounded border border-white/[0.05] bg-[#141820] px-2 py-1">
              <div className="text-slate-500">2. Calc Position Size</div>
              <div className="font-semibold text-emerald-300">
                ${effectiveUsdt.toFixed(2)} ({preTradeValidation.rewardToRiskRatio.toFixed(2)}R)
              </div>
            </div>
          </div>

          {showNineStepChecklist && (
            <div className="space-y-1.5 border-t border-white/[0.06] pt-2 text-[10px]">
              <div className="rounded bg-[#141820] p-2 font-mono text-[10px] text-slate-300 space-y-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-[#7DF2AD]">
                  Trade Plan Hierarchy
                </div>
                <div className="truncate text-slate-400">
                  <strong className="text-slate-200">Signal:</strong> {preTradeValidation.hierarchy.signalLayer}
                </div>
                <div className="truncate text-slate-400">
                  <strong className="text-slate-200">Rec:</strong> {preTradeValidation.hierarchy.recommendationLayer}
                </div>
                <div className="truncate text-slate-300">
                  <strong className="text-[#7DF2AD]">Plan:</strong> {preTradeValidation.hierarchy.tradePlanLayer}
                </div>
              </div>

              <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {preTradeValidation.steps.map((st) => (
                  <div
                    key={st.step}
                    className="flex items-start justify-between gap-2 rounded bg-[#141820]/70 px-2 py-1"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-200">
                        {st.step}. {st.title}
                      </div>
                      <div className="truncate font-mono text-[9px] text-slate-400">{st.detail}</div>
                    </div>
                    {st.passed ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <XCircle
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                          st.mandatory ? 'text-rose-400' : 'text-amber-400'
                        }`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {feedback && (
          <div
            role="status"
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${
              feedback.type === 'ok'
                ? 'bg-emerald-950/60 text-emerald-200'
                : 'bg-rose-950/60 text-rose-200'
            }`}
          >
            {feedback.text}
          </div>
        )}
      </div>

      {!manualAllowed && (
        <div
          role="status"
          className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200"
        >
          {!config.features.manualTrading
            ? 'Manual Trading is currently toggled OFF in Bot -> Feature Toggles.'
            : `${activeVenue} market venue is disabled in Feature Toggles.`}
        </div>
      )}

      {manualAllowed && quantPositionSize.blockedByNegativeKelly && (
        <div
          role="status"
          className="mt-3 rounded-lg border border-rose-500/35 bg-rose-950/35 px-3 py-2 text-[11px] text-rose-200"
        >
          Kelly sizing blocked new entries: historical strategy expectancy is negative (0.00% optimal fraction). Switch to Fixed Risk / Manual USDT or pause until edge recovers.
        </div>
      )}

      {manualAllowed && !quantPositionSize.blockedByNegativeKelly && effectiveUsdt < 10 && (
        <div
          role="status"
          className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200"
        >
          Minimum order notional is $10.00 USDT (current allocation: ${effectiveUsdt.toFixed(2)}).
        </div>
      )}

      {/* Save + Mint Submit Order CTA */}
      <div className="mt-4 grid grid-cols-12 gap-2">
        <button
          type="button"
          disabled={!manualAllowed}
          onClick={handleSavePreset}
          className="col-span-4 flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          Save
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={
            !manualAllowed ||
            submitting ||
            quantPositionSize.blockedByNegativeKelly ||
            effectiveUsdt < 10
          }
          className={`col-span-8 rounded-lg py-2.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
            snapshot.accountMode === 'Live'
              ? 'bg-amber-400 text-[#0B0F17] hover:bg-amber-300'
              : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#9AF7BF]'
          }`}
        >
          {submitting
            ? 'Submitting Order…'
            : snapshot.accountMode === 'Live'
              ? isRemoteVpsDaemon
                ? `Place Live Order on Remote VPS (${activeVenue})`
                : `Place Local Live Order (${activeVenue})`
              : `Submit Paper ${activeVenue} Order`}
        </button>
      </div>
    </section>
  );
};
