import React, { useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Flame,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Shield,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { fmtPx, fmtUsdMagnitude } from '../engine/formatters';
import { evaluatePreTradeValidation } from '../engine/quantAnalytics';
import { evaluateSignalDiagnostics } from '../engine/strategy';
import type {
  BotConfig,
  EngineSnapshot,
  PairSelectionMode,
  PairSourceTag,
  ScreenerSnapshotPayload,
  TransportMode,
  TrendingCategory,
} from '../engine/types';

interface MarketsViewProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  selectedSymbol: string;
  onSelectPairAndTrade: (symbol: string) => void;
  onSimulateTransport: (mode: TransportMode) => void;
  onToggleFeedSource: (source: 'Simulated' | 'BinanceLive') => void;
  screenerSnapshot?: ScreenerSnapshotPayload | null;
  screenerCategory?: TrendingCategory;
  onChangeScreenerCategory?: (category: TrendingCategory) => void;
  onUpdatePairSelectionMode?: (mode: PairSelectionMode) => void;
  onTogglePinPair?: (symbol: string) => void;
  onPinAndTradeSymbol?: (symbol: string) => void;
}

const PAIR_MODE_OPTIONS: Array<{
  id: PairSelectionMode;
  label: string;
  desc: string;
}> = [
  { id: 'static', label: 'Static Only', desc: 'Trade only your pinned watchlist pairs.' },
  { id: 'hybrid', label: 'Hybrid (Pinned + Auto)', desc: 'Keep pinned pairs + rotate top Binance trending pairs.' },
  { id: 'dynamic', label: 'Dynamic Auto', desc: 'Rotate entire watchlist from live WS screener (positions always protected).' },
];

const SCREENER_CATEGORIES: Array<{
  id: TrendingCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'hot_volume', label: 'Hot Volume', icon: Flame },
  { id: 'top_gainers', label: 'Top Gainers', icon: TrendingUp },
  { id: 'top_losers', label: 'Top Losers (Shorts)', icon: TrendingDown },
  { id: 'volatility_leaders', label: 'Volatility Leaders', icon: Zap },
  { id: 'cts_momentum', label: 'CTS Momentum', icon: Activity },
];

function renderSourceTagBadge(tag?: PairSourceTag) {
  if (tag === 'protected_position') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-cyan-400/35 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
        <Shield className="h-2.5 w-2.5" aria-hidden="true" />
        Protected
      </span>
    );
  }
  if (tag === 'trending') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-400/35 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
        <Flame className="h-2.5 w-2.5" aria-hidden="true" />
        Trending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[#7DF2AD]/30 bg-[#7DF2AD]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#7DF2AD]">
      <Pin className="h-2.5 w-2.5" aria-hidden="true" />
      Pinned
    </span>
  );
}

