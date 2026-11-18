import type {
  BotConfig,
  ClosedTrade,
  PairRuntimeState,
  PositionSizingMode,
  Side,
} from './types';

export interface ExpectancyAnalytics {
  sampleCount: number;
  isStatisticallySignificant: boolean; // >= 50 trades per §5 & §6
  winCount: number;
  lossCount: number;
  winRateP: number; // p in [0, 1]
  lossRateQ: number; // q = 1 - p
  avgWinUsdt: number;
  avgLossUsdt: number;
  avgWinR: number;
  avgLossR: number;
  payoffRatioB: number; // b = AvgWin / AvgLoss
  expectancyR: number; // E(R) = p * AvgWinR - q * AvgLossR
  expectancyUsdt: number; // E($) = p * AvgWin$ - q * AvgLoss$
  grossProfitUsdt: number;
  grossLossUsdt: number;
  profitFactor: number; // GrossProfit / GrossLoss
  profitFactorRegime:
    | 'NoSample'
    | 'NetLosing'
    | 'SubThreshold'
    | 'ViableEdge'
    | 'StrongEdge'
    | 'OverfitWarning';
  expectedMaxLossStreak500: number;
  streak12DrawdownAtCurrentRiskPct: number;
  streak12DrawdownAt5PctRisk: number;
  streak12DrawdownAt1PctRisk: number;
}

export interface KellyTierProjection {
  id: PositionSizingMode;
  label: string;
  riskFractionPct: number; // % of account equity risked per trade
  capitalRiskPerTradeUsdt: number;
  notionalPositionUsdt: number;
  requiredLeverage: number;
  logGrowthRateG: number; // G(f) = p * ln(1 + b*f) + q * ln(1 - f)
  projectedGain100TradesUsdt: number;
  projectedEndingEquity100TradesUsdt: number;
  estimatedMaxDrawdownPct: number;
  probabilityOfRuinPct: number;
}

export interface KellyGrowthPoint {
  fractionPct: number;
  logGrowthBps: number;
  zone: 'Optimal' | 'Overbet' | 'Ruin';
}

export interface KellySizingAnalytics {
  winRateP: number;
  lossRateQ: number;
  payoffRatioB: number;
  rawFullKellyFraction: number; // f* = (b*p - q) / b (can be <= 0)
  fullKellyPct: number; // clamped [0, 60]%
  halfKellyPct: number; // 0.5 * f*
  quarterKellyPct: number; // 0.25 * f*
  negativeExpectancyWarning: boolean; // true when f* <= 0 (EV <= 0)
  sampleSizeWarning: boolean; // true when closedTrades < 50
  stopDistanceFraction: number; // |Entry - SL| / Entry
  tiers: KellyTierProjection[];
  growthCurve: KellyGrowthPoint[];
}

export interface PortfolioCorrelationMatrix {
  symbols: string[];
  matrix: number[][]; // N x N Pearson correlation in [-1, 1]
  avgPairwiseCorrelation: number;
  diversificationMultiplier: number; // C^-1 scaling factor in (0, 1]
  adjustedHalfKellyBySymbol: Record<string, number>; // % equity risk per pair after correlation penalty
}

export interface MultiTimeframeRoleStatus {
  timeframe: 'D1 (Macro)' | 'H4 (Structure)' | 'H1 (Momentum)' | 'M5 (Execution)';
  role: string;
  metricSummary: string;
  aligned: boolean;
}

export interface ValidationStepResult {
  step: number;
  title: string;
  detail: string;
  passed: boolean;
  mandatory: boolean;
}

export interface PreTradeValidationReport {
  symbol: string;
  side: Side;
  entryPrice: number;
  invalidationPrice: number;
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  rewardToRiskRatio: number;
  calculatedDollarRiskUsdt: number;
  calculatedNotionalUsdt: number;
  calculatedBaseQty: number;
  estimatedRoundTripFeeUsdt: number;
  feeToTargetProfitPct: number;
  volumeRatio: number;
  hierarchy: {
    signalLayer: string;
    recommendationLayer: string;
    tradePlanLayer: string;
  };
  mtfAlignment: MultiTimeframeRoleStatus[];
  steps: ValidationStepResult[];
  passedCount: number;
  allMandatoryPassed: boolean;
}

