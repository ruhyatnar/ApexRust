import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Pause,
  Play,
  Radar,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { fmtPx, fmtUsdMagnitude } from '../engine/formatters';
import { evaluateUtcSessionWindows } from '../engine/sessionWindows';
import type {
  BotConfig,
  EngineSnapshot,
  ExchangeVenue,
  LiveCredentialStatus,
  ManualOrderInput,
  MarginType,
  Timeframe,
  TransportMode,
} from '../engine/types';
import { CandlestickChart } from './CandlestickChart';
import { OrderTicketPanel } from './OrderTicketPanel';
import { SummaryCardsRow } from './SummaryCardsRow';
import { TradeHistoryView } from './TradeHistoryView';

interface TradingDeskViewProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  liveStatus: LiveCredentialStatus;
  liveTicker?: { symbol: string; bid: number; ask: number; last: number } | null;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onChangeTimeframe: (tf: Timeframe) => void;
  onStepBar: () => void;
  onToggleFeedSource: (source: 'Simulated' | 'BinanceLive') => void;
  onSimulateTransport: (mode: TransportMode) => void;
  onSubmitOrder: (input: ManualOrderInput) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>;
  onClosePosition: (symbol: string) => void;
  onFlattenAll: () => void;
  onCancelPendingOrder: (orderId: string) => void;
  onToggleAutomation: () => void;
  onRunAutoScan: () => void;
  onOpenStrategyConfig: () => void;
  onOpenFeatureToggles: () => void;
  onUpdateVenue: (venue: ExchangeVenue) => void;
  onUpdateFuturesSettings: (leverage: number, marginType: MarginType) => void;
  onResetCircuitBreaker: () => void;
  onOpenLiveCredentials: () => void;
  serverTargetLabel?: string;
  isRemoteVpsDaemon?: boolean;
  onOpenVpsConnection?: () => void;
  onSyncLiveTrades?: (symbol: string) => Promise<{
    ok: boolean;
    added: number;
    latencyMs?: number;
    message: string;
  }>;
}

const PROFILE_LABELS: Record<BotConfig['automation']['strategyProfile'], string> = {
  trend_pullback: 'EMA Trend Pullback',
  ema_breakout: 'Momentum Breakout',
  vwap_reversion: 'VWAP Reversion',
};

function fmtUsd(val: number): string {
  return `${val < 0 ? '-' : ''}$${fmtUsdMagnitude(val)}`;
}

const fmtPrice = fmtPx;