export const MarketsView: React.FC<MarketsViewProps> = ({
  snapshot,
  config,
  selectedSymbol,
  onSelectPairAndTrade,
  onSimulateTransport,
  onToggleFeedSource,
  screenerSnapshot = null,
  screenerCategory = config.trading.trendingCategory,
  onChangeScreenerCategory,
  onUpdatePairSelectionMode,
  onTogglePinPair,
  onPinAndTradeSymbol,
}) => {
  const { transport, risk } = snapshot;
  const [pinDraft, setPinDraft] = useState('');
  const [screenerSearch, setScreenerSearch] = useState('');

  const pinnedSet = useMemo(
    () => new Set(config.trading.pairs.map((s) => s.trim().toUpperCase())),
    [config.trading.pairs]
  );

  const filteredScreenerTickers = useMemo(() => {
    const list = screenerSnapshot?.tickers ?? [];
    const q = screenerSearch.trim().toUpperCase();
    if (!q) return list.slice(0, 40);
    return list.filter((t) => t.symbol.includes(q)).slice(0, 40);
  }, [screenerSnapshot, screenerSearch]);

  const handleAddPinned = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pinDraft.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean || !onTogglePinPair) return;
    if (!pinnedSet.has(clean)) {
      onTogglePinPair(clean);
    }
    setPinDraft('');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Multi-Pair Markets & Binance Transport Health
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Live multi-pair scanner powered by WebSocket primary streams with automatic REST API fallback.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.08] bg-[#0D1015] p-1">
            <button
              type="button"
              disabled={snapshot.accountMode === 'Live'}
              onClick={() => onToggleFeedSource('Simulated')}
              title={
                snapshot.accountMode === 'Live'
                  ? 'Synthetic simulation disabled in isolated Live mode'
                  : 'Use deterministic local simulation bars'
              }
              className={`rounded-md px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                transport.feedSource === 'Simulated'
                  ? 'bg-[#1D2330] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Deterministic Sim
            </button>
            <button
              type="button"
              disabled={!config.features.wsPrimaryFeed && !config.features.restFallback}
              title={
                !config.features.wsPrimaryFeed && !config.features.restFallback
                  ? 'Enable WebSocket Primary Feed or REST API Fallback in Feature Toggles'
                  : undefined
              }
              onClick={() => onToggleFeedSource('BinanceLive')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                transport.feedSource === 'BinanceLive'
                  ? 'bg-[#7DF2AD] font-semibold text-[#0B0F17]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Binance Public WS
            </button>
          </div>

          <button
            type="button"
            disabled={
              transport.mode === 'WsPrimary'
                ? !config.features.restFallback
                : !config.features.wsPrimaryFeed
            }
            title={
              (transport.mode === 'WsPrimary'
                ? !config.features.restFallback
                : !config.features.wsPrimaryFeed)
                ? 'Target transport path is disabled in Feature Toggles'
                : undefined
            }
            onClick={() =>
              onSimulateTransport(
                transport.mode === 'WsPrimary' ? 'RestFallback' : 'WsPrimary'
              )
            }
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {transport.mode === 'WsPrimary' ? 'Test REST Fallback' : 'Recover WS Primary'}
          </button>
        </div>
      </div>

      {/* Transport Endpoint Status Strip */}
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Active Transport</span>
            {transport.mode === 'WsPrimary' ? (
              <Wifi className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            ) : (
              <WifiOff className="h-4 w-4 text-amber-400" aria-hidden="true" />
            )}
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-slate-100">
            {transport.mode === 'WsPrimary' ? 'WebSocket Primary' : 'REST API Fallback'}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-slate-400">
            {transport.mode === 'WsPrimary' ? transport.wsEndpoint : transport.restEndpoint}
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs text-slate-400">Watchdog Heartbeat Age</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums text-slate-100">
            {transport.lastWsAgeMs} ms / {transport.wsHeartbeatTimeoutMs} ms
          </div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-slate-400">
            Failovers: {transport.failoverCount} · Poll {transport.restPollIntervalMs} ms
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4">
          <div className="text-xs text-slate-400">Active Watchlist Mode</div>
          <div className="mt-1 font-mono text-base font-semibold capitalize text-slate-100">
            {config.trading.pairSelectionMode} · {config.trading.venue} ({config.trading.timeframe})
          </div>
          <div className="mt-1 font-mono text-[11px] text-slate-400">
            {snapshot.pairs.length}/{config.trading.maxWatchlistPairs} Pairs ·{' '}
            {config.trading.venue === 'Spot' ? 'Long Only (Spot)' : 'Long & Short (Futures)'}
          </div>
        </div>
      </div>

      {/* Pair Selection Mode & Pinned Watchlist Manager */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Watchlist Mode & Pinned Pairs ({config.trading.pairs.length} Pinned · Max {config.trading.maxWatchlistPairs})
            </h3>
            <p className="text-xs text-slate-400">
              {PAIR_MODE_OPTIONS.find((m) => m.id === config.trading.pairSelectionMode)?.desc}
            </p>
          </div>
          <div className="flex flex-wrap rounded-lg border border-white/[0.08] bg-[#0D1015] p-1">
            {PAIR_MODE_OPTIONS.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={!onUpdatePairSelectionMode}
                onClick={() => onUpdatePairSelectionMode?.(mode.id)}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                  config.trading.pairSelectionMode === mode.id
                    ? 'bg-[#7DF2AD] text-[#0B0F17]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {config.trading.pairs.map((sym) => (
            <span
              key={sym}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#7DF2AD]/30 bg-[#7DF2AD]/10 px-2.5 py-1 font-mono text-xs font-semibold text-[#7DF2AD]"
            >
              <Pin className="h-3 w-3" aria-hidden="true" />
              {sym}
              {onTogglePinPair && (
                <button
                  type="button"
                  onClick={() => onTogglePinPair(sym)}
                  aria-label={`Unpin ${sym}`}
                  className="rounded p-0.5 text-slate-300 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
          {onTogglePinPair && (
            <form onSubmit={handleAddPinned} className="inline-flex items-center gap-1.5">
              <input
                type="text"
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value)}
                placeholder="Add e.g. PEPEUSDT"
                className="w-36 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1 text-xs font-semibold text-slate-200 hover:border-[#7DF2AD]/50 hover:text-[#7DF2AD]"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Pin
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Active Monitored Watchlist Table */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#141820]">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-white/[0.06] text-slate-400">
              <th className="px-4 py-3 font-medium">Active Pair</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 text-right font-medium">Last Price</th>
              <th className="px-4 py-3 text-right font-medium">24h %</th>
              <th className="px-4 py-3 text-right font-medium">Spread / Warmup</th>
              <th className="px-4 py-3 text-right font-medium">ADX (14)</th>
              <th className="px-4 py-3 text-right font-medium">RSI (14)</th>
              <th className="px-4 py-3 text-right font-medium">Vol Ratio (20)</th>
              <th className="px-4 py-3 text-right font-medium">Daily PnL</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
            {snapshot.pairs.map((p) => {
              const ind = p.indicators;
              const isSelected = p.symbol === selectedSymbol;
              const isQuarantined = risk.quarantinedPairs.includes(p.symbol);
              const volRatio = ind.volumeRatio ?? 1.0;
              const minVolMult = config.indicators.minVolumeExpansionMult ?? 1.5;
              const warmed = p.barsWarmedUp ?? p.candles.length;
              const minWarm = config.indicators.minWarmupBars ?? 50;
              const spreadBps = p.spreadBps ?? 0;
              const isPinned = pinnedSet.has(p.symbol);
              return (
                <tr key={p.symbol} className={isSelected ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}>
                  <td className="px-4 py-3 font-sans font-semibold text-slate-100">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{p.symbol}</span>
                      {p.openPosition && (
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                            p.openPosition.side === 'Long'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-rose-500/20 text-rose-300'
                          }`}
                        >
                          {p.openPosition.side.toUpperCase()}
                        </span>
                      )}
                      {isQuarantined && (
                        <span className="text-[11px] font-medium text-rose-400">Quarantined</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-sans">
                    {renderSourceTagBadge(p.sourceTag)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-100">
                    ${fmtPx(p.lastPrice)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      p.change24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {p.change24hPct >= 0 ? '+' : ''}
                    {p.change24hPct.toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300">
                    <span className={spreadBps > (config.indicators.maxSpreadBps ?? 25) ? 'text-amber-400' : ''}>
                      {spreadBps.toFixed(1)} bps
                    </span>{' '}
                    <span className={warmed < minWarm ? 'text-amber-400' : 'text-emerald-400'}>
                      · {warmed}/{minWarm}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      (ind.adx ?? 0) >= config.indicators.adxMinTrend
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {ind.adx !== null ? ind.adx.toFixed(1) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-200">
                    {ind.rsi !== null ? ind.rsi.toFixed(1) : '—'}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      volRatio >= minVolMult ? 'font-semibold text-emerald-400' : 'text-slate-300'
                    }`}
                  >
                    {volRatio.toFixed(2)}×
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      p.dailyPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {p.dailyPnlUsdt >= 0 ? '+' : '-'}${Math.abs(p.dailyPnlUsdt).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right font-sans">
                    <div className="inline-flex items-center gap-1.5">
                      {onTogglePinPair && (
                        <button
                          type="button"
                          onClick={() => onTogglePinPair(p.symbol)}
                          className={`rounded border px-2 py-1 text-[11px] font-medium transition ${
                            isPinned
                              ? 'border-[#7DF2AD]/40 bg-[#7DF2AD]/10 text-[#7DF2AD]'
                              : 'border-white/10 text-slate-300 hover:border-[#7DF2AD]/40'
                          }`}
                        >
                          {isPinned ? 'Pinned' : 'Pin'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectPairAndTrade(p.symbol)}
                        className="inline-flex items-center gap-1 rounded-md bg-[#7DF2AD]/15 px-2.5 py-1 text-xs font-semibold text-[#7DF2AD] transition hover:bg-[#7DF2AD] hover:text-[#0B0F17]"
                      >
                        <span>Load Ticket</span>
                        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Live Binance !miniTicker@arr Trending Screener (Zero REST Polling Overhead) */}
      <div className="rounded-xl border border-white/[0.06] bg-[#141820]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-100">
                Live Binance Exchange Screener (!miniTicker@arr WS)
              </h3>
              <span
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                  screenerSnapshot?.streamConnected
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-400/35 bg-amber-400/10 text-amber-300'
                }`}
              >
                {screenerSnapshot?.streamConnected ? 'WS STREAM LIVE' : 'SEEDING / FALLBACK'}
              </span>
              {screenerSnapshot && (
                <span className="font-mono text-[11px] text-slate-400">
                  {screenerSnapshot.totalTradableSymbols} {config.trading.venue} tradable · Source:{' '}
                  {screenerSnapshot.rankingSourceUsed}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              Discovers real-time Hot Volume, Top Gainers, Futures Breakdown Shorts, and Volatility Leaders directly from Binance WebSocket streams.
            </p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
            <input
              type="text"
              value={screenerSearch}
              onChange={(e) => setScreenerSearch(e.target.value)}
              placeholder="Search pair (e.g. PEPE)..."
              className="w-52 rounded-lg border border-white/[0.08] bg-[#0D1015] py-1.5 pl-8 pr-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#7DF2AD] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
          <div className="flex flex-wrap gap-1.5">
            {SCREENER_CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const active = screenerCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => onChangeScreenerCategory?.(cat.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? 'bg-[#7DF2AD] text-[#0B0F17]'
                      : 'border border-white/[0.08] bg-[#0D1015] text-slate-300 hover:border-white/20 hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {cat.label}
                </button>
              );
            })}
          </div>
          {screenerCategory === 'top_losers' && config.trading.venue === 'Spot' && (
            <span className="font-mono text-[11px] text-amber-300">
              Spot Mode: Top Losers monitored for oversold bounce/Long setups only (switch to Futures for Shorting).
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          {filteredScreenerTickers.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-400">
              {screenerSnapshot
                ? 'No pairs match your current search or minimum volume filter.'
                : 'Connecting to Binance !miniTicker@arr WebSocket stream...'}
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] text-slate-400">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-4 py-2.5 font-medium">Symbol</th>
                  <th className="px-4 py-2.5 text-right font-medium">Last Price</th>
                  <th className="px-4 py-2.5 text-right font-medium">24h Change</th>
                  <th className="px-4 py-2.5 text-right font-medium">24h Range</th>
                  <th className="px-4 py-2.5 text-right font-medium">24h Quote Volume</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                {filteredScreenerTickers.map((t, idx) => {
                  const isPinned = pinnedSet.has(t.symbol);
                  const inActive = snapshot.pairs.some((p) => p.symbol === t.symbol);
                  const rangePct = t.rangePct24h ?? (t.lowPrice24h > 0 ? ((t.highPrice24h - t.lowPrice24h) / t.lowPrice24h) * 100 : 0);
                  return (
                    <tr key={t.symbol} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5 text-slate-500">{idx + 1}</td>
                      <td className="px-4 py-2.5 font-sans font-semibold text-slate-100">
                        <div className="flex items-center gap-2">
                          <span>{t.symbol}</span>
                          {inActive && (
                            <span className="rounded bg-[#7DF2AD]/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#7DF2AD]">
                              WATCHING
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-100">
                        ${fmtPx(t.lastPrice)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-semibold ${
                          t.priceChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {t.priceChangePercent >= 0 ? '+' : ''}
                        {t.priceChangePercent.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2.5 text-right text-sky-300">
                        {rangePct.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-200">
                        ${fmtUsdMagnitude(t.quoteVolume)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-sans">
                        <div className="inline-flex items-center gap-1.5">
                          {onTogglePinPair && (
                            <button
                              type="button"
                              onClick={() => onTogglePinPair(t.symbol)}
                              className={`rounded border px-2 py-1 text-[11px] font-medium transition ${
                                isPinned
                                  ? 'border-[#7DF2AD]/40 bg-[#7DF2AD]/10 text-[#7DF2AD]'
                                  : 'border-white/10 text-slate-300 hover:border-[#7DF2AD]/40'
                              }`}
                            >
                              {isPinned ? 'Unpin' : 'Pin'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              onPinAndTradeSymbol
                                ? onPinAndTradeSymbol(t.symbol)
                                : onSelectPairAndTrade(t.symbol)
                            }
                            className="inline-flex items-center gap-1 rounded-md bg-[#7DF2AD]/15 px-2.5 py-1 text-xs font-semibold text-[#7DF2AD] transition hover:bg-[#7DF2AD] hover:text-[#0B0F17]"
                          >
                            <span>Trade</span>
                            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

interface SignalsViewProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  onSelectPairAndTrade: (symbol: string) => void;
}

const STRATEGY_CHECKLIST_TITLE: Record<BotConfig['automation']['strategyProfile'], string> = {
  trend_pullback: 'EMA Trend Pullback Signal Matrix',
  ema_breakout: 'Momentum Breakout Signal Matrix',
  vwap_reversion: 'VWAP Mean-Reversion Signal Matrix',
};

export const SignalsView: React.FC<SignalsViewProps> = ({
  snapshot,
  config,
  onSelectPairAndTrade,
}) => {
  const profile = config.automation.strategyProfile;
  const effectivePolicy =
    config.trading.venue === 'Spot' ? 'long_only' : config.automation.directionPolicy;
  const policyLabel =
    effectivePolicy === 'long_only'
      ? 'Long Only'
      : effectivePolicy === 'short_only'
        ? 'Short Only'
        : 'Long & Short';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            {STRATEGY_CHECKLIST_TITLE[profile]}
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Real-time multi-pair confluence checklist synced with your automated strategy ({profile}), 11-layer mitigation gates, and order method ({config.automation.orderMethod}).
          </p>
        </div>
        <div className="font-mono text-xs text-slate-400">
          Venue &amp; Policy:{' '}
          <span className="text-[#7DF2AD]">
            {config.trading.venue} · {policyLabel}
          </span>
        </div>
      </div>

      {!config.features.signalGenerator && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-4 py-2.5 text-xs text-amber-200"
        >
          Signal Generator Pipeline is currently toggled <strong>OFF</strong> in Bot → Feature Toggles. Entry evaluation and signal actions are disabled.
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 ${!config.features.signalGenerator ? 'opacity-50' : ''}`}>
        {snapshot.pairs.map((p) => {
          const ind = p.indicators;
          const diag = evaluateSignalDiagnostics(
            p.symbol,
            p.candles,
            ind,
            config.trading,
            config.indicators,
            Date.now(),
            {
              strategyProfile: profile,
              directionPolicy: config.automation.directionPolicy,
              recentCandles: p.candles,
              features: config.features,
              spreadBps: p.spreadBps,
              enforceVenueLongOnly: true,
            }
          );
          const { checks, bias, preferredSide } = diag;
          const atrVal = ind.atr ?? p.lastPrice * 0.008;
          const slDist = atrVal * config.exits.atrSlMultiplier;
          const slPrice = preferredSide === 'Long' ? p.lastPrice - slDist : p.lastPrice + slDist;
          const tp1Price =
            preferredSide === 'Long'
              ? p.lastPrice + atrVal * config.exits.atrTp1Multiplier
              : p.lastPrice - atrVal * config.exits.atrTp1Multiplier;
          const tp2Price =
            preferredSide === 'Long'
              ? p.lastPrice + atrVal * config.exits.atrTp2Multiplier
              : p.lastPrice - atrVal * config.exits.atrTp2Multiplier;

          const preTradeAudit = evaluatePreTradeValidation({
            pair: p,
            side: preferredSide,
            entryPrice: p.lastPrice,
            stopLossPrice: slPrice,
            takeProfit1Price: tp1Price,
            takeProfit2Price: tp2Price,
            notionalUsdt: config.automation.autoOrderNotionalUsdt,
            equityUsdt: snapshot.risk.currentEquity,
            config,
          });
          const warmedBars = p.barsWarmedUp ?? p.candles.length;
          const minWarmup = config.indicators.minWarmupBars ?? 50;
          const spreadBps = p.spreadBps ?? 0;
          const maxSpread = config.indicators.maxSpreadBps ?? 25;

          return (
            <div
              key={p.symbol}
              className="flex flex-col justify-between space-y-3 rounded-xl border border-white/[0.06] bg-[#141820] p-4"
            >
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="text-base font-semibold text-slate-100">{p.symbol}</h3>
                    {renderSourceTagBadge(p.sourceTag)}
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#7DF2AD]">
                      9-Step: {preTradeAudit.passedCount}/9
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{bias}</span>
                    <span className={`font-mono text-[10px] ${warmedBars >= minWarmup ? 'text-emerald-400' : 'text-amber-400'}`}>
                      Warmup {warmedBars}/{minWarmup}
                    </span>
                    <span className={`font-mono text-[10px] ${spreadBps <= maxSpread ? 'text-slate-400' : 'text-rose-400'}`}>
                      Spread {spreadBps.toFixed(1)} bps
                    </span>
                  </div>
                </div>
                <span className="font-mono text-sm font-semibold tabular-nums text-slate-100">
                  ${fmtPx(p.lastPrice)}
                </span>
              </div>

              {/* Multi-Timeframe Alignment Protocol (§3 Table: D1 / H4 / H1 / M5) */}
              <div className="grid grid-cols-4 gap-1 rounded-lg border border-white/[0.05] bg-[#0D1015] p-1.5 font-mono text-[10px]">
                {preTradeAudit.mtfAlignment.map((mtf) => (
                  <div
                    key={mtf.timeframe}
                    title={`${mtf.role}: ${mtf.metricSummary}`}
                    className={`rounded px-1.5 py-1 text-center ${
                      mtf.aligned
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-white/[0.03] text-slate-500'
                    }`}
                  >
                    <div className="font-bold">{mtf.timeframe.split(' ')[0]}</div>
                    <div className="text-[9px]">{mtf.aligned ? 'ALIGN' : 'WAIT'}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 border-y border-white/[0.06] py-3 text-xs">
                {checks.map((chk) => (
                  <div key={chk.label} className="flex items-center justify-between">
                    <span className="text-slate-300">{chk.label}</span>
                    {chk.ok ? (
                      <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Pass
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-medium text-slate-500">
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        Wait
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Trade Plan Invalidation & R:R Readout (§1 & §4) */}
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                <span>
                  Invalidation:{' '}
                  <strong className="text-rose-300">
                    ${fmtPx(slPrice)}
                  </strong>
                </span>
                <span>
                  Target R:R:{' '}
                  <strong className="text-emerald-300">
                    1:{preTradeAudit.rewardToRiskRatio.toFixed(2)}
                  </strong>
                </span>
              </div>

              <button
                type="button"
                disabled={!config.features.signalGenerator}
                title={!config.features.signalGenerator ? 'Signal Generator is disabled in Feature Toggles' : undefined}
                onClick={() => onSelectPairAndTrade(p.symbol)}
                className="w-full rounded-lg border border-white/[0.08] bg-[#0D1015] py-2 text-xs font-semibold text-slate-100 transition hover:border-emerald-400/50 hover:text-[#7DF2AD] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Open {p.symbol} in Trade Desk
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