/**
 * §6 Strategy Expectancy & Profit Factor Engine
 * E(R) = (p * AvgWinR) - (q * AvgLossR)
 * Profit Factor = Gross Profit ($) / Gross Loss ($)
 */
export function computeExpectancyStats(
  closedTrades: ClosedTrade[],
  baseRiskPerTradePct = 0.75
): ExpectancyAnalytics {
  const sampleCount = closedTrades.length;
  const wins = closedTrades.filter((t) => t.pnlUsdt > 0);
  const losses = closedTrades.filter((t) => t.pnlUsdt <= 0);

  const winCount = wins.length;
  const lossCount = losses.length;

  // Use empirical stats if we have both wins and losses; fallback to briefing priors (p=0.58, b=1.5) when empty
  const winRateP = sampleCount > 0 ? winCount / sampleCount : 0.58;
  const lossRateQ = 1 - winRateP;

  const grossProfitUsdt = wins.reduce((acc, t) => acc + t.pnlUsdt, 0);
  const grossLossUsdt = Math.abs(losses.reduce((acc, t) => acc + t.pnlUsdt, 0));

  const avgWinUsdt = winCount > 0 ? grossProfitUsdt / winCount : 150;
  const avgLossUsdt = lossCount > 0 ? grossLossUsdt / lossCount : 100;

  const avgWinR =
    winCount > 0
      ? wins.reduce((acc, t) => acc + Math.max(0.05, Math.abs(t.rMultiple)), 0) / winCount
      : 1.8;
  const avgLossR =
    lossCount > 0
      ? losses.reduce((acc, t) => acc + Math.max(0.05, Math.abs(t.rMultiple)), 0) / lossCount
      : 1.0;

  const payoffRatioB = avgLossR > 1e-9 ? avgWinR / avgLossR : 1.5;
  const expectancyR = winRateP * avgWinR - lossRateQ * avgLossR;
  const expectancyUsdt = winRateP * avgWinUsdt - lossRateQ * avgLossUsdt;

  const profitFactor =
    grossLossUsdt > 1e-6
      ? grossProfitUsdt / grossLossUsdt
      : grossProfitUsdt > 0
        ? Infinity
        : 0;

  let profitFactorRegime: ExpectancyAnalytics['profitFactorRegime'] = 'NoSample';
  if (sampleCount > 0) {
    if (!Number.isFinite(profitFactor)) profitFactorRegime = 'StrongEdge';
    else if (profitFactor < 1.0) profitFactorRegime = 'NetLosing';
    else if (profitFactor < 1.3) profitFactorRegime = 'SubThreshold';
    else if (profitFactor <= 2.0) profitFactorRegime = 'ViableEdge';
    else if (profitFactor <= 3.0) profitFactorRegime = 'StrongEdge';
    else profitFactorRegime = 'OverfitWarning';
  }

  // Expected longest losing run in N=500 trades: ln(500) / -ln(q)
  const safeQ = Math.min(0.95, Math.max(0.05, lossRateQ));
  const expectedMaxLossStreak500 = Math.max(1, Math.round(Math.log(500) / -Math.log(safeQ)));

  // Peak-to-trough compound drawdown across a 12-consecutive-loss tail event: 1 - (1 - r)^12
  const rCur = Math.min(0.5, Math.max(0.001, baseRiskPerTradePct / 100));
  const streak12DrawdownAtCurrentRiskPct = (1 - Math.pow(1 - rCur, 12)) * 100;
  const streak12DrawdownAt5PctRisk = (1 - Math.pow(1 - 0.05, 12)) * 100;
  const streak12DrawdownAt1PctRisk = (1 - Math.pow(1 - 0.01, 12)) * 100;

  return {
    sampleCount,
    isStatisticallySignificant: sampleCount >= 50,
    winCount,
    lossCount,
    winRateP,
    lossRateQ,
    avgWinUsdt,
    avgLossUsdt,
    avgWinR,
    avgLossR,
    payoffRatioB,
    expectancyR,
    expectancyUsdt,
    grossProfitUsdt,
    grossLossUsdt,
    profitFactor,
    profitFactorRegime,
    expectedMaxLossStreak500,
    streak12DrawdownAtCurrentRiskPct,
    streak12DrawdownAt5PctRisk,
    streak12DrawdownAt1PctRisk,
  };
}

/**
 * §5 Expected Logarithmic Growth Rate G(f) = p * ln(1 + b*f) + q * ln(1 - f)
 */