export const TradingDeskView: React.FC<TradingDeskViewProps> = ({
  snapshot,
  config,
  liveStatus,
  liveTicker,
  selectedSymbol,
  onSelectSymbol,
  onChangeTimeframe,
  onStepBar,
  onToggleFeedSource,
  onSimulateTransport,
  onSubmitOrder,
  onClosePosition,
  onFlattenAll,
  onCancelPendingOrder,
  onToggleAutomation,
  onRunAutoScan,
  onOpenStrategyConfig,
  onOpenFeatureToggles,
  onUpdateVenue,
  onUpdateFuturesSettings,
  onResetCircuitBreaker,
  onOpenLiveCredentials,
  serverTargetLabel = '🖥️ This Computer',
  isRemoteVpsDaemon = false,
  onOpenVpsConnection,
  onSyncLiveTrades,
}) => {
  const [ledgerTab, setLedgerTab] = useState<'positions' | 'pending' | 'trades' | 'events'>('positions');
  const activePair =
    snapshot.pairs.find((p) => p.symbol === selectedSymbol) ?? snapshot.pairs[0];
  const openPositions = snapshot.pairs.filter((p) => p.openPosition !== null);
  const { risk } = snapshot;
  const auto = config.automation;
  const enabledFeaturesCount = Object.values(config.features).filter(Boolean).length;
  const totalFeaturesCount = Object.keys(config.features).length;
  const sessionEval = evaluateUtcSessionWindows(
    Date.now(),
    auto.sessionWindows,
    Boolean(config.features.sessionWindowFilter)
  );

  const activeVenueAllowed =
    config.trading.venue === 'Spot'
      ? config.features.spotMarket
      : config.features.futuresMarket;
  const canRunAutoScan =
    config.features.automatedTrading &&
    config.features.signalGenerator &&
    activeVenueAllowed &&
    !(isRemoteVpsDaemon && snapshot.accountMode === 'Live');

  const localAutoManagedByVps = isRemoteVpsDaemon && snapshot.accountMode === 'Live';

  return (
    <div className="space-y-4">
      {/* Compact Automated Trading & Strategy Control Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#141820] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
            <span className="font-semibold text-slate-100">Auto-Trading</span>
            <span
              className={`font-mono text-[11px] font-bold ${
                localAutoManagedByVps
                  ? 'text-cyan-300'
                  : auto.enabled
                    ? 'text-[#7DF2AD]'
                    : 'text-amber-400'
              }`}
            >
              {localAutoManagedByVps ? '☁️ 24/7 VPS MANAGED' : auto.enabled ? 'ACTIVE' : 'PAUSED'}
            </span>
          </div>

          <span className="hidden h-3.5 w-px bg-white/[0.08] sm:inline-block" aria-hidden="true" />

          <span className="text-slate-400">
            Venue:{' '}
            <strong
              className={`font-mono font-semibold ${
                config.trading.venue === 'Futures' ? 'text-amber-300' : 'text-[#7DF2AD]'
              }`}
            >
              {config.trading.venue === 'Futures'
                ? `Futures · ${config.trading.leverage}x`
                : 'Spot'}
            </strong>
          </span>

          <span className="text-slate-400">
            Strategy:{' '}
            <strong className="font-medium text-slate-100">
              {PROFILE_LABELS[auto.strategyProfile]}
            </strong>
          </span>

          <span className="text-slate-400">
            Order:{' '}
            <strong className="font-mono font-semibold text-slate-100">
              {auto.orderMethod.replace('_', ' ')}
            </strong>
          </span>

          <span className="text-slate-400">
            Bias:{' '}
            <strong className="font-mono font-medium text-slate-200">
              {config.trading.venue === 'Spot'
                ? 'Spot Long Only'
                : auto.directionPolicy === 'long_only'
                  ? 'Futures Long Only'
                  : auto.directionPolicy === 'short_only'
                    ? 'Futures Short Only'
                    : 'Futures Long & Short'}
            </strong>
          </span>

          <span className="text-slate-400">
            Watchlist:{' '}
            <strong className="font-mono font-medium capitalize text-[#7DF2AD]">
              {config.trading.pairSelectionMode ?? 'hybrid'} ({snapshot.pairs.length})
            </strong>
          </span>

          {config.features.sessionWindowFilter && (
            <span className="text-slate-400">
              Session:{' '}
              <strong
                className={`font-mono font-semibold ${
                  sessionEval.allowed ? 'text-[#7DF2AD]' : 'text-amber-400'
                }`}
              >
                {sessionEval.allowed
                  ? `${sessionEval.activeWindow?.label ?? 'Active'} (${sessionEval.currentUtcHHMM} UTC)`
                  : `Outside Window (${sessionEval.currentUtcHHMM} UTC)`}
              </strong>
            </span>
          )}

          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            Modules {enabledFeaturesCount}/{totalFeaturesCount} · Scans {snapshot.autoStats.scansRun} · Orders{' '}
            {snapshot.autoStats.autoOrdersDispatched}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canRunAutoScan}
            title={
              localAutoManagedByVps
                ? '☁️ Automated Trading is managed 24/7 by your Remote VPS'
                : !canRunAutoScan
                  ? 'Enable Automated Trading, Signal Generator, and active Market Venue in Feature Toggles'
                  : undefined
            }
            onClick={onRunAutoScan}
            className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-[#7DF2AD]/50 hover:text-[#7DF2AD] disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap"
          >
            <Radar className="h-3.5 w-3.5" aria-hidden="true" />
            Scan Now
          </button>

          <button
            type="button"
            disabled={!config.features.automatedTrading || localAutoManagedByVps}
            title={
              localAutoManagedByVps
                ? '☁️ Use Open 24/7 VPS Bot Monitor to pause or resume the 24/7 VPS Bot'
                : !config.features.automatedTrading
                  ? 'Automated Trading Engine is toggled OFF in Bot -> Feature Toggles'
                  : undefined
            }
            onClick={onToggleAutomation}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
              auto.enabled
                ? 'border border-white/[0.08] bg-[#0D1015] text-slate-200 hover:border-amber-400/50 hover:text-amber-300'
                : 'bg-[#7DF2AD] text-[#0B0F17] hover:bg-[#95F7BD]'
            }`}
          >
            {auto.enabled ? (
              <>
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                Pause Auto
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Auto Disabled (OFF)
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenFeatureToggles}
            className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-[#7DF2AD]/40 hover:text-white whitespace-nowrap"
          >
            Feature Toggles
          </button>

          <button
            type="button"
            onClick={onOpenStrategyConfig}
            className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#0D1015] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:text-white whitespace-nowrap"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Strategy Options
          </button>
        </div>
      </div>

      {/* Remote VPS 24/7 Daemon Context Banner */}
      {isRemoteVpsDaemon && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-400/35 bg-cyan-950/25 px-4 py-2.5 text-xs text-cyan-100"
        >
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
            <span>
              <strong>Connected to {serverTargetLabel}:</strong> 24/7 Automated Trading & ATR Exits run continuously on your Remote VPS. Manual Live Orders placed here are routed directly to your 24/7 VPS Bot.
            </span>
          </div>
          {onOpenVpsConnection && (
            <button
              type="button"
              onClick={onOpenVpsConnection}
              className="rounded-md bg-cyan-400 px-3 py-1 text-xs font-bold text-[#0B0F17] transition hover:bg-cyan-300 whitespace-nowrap"
            >
              Open 24/7 VPS Bot Monitor
            </button>
          )}
        </div>
      )}

      {/* Circuit Breaker Alert Banner when Halted or Cooldown */}
      {risk.state !== 'Active' && (
        <div
          role="alert"
          className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
            risk.state === 'Halted'
              ? 'border-rose-500/40 bg-rose-950/30 text-rose-100'
              : 'border-amber-500/40 bg-amber-950/30 text-amber-100'
          }`}
        >
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">
                {risk.state === 'Halted'
                  ? 'Circuit Breaker Tripped — Trading Halted'
                  : 'Streak Cooldown Active'}
              </p>
              <p className="text-xs text-slate-300">
                {risk.haltReason ?? 'New entries paused by risk management policy.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!config.features.circuitBreaker}
            title={!config.features.circuitBreaker ? 'Circuit Breaker is disabled in Feature Toggles' : undefined}
            onClick={onResetCircuitBreaker}
            className="rounded-md bg-[#7DF2AD] px-3.5 py-1.5 text-xs font-bold text-[#0B0F17] transition hover:bg-[#9AF7BF] disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Reset Circuit Breaker
          </button>
        </div>
      )}

      {/* Live Credentials Safety Gate Banner when viewing Live Account */}
      {snapshot.accountMode === 'Live' && (!liveStatus.configured || !liveStatus.armedForLiveOrders) && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-500/35 bg-amber-950/25 px-4 py-3 text-amber-100"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">
                {!liveStatus.configured
                  ? 'Isolated Live Account — API Credentials Required'
                  : `Live Account Disarmed (${liveStatus.environment})`}
              </p>
              <p className="text-xs text-slate-300">
                {!liveStatus.configured
                  ? 'Paper balances and trades are hidden here. Configure your Binance Spot API Key & Secret in the Server Vault to sync live balances and execute orders.'
                  : 'Credentials are stored in the server vault, but Live Order Execution is currently disarmed for safety.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenLiveCredentials}
            className="rounded-md bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-[#0B0F17] transition hover:bg-amber-300 whitespace-nowrap shrink-0"
          >
            Configure Live Credentials
          </button>
        </div>
      )}

      {/* Reference Split: Left Order Ticket (~340px) + Right (3 Cards + Chart + Positions Dock) */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-4 2xl:col-span-3">
          {activePair && (
            <OrderTicketPanel
              snapshot={snapshot}
              config={config}
              activePair={activePair}
              liveStatus={liveStatus}
              liveTicker={liveTicker}
              isRemoteVpsDaemon={isRemoteVpsDaemon}
              onSelectSymbol={onSelectSymbol}
              onSubmitOrder={onSubmitOrder}
              onToggleFeedSource={onToggleFeedSource}
              onOpenLiveCredentials={onOpenLiveCredentials}
              onUpdateVenue={onUpdateVenue}
              onUpdateFuturesSettings={onUpdateFuturesSettings}
            />
          )}
        </div>

        <div className="min-w-0 space-y-4 xl:col-span-8 2xl:col-span-9">
          {/* Top 3 Summary Cards: Balance, Trades Donut, PnL Sparkline */}
          <SummaryCardsRow snapshot={snapshot} config={config} />

          {/* Main Interactive Candlestick Chart */}
          {activePair && (
            <CandlestickChart
              pair={activePair}
              timeframe={config.trading.timeframe}
              adxMinTrend={config.indicators.adxMinTrend}
              transportMode={snapshot.transport.mode}
              features={config.features}
              onChangeTimeframe={onChangeTimeframe}
              onStepBar={onStepBar}
              onSimulateTransport={onSimulateTransport}
            />
          )}

          {/* Compact Multi-Pair Quick Strip + Tabbed Positions / Pending / Trades / Log */}
          <div className="rounded-xl border border-white/[0.06] bg-[#141820]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
              <div
                className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-[#0D1015] p-1"
                role="tablist"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={ledgerTab === 'positions'}
                  onClick={() => setLedgerTab('positions')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition whitespace-nowrap shrink-0 ${
                    ledgerTab === 'positions'
                      ? 'bg-[#1D2330] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Open Positions ({openPositions.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={ledgerTab === 'pending'}
                  onClick={() => setLedgerTab('pending')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition whitespace-nowrap shrink-0 ${
                    ledgerTab === 'pending'
                      ? 'bg-[#1D2330] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Pending Orders ({snapshot.pendingOrders.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={ledgerTab === 'trades'}
                  onClick={() => setLedgerTab('trades')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition whitespace-nowrap shrink-0 ${
                    ledgerTab === 'trades'
                      ? 'bg-[#1D2330] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Closed Trades ({snapshot.recentTrades.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={ledgerTab === 'events'}
                  onClick={() => setLedgerTab('events')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition whitespace-nowrap shrink-0 ${
                    ledgerTab === 'events'
                      ? 'bg-[#1D2330] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Execution Log ({snapshot.eventLog.length})
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {snapshot.pairs.map((p) => {
                  const active = p.symbol === activePair?.symbol;
                  return (
                    <button
                      key={p.symbol}
                      type="button"
                      onClick={() => onSelectSymbol(p.symbol)}
                      className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-medium transition whitespace-nowrap ${
                        active
                          ? 'border border-emerald-400/40 bg-emerald-950/40 text-emerald-300'
                          : 'border border-white/[0.06] bg-[#0D1015] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {p.symbol.replace('USDT', '')}
                    </button>
                  );
                })}

                {openPositions.length > 0 && (
                  <button
                    type="button"
                    onClick={onFlattenAll}
                    className="ml-1 rounded-md border border-rose-500/40 px-2.5 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-950/40 whitespace-nowrap"
                  >
                    Flatten All
                  </button>
                )}
              </div>
            </div>

            {ledgerTab === 'positions' && (
              <div className="overflow-x-auto">
                {openPositions.length === 0 ? (
                  <div className="px-5 py-6 text-center">
                    <p className="text-sm text-slate-300">No open positions currently held.</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Submit an order from the left ticket or wait for automated trend confluence (ADX ≥ {config.indicators.adxMinTrend}).
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-slate-400">
                        <th className="px-4 py-2.5 font-medium">Pair / Side</th>
                        <th className="px-4 py-2.5 text-right font-medium">Entry</th>
                        <th className="px-4 py-2.5 text-right font-medium">Active SL</th>
                        <th className="px-4 py-2.5 text-right font-medium">Targets</th>
                        <th className="px-4 py-2.5 text-right font-medium">Exit Mode</th>
                        <th className="px-4 py-2.5 text-right font-medium">Unrealized</th>
                        <th className="px-4 py-2.5 text-right font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                      {openPositions.map((p) => {
                        const pos = p.openPosition!;
                        const exitMode = pos.exitPlan.trailingActive
                          ? 'ATR Trailing'
                          : pos.exitPlan.breakEvenArmed
                            ? 'Break-Even'
                            : 'Initial SL';
                        return (
                          <tr key={pos.id} className="hover:bg-white/[0.02]">
                            <td className="px-4 py-2.5 font-sans">
                              <button
                                type="button"
                                onClick={() => onSelectSymbol(p.symbol)}
                                className="flex items-center gap-1.5 font-semibold text-slate-100 hover:text-emerald-300"
                              >
                                {pos.side === 'Long' ? (
                                  <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                                ) : (
                                  <ArrowDownRight className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
                                )}
                                <span>{p.symbol}</span>
                                <span className="text-slate-400">· {pos.side}</span>
                              </button>
                            </td>
                            <td className="px-4 py-2.5 text-right text-slate-200">
                              ${fmtPrice(pos.entryPrice)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-amber-300">
                              ${fmtPrice(pos.exitPlan.activeStopLoss)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-slate-300">
                              {pos.exitPlan.tpTargets
                                ? `${pos.exitPlan.tpTargets.length} TP Ladder`
                                : `$${fmtPrice(pos.exitPlan.takeProfit1)} / $${fmtPrice(pos.exitPlan.takeProfit2)}`}
                            </td>
                            <td className="px-4 py-2.5 text-right font-sans text-slate-300">
                              {exitMode}
                            </td>
                            <td
                              className={`px-4 py-2.5 text-right font-semibold ${
                                pos.unrealizedPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {pos.unrealizedPnlUsdt >= 0 ? '+' : ''}
                              {fmtUsd(pos.unrealizedPnlUsdt)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-sans">
                              <button
                                type="button"
                                onClick={() => onClosePosition(p.symbol)}
                                className="rounded border border-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:border-rose-400/50 hover:text-rose-300"
                              >
                                Close
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {ledgerTab === 'pending' && (
              <div className="overflow-x-auto">
                {snapshot.pendingOrders.length === 0 ? (
                  <div className="px-5 py-6 text-center">
                    <p className="text-sm text-slate-300">No resting LIMIT or LIMIT MAKER orders.</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Place a passive LIMIT / LIMIT MAKER order from the ticket or switch Automated Order Method to LIMIT.
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.06] text-slate-400">
                        <th className="px-4 py-2.5 font-medium">Pair / Side</th>
                        <th className="px-4 py-2.5 font-medium">Method / Origin</th>
                        <th className="px-4 py-2.5 text-right font-medium">Limit Price</th>
                        <th className="px-4 py-2.5 text-right font-medium">Notional</th>
                        <th className="px-4 py-2.5 text-right font-medium">TIF / Age</th>
                        <th className="px-4 py-2.5 text-right font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                      {snapshot.pendingOrders.map((ord) => {
                        const pairState = snapshot.pairs.find((p) => p.symbol === ord.symbol);
                        const closedBars = pairState?.barsWarmedUp ?? pairState?.candles.filter((c) => c.isClosed).length ?? 0;
                        const barsAged =
                          typeof ord.ageBars === 'number'
                            ? Math.max(0, ord.ageBars)
                            : typeof ord.createdBarIndex === 'number'
                              ? Math.max(0, closedBars - ord.createdBarIndex)
                              : 0;
                        const maxAge = config.automation.maxPendingOrderBars ?? 6;
                        return (
                        <tr key={ord.id} className="hover:bg-white/[0.02]">
                          <td className="px-4 py-2.5 font-sans font-semibold text-slate-100">
                            <div>
                              {ord.symbol}{' '}
                              <span className={ord.side === 'Long' ? 'text-emerald-400' : 'text-rose-400'}>
                                · {ord.side}
                              </span>
                            </div>
                            {ord.dynamicStatusNote && (
                              <div className="mt-0.5 text-[10px] font-normal text-amber-300/90">
                                {ord.dynamicStatusNote}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-slate-300">
                            <span>{ord.orderType}</span>{' '}
                            <span
                              className={`ml-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase ${
                                ord.source === 'manual'
                                  ? 'bg-sky-500/15 text-sky-300'
                                  : 'bg-[#7DF2AD]/15 text-[#7DF2AD]'
                              }`}
                            >
                              {ord.source ?? 'auto'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right text-amber-300">
                            ${ord.limitPrice >= 100 ? ord.limitPrice.toFixed(2) : ord.limitPrice.toFixed(4)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-slate-200">
                            {fmtUsd(ord.usdtAmount)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-slate-400">
                            {ord.orderMethod === 'LIMIT_MAKER' ? 'POST-ONLY' : ord.timeInForce} ·{' '}
                            <span className="text-slate-300">
                              {ord.source === 'manual' ? `${barsAged}b` : `${barsAged}/${maxAge}b`}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-sans">
                            <button
                              type="button"
                              onClick={() => onCancelPendingOrder(ord.id)}
                              className="rounded border border-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:border-rose-400/50 hover:text-rose-300"
                            >
                              Cancel
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {ledgerTab === 'trades' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-slate-400">
                      <th className="px-4 py-2.5 font-medium">Pair</th>
                      <th className="px-4 py-2.5 font-medium">Exit Reason</th>
                      <th className="px-4 py-2.5 text-right font-medium">Entry → Exit</th>
                      <th className="px-4 py-2.5 text-right font-medium">R-Mult</th>
                      <th className="px-4 py-2.5 text-right font-medium">Realized PnL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                    {snapshot.recentTrades.slice(0, 12).map((t) => (
                      <tr key={t.id} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5 font-sans font-medium text-slate-100">
                          {t.symbol} · {t.side}
                        </td>
                        <td className="px-4 py-2.5 font-sans text-slate-300">{t.reason}</td>
                        <td className="px-4 py-2.5 text-right text-slate-300">
                          ${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right ${
                            t.rMultiple >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {t.rMultiple >= 0 ? '+' : ''}
                          {t.rMultiple.toFixed(2)}R
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-semibold ${
                            t.pnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {t.pnlUsdt >= 0 ? '+' : ''}
                          {fmtUsd(t.pnlUsdt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {ledgerTab === 'events' && (
              <div className="max-h-56 divide-y divide-white/[0.05] overflow-y-auto">
                {snapshot.eventLog.map((ev) => (
                  <div key={ev.id} className="flex items-start justify-between gap-3 px-4 py-2 text-xs">
                    <div className="flex items-start gap-2">
                      {ev.level === 'alert' ? (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
                      ) : ev.level === 'warn' ? (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                      ) : (
                        <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7DF2AD]" aria-hidden="true" />
                      )}
                      <span className="text-slate-200">{ev.message}</span>
                    </div>
                    <span className="font-mono text-[11px] tabular-nums text-slate-500 whitespace-nowrap shrink-0">
                      {new Date(ev.timestampMs).toISOString().slice(11, 19)} UTC
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Full-Width Binance Execution & Trade History Table (Entries + Exits) */}
      <TradeHistoryView
        executions={snapshot.executionHistory}
        activeSymbol={activePair?.symbol ?? selectedSymbol}
        activeVenue={config.trading.venue}
        symbols={snapshot.pairs.map((p) => p.symbol)}
        onSelectSymbol={onSelectSymbol}
        onSyncLiveTrades={onSyncLiveTrades}
      />
    </div>
  );
};
