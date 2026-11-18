import React from 'react';
import { ArrowUpRight, CheckCircle2, RefreshCw, Wifi, WifiOff, XCircle } from 'lucide-react';
import { evaluatePreTradeValidation } from '../engine/quantAnalytics';
import { evaluateSignalDiagnostics } from '../engine/strategy';
import type { BotConfig, EngineSnapshot, TransportMode } from '../engine/types';

interface MarketsViewProps {
  snapshot: EngineSnapshot;
  config: BotConfig;
  selectedSymbol: string;
  onSelectPairAndTrade: (symbol: string) => void;
  onSimulateTransport: (mode: TransportMode) => void;
  onToggleFeedSource: (source: 'Simulated' | 'BinanceLive') => void;
}

export const MarketsView: React.FC<MarketsViewProps> = ({
  snapshot,
  config,
  selectedSymbol,
  onSelectPairAndTrade,
  onSimulateTransport,
  onToggleFeedSource,
}) => {
  const { transport, risk } = snapshot;

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
              onClick={() => onToggleFeedSource('BinanceLive')}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
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
            onClick={() =>
              onSimulateTransport(
                transport.mode === 'WsPrimary' ? 'RestFallback' : 'WsPrimary'
              )
            }
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
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
          <div className="text-xs text-slate-400">Active Profile</div>
          <div className="mt-1 font-mono text-base font-semibold capitalize text-slate-100">
            {config.trading.mode} · {config.trading.timeframe}
          </div>
          <div className="mt-1 font-mono text-[11px] text-slate-400">
            {snapshot.pairs.length} Pairs · ADX Min {config.indicators.adxMinTrend}
          </div>
        </div>
      </div>

      {/* Multi-Pair Table */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-[#141820]">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-white/[0.06] text-slate-400">
              <th className="px-4 py-3 font-medium">Pair</th>
              <th className="px-4 py-3 text-right font-medium">Last Price</th>
              <th className="px-4 py-3 text-right font-medium">Session %</th>
              <th className="px-4 py-3 text-right font-medium">ADX (14)</th>
              <th className="px-4 py-3 text-right font-medium">RSI (14)</th>
              <th className="px-4 py-3 text-right font-medium">Vol Ratio (20)</th>
              <th className="px-4 py-3 text-right font-medium">ATR (14)</th>
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
              return (
                <tr key={p.symbol} className={isSelected ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}>
                  <td className="px-4 py-3 font-sans font-semibold text-slate-100">
                    {p.symbol}
                    {isQuarantined && (
                      <span className="ml-2 text-[11px] font-medium text-rose-400">Quarantined</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-100">
                    ${p.lastPrice >= 100 ? p.lastPrice.toFixed(2) : p.lastPrice.toFixed(4)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      p.change24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {p.change24hPct >= 0 ? '+' : ''}
                    {p.change24hPct.toFixed(2)}%
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
                  <td className="px-4 py-3 text-right text-slate-200">
                    {ind.atr !== null ? `$${ind.atr.toFixed(p.lastPrice >= 100 ? 2 : 4)}` : '—'}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${
                      p.dailyPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {p.dailyPnlUsdt >= 0 ? '+' : '-'}${Math.abs(p.dailyPnlUsdt).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right font-sans">
                    <button
                      type="button"
                      onClick={() => onSelectPairAndTrade(p.symbol)}
                      className="inline-flex items-center gap-1 rounded-md bg-[#7DF2AD]/15 px-2.5 py-1 text-xs font-semibold text-[#7DF2AD] transition hover:bg-[#7DF2AD] hover:text-[#0B0F17]"
                    >
                      <span>Load Ticket</span>
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
  const longOnly = config.automation.directionPolicy === 'long_only';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            {STRATEGY_CHECKLIST_TITLE[profile]}
          </h2>
          <p className="mt-0.5 text-sm text-slate-400">
            Real-time multi-pair confluence checklist synced with your automated strategy ({profile}) and order method ({config.automation.orderMethod}).
          </p>
        </div>
        <div className="font-mono text-xs text-slate-400">
          Policy:{' '}
          <span className="text-[#7DF2AD]">{longOnly ? 'Spot Long Only' : 'Long & Short'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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

          return (
            <div
              key={p.symbol}
              className="flex flex-col justify-between space-y-3 rounded-xl border border-white/[0.06] bg-[#141820] p-4"
            >
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-slate-100">{p.symbol}</h3>
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#7DF2AD]">
                      9-Step: {preTradeAudit.passedCount}/9
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">{bias}</div>
                </div>
                <span className="font-mono text-sm font-semibold tabular-nums text-slate-100">
                  ${p.lastPrice >= 100 ? p.lastPrice.toFixed(2) : p.lastPrice.toFixed(4)}
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
                    ${slPrice.toFixed(p.lastPrice >= 100 ? 2 : 4)}
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
                onClick={() => onSelectPairAndTrade(p.symbol)}
                className="w-full rounded-lg border border-white/[0.08] bg-[#0D1015] py-2 text-xs font-semibold text-slate-100 transition hover:border-emerald-400/50 hover:text-[#7DF2AD]"
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