export function computeLogGrowthRate(winRateP: number, payoffB: number, fractionF: number): number {
  const f = Math.max(0, Math.min(0.99, fractionF));
  if (f <= 0 || payoffB <= 0) return 0;
  const p = Math.min(0.99, Math.max(0.01, winRateP));
  const q = 1 - p;
  return p * Math.log(1 + payoffB * f) + q * Math.log(1 - f);
}

/**
 * §5 Kelly Criterion & Comparative Position Sizing Engine
 * f* = (b * p - q) / b
 * Notional Position Size = (Account Equity * f) / StopDistanceDecimal
 */
export function computeKellySizingAnalytics(
  expectancy: ExpectancyAnalytics,
  equityUsdt: number,
  stopDistanceFraction: number,
  baseRiskPerTradePct = 0.75
): KellySizingAnalytics {
  const safeEquity = Math.max(100, equityUsdt || 10_000);
  const safeStopDist = Math.max(0.002, Math.min(0.25, stopDistanceFraction || 0.015));

  const p = expectancy.winRateP;
  const q = expectancy.lossRateQ;
  const b = Math.max(0.1, expectancy.payoffRatioB);

  const rawFullKellyFraction = (b * p - q) / b;
  const negativeExpectancyWarning = rawFullKellyFraction <= 0;
  const clampedFullF = Math.max(0, Math.min(0.5, rawFullKellyFraction));

  const fullKellyPct = clampedFullF * 100;
  const halfKellyPct = fullKellyPct * 0.5;
  const quarterKellyPct = fullKellyPct * 0.25;

  const buildTier = (
    id: PositionSizingMode,
    label: string,
    riskFractionPct: number,
    estMaxDdFactor: number,
    ruinProbPct: number
  ): KellyTierProjection => {
    const f = Math.max(0, riskFractionPct / 100);
    const capitalRiskPerTradeUsdt = safeEquity * f;
    const notionalPositionUsdt = safeStopDist > 0 ? capitalRiskPerTradeUsdt / safeStopDist : 0;
    const requiredLeverage = safeEquity > 0 ? notionalPositionUsdt / safeEquity : 1;
    const logGrowthRateG = computeLogGrowthRate(p, b, f);
    // Expected geometric equity after 100 trades damped by crypto autocorrelation (0.45 realism factor)
    const dampedG = logGrowthRateG * 0.45;
    const projectedEndingEquity100TradesUsdt =
      f > 0 ? safeEquity * Math.exp(Math.max(-0.9, Math.min(2.2, dampedG * 100))) : safeEquity;
    const projectedGain100TradesUsdt = projectedEndingEquity100TradesUsdt - safeEquity;

    return {
      id,
      label,
      riskFractionPct,
      capitalRiskPerTradeUsdt,
      notionalPositionUsdt,
      requiredLeverage,
      logGrowthRateG,
      projectedGain100TradesUsdt,
      projectedEndingEquity100TradesUsdt,
      estimatedMaxDrawdownPct: estMaxDdFactor,
      probabilityOfRuinPct: ruinProbPct,
    };
  };

  const tiers: KellyTierProjection[] = [
    buildTier('fixed_risk_pct', `Fixed ${baseRiskPerTradePct.toFixed(2)}% Risk`, baseRiskPerTradePct, 8.5, 0.05),
    buildTier('quarter_kelly', 'Quarter-Kelly (0.25 f*)', quarterKellyPct, Math.min(35, Math.max(9, quarterKellyPct * 2.8)), 0.8),
    buildTier('half_kelly', 'Half-Kelly (0.50 f*)', halfKellyPct, Math.min(55, Math.max(16, halfKellyPct * 2.5)), 3.9),
    buildTier('full_kelly', 'Full Kelly (1.00 f*)', fullKellyPct, Math.min(82, Math.max(32, fullKellyPct * 2.05)), 18.2),
  ];

  // Build G(f) curve from f = 0 to f = max(2.2 * f*, 0.40)
  const maxCurveF = Math.min(0.85, Math.max(0.35, clampedFullF * 2.15));
  const steps = 28;
  const growthCurve: KellyGrowthPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const f = (i / steps) * maxCurveF;
    const g = computeLogGrowthRate(p, b, f);
    const zone: KellyGrowthPoint['zone'] =
      g < 0 ? 'Ruin' : f <= clampedFullF * 1.02 ? 'Optimal' : 'Overbet';
    growthCurve.push({
      fractionPct: Number((f * 100).toFixed(2)),
      logGrowthBps: Number((g * 10_000).toFixed(2)),
      zone,
    });
  }

  return {
    winRateP: p,
    lossRateQ: q,
    payoffRatioB: b,
    rawFullKellyFraction,
    fullKellyPct,
    halfKellyPct,
    quarterKellyPct,
    negativeExpectancyWarning,
    sampleSizeWarning: !expectancy.isStatisticallySignificant,
    stopDistanceFraction: safeStopDist,
    tiers,
    growthCurve,
  };
}

