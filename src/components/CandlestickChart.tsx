import React, { useMemo, useState } from 'react';
import {
  Activity,
  BarChart2,
  Crosshair,
  Eye,
  EyeOff,
  Minus,
  Plus,
  RefreshCw,
  StepForward,
  TrendingUp,
} from 'lucide-react';
import type {
  FeatureToggles,
  PairRuntimeState,
  Timeframe,
  TransportMode,
} from '../engine/types';

interface CandlestickChartProps {
  pair: PairRuntimeState;
  timeframe: Timeframe;
  adxMinTrend: number;
  transportMode: TransportMode;
  features?: FeatureToggles;
  onChangeTimeframe: (tf: Timeframe) => void;
  onStepBar: () => void;
  onSimulateTransport: (mode: TransportMode) => void;
}

function fmtPrice(val: number): string {
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 10) return val.toFixed(2);
  return val.toFixed(4);
}

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '1h'];

export const CandlestickChart: React.FC<CandlestickChartProps> = ({
  pair,
  timeframe,
  adxMinTrend,
  transportMode,
  features,
  onChangeTimeframe,
  onStepBar,
  onSimulateTransport,
}) => {
  const [chartType, setChartType] = useState<'candles' | 'line'>('candles');
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showBrackets, setShowBrackets] = useState(true);
  const [showIndicatorsMenu, setShowIndicatorsMenu] = useState(false);
  const [hideChart, setHideChart] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const wsPrimaryEnabled = features?.wsPrimaryFeed ?? true;
  const restFallbackEnabled = features?.restFallback ?? true;
  const emaEnabled = features?.emaTrendFilter ?? true;
  const vwapEnabled = features?.vwapBiasFilter ?? true;
  const atrExitsEnabled = features?.atrDynamicExits ?? true;
  const effectiveShowEma = showEma && emaEnabled;
  const effectiveShowVwap = showVwap && vwapEnabled;
  const effectiveShowBrackets = showBrackets && atrExitsEnabled;
  const transportSwitchDisabled =
    transportMode === 'WsPrimary' ? !restFallbackEnabled : !wsPrimaryEnabled;

  const visibleCount = 72;
  const candles = pair.candles.slice(-visibleCount);
  const indicators = pair.indicatorHistory.slice(-visibleCount);
  const pos = pair.openPosition;

  const activeCandle =
    hoverIdx !== null && candles[hoverIdx]
      ? candles[hoverIdx]
      : candles[candles.length - 1];

  const chartMath = useMemo(() => {
    const width = 900;
    const height = 340;
    const padTop = 18;
    const padBottom = 52; // extra band at bottom for volume histogram
    const padLeft = 12;
    const padRight = 84;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    let minP = Infinity;
    let maxP = -Infinity;
    let maxVol = 1;

    for (let i = 0; i < candles.length; i += 1) {
      const c = candles[i];
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
      const ind = indicators[i];
      if (effectiveShowEma && ind?.emaFast) {
        minP = Math.min(minP, ind.emaFast);
        maxP = Math.max(maxP, ind.emaFast);
      }
      if (effectiveShowEma && ind?.emaSlow) {
        minP = Math.min(minP, ind.emaSlow);
        maxP = Math.max(maxP, ind.emaSlow);
      }
    }

    if (effectiveShowBrackets && pos) {
      minP = Math.min(minP, pos.exitPlan.activeStopLoss, pos.entryPrice);
      maxP = Math.max(maxP, pos.exitPlan.takeProfit2, pos.entryPrice);
    }

    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP) {
      minP = pair.lastPrice * 0.99;
      maxP = pair.lastPrice * 1.01;
    }

    const span = maxP - minP;
    minP -= span * 0.08;
    maxP += span * 0.08;

    const toY = (price: number) =>
      padTop + ((maxP - price) / Math.max(maxP - minP, 1e-9)) * plotH;
    const stepX = plotW / Math.max(candles.length, 1);

    const buildLine = (getter: (i: number) => number | null) => {
      const pts: string[] = [];
      for (let i = 0; i < candles.length; i += 1) {
        const v = getter(i);
        if (v !== null) {
          const x = padLeft + i * stepX + stepX * 0.5;
          pts.push(`${pts.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${toY(v).toFixed(1)}`);
        }
      }
      return pts.join(' ');
    };

    const gridLevels = Array.from({ length: 5 }, (_, idx) => {
      const price = minP + ((maxP - minP) * idx) / 4;
      return { price, y: toY(price) };
    });

    return {
      width,
      height,
      padLeft,
      padRight,
      padTop,
      plotW,
      plotH,
      maxVol,
      toY,
      stepX,
      gridLevels,
      closeLinePath: buildLine((i) => candles[i]?.close ?? null),
      emaFastPath: buildLine((i) => indicators[i]?.emaFast ?? null),
      emaMidPath: buildLine((i) => indicators[i]?.emaMid ?? null),
      emaSlowPath: buildLine((i) => indicators[i]?.emaSlow ?? null),
      vwapPath: buildLine((i) => indicators[i]?.vwap ?? null),
    };
  }, [candles, indicators, pos, pair.lastPrice, effectiveShowEma, effectiveShowBrackets]);

  const ind = pair.indicators;
  const adxValue = ind.adx ?? 0;
  const isTrending = adxValue >= adxMinTrend;
  const candleDelta = activeCandle ? activeCandle.close - activeCandle.open : 0;
  const candleDeltaPct = activeCandle && activeCandle.open > 0 ? (candleDelta / activeCandle.open) * 100 : 0;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#141820] overflow-hidden">
      {/* Top TradingView-style Chart Toolbar */}
      <div className="relative flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => onChangeTimeframe(tf)}
              className={`rounded px-2 py-1 font-mono text-xs transition ${
                timeframe === tf
                  ? 'bg-sky-500/15 font-semibold text-sky-400'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {tf}
            </button>
          ))}

          <span className="mx-1 h-4 w-px bg-white/[0.08]" aria-hidden="true" />

          <button
            type="button"
            onClick={() => setChartType((c) => (c === 'candles' ? 'line' : 'candles'))}
            aria-label="Toggle candle or line chart"
            className={`rounded p-1.5 transition ${
              chartType === 'candles'
                ? 'text-slate-200 hover:bg-white/[0.06]'
                : 'bg-sky-500/15 text-sky-400'
            }`}
          >
            {chartType === 'candles' ? (
              <BarChart2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowIndicatorsMenu((v) => !v)}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white whitespace-nowrap"
          >
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            Indicators
          </button>

          <button
            type="button"
            onClick={() => setHideChart((h) => !h)}
            className="flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#0D1015] px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-800 whitespace-nowrap"
          >
            {hideChart ? (
              <>
                <Eye className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                Show Charts
              </>
            ) : (
              <>
                <EyeOff className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                Hide Charts
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onStepBar}
            className="flex items-center gap-1 rounded border border-white/[0.08] bg-[#0D1015] px-2.5 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-800 whitespace-nowrap"
          >
            <StepForward className="h-3.5 w-3.5" aria-hidden="true" />
            Step Bar
          </button>
          <button
            type="button"
            disabled={transportSwitchDisabled}
            title={transportSwitchDisabled ? 'Target transport mode is disabled in Feature Toggles' : undefined}
            onClick={() =>
              onSimulateTransport(
                transportMode === 'WsPrimary' ? 'RestFallback' : 'WsPrimary'
              )
            }
            className={`flex items-center gap-1 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
              transportMode === 'WsPrimary'
                ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300'
                : 'border-amber-500/35 bg-amber-950/30 text-amber-300'
            }`}
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {transportMode === 'WsPrimary' ? 'WS Primary' : 'REST Fallback'}
          </button>
        </div>

        {/* Indicators Popover Menu */}
        {showIndicatorsMenu && (
          <div className="absolute left-36 top-10 z-30 w-56 rounded-lg border border-white/10 bg-[#0D1015] p-3 shadow-xl space-y-2 text-xs">
            <div className="font-semibold text-slate-200">Overlay Indicators</div>
            <label className={`flex items-center justify-between ${emaEnabled ? 'text-slate-300' : 'text-slate-500 opacity-50'}`}>
              <span>EMA Stack (9 / 21 / 50)</span>
              <input
                type="checkbox"
                disabled={!emaEnabled}
                checked={effectiveShowEma}
                onChange={(e) => setShowEma(e.target.checked)}
                className="h-3.5 w-3.5 disabled:cursor-not-allowed"
              />
            </label>
            <label className={`flex items-center justify-between ${vwapEnabled ? 'text-slate-300' : 'text-slate-500 opacity-50'}`}>
              <span>Session VWAP</span>
              <input
                type="checkbox"
                disabled={!vwapEnabled}
                checked={effectiveShowVwap}
                onChange={(e) => setShowVwap(e.target.checked)}
                className="h-3.5 w-3.5 disabled:cursor-not-allowed"
              />
            </label>
            <label className={`flex items-center justify-between ${atrExitsEnabled ? 'text-slate-300' : 'text-slate-500 opacity-50'}`}>
              <span>ATR SL / TP Brackets</span>
              <input
                type="checkbox"
                disabled={!atrExitsEnabled}
                checked={effectiveShowBrackets}
                onChange={(e) => setShowBrackets(e.target.checked)}
                className="h-3.5 w-3.5 disabled:cursor-not-allowed"
              />
            </label>
          </div>
        )}
      </div>

      {/* Main Chart Body (with Left Tool Rail matching reference) */}
      {!hideChart && (
        <div className="flex">
          {/* Left Vertical Drawing Tool Rail */}
          <div className="hidden w-10 shrink-0 flex-col items-center gap-2 border-r border-white/[0.06] bg-[#10141B] py-3 sm:flex">
            <button
              type="button"
              onClick={() => setHoverIdx(null)}
              aria-label="Reset crosshair inspector"
              className="rounded p-1.5 text-[#7DF2AD] transition hover:bg-white/10"
            >
              <Crosshair className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!emaEnabled}
              onClick={() => setShowEma((v) => !v)}
              aria-pressed={effectiveShowEma}
              aria-label="Toggle EMA trend lines"
              className={`rounded p-1.5 transition disabled:cursor-not-allowed disabled:opacity-35 ${
                effectiveShowEma ? 'bg-white/10 text-sky-400' : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              <TrendingUp className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!atrExitsEnabled}
              onClick={() => setShowBrackets((v) => !v)}
              aria-pressed={effectiveShowBrackets}
              aria-label="Toggle ATR SL and TP price levels"
              className={`rounded p-1.5 transition disabled:cursor-not-allowed disabled:opacity-35 ${
                effectiveShowBrackets ? 'bg-white/10 text-emerald-400' : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={!vwapEnabled}
              onClick={() => setShowVwap((v) => !v)}
              aria-label="Toggle VWAP overlay"
              className={`rounded p-1.5 transition disabled:cursor-not-allowed disabled:opacity-35 ${
                effectiveShowVwap ? 'text-slate-200 hover:bg-white/5' : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* Chart Canvas + Live OHLC Header */}
          <div className="min-w-0 flex-1 bg-[#10141B]">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="font-semibold text-slate-100">
                  {pair.symbol.replace('USDT', '')} / TetherUS · {timeframe} · BINANCE
                </h2>
                {activeCandle && (
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums">
                    <span>
                      <span className="text-slate-500">O</span>
                      <span className={candleDelta >= 0 ? 'text-[#26A69A]' : 'text-[#EF5350]'}>
                        {fmtPrice(activeCandle.open)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">H</span>
                      <span className={candleDelta >= 0 ? 'text-[#26A69A]' : 'text-[#EF5350]'}>
                        {fmtPrice(activeCandle.high)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">L</span>
                      <span className={candleDelta >= 0 ? 'text-[#26A69A]' : 'text-[#EF5350]'}>
                        {fmtPrice(activeCandle.low)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">C</span>
                      <span className={candleDelta >= 0 ? 'text-[#26A69A]' : 'text-[#EF5350]'}>
                        {fmtPrice(activeCandle.close)} ({candleDeltaPct >= 0 ? '+' : ''}
                        {candleDeltaPct.toFixed(2)}%)
                      </span>
                    </span>
                  </div>
                )}
              </div>

              {activeCandle && (
                <div className="font-mono text-[11px] tabular-nums text-slate-400">
                  Vol{' '}
                  <span className={candleDelta >= 0 ? 'text-[#26A69A]' : 'text-[#EF5350]'}>
                    {(activeCandle.volume / 1000).toFixed(2)}K
                  </span>
                </div>
              )}
            </div>

            <div className="px-1 pb-1">
              <svg
                data-testid="pair-candlestick-chart"
                viewBox={`0 0 ${chartMath.width} ${chartMath.height}`}
                className="h-[300px] w-full select-none"
                role="img"
                aria-label={`${pair.symbol} candlestick and ATR exit bracket chart`}
                onMouseLeave={() => setHoverIdx(null)}
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = ((e.clientX - rect.left) / rect.width) * chartMath.width;
                  const idx = Math.floor((relX - chartMath.padLeft) / chartMath.stepX);
                  if (idx >= 0 && idx < candles.length) {
                    setHoverIdx(idx);
                  }
                }}
              >
                {/* Horizontal Price Grid */}
                {chartMath.gridLevels.map((g, idx) => (
                  <g key={idx}>
                    <line
                      x1={chartMath.padLeft}
                      y1={g.y}
                      x2={chartMath.width - chartMath.padRight}
                      y2={g.y}
                      stroke="#1B212C"
                      strokeWidth="1"
                    />
                    <text
                      x={chartMath.width - chartMath.padRight + 8}
                      y={g.y + 4}
                      fill="#64748B"
                      fontSize="10"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {fmtPrice(g.price)}
                    </text>
                  </g>
                ))}

                {/* Volume Histogram along bottom */}
                {candles.map((c, i) => {
                  const xCenter = chartMath.padLeft + i * chartMath.stepX + chartMath.stepX * 0.5;
                  const barW = Math.max(2, chartMath.stepX * 0.55);
                  const volH = (c.volume / Math.max(chartMath.maxVol, 1)) * 34;
                  const yBase = chartMath.height - 6;
                  const bullish = c.close >= c.open;
                  return (
                    <rect
                      key={`v-${c.openTimeMs}`}
                      x={xCenter - barW / 2}
                      y={yBase - volH}
                      width={barW}
                      height={volH}
                      fill={bullish ? '#26A69A' : '#EF5350'}
                      opacity="0.28"
                    />
                  );
                })}

                {/* Indicator Overlays */}
                {effectiveShowVwap && chartMath.vwapPath && (
                  <path
                    d={chartMath.vwapPath}
                    fill="none"
                    stroke="#CBD5E1"
                    strokeWidth="1.15"
                    strokeDasharray="3 3"
                    opacity="0.65"
                  />
                )}
                {effectiveShowEma && chartMath.emaSlowPath && (
                  <path d={chartMath.emaSlowPath} fill="none" stroke="#A78BFA" strokeWidth="1.3" opacity="0.8" />
                )}
                {effectiveShowEma && chartMath.emaMidPath && (
                  <path d={chartMath.emaMidPath} fill="none" stroke="#FBBF24" strokeWidth="1.3" opacity="0.85" />
                )}
                {effectiveShowEma && chartMath.emaFastPath && (
                  <path d={chartMath.emaFastPath} fill="none" stroke="#38BDF8" strokeWidth="1.4" />
                )}

                {/* Candlesticks or Close Line */}
                {chartType === 'candles' ? (
                  candles.map((c, i) => {
                    const xCenter = chartMath.padLeft + i * chartMath.stepX + chartMath.stepX * 0.5;
                    const candleW = Math.max(3, chartMath.stepX * 0.62);
                    const bullish = c.close >= c.open;
                    const color = bullish ? '#26A69A' : '#EF5350';
                    const yHigh = chartMath.toY(c.high);
                    const yLow = chartMath.toY(c.low);
                    const yTop = chartMath.toY(Math.max(c.open, c.close));
                    const yBot = chartMath.toY(Math.min(c.open, c.close));
                    const bodyH = Math.max(1.5, yBot - yTop);

                    return (
                      <g key={c.openTimeMs}>
                        <line x1={xCenter} y1={yHigh} x2={xCenter} y2={yLow} stroke={color} strokeWidth="1.1" />
                        <rect
                          x={xCenter - candleW / 2}
                          y={yTop}
                          width={candleW}
                          height={bodyH}
                          fill={color}
                          rx="0.5"
                        />
                      </g>
                    );
                  })
                ) : (
                  <path d={chartMath.closeLinePath} fill="none" stroke="#7DF2AD" strokeWidth="1.8" />
                )}

                {/* Crosshair Hover Line */}
                {hoverIdx !== null && candles[hoverIdx] && (
                  <line
                    x1={chartMath.padLeft + hoverIdx * chartMath.stepX + chartMath.stepX * 0.5}
                    y1={chartMath.padTop}
                    x2={chartMath.padLeft + hoverIdx * chartMath.stepX + chartMath.stepX * 0.5}
                    y2={chartMath.height - 6}
                    stroke="#64748B"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                )}

                {/* Current Last Price Dashed Line & Right Axis Tag */}
                {(() => {
                  const lastY = chartMath.toY(pair.lastPrice);
                  const bullish = (candles[candles.length - 1]?.close ?? 0) >= (candles[candles.length - 1]?.open ?? 0);
                  const tagColor = bullish ? '#26A69A' : '#EF5350';
                  return (
                    <g>
                      <line
                        x1={chartMath.padLeft}
                        y1={lastY}
                        x2={chartMath.width - chartMath.padRight}
                        y2={lastY}
                        stroke={tagColor}
                        strokeWidth="1"
                        strokeDasharray="2 2"
                        opacity="0.7"
                      />
                      <rect
                        x={chartMath.width - chartMath.padRight + 4}
                        y={lastY - 9}
                        width="76"
                        height="18"
                        rx="2"
                        fill={tagColor}
                      />
                      <text
                        x={chartMath.width - chartMath.padRight + 8}
                        y={lastY + 3.5}
                        fill="#FFFFFF"
                        fontSize="10"
                        fontWeight="700"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {fmtPrice(pair.lastPrice)}
                      </text>
                    </g>
                  );
                })()}

                {/* Active Position ATR SL / BE / TP Brackets */}
                {effectiveShowBrackets && pos && (
                  <g>
                    {[
                      ...(pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0
                        ? pos.exitPlan.tpTargets.map((t, idx) => ({
                            label: `TP${idx + 1}`,
                            price: t.targetPrice,
                            color: idx === pos.exitPlan.tpTargets!.length - 1 ? '#10B981' : '#34D399',
                            dash: idx === pos.exitPlan.tpTargets!.length - 1 ? '4 3' : '2 2',
                          }))
                        : [
                            { label: 'TP2', price: pos.exitPlan.takeProfit2, color: '#10B981', dash: '4 3' },
                            { label: 'TP1', price: pos.exitPlan.takeProfit1, color: '#34D399', dash: '2 2' },
                          ]),
                      { label: 'ENTRY', price: pos.entryPrice, color: '#3B82F6', dash: '' },
                      {
                        label: pos.exitPlan.trailingActive
                          ? 'TRAIL SL'
                          : pos.exitPlan.breakEvenArmed
                            ? 'BE SL'
                            : 'ATR SL',
                        price: pos.exitPlan.activeStopLoss,
                        color: pos.exitPlan.breakEvenArmed ? '#F59E0B' : '#EF4444',
                        dash: '',
                      },
                    ].map((lvl) => {
                      const y = chartMath.toY(lvl.price);
                      return (
                        <g key={lvl.label}>
                          <line
                            x1={chartMath.padLeft}
                            y1={y}
                            x2={chartMath.width - chartMath.padRight}
                            y2={y}
                            stroke={lvl.color}
                            strokeWidth="1.2"
                            strokeDasharray={lvl.dash || undefined}
                          />
                          <rect
                            x={chartMath.padLeft + 4}
                            y={y - 11}
                            width="58"
                            height="14"
                            rx="2"
                            fill={lvl.color}
                          />
                          <text
                            x={chartMath.padLeft + 8}
                            y={y - 1}
                            fill="#0B0F17"
                            fontSize="8.5"
                            fontWeight="700"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {lvl.label}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                )}
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Compact Technical Indicator Telemetry Bar */}
      <div className="grid grid-cols-2 gap-px border-t border-white/[0.06] bg-white/[0.06] sm:grid-cols-5">
        <div className="bg-[#141820] px-3.5 py-2">
          <div className="text-[11px] text-slate-400">ADX (14)</div>
          <div className="mt-0.5 flex items-baseline gap-2 font-mono text-xs font-semibold tabular-nums">
            <span className={isTrending ? 'text-emerald-400' : 'text-amber-400'}>
              {ind.adx !== null ? ind.adx.toFixed(1) : '—'}
            </span>
            <span className="font-sans text-[11px] font-medium text-slate-400">
              {isTrending ? 'Trending' : 'Choppy'}
            </span>
          </div>
        </div>
        <div className="bg-[#141820] px-3.5 py-2">
          <div className="text-[11px] text-slate-400">+DI / -DI</div>
          <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
            {ind.plusDi !== null && ind.minusDi !== null
              ? `${ind.plusDi.toFixed(1)} / ${ind.minusDi.toFixed(1)}`
              : '—'}
          </div>
        </div>
        <div className="bg-[#141820] px-3.5 py-2">
          <div className="text-[11px] text-slate-400">Wilder RSI (14)</div>
          <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
            {ind.rsi !== null ? ind.rsi.toFixed(1) : '—'}
          </div>
        </div>
        <div className="bg-[#141820] px-3.5 py-2">
          <div className="text-[11px] text-slate-400">ATR (14)</div>
          <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
            {ind.atr !== null ? `$${fmtPrice(ind.atr)}` : '—'}
          </div>
        </div>
        <div className="col-span-2 bg-[#141820] px-3.5 py-2 sm:col-span-1">
          <div className="text-[11px] text-slate-400">Session VWAP</div>
          <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-slate-200">
            {ind.vwap !== null ? `$${fmtPrice(ind.vwap)}` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
};
