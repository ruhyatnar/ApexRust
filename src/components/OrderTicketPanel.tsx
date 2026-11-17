import React, { useMemo, useState } from 'react';
import { ChevronDown, Plus, Save, Sliders, X, Zap } from 'lucide-react';
import type {
  BotConfig,
  EngineSnapshot,
  LiveCredentialStatus,
  ManualOrderInput,
  OrderType,
  PairRuntimeState,
  Side,
} from '../engine/types';

interface OrderTicketPanelProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  activePair: PairRuntimeState;
  liveStatus: LiveCredentialStatus;
  onSelectSymbol: (symbol: string) => void;
  onSubmitOrder: (input: ManualOrderInput) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onToggleFeedSource: (source: 'Simulated' | 'BinanceLive') => void;
  onOpenLiveCredentials: () => void;
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
  onSelectSymbol,
  onSubmitOrder,
  onToggleFeedSource,
  onOpenLiveCredentials,
}) => {
  const [orderType, setOrderType] = useState<OrderType>('OCO SELL');
  const [side, setSide] = useState<Side>('Long');
  const [amountUnit, setAmountUnit] = useState<'USDT' | '%'>('USDT');
  const [usdtAmount, setUsdtAmount] = useState<number>(250);
  const [allocPct, setAllocPct] = useState<number>(25);
  const [limitPriceInput, setLimitPriceInput] = useState<string>('');
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

  const [triggerRef, setTriggerRef] = useState<'LAST' | 'MARK'>('LAST');
  const [showAdvance, setShowAdvance] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem('apexrust_ticket_preset');
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<{
        orderType: OrderType;
        side: Side;
        stopLossMode: 'ATR' | 'MARKET' | 'LIMIT';
        stopLossPct: number;
        useBreakEven: boolean;
        useTrailingStop: boolean;
        tpMode: 'MARKET' | 'ATR';
        targets: TpDraft[];
      }>;
      if (saved.orderType) setOrderType(saved.orderType);
      if (saved.side) setSide(saved.side);
      if (saved.stopLossMode) setStopLossMode(saved.stopLossMode);
      if (typeof saved.stopLossPct === 'number') setStopLossPct(saved.stopLossPct);
      if (typeof saved.useBreakEven === 'boolean') setUseBreakEven(saved.useBreakEven);
      if (typeof saved.useTrailingStop === 'boolean') setUseTrailingStop(saved.useTrailingStop);
      if (saved.tpMode) setTpMode(saved.tpMode);
      if (Array.isArray(saved.targets) && saved.targets.length > 0) setTargets(saved.targets);
    } catch {
      // Ignore invalid localStorage payload
    }
  }, []);

  const last = activePair.lastPrice;
  const priceDecimals = last >= 100 ? 2 : 4;
  const spread = last * 0.00025;
  const bid = last - spread;
  const ask = last + spread;

  const isLimitOrderType = orderType === 'LIMIT' || orderType === 'LIMIT MAKER';

  React.useEffect(() => {
    if (isLimitOrderType && !limitPriceInput) {
      const defaultLimit = side === 'Long' ? bid : ask;
      setLimitPriceInput(defaultLimit.toFixed(priceDecimals));
    }
  }, [isLimitOrderType, limitPriceInput, side, bid, ask, priceDecimals]);

  // Reset suggested limit price when symbol changes
  React.useEffect(() => {
    if (isLimitOrderType) {
      const suggested = side === 'Long' ? bid : ask;
      setLimitPriceInput(suggested.toFixed(priceDecimals));
    } else {
      setLimitPriceInput('');
    }
  }, [activePair.symbol]);

  const effectiveUsdt = useMemo(() => {
    if (amountUnit === '%') {
      return Number(((snapshot.availableBalanceUsdt * allocPct) / 100).toFixed(2));
    }
    return usdtAmount;
  }, [amountUnit, allocPct, usdtAmount, snapshot.availableBalanceUsdt]);

  const handleSliderPct = (pct: number) => {
    setAllocPct(pct);
    if (pct === 0) {
      setUsdtAmount(0);
      return;
    }
    const val = Number(((snapshot.availableBalanceUsdt * pct) / 100).toFixed(2));
    setUsdtAmount(Math.max(10, val));
  };

  const handleAddTarget = () => {
    if (targets.length >= 4) return;
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
    setTargets(targets.filter((t) => t.id !== id));
  };

  const handleSubmit = async () => {
    const parsedLimit = Number(limitPriceInput);
    const res = await onSubmitOrder({
      symbol: activePair.symbol,
      orderType,
      side,
      usdtAmount: effectiveUsdt,
      limitPrice:
        isLimitOrderType && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : undefined,
      timeInForce: orderType === 'LIMIT' ? timeInForce : 'GTC',
      stopLossMode,
      stopLossPct,
      useBreakEven,
      useTrailingStop,
      targets: targets.map((t) => ({
        pctOffset: t.pctOffset,
        allocationPct: t.allocationPct,
      })),
    });

    if (res.ok) {
      setFeedback({
        type: 'ok',
        text: `${snapshot.accountMode} ${activePair.symbol} ${side} ${orderType} submitted`,
      });
    } else {
      setFeedback({ type: 'err', text: res.reason });
    }
    window.setTimeout(() => setFeedback(null), 4000);
  };

  const handleSavePreset = () => {
    try {
      window.localStorage.setItem(
        'apexrust_ticket_preset',
        JSON.stringify({
          orderType,
          side,
          stopLossMode,
          stopLossPct,
          useBreakEven,
          useTrailingStop,
          tpMode,
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
    window.setTimeout(() => setFeedback(null), 3000);
  };

  const coinCode = activePair.symbol.replace('USDT', '');

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
              ? `LIVE · ${liveStatus.environment} (${liveStatus.armedForLiveOrders ? 'ARMED' : 'DISARMED'})`
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

        {/* Order Type Row */}
        <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
          <label htmlFor="ticket-order-type" className="text-xs text-slate-400">
            Order
          </label>
          <div className="flex items-center gap-2">
            <select
              id="ticket-order-type"
              value={orderType}
              onChange={(e) => {
                const next = e.target.value as OrderType;
                setOrderType(next);
                const nextSide =
                  next === 'OCO SELL' ? 'Long' : next === 'OCO BUY' ? 'Short' : side;
                setSide(nextSide);
                if (next === 'LIMIT' || next === 'LIMIT MAKER') {
                  const defaultPx = nextSide === 'Long' ? bid : ask;
                  setLimitPriceInput(defaultPx.toFixed(priceDecimals));
                }
              }}
              className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none"
            >
              <option value="OCO SELL" className="bg-[#141820]">OCO SELL</option>
              <option value="OCO BUY" className="bg-[#141820]">OCO BUY</option>
              <option value="ATR SCALP" className="bg-[#141820]">ATR SCALP</option>
              <option value="MARKET" className="bg-[#141820]">MARKET</option>
              <option value="LIMIT" className="bg-[#141820]">LIMIT</option>
              <option value="LIMIT MAKER" className="bg-[#141820]">LIMIT MAKER</option>
            </select>
            <button
              type="button"
              onClick={() => setSide((s) => (s === 'Long' ? 'Short' : 'Long'))}
              className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold transition ${
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
          <div className="space-y-2 rounded-lg border border-white/[0.06] bg-[#0D1015] p-2.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="ticket-limit-price" className="text-xs text-slate-400">
                Limit Price
              </label>
              <div className="flex items-center gap-1 font-mono text-[10px]">
                <button
                  type="button"
                  onClick={() => setLimitPriceInput(bid.toFixed(priceDecimals))}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-emerald-300 hover:border-emerald-400/50"
                >
                  Bid
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPriceInput(last.toFixed(priceDecimals))}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-slate-300 hover:border-white/30"
                >
                  Last
                </button>
                <button
                  type="button"
                  onClick={() => setLimitPriceInput(ask.toFixed(priceDecimals))}
                  className="rounded border border-white/[0.08] px-1.5 py-0.5 text-sky-300 hover:border-sky-400/50"
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
                value={limitPriceInput}
                onChange={(e) => setLimitPriceInput(e.target.value)}
                className="w-full rounded border border-white/[0.08] bg-[#141820] px-2.5 py-1.5 font-mono text-xs font-semibold tabular-nums text-slate-100 focus:border-[#7DF2AD] focus:outline-none"
              />
              {orderType === 'LIMIT' ? (
                <select
                  aria-label="Time In Force"
                  value={timeInForce}
                  onChange={(e) => setTimeInForce(e.target.value as 'GTC' | 'IOC' | 'FOK')}
                  className="rounded border border-white/[0.08] bg-[#141820] px-2 py-1.5 font-mono text-xs font-semibold text-slate-200 focus:outline-none"
                >
                  <option value="GTC">GTC</option>
                  <option value="IOC">IOC</option>
                  <option value="FOK">FOK</option>
                </select>
              ) : (
                <span className="flex items-center rounded border border-white/[0.08] bg-[#141820] px-2 font-mono text-[10px] font-semibold text-[#7DF2AD] whitespace-nowrap">
                  POST ONLY
                </span>
              )}
            </div>
          </div>
        )}

        {/* Market / Coin Selector */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
            <span className="text-xs text-slate-400">Market</span>
            <span className="font-mono text-xs font-semibold text-slate-100">USDT</span>
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
                  {p.symbol.replace('USDT', '')}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Amount Input + Mint % Toggle */}
        <div className="flex items-stretch overflow-hidden rounded-lg border border-white/[0.06] bg-[#0D1015]">
          <button
            type="button"
            onClick={() => setAmountUnit((u) => (u === 'USDT' ? '%' : 'USDT'))}
            className="flex items-center border-r border-white/[0.06] px-3 text-xs font-medium text-slate-300 transition hover:text-white"
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
            min="10"
            step="10"
            value={amountUnit === 'USDT' ? usdtAmount : allocPct}
            onChange={(e) => {
              const v = Math.max(0, Number(e.target.value) || 0);
              if (amountUnit === 'USDT') setUsdtAmount(v);
              else setAllocPct(Math.min(100, v));
            }}
            className="w-full bg-transparent px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-100 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setAmountUnit((u) => (u === 'USDT' ? '%' : 'USDT'))}
            aria-label="Toggle allocation unit"
            className="bg-[#7DF2AD] px-3 font-mono text-xs font-bold text-[#0B0F17] transition hover:bg-[#9AF7BF]"
          >
            {amountUnit === '%' ? '%' : 'USDT'}
          </button>
        </div>

        {/* 5-Node Diamond Allocation Slider */}
        <div className="px-1 pt-0.5">
          <div className="relative flex items-center justify-between">
            <div className="absolute left-1 right-1 h-0.5 bg-slate-700" aria-hidden="true" />
            {[0, 25, 50, 75, 100].map((pct) => {
              const active = allocPct === pct;
              return (
                <button
                  key={pct}
                  type="button"
                  onClick={() => handleSliderPct(pct)}
                  aria-label={`Set allocation to ${pct}%`}
                  className={`relative z-10 h-3 w-3 rotate-45 border transition ${
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
        <div className="space-y-2 border-t border-white/[0.06] pt-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <label htmlFor="ticket-sl-mode" className="text-xs text-slate-400">
                Stop Loss
              </label>
              <select
                id="ticket-sl-mode"
                value={stopLossMode}
                onChange={(e) => setStopLossMode(e.target.value as 'ATR' | 'MARKET' | 'LIMIT')}
                className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none"
              >
                <option value="ATR" className="bg-[#141820]">ATR ({config.exits.atrSlMultiplier}x)</option>
                <option value="MARKET" className="bg-[#141820]">MARKET</option>
                <option value="LIMIT" className="bg-[#141820]">LIMIT</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => setUseBreakEven((b) => !b)}
              aria-pressed={useBreakEven}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition whitespace-nowrap ${
                useBreakEven
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
              value={stopLossPct}
              onChange={(e) => setStopLossPct(Math.max(0.2, Number(e.target.value) || 1.5))}
              className="w-full bg-transparent px-2 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-100 focus:outline-none"
            />
            <span className="flex items-center px-2 font-mono text-[11px] text-slate-400">
              {stopLossMode === 'ATR' ? 'ATR%' : 'USDT'}
            </span>
            <button
              type="button"
              onClick={() => setUseTrailingStop((t) => !t)}
              aria-pressed={useTrailingStop}
              className={`px-2.5 font-mono text-[11px] font-bold transition whitespace-nowrap ${
                useTrailingStop
                  ? 'bg-[#7DF2AD] text-[#0B0F17]'
                  : 'bg-slate-800 text-slate-300'
              }`}
              title="Toggle ATR Trailing Stop"
            >
              {useTrailingStop ? 'TRAIL ON' : '%'}
            </button>
          </div>
        </div>

        {/* Take Profit Multi-Target Ladder */}
        <div className="space-y-2 border-t border-white/[0.06] pt-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center justify-between rounded-lg border border-white/[0.06] bg-[#0D1015] px-3 py-2">
              <label htmlFor="ticket-tp-mode" className="text-xs text-slate-400">
                Take Profit
              </label>
              <select
                id="ticket-tp-mode"
                value={tpMode}
                onChange={(e) => setTpMode(e.target.value as 'MARKET' | 'ATR')}
                className="bg-transparent font-mono text-xs font-semibold text-slate-100 focus:outline-none"
              >
                <option value="MARKET" className="bg-[#141820]">MARKET</option>
                <option value="ATR" className="bg-[#141820]">ATR SCALED</option>
              </select>
            </div>
            <button
              type="button"
              onClick={handleAddTarget}
              className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0D1015] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-emerald-400/50 hover:text-white whitespace-nowrap"
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
                    aria-label={`Take profit target ${idx + 1} percentage`}
                    value={t.pctOffset}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 0;
                      setTargets((prev) =>
                        prev.map((item) => (item.id === t.id ? { ...item, pctOffset: val } : item))
                      );
                    }}
                    className="w-full bg-transparent px-1.5 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:outline-none"
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
                    aria-label={`Take profit target ${idx + 1} size percentage`}
                    value={t.allocationPct}
                    onChange={(e) => {
                      const val = Math.min(100, Math.max(5, Number(e.target.value) || 0));
                      setTargets((prev) =>
                        prev.map((item) =>
                          item.id === t.id ? { ...item, allocationPct: val } : item
                        )
                      );
                    }}
                    className="w-full bg-transparent px-2 py-1.5 font-mono text-xs tabular-nums text-slate-100 focus:outline-none"
                  />
                  <span className="flex items-center px-2 font-mono text-[11px] text-slate-400">
                    %
                  </span>
                </div>

                <div className="col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleRemoveTarget(t.id)}
                    disabled={targets.length <= 1}
                    aria-label={`Remove target ${idx + 1}`}
                    className="rounded p-1 text-rose-400 transition hover:bg-rose-950/50 disabled:opacity-30"
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
              <span className="text-emerald-400">{bid.toFixed(last >= 100 ? 2 : 4)}</span>
            </span>
            <span>
              <span className="text-slate-500">Last </span>
              <span className="text-rose-400">{last.toFixed(last >= 100 ? 2 : 4)}</span>
            </span>
            <span>
              <span className="text-slate-500">Ask </span>
              <span className="text-sky-400">{ask.toFixed(last >= 100 ? 2 : 4)}</span>
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
          <span>
            Avbl <strong className="text-slate-100">${snapshot.availableBalanceUsdt.toFixed(2)}</strong>
          </span>
          <span>
            Cost <strong className="text-slate-100">${effectiveUsdt.toFixed(2)}</strong>
          </span>
        </div>

        {/* Demo Toggle + Triggers + Advance */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() =>
              onToggleFeedSource(
                snapshot.transport.feedSource === 'Simulated' ? 'BinanceLive' : 'Simulated'
              )
            }
            className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#0D1015] px-2.5 py-1.5 text-xs font-medium text-slate-200"
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
            <button
              type="button"
              onClick={() => setTriggerRef((r) => (r === 'LAST' ? 'MARK' : 'LAST'))}
              className="rounded-md border border-white/[0.06] bg-[#0D1015] px-2 py-1.5 font-mono text-[11px] text-slate-300 hover:text-white"
            >
              {triggerRef}
            </button>
            <button
              type="button"
              onClick={() => setUseTrailingStop((t) => !t)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition ${
                useTrailingStop
                  ? 'border-amber-400/35 bg-amber-950/30 text-amber-200'
                  : 'border-white/[0.06] bg-[#0D1015] text-slate-400'
              }`}
            >
              <Zap className="h-3 w-3" aria-hidden="true" />
              Triggers
            </button>
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
              <span className="font-mono text-emerald-300">+{config.exits.breakEvenTriggerR}R</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Max Pair Drawdown</span>
              <span className="font-mono text-rose-300">-{config.risk.maxPairDailyDrawdownPct}%</span>
            </div>
          </div>
        )}

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

      {/* Save + Mint Submit Order CTA */}
      <div className="mt-4 grid grid-cols-12 gap-2">
        <button
          type="button"
          onClick={handleSavePreset}
          className="col-span-4 flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#0D1015] py-2.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          Save
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className={`col-span-8 rounded-lg py-2.5 text-xs font-bold transition ${
            snapshot.accountMode === 'Live'
              ? 'bg-amber-400 text-[#0B0F17] hover:bg-amber-300'
              : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#9AF7BF]'
          }`}
        >
          {snapshot.accountMode === 'Live' ? 'Submit Live Order' : 'Submit Paper Order'}
        </button>
      </div>
    </section>
  );
};