/**
 * Converts a chosen PositionSizingMode into an order notional (USDT) using the Briefing §5 formula:
 * Dollar Risk = Account Equity * f
 * Notional Position Size = Dollar Risk / StopDistanceDecimal
 */
export function calculateQuantitativePositionSizeUsdt(params: {
  mode: PositionSizingMode;
  fixedUsdt: number;
  equityUsdt: number;
  availableBalanceUsdt: number;
  baseRiskPerTradePct: number;
  entryPrice: number;
  stopLossPrice: number;
  kelly: KellySizingAnalytics;
  venue: 'Spot' | 'Futures';
  leverage: number;
  diversificationMultiplier?: number;
}): {
  notionalUsdt: number;
  dollarRiskUsdt: number;
  riskFractionPct: number;
  stopDistancePct: number;
  blockedByNegativeKelly: boolean;
} {
  const stopDistanceFraction =
    params.entryPrice > 0
      ? Math.max(0.002, Math.abs(params.entryPrice - params.stopLossPrice) / params.entryPrice)
      : 0.015;
  const stopDistancePct = stopDistanceFraction * 100;

  if (params.mode === 'fixed_usdt') {
    const notionalUsdt = Math.max(10, params.fixedUsdt);
    const dollarRiskUsdt = notionalUsdt * stopDistanceFraction;
    const riskFractionPct = params.equityUsdt > 0 ? (dollarRiskUsdt / params.equityUsdt) * 100 : 0;
    return {
      notionalUsdt,
      dollarRiskUsdt,
      riskFractionPct,
      stopDistancePct,
      blockedByNegativeKelly: false,
    };
  }

  const divMult = params.diversificationMultiplier ?? 1;
  let riskFractionPct = params.baseRiskPerTradePct;

  if (params.mode === 'quarter_kelly') {
    if (params.kelly.negativeExpectancyWarning) {
      return {
        notionalUsdt: 0,
        dollarRiskUsdt: 0,
        riskFractionPct: 0,
        stopDistancePct,
        blockedByNegativeKelly: true,
      };
    }
    riskFractionPct = params.kelly.quarterKellyPct * divMult;
  } else if (params.mode === 'half_kelly') {
    if (params.kelly.negativeExpectancyWarning) {
      return {
        notionalUsdt: 0,
        dollarRiskUsdt: 0,
        riskFractionPct: 0,
        stopDistancePct,
        blockedByNegativeKelly: true,
      };
    }
    riskFractionPct = params.kelly.halfKellyPct * divMult;
  } else if (params.mode === 'full_kelly') {
    if (params.kelly.negativeExpectancyWarning) {
      return {
        notionalUsdt: 0,
        dollarRiskUsdt: 0,
        riskFractionPct: 0,
        stopDistancePct,
        blockedByNegativeKelly: true,
      };
    }
    riskFractionPct = params.kelly.fullKellyPct * divMult;
  }

  const dollarRiskUsdt = params.equityUsdt * (riskFractionPct / 100);
  const rawNotionalUsdt = dollarRiskUsdt / stopDistanceFraction;

  // Cap notional by venue buying power (Spot: availableBalanceUsdt * 0.98; Futures: availableBalanceUsdt * leverage * 0.95)
  const maxBuyingPowerUsdt =
    params.venue === 'Futures'
      ? params.availableBalanceUsdt * Math.max(1, params.leverage) * 0.95
      : params.availableBalanceUsdt * 0.98;

  const notionalUsdt = Number(
    Math.max(10, Math.min(rawNotionalUsdt, Math.max(10, maxBuyingPowerUsdt))).toFixed(2)
  );

  return {
    notionalUsdt,
    dollarRiskUsdt: Number((notionalUsdt * stopDistanceFraction).toFixed(2)),
    riskFractionPct: Number(riskFractionPct.toFixed(2)),
    stopDistancePct: Number(stopDistancePct.toFixed(2)),
    blockedByNegativeKelly: false,
  };
}

/**
 * §5 Portfolio Kelly Matrix for Correlated Assets (f* = C^-1 * mu)
 * Computes pairwise return correlation across active symbols and derives the
 * covariance diversification multiplier so correlated positions don't overbet.
 */
export function computePortfolioCorrelationMatrix(
  pairs: PairRuntimeState[],
  baseHalfKellyPct: number
): PortfolioCorrelationMatrix {
  const symbols = pairs.map((p) => p.symbol);
  const n = symbols.length;
  const returnsBySymbol: number[][] = pairs.map((p) => {
    const closes = p.candles.slice(-65).map((c) => c.close);
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const prev = closes[i - 1] || 1;
      rets.push((closes[i] - prev) / prev);
    }
    return rets;
  });

  const pearson = (a: number[], b: number[]): number => {
    const len = Math.min(a.length, b.length);
    if (len < 3) return 0;
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < len; i += 1) {
      meanA += a[i];
      meanB += b[i];
    }
    meanA /= len;
    meanB /= len;
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < len; i += 1) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    const denom = Math.sqrt(denA * denB);
    return denom > 1e-12 ? Math.max(-1, Math.min(1, num / denom)) : 0;
  };

  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  let offDiagSum = 0;
  let offDiagCount = 0;

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) {
        matrix[i][j] = 1;
      } else {
        const corr = pearson(returnsBySymbol[i], returnsBySymbol[j]);
        matrix[i][j] = Number(corr.toFixed(2));
        if (j > i) {
          offDiagSum += Math.max(0, corr);
          offDiagCount += 1;
        }
      }
    }
  }

  const avgPairwiseCorrelation = offDiagCount > 0 ? offDiagSum / offDiagCount : 0.5;
  // Closed-form equal-correlation inverse covariance dampening factor: 1 / (1 + (k - 1) * rho)
  // For k = 3 concurrent crypto positions with correlation rho, C^-1 scales each single-asset Kelly by 1 / (1 + 2 * rho)
  const effectiveConcurrent = Math.min(n, 3);
  const diversificationMultiplier =
    1 / (1 + Math.max(0, (effectiveConcurrent - 1) * avgPairwiseCorrelation));

  const adjustedHalfKellyBySymbol: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const sym = symbols[i];
    const rowAvgCorr =
      n > 1
        ? matrix[i].reduce((acc, v, idx) => (idx === i ? acc : acc + Math.max(0, v)), 0) / (n - 1)
        : 0;
    const symScale = 1 / (1 + Math.max(0, (effectiveConcurrent - 1) * rowAvgCorr));
    adjustedHalfKellyBySymbol[sym] = Number((baseHalfKellyPct * symScale).toFixed(2));
  }

  return {
    symbols,
    matrix,
    avgPairwiseCorrelation: Number(avgPairwiseCorrelation.toFixed(2)),
    diversificationMultiplier: Number(diversificationMultiplier.toFixed(3)),
    adjustedHalfKellyBySymbol,
  };
}

/**
 * §3 9-Step Signal Validation Protocol + Multi-Timeframe Alignment + §1 Trade Plan Hierarchy
 */
export function evaluatePreTradeValidation(params: {
  pair: PairRuntimeState;
  side: Side;
  entryPrice: number;
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  notionalUsdt: number;
  equityUsdt: number;
  config: BotConfig;
}): PreTradeValidationReport {
  const { pair, side, entryPrice, stopLossPrice, takeProfit1Price, takeProfit2Price, notionalUsdt, equityUsdt, config } =
    params;
  const ind = pair.indicators;
  const latestCandle = pair.candles[pair.candles.length - 1];
  const recent20 = pair.candles.slice(-21, -1);

  const swingHigh20 =
    recent20.length > 0 ? Math.max(...recent20.map((c) => c.high)) : entryPrice * 1.015;
  const swingLow20 =
    recent20.length > 0 ? Math.min(...recent20.map((c) => c.low)) : entryPrice * 0.985;

  const atr = ind.atr ?? entryPrice * 0.008;
  const invalidationPrice =
    side === 'Long'
      ? Math.min(entryPrice - atr * 0.5, swingLow20)
      : Math.max(entryPrice + atr * 0.5, swingHigh20);

  const stopDist = Math.max(1e-8, Math.abs(entryPrice - stopLossPrice));
  const targetDist = Math.max(
    Math.abs(takeProfit2Price - entryPrice),
    Math.abs(takeProfit1Price - entryPrice)
  );
  const rewardToRiskRatio = targetDist / stopDist;

  const calculatedBaseQty = entryPrice > 0 ? notionalUsdt / entryPrice : 0;
  const calculatedDollarRiskUsdt = calculatedBaseQty * stopDist;
  const equityRiskPct = equityUsdt > 0 ? (calculatedDollarRiskUsdt / equityUsdt) * 100 : 0;

  // Round-trip taker/maker fee + estimated 2.5 bps spread cost
  const feeRatePerLeg = config.trading.takerFeeBps / 10_000;
  const estimatedRoundTripFeeUsdt = notionalUsdt * (feeRatePerLeg * 2 + 0.00025);
  const grossTargetProfitUsdt = calculatedBaseQty * targetDist;
  const feeToTargetProfitPct =
    grossTargetProfitUsdt > 0 ? (estimatedRoundTripFeeUsdt / grossTargetProfitUsdt) * 100 : 100;

  const volumeRatio = ind.volumeRatio ?? 1.0;
  const minVolMult = config.indicators.minVolumeExpansionMult ?? 1.5;

  // Multi-Timeframe Alignment Roles (§3 Table)
  const d1Aligned =
    ind.emaMacro !== null
      ? side === 'Long'
        ? entryPrice >= ind.emaMacro
        : entryPrice <= ind.emaMacro
      : true;
  const h4Aligned =
    ind.emaSlow !== null && ind.vwap !== null
      ? side === 'Long'
        ? entryPrice >= Math.min(ind.emaSlow, ind.vwap)
        : entryPrice <= Math.max(ind.emaSlow, ind.vwap)
      : true;
  const h1Aligned =
    ind.emaFast !== null && ind.emaMid !== null
      ? side === 'Long'
        ? ind.emaFast >= ind.emaMid && (ind.plusDi ?? 25) >= (ind.minusDi ?? 15)
        : ind.emaFast <= ind.emaMid && (ind.minusDi ?? 25) >= (ind.plusDi ?? 15)
      : true;
  const m5Aligned = Boolean(latestCandle?.isClosed) && (ind.adx ?? 0) >= config.indicators.adxMinTrend;

  const mtfAlignment: MultiTimeframeRoleStatus[] = [
    {
      timeframe: 'D1 (Macro)',
      role: 'Dominant Market Trend',
      metricSummary:
        ind.emaMacro !== null
          ? `Price ${side === 'Long' ? '>' : '<'} Macro EMA200 ($${ind.emaMacro.toFixed(2)})`
          : 'EMA200 Warmup',
      aligned: d1Aligned,
    },
    {
      timeframe: 'H4 (Structure)',
      role: 'Swing Value Zone',
      metricSummary: `Swing Range $${swingLow20.toFixed(2)} – $${swingHigh20.toFixed(2)} · VWAP $${(ind.vwap ?? entryPrice).toFixed(2)}`,
      aligned: h4Aligned,
    },
    {
      timeframe: 'H1 (Momentum)',
      role: 'Momentum & DI Shift',
      metricSummary: `EMA9/21 Stack · +DI ${(ind.plusDi ?? 0).toFixed(1)} / -DI ${(ind.minusDi ?? 0).toFixed(1)}`,
      aligned: h1Aligned,
    },
    {
      timeframe: 'M5 (Execution)',
      role: 'Closed Bar & ADX Trigger',
      metricSummary: `ADX ${(ind.adx ?? 0).toFixed(1)} · Vol ${volumeRatio.toFixed(2)}× Avg`,
      aligned: m5Aligned,
    },
  ];

  // 9-Step Signal Validation Protocol (§3)
  const atrBufferMult = atr > 0 ? stopDist / atr : config.exits.atrSlMultiplier;
  const steps: ValidationStepResult[] = [
    {
      step: 1,
      title: 'Check HTF Trend (Macro EMA200)',
      detail: d1Aligned
        ? `${side} aligned with macro trend filter`
        : `${side} counter-trend to Macro EMA200`,
      passed: d1Aligned,
      mandatory: false,
    },
    {
      step: 2,
      title: 'Map Market Structure & VWAP',
      detail: `Support $${swingLow20.toFixed(2)} · Resistance $${swingHigh20.toFixed(2)}`,
      passed: h4Aligned,
      mandatory: false,
    },
    {
      step: 3,
      title: 'Wait for Candle Close (Non-Repainting)',
      detail: latestCandle?.isClosed
        ? 'Closed bar confirmed (no mid-candle repainting)'
        : 'Incomplete bar — wait for close',
      passed: Boolean(latestCandle?.isClosed ?? true),
      mandatory: true,
    },
    {
      step: 4,
      title: `Confirm Volume (${minVolMult.toFixed(1)}× Avg Baseline)`,
      detail: `Current bar ${volumeRatio.toFixed(2)}× 20-bar average volume`,
      passed: volumeRatio >= minVolMult,
      mandatory: Boolean(config.features.volumeConfirmationFilter),
    },
    {
      step: 5,
      title: 'Define Structural Invalidation Level',
      detail: `Invalidated beyond $${invalidationPrice.toFixed(entryPrice >= 100 ? 2 : 4)}`,
      passed: stopDist > 0 && Number.isFinite(invalidationPrice),
      mandatory: true,
    },
    {
      step: 6,
      title: 'Place Volatility-Adaptive ATR Stop-Loss',
      detail: `SL $${stopLossPrice.toFixed(entryPrice >= 100 ? 2 : 4)} (${atrBufferMult.toFixed(2)}× ATR buffer)`,
      passed: atrBufferMult >= 0.8 && atrBufferMult <= 4.0,
      mandatory: true,
    },
    {
      step: 7,
      title: 'Set Scaled Take-Profits (R:R ≥ 1.5:1)',
      detail: `Reward-to-Risk ${rewardToRiskRatio.toFixed(2)}:1 (TP1 $${takeProfit1Price.toFixed(2)} / TP2 $${takeProfit2Price.toFixed(2)})`,
      passed: rewardToRiskRatio >= 1.49,
      mandatory: true,
    },
    {
      step: 8,
      title: 'Calculate Quantitative Position Size',
      detail: `Notional $${notionalUsdt.toFixed(2)} · Risk $${calculatedDollarRiskUsdt.toFixed(2)} (${equityRiskPct.toFixed(2)}% Equity)`,
      passed: notionalUsdt >= 10 && equityRiskPct <= config.risk.maxDailyDrawdownPct,
      mandatory: true,
    },
    {
      step: 9,
      title: 'Account for Execution Costs & Fees',
      detail: `Est. RT Fees+Spread $${estimatedRoundTripFeeUsdt.toFixed(2)} (${feeToTargetProfitPct.toFixed(1)}% of target profit)`,
      passed: feeToTargetProfitPct <= 25,
      mandatory: true,
    },
  ];

  const passedCount = steps.filter((s) => s.passed).length;
  const allMandatoryPassed = steps.filter((s) => s.mandatory).every((s) => s.passed);

  return {
    symbol: pair.symbol,
    side,
    entryPrice,
    invalidationPrice,
    stopLossPrice,
    takeProfit1Price,
    takeProfit2Price,
    rewardToRiskRatio,
    calculatedDollarRiskUsdt,
    calculatedNotionalUsdt: notionalUsdt,
    calculatedBaseQty,
    estimatedRoundTripFeeUsdt,
    feeToTargetProfitPct,
    volumeRatio,
    hierarchy: {
      signalLayer: `${pair.symbol} ${side} momentum & regime setup (${config.automation.strategyProfile})`,
      recommendationLayer: `${side} ${pair.symbol} @ $${entryPrice.toFixed(2)} · Invalidated ${side === 'Long' ? 'below' : 'above'} $${stopLossPrice.toFixed(2)}`,
      tradePlanLayer: `Size $${notionalUsdt.toFixed(2)} (Risk $${calculatedDollarRiskUsdt.toFixed(2)}) · SL $${stopLossPrice.toFixed(2)} · TP1 50% @ $${takeProfit1Price.toFixed(2)} (+BE Ratchet) · TP2 50% @ $${takeProfit2Price.toFixed(2)}`,
    },
    mtfAlignment,
    steps,
    passedCount,
    allMandatoryPassed,
  };
}
