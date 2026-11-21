import type {
  AutomationConfig,
  Candle,
  DirectionPolicy,
  EntrySignal,
  ExitConfig,
  ExitPlan,
  ExitReason,
  FeatureToggles,
  IndicatorConfig,
  IndicatorSnapshot,
  PendingOrder,
  Position,
  Side,
  StrategyProfile,
  TradingConfig,
} from './types';

interface StrategyEvalOptions {
  strategyProfile?: StrategyProfile;
  directionPolicy?: DirectionPolicy;
  recentCandles?: Candle[];
  features?: Partial<FeatureToggles>;
  spreadBps?: number | null;
  enforceVenueLongOnly?: boolean;
}

function resolveEffectiveDirectionPolicy(
  policy: DirectionPolicy | undefined,
  venue: TradingConfig['venue'],
  enforceVenueLongOnly = false
): DirectionPolicy {
  if (enforceVenueLongOnly && venue === 'Spot') {
    return 'long_only';
  }
  return policy ?? 'both';
}

interface SignalQualityEvaluation {
  allOk: boolean;
  warmupOk: boolean;
  gapOk: boolean;
  spreadOk: boolean;
  macroOk: boolean;
  extensionOk: boolean;
  vwapCeilingOk: boolean;
  candleStrengthOk: boolean;
  bodyRatioOk: boolean;
  adxSlopeOk: boolean;
  diSpreadOk: boolean;
  emaSlopeOk: boolean;
}

function computeCandleStrengthMetrics(candle: Candle, side: Side): {
  closeStrength: number;
  bodyRatio: number;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 1e-12) {
    return { closeStrength: 1, bodyRatio: 1 };
  }
  const closeStrength =
    side === 'Long' ? (candle.close - candle.low) / range : (candle.high - candle.close) / range;
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  return { closeStrength, bodyRatio };
}

function evaluateSignalQualityMitigation(
  side: Side,
  candle: Candle,
  ind: IndicatorSnapshot,
  tradingCfg: TradingConfig,
  indCfg: IndicatorConfig,
  options?: StrategyEvalOptions
): SignalQualityEvaluation {
  const profile: StrategyProfile = options?.strategyProfile ?? 'trend_pullback';
  const useEma = options?.features?.emaTrendFilter !== false;
  const useAdx = options?.features?.adxStrengthFilter !== false;
  const useVwap = options?.features?.vwapBiasFilter !== false;

  const minWarmup = Math.max(20, indCfg.minWarmupBars ?? 50);
  const warmupOk =
    ind.warmupBarsCount === undefined || ind.warmupBarsCount === null || ind.warmupBarsCount >= minWarmup;
  const gapOk = ind.hasBarGap !== true;

  const maxSpread = indCfg.maxSpreadBps ?? 20.0;
  const spreadOk =
    options?.spreadBps === undefined ||
    options.spreadBps === null ||
    maxSpread <= 0 ||
    options.spreadBps <= maxSpread;

  const requireMacro =
    ind.emaMacro !== null &&
    useEma &&
    (tradingCfg.mode === 'intraday' || indCfg.requireMacroEmaInScalping !== false);
  const macroOk =
    profile === 'vwap_reversion' ||
    !requireMacro ||
    (side === 'Long' ? candle.close > ind.emaMacro! : candle.close < ind.emaMacro!);

  const atr = ind.atr ?? 0;
  const maxEmaExt = indCfg.maxEmaMidExtensionAtr ?? 2.2;
  const maxVwapExt = indCfg.maxVwapExtensionAtr ?? 2.8;
  const extensionOk =
    profile === 'vwap_reversion' ||
    atr <= 0 ||
    ind.emaMid === null ||
    maxEmaExt <= 0 ||
    (side === 'Long'
      ? candle.close - ind.emaMid <= maxEmaExt * atr
      : ind.emaMid - candle.close <= maxEmaExt * atr);
  const vwapCeilingOk =
    profile === 'vwap_reversion' ||
    !useVwap ||
    atr <= 0 ||
    ind.vwap === null ||
    maxVwapExt <= 0 ||
    (side === 'Long'
      ? candle.close - ind.vwap <= maxVwapExt * atr
      : ind.vwap - candle.close <= maxVwapExt * atr);

  const { closeStrength, bodyRatio } = computeCandleStrengthMetrics(candle, side);
  const minStrength = indCfg.minCloseStrengthRatio ?? 0.55;
  const minBody = indCfg.minCandleBodyRatio ?? 0.30;
  const candleStrengthOk =
    profile === 'vwap_reversion' || minStrength <= 0 || closeStrength >= minStrength;
  const bodyRatioOk =
    profile === 'vwap_reversion' || minBody <= 0 || bodyRatio >= minBody;

  const adxSlopeOk =
    profile === 'vwap_reversion' ||
    !useAdx ||
    indCfg.requireRisingAdx === false ||
    ind.adx === null ||
    ind.prevAdx === undefined ||
    ind.prevAdx === null ||
    ind.adx >= indCfg.adxMinTrend + 6 ||
    ind.adx >= ind.prevAdx;

  const minDiSpread = indCfg.minDiSpread ?? 3.0;
  const diSpreadOk =
    profile === 'vwap_reversion' ||
    !useAdx ||
    minDiSpread <= 0 ||
    ind.plusDi === null ||
    ind.minusDi === null ||
    Math.abs(ind.plusDi - ind.minusDi) >= minDiSpread;

  const emaSlopeOk =
    profile === 'vwap_reversion' ||
    !useEma ||
    ind.emaMid === null ||
    ind.prevEmaMid === undefined ||
    ind.prevEmaMid === null ||
    (side === 'Long' ? ind.emaMid >= ind.prevEmaMid : ind.emaMid <= ind.prevEmaMid);

  const allOk =
    warmupOk &&
    gapOk &&
    spreadOk &&
    macroOk &&
    extensionOk &&
    vwapCeilingOk &&
    candleStrengthOk &&
    bodyRatioOk &&
    adxSlopeOk &&
    diSpreadOk &&
    emaSlopeOk;

  return {
    allOk,
    warmupOk,
    gapOk,
    spreadOk,
    macroOk,
    extensionOk,
    vwapCeilingOk,
    candleStrengthOk,
    bodyRatioOk,
    adxSlopeOk,
    diSpreadOk,
    emaSlopeOk,
  };
}

export function evaluateEntrySignal(
  symbol: string,
  candle: Candle,
  ind: IndicatorSnapshot,
  tradingCfg: TradingConfig,
  indCfg: IndicatorConfig,
  nowMs: number,
  options?: StrategyEvalOptions
): EntrySignal | null {
  if (
    ind.emaFast === null ||
    ind.emaMid === null ||
    ind.emaSlow === null ||
    ind.adx === null ||
    ind.plusDi === null ||
    ind.minusDi === null ||
    ind.rsi === null ||
    ind.prevRsi === null ||
    ind.atr === null
  ) {
    return null;
  }

  if (ind.atr <= 0) {
    return null;
  }

  if (options?.features?.signalGenerator === false) {
    return null;
  }

  const profile: StrategyProfile = options?.strategyProfile ?? 'trend_pullback';
  const effectivePolicy = resolveEffectiveDirectionPolicy(
    options?.directionPolicy,
    tradingCfg.venue,
    Boolean(options?.enforceVenueLongOnly)
  );
  const allowLong = effectivePolicy === 'long_only' || effectivePolicy === 'both';
  const allowShort = effectivePolicy === 'short_only' || effectivePolicy === 'both';
  const useEma = options?.features?.emaTrendFilter !== false;
  const useRsi = options?.features?.rsiMomentumFilter !== false;
  const useAdx = options?.features?.adxStrengthFilter !== false;
  const useVwap = options?.features?.vwapBiasFilter !== false;
  const useVolConfirm = options?.features?.volumeConfirmationFilter === true;
  const minVolMult = indCfg.minVolumeExpansionMult ?? 1.5;
  const currentVolRatio = ind.volumeRatio ?? 1.0;

  if (useVolConfirm && currentVolRatio < minVolMult) {
    return null;
  }

  // Higher-timeframe (closed 1h) trend alignment. Missing HTF data fails open.
  const useHtf = options?.features?.htfTrendFilter === true;
  const htfLongOk =
    !useHtf || ind.htfClose == null || ind.htfEmaMacro == null || ind.htfClose >= ind.htfEmaMacro;
  const htfShortOk =
    !useHtf || ind.htfClose == null || ind.htfEmaMacro == null || ind.htfClose <= ind.htfEmaMacro;

  // Order-book imbalance gate. A missing book snapshot fails open.
  const useObi = options?.features?.obiEntryFilter === true;
  const obiThreshold = Math.max(0, indCfg.obiMinImbalance ?? 0.35);
  const obiLongOk = !useObi || ind.obi == null || ind.obi >= obiThreshold;
  const obiShortOk = !useObi || ind.obi == null || ind.obi <= -obiThreshold;

  // Volatility regime: ATR must be expanding versus its SMA(50) baseline.
  const atrBaseline = ind.atrSma50 ?? null;
  const atrExpansionOk =
    indCfg.atrExpansionFilterEnabled !== true ||
    atrBaseline == null ||
    atrBaseline <= 0 ||
    ind.atr / atrBaseline >= (indCfg.atrExpansionMinRatio ?? 1.15);

  if (profile === 'vwap_reversion') {
    if (
      (useVwap && ind.vwap === null) ||
      (useAdx && ind.adx > Math.max(38, indCfg.adxMinTrend + 12))
    ) {
      return null;
    }
    const refAnchor = useVwap && ind.vwap !== null ? ind.vwap : ind.emaMid;
    const stretch = Math.abs(candle.close - refAnchor);
    const minStretch = ind.atr * 1.1;

    const qualLong = evaluateSignalQualityMitigation('Long', candle, ind, tradingCfg, indCfg, options);
    if (
      allowLong &&
      htfLongOk &&
      obiLongOk &&
      qualLong.warmupOk &&
      qualLong.gapOk &&
      qualLong.spreadOk &&
      candle.close <= refAnchor - minStretch &&
      (!useRsi || (ind.rsi <= 38 && ind.rsi > ind.prevRsi))
    ) {
      return {
        symbol,
        side: 'Long',
        entryPrice: candle.close,
        atr: ind.atr,
        adx: ind.adx,
        rsi: ind.rsi,
        rationale: `VWAP Reversion Long · Stretch ${(stretch / ind.atr).toFixed(2)}×ATR below anchor · RSI curl ${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} · Vol ${currentVolRatio.toFixed(2)}×`,
        timestampMs: nowMs,
      };
    }

    const qualShort = evaluateSignalQualityMitigation('Short', candle, ind, tradingCfg, indCfg, options);
    if (
      allowShort &&
      htfShortOk &&
      obiShortOk &&
      qualShort.warmupOk &&
      qualShort.gapOk &&
      qualShort.spreadOk &&
      candle.close >= refAnchor + minStretch &&
      (!useRsi || (ind.rsi >= 62 && ind.rsi < ind.prevRsi))
    ) {
      return {
        symbol,
        side: 'Short',
        entryPrice: candle.close,
        atr: ind.atr,
        adx: ind.adx,
        rsi: ind.rsi,
        rationale: `VWAP Reversion Short · Stretch ${(stretch / ind.atr).toFixed(2)}×ATR above anchor · RSI curl ${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} · Vol ${currentVolRatio.toFixed(2)}×`,
        timestampMs: nowMs,
      };
    }

    return null;
  }

  if (!atrExpansionOk) {
    return null;
  }

  if (useAdx && ind.adx < indCfg.adxMinTrend) {
    return null;
  }

  const vwapLongOk =
    !useVwap || !indCfg.requireVwapAlignment || ind.vwap === null || candle.close >= ind.vwap;
  const vwapShortOk =
    !useVwap || !indCfg.requireVwapAlignment || ind.vwap === null || candle.close <= ind.vwap;

  const qualLong = evaluateSignalQualityMitigation('Long', candle, ind, tradingCfg, indCfg, options);
  const qualShort = evaluateSignalQualityMitigation('Short', candle, ind, tradingCfg, indCfg, options);

  if (profile === 'ema_breakout') {
    const lookback = Math.max(3, Math.min(200, Math.round(indCfg.donchianLookback ?? 20)));
    const rawHistory = options?.recentCandles ?? [];
    const history =
      rawHistory.length > 0 && rawHistory[rawHistory.length - 1]?.openTimeMs === candle.openTimeMs
        ? rawHistory.slice(-(lookback + 1), -1)
        : rawHistory.slice(-lookback);
    const priorHigh = history.length > 0 ? Math.max(...history.map((c) => c.high)) : candle.open;
    const priorLow = history.length > 0 ? Math.min(...history.map((c) => c.low)) : candle.open;
    const avgVol =
      history.length > 0
        ? history.reduce((sum, c) => sum + c.volume, 0) / history.length
        : candle.volume;
    const requiredBreakoutVolMult = useVolConfirm ? Math.max(1.1, minVolMult) : 1.1;
    const volSurgeOk = candle.volume >= avgVol * requiredBreakoutVolMult;

    const emaLongOk = !useEma || (ind.emaFast > ind.emaMid && ind.emaMid > ind.emaSlow);
    const emaShortOk = !useEma || (ind.emaFast < ind.emaMid && ind.emaMid < ind.emaSlow);
    const adxLongOk = !useAdx || ind.plusDi > ind.minusDi;
    const adxShortOk = !useAdx || ind.minusDi > ind.plusDi;
    const rsiLongOk = !useRsi || (ind.rsi >= 50 && ind.rsi <= 74);
    const rsiShortOk = !useRsi || (ind.rsi <= 50 && ind.rsi >= 26);

    if (
      allowLong &&
      htfLongOk &&
      obiLongOk &&
      candle.close > priorHigh &&
      emaLongOk &&
      qualLong.allOk &&
      adxLongOk &&
      rsiLongOk &&
      volSurgeOk &&
      vwapLongOk
    ) {
      return {
        symbol,
        side: 'Long',
        entryPrice: candle.close,
        atr: ind.atr,
        adx: ind.adx,
        rsi: ind.rsi,
        rationale: `Momentum Breakout Long · Close > ${lookback}-bar High · ADX ${ind.adx.toFixed(1)} · Vol ${(candle.volume / Math.max(avgVol, 1)).toFixed(2)}×`,
        timestampMs: nowMs,
      };
    }

    if (
      allowShort &&
      htfShortOk &&
      obiShortOk &&
      candle.close < priorLow &&
      emaShortOk &&
      qualShort.allOk &&
      adxShortOk &&
      rsiShortOk &&
      volSurgeOk &&
      vwapShortOk
    ) {
      return {
        symbol,
        side: 'Short',
        entryPrice: candle.close,
        atr: ind.atr,
        adx: ind.adx,
        rsi: ind.rsi,
        rationale: `Momentum Breakout Short · Close < ${lookback}-bar Low · ADX ${ind.adx.toFixed(1)} · Vol ${(candle.volume / Math.max(avgVol, 1)).toFixed(2)}×`,
        timestampMs: nowMs,
      };
    }

    return null;
  }

  // Default: trend_pullback
  const emaPullLongOk =
    !useEma || (candle.close > ind.emaMid && ind.emaFast >= ind.emaMid && ind.emaMid > ind.emaSlow);
  const emaPullShortOk =
    !useEma || (candle.close < ind.emaMid && ind.emaFast <= ind.emaMid && ind.emaMid < ind.emaSlow);
  const diLongOk = !useAdx || ind.plusDi > ind.minusDi;
  const diShortOk = !useAdx || ind.minusDi > ind.plusDi;
  const rsiPullLongOk =
    !useRsi ||
    (ind.rsi >= indCfg.rsiLongPullbackMin &&
      ind.rsi <= indCfg.rsiLongPullbackMax &&
      ind.rsi > ind.prevRsi);
  const rsiPullShortOk =
    !useRsi ||
    (ind.rsi >= indCfg.rsiShortPullbackMin &&
      ind.rsi <= indCfg.rsiShortPullbackMax &&
      ind.rsi < ind.prevRsi);

  if (
    allowLong &&
    htfLongOk &&
    obiLongOk &&
    emaPullLongOk &&
    qualLong.allOk &&
    diLongOk &&
    rsiPullLongOk &&
    vwapLongOk
  ) {
    return {
      symbol,
      side: 'Long',
      entryPrice: candle.close,
      atr: ind.atr,
      adx: ind.adx,
      rsi: ind.rsi,
      rationale: `EMA Trend Pullback Long · ADX ${ind.adx.toFixed(1)} (+DI > -DI) · RSI curl ${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} · Vol ${currentVolRatio.toFixed(2)}×`,
      timestampMs: nowMs,
    };
  }

  if (
    allowShort &&
    htfShortOk &&
    obiShortOk &&
    emaPullShortOk &&
    qualShort.allOk &&
    diShortOk &&
    rsiPullShortOk &&
    vwapShortOk
  ) {
    return {
      symbol,
      side: 'Short',
      entryPrice: candle.close,
      atr: ind.atr,
      adx: ind.adx,
      rsi: ind.rsi,
      rationale: `EMA Trend Pullback Short · ADX ${ind.adx.toFixed(1)} (-DI > +DI) · RSI curl ${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} · Vol ${currentVolRatio.toFixed(2)}×`,
      timestampMs: nowMs,
    };
  }

  return null;
}

interface SignalDiagnosticsResult {
  bias: string;
  preferredSide: Side;
  checks: Array<{ label: string; ok: boolean }>;
  signal: EntrySignal | null;
}

export function evaluateSignalDiagnostics(
  symbol: string,
  candles: Candle[],
  ind: IndicatorSnapshot,
  tradingCfg: TradingConfig,
  indCfg: IndicatorConfig,
  nowMs: number,
  options?: StrategyEvalOptions
): SignalDiagnosticsResult {
  const latestCandle: Candle = candles[candles.length - 1] ?? {
    openTimeMs: nowMs,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    isClosed: false,
  };
  const price = latestCandle.close;
  const profile: StrategyProfile = options?.strategyProfile ?? 'trend_pullback';
  const effectivePolicy = resolveEffectiveDirectionPolicy(
    options?.directionPolicy,
    tradingCfg.venue,
    Boolean(options?.enforceVenueLongOnly)
  );
  const allowLong = effectivePolicy === 'long_only' || effectivePolicy === 'both';
  const allowShort = effectivePolicy === 'short_only' || effectivePolicy === 'both';
  const useEma = options?.features?.emaTrendFilter !== false;
  const useRsi = options?.features?.rsiMomentumFilter !== false;
  const useAdx = options?.features?.adxStrengthFilter !== false;
  const useVwap = options?.features?.vwapBiasFilter !== false;
  const useVolConfirm = options?.features?.volumeConfirmationFilter === true;
  const useHtf = options?.features?.htfTrendFilter === true;
  const useObi = options?.features?.obiEntryFilter === true;

  const emaBull =
    ind.emaFast !== null &&
    ind.emaMid !== null &&
    ind.emaSlow !== null &&
    price > ind.emaMid &&
    ind.emaFast >= ind.emaMid &&
    ind.emaMid > ind.emaSlow;
  const emaBear =
    ind.emaFast !== null &&
    ind.emaMid !== null &&
    ind.emaSlow !== null &&
    price < ind.emaMid &&
    ind.emaFast <= ind.emaMid &&
    ind.emaMid < ind.emaSlow;

  const emaStackBull =
    ind.emaFast !== null &&
    ind.emaMid !== null &&
    ind.emaSlow !== null &&
    ind.emaFast > ind.emaMid &&
    ind.emaMid > ind.emaSlow;
  const emaStackBear =
    ind.emaFast !== null &&
    ind.emaMid !== null &&
    ind.emaSlow !== null &&
    ind.emaFast < ind.emaMid &&
    ind.emaMid < ind.emaSlow;

  const preferredSide: Side =
    !allowLong && allowShort
      ? 'Short'
      : allowLong && !allowShort
        ? 'Long'
        : profile === 'vwap_reversion'
          ? ind.vwap !== null && price > ind.vwap
            ? 'Short'
            : 'Long'
          : emaBear
            ? 'Short'
            : 'Long';

  const bias =
    profile === 'vwap_reversion'
      ? preferredSide === 'Short'
        ? 'Overextended Above VWAP (Short Setup)'
        : 'Stretched Below VWAP (Long Setup)'
      : emaBull || emaStackBull
        ? !allowLong
          ? 'Bullish (Short-Only Filtered)'
          : 'Bullish Trend'
        : emaBear || emaStackBear
          ? !allowShort
            ? tradingCfg.venue === 'Spot'
              ? 'Bearish (Spot Long-Only Filtered)'
              : 'Bearish (Long-Only Filtered)'
            : 'Bearish Trend'
          : 'Neutral / Transition';

  const minVolMult = indCfg.minVolumeExpansionMult ?? 1.5;
  const volRatio = ind.volumeRatio ?? 1.0;
  const adxVal = ind.adx ?? 0;
  const adxOk = !useAdx || adxVal >= indCfg.adxMinTrend;

  let checks: Array<{ label: string; ok: boolean }>;

  if (profile === 'ema_breakout') {
    const lookback = Math.max(3, Math.min(200, Math.round(indCfg.donchianLookback ?? 20)));
    const recent =
      candles.length > 0 && candles[candles.length - 1]?.openTimeMs === latestCandle.openTimeMs
        ? candles.slice(-(lookback + 1), -1)
        : candles.slice(-lookback);
    const priorHigh = recent.length > 0 ? Math.max(...recent.map((c) => c.high)) : latestCandle.open;
    const priorLow = recent.length > 0 ? Math.min(...recent.map((c) => c.low)) : latestCandle.open;
    const avgVol =
      recent.length > 0 ? recent.reduce((sum, c) => sum + c.volume, 0) / recent.length : latestCandle.volume;
    const reqVolMult = useVolConfirm ? Math.max(1.1, minVolMult) : 1.1;
    const volSurgeOk = avgVol > 0 ? latestCandle.volume >= avgVol * reqVolMult : false;
    const breakoutLong = allowLong && price > priorHigh;
    const breakoutShort = allowShort && price < priorLow;
    const breakoutOk = breakoutLong || breakoutShort;
    const preferShortBreakout = preferredSide === 'Short' || (breakoutShort && !breakoutLong);
    const macroLongOk =
      !useEma || (tradingCfg.mode === 'intraday' && ind.emaMacro !== null ? price > ind.emaMacro : true);
    const macroShortOk =
      !useEma || (tradingCfg.mode === 'intraday' && ind.emaMacro !== null ? price < ind.emaMacro : true);
    const macroOk = preferShortBreakout ? macroShortOk : macroLongOk;
    const diOk =
      !useAdx ||
      (ind.plusDi !== null &&
        ind.minusDi !== null &&
        ((allowLong && ind.plusDi > ind.minusDi) || (allowShort && ind.minusDi > ind.plusDi)));
    const vwapAlignOk =
      !useVwap ||
      !indCfg.requireVwapAlignment ||
      ind.vwap === null ||
      (preferShortBreakout ? price <= ind.vwap : price >= ind.vwap);
    const rsiOk =
      !useRsi ||
      (ind.rsi !== null &&
        ((allowLong && ind.rsi >= 50 && ind.rsi <= 74) || (allowShort && ind.rsi <= 50 && ind.rsi >= 26)));
    const qualDiag = evaluateSignalQualityMitigation(preferredSide, latestCandle, ind, tradingCfg, indCfg, options);

    checks = [
      { label: `${lookback}-Bar Donchian Breakout`, ok: breakoutOk },
      { label: 'EMA Stack (9 > 21 > 50)', ok: !useEma || (allowLong && emaStackBull) || (allowShort && emaStackBear) },
      { label: 'Macro EMA Alignment (200)', ok: qualDiag.macroOk && macroOk },
      { label: `ADX ≥ ${indCfg.adxMinTrend} & +DI/-DI (${ind.adx?.toFixed(1) ?? '—'})`, ok: adxOk && diOk && qualDiag.adxSlopeOk && qualDiag.diSpreadOk },
      { label: `RSI Momentum Band (${ind.rsi?.toFixed(1) ?? '—'})`, ok: rsiOk },
      { label: 'Session VWAP Alignment', ok: vwapAlignOk && qualDiag.vwapCeilingOk },
      { label: `Anti-Chase Clamp (≤ ${(indCfg.maxEmaMidExtensionAtr ?? 2.2).toFixed(1)}× ATR)`, ok: qualDiag.extensionOk },
      { label: 'Candle Strength & Close Quality', ok: qualDiag.candleStrengthOk && qualDiag.bodyRatioOk },
      { label: `Warmup & Spread Gate (≤ ${(indCfg.maxSpreadBps ?? 20).toFixed(0)} bps)`, ok: qualDiag.warmupOk && qualDiag.gapOk && qualDiag.spreadOk },
      {
        label: `Volume ≥ ${reqVolMult.toFixed(1)}× Avg (${(latestCandle.volume / Math.max(avgVol, 1e-9)).toFixed(2)}×)`,
        ok: volSurgeOk,
      },
    ];
    if (useHtf) {
      const htfOk =
        ind.htfClose == null ||
        ind.htfEmaMacro == null ||
        (preferShortBreakout ? ind.htfClose <= ind.htfEmaMacro : ind.htfClose >= ind.htfEmaMacro);
      checks.push({
        label: `HTF 1h EMA${indCfg.htfEmaPeriod ?? 200} Alignment`,
        ok: htfOk,
      });
    }
    if (useObi) {
      const threshold = Math.max(0, indCfg.obiMinImbalance ?? 0.35);
      checks.push({
        label: `Order-Book Imbalance ≥ ±${threshold.toFixed(2)} (${ind.obi == null ? '—' : ind.obi.toFixed(2)})`,
        ok: ind.obi == null || (preferShortBreakout ? ind.obi <= -threshold : ind.obi >= threshold),
      });
    }
  } else if (profile === 'vwap_reversion') {
    const atr = ind.atr ?? 0;
    const refAnchor = useVwap && ind.vwap !== null ? ind.vwap : ind.emaMid;
    const stretchRatio = refAnchor !== null && atr > 0 ? Math.abs(price - refAnchor) / atr : 0;
    const rsiExtremeCurl =
      !useRsi ||
      (ind.rsi !== null &&
        ind.prevRsi !== null &&
        ((allowLong && ind.rsi <= 38 && ind.rsi > ind.prevRsi) ||
          (allowShort && ind.rsi >= 62 && ind.rsi < ind.prevRsi)));
    const adxMax = Math.max(38, indCfg.adxMinTrend + 12);
    const boundedAdx = !useAdx || (ind.adx !== null && ind.adx <= adxMax);
    const revertSideOk =
      refAnchor !== null &&
      ((allowLong && price <= refAnchor - atr * 1.1) || (allowShort && price >= refAnchor + atr * 1.1));
    const qualDiag = evaluateSignalQualityMitigation(preferredSide, latestCandle, ind, tradingCfg, indCfg, options);

    checks = [
      { label: `Anchor Stretch ≥ 1.1× ATR (${stretchRatio.toFixed(2)}×)`, ok: stretchRatio >= 1.1 },
      { label: `RSI Extreme Curl (${ind.rsi?.toFixed(1) ?? '—'})`, ok: rsiExtremeCurl },
      { label: `Bounded ADX ≤ ${adxMax} (${ind.adx?.toFixed(1) ?? '—'})`, ok: boundedAdx },
      { label: 'Reversion Side Alignment', ok: revertSideOk },
      { label: `Warmup & Spread Gate (≤ ${(indCfg.maxSpreadBps ?? 20).toFixed(0)} bps)`, ok: qualDiag.warmupOk && qualDiag.gapOk && qualDiag.spreadOk },
    ];
    if (useVolConfirm) {
      checks.push({
        label: `Volume ≥ ${minVolMult.toFixed(1)}× Avg (${volRatio.toFixed(2)}×)`,
        ok: volRatio >= minVolMult,
      });
    }
  } else {
    const rsiPullLongOk =
      allowLong &&
      ind.rsi !== null &&
      ind.prevRsi !== null &&
      ind.rsi >= indCfg.rsiLongPullbackMin &&
      ind.rsi <= indCfg.rsiLongPullbackMax &&
      ind.rsi > ind.prevRsi;
    const rsiPullShortOk =
      allowShort &&
      ind.rsi !== null &&
      ind.prevRsi !== null &&
      ind.rsi >= indCfg.rsiShortPullbackMin &&
      ind.rsi <= indCfg.rsiShortPullbackMax &&
      ind.rsi < ind.prevRsi;
    const preferShortPull = preferredSide === 'Short';
    const vwapAlign =
      !useVwap ||
      !indCfg.requireVwapAlignment ||
      ind.vwap === null ||
      (preferShortPull ? price <= ind.vwap : price >= ind.vwap);

    const macroPullOk =
      !useEma ||
      (tradingCfg.mode !== 'intraday' && indCfg.requireMacroEmaInScalping === false) ||
      ind.emaMacro === null ||
      (preferShortPull ? price < ind.emaMacro : price > ind.emaMacro);
    const diPullOk =
      !useAdx ||
      (ind.plusDi !== null &&
        ind.minusDi !== null &&
        (preferShortPull ? ind.minusDi > ind.plusDi : ind.plusDi > ind.minusDi));
    const qualDiag = evaluateSignalQualityMitigation(preferredSide, latestCandle, ind, tradingCfg, indCfg, options);

    checks = [
      { label: 'EMA Stack, Slope & Macro (200)', ok: (!useEma || (allowLong && emaBull) || (allowShort && emaBear)) && macroPullOk && qualDiag.emaSlopeOk },
      { label: `ADX ≥ ${indCfg.adxMinTrend}, Slope & DI (${ind.adx?.toFixed(1) ?? '—'})`, ok: adxOk && diPullOk && qualDiag.adxSlopeOk && qualDiag.diSpreadOk },
      {
        label: `RSI Curl Band (${ind.prevRsi?.toFixed(1) ?? '—'} → ${ind.rsi?.toFixed(1) ?? '—'})`,
        ok: !useRsi || rsiPullLongOk || rsiPullShortOk,
      },
      { label: 'Session VWAP Alignment', ok: vwapAlign && qualDiag.vwapCeilingOk },
      { label: `Anti-Chase Clamp (≤ ${(indCfg.maxEmaMidExtensionAtr ?? 2.2).toFixed(1)}× ATR)`, ok: qualDiag.extensionOk },
      { label: 'Candle Strength & Body Ratio', ok: qualDiag.candleStrengthOk && qualDiag.bodyRatioOk },
      { label: `Warmup & Spread Gate (≤ ${(indCfg.maxSpreadBps ?? 20).toFixed(0)} bps)`, ok: qualDiag.warmupOk && qualDiag.gapOk && qualDiag.spreadOk },
    ];
    if (useVolConfirm || volRatio > 0) {
      checks.push({
        label: `Volume ${useVolConfirm ? `(Required ≥ ${minVolMult.toFixed(1)}×)` : `(Info ≥ ${minVolMult.toFixed(1)}×)`} (${volRatio.toFixed(2)}×)`,
        ok: volRatio >= minVolMult,
      });
    }
    if (useHtf) {
      const htfOk =
        ind.htfClose == null ||
        ind.htfEmaMacro == null ||
        (preferShortPull ? ind.htfClose <= ind.htfEmaMacro : ind.htfClose >= ind.htfEmaMacro);
      checks.push({ label: `HTF 1h EMA${indCfg.htfEmaPeriod ?? 200} Alignment`, ok: htfOk });
    }
    if (useObi) {
      const threshold = Math.max(0, indCfg.obiMinImbalance ?? 0.35);
      checks.push({
        label: `Order-Book Imbalance ≥ ±${threshold.toFixed(2)} (${ind.obi == null ? '—' : ind.obi.toFixed(2)})`,
        ok: ind.obi == null || (preferShortPull ? ind.obi <= -threshold : ind.obi >= threshold),
      });
    }
  }

  const signal = evaluateEntrySignal(symbol, latestCandle, ind, tradingCfg, indCfg, nowMs, {
    ...options,
    recentCandles: candles,
  });

  return { bias, preferredSide, checks, signal };
}

export function buildExitPlan(
  side: Side,
  entryPrice: number,
  atr: number,
  cfg: ExitConfig,
  features?: Partial<FeatureToggles>
): ExitPlan {
  const atrEnabled = features?.atrDynamicExits !== false;
  const slDist = atrEnabled ? atr * cfg.atrSlMultiplier : entryPrice * 0.015;
  const tp1Dist = atrEnabled ? atr * cfg.atrTp1Multiplier : entryPrice * 0.025;
  const tp2Dist = atrEnabled ? atr * cfg.atrTp2Multiplier : entryPrice * 0.04;

  if (side === 'Long') {
    return {
      initialStopLoss: entryPrice - slDist,
      activeStopLoss: entryPrice - slDist,
      takeProfit1: entryPrice + tp1Dist,
      takeProfit2: entryPrice + tp2Dist,
      tp1Hit: false,
      breakEvenArmed: false,
      breakEvenEnabled: atrEnabled && features?.breakEvenStop !== false,
      trailingActive: false,
      trailingEnabled: atrEnabled && features?.trailingStop !== false,
      riskDistanceR: slDist,
    };
  }

  return {
    initialStopLoss: entryPrice + slDist,
    activeStopLoss: entryPrice + slDist,
    takeProfit1: entryPrice - tp1Dist,
    takeProfit2: entryPrice - tp2Dist,
    tp1Hit: false,
    breakEvenArmed: false,
    breakEvenEnabled: atrEnabled && features?.breakEvenStop !== false,
    trailingActive: false,
    trailingEnabled: atrEnabled && features?.trailingStop !== false,
    riskDistanceR: slDist,
  };
}

type PositionTickAction =
  | { type: 'Hold' }
  | { type: 'PartialClose'; ratio: number; exitPrice: number; reason: ExitReason }
  | { type: 'FullClose'; exitPrice: number; reason: ExitReason };

export function managePositionTick(
  pos: Position,
  markPrice: number,
  currentAtr: number,
  cfg: ExitConfig,
  features?: Partial<FeatureToggles>,
  effectiveTrailingMultOverride?: number
): PositionTickAction {
  const r = Math.max(pos.exitPlan.riskDistanceR, 1e-9);
  const feeBuffer = pos.entryPrice * (cfg.breakEvenFeeBufferBps / 10_000);
  const trailMult =
    effectiveTrailingMultOverride !== undefined && effectiveTrailingMultOverride > 0
      ? Math.min(cfg.atrTrailingMultiplier, effectiveTrailingMultOverride)
      : cfg.atrTrailingMultiplier;
  const atrEnabled = features?.atrDynamicExits !== false;
  const tpEnabled = features?.takeProfitLadder !== false;
  const beEnabled =
    atrEnabled && features?.breakEvenStop !== false && pos.exitPlan.breakEvenEnabled !== false;
  const trailEnabled = atrEnabled && features?.trailingStop !== false && pos.exitPlan.trailingEnabled !== false;

  if (pos.side === 'Long') {
    pos.highestFavorablePrice = Math.max(pos.highestFavorablePrice, markPrice);
    pos.unrealizedPnlUsdt = (markPrice - pos.entryPrice) * pos.remainingQuantity;

    if (markPrice <= pos.exitPlan.activeStopLoss) {
      const reason: ExitReason = pos.exitPlan.trailingActive
        ? 'TrailingStop'
        : pos.exitPlan.breakEvenArmed
          ? 'BreakEvenStop'
          : 'StopLoss';
      return { type: 'FullClose', exitPrice: pos.exitPlan.activeStopLoss, reason };
    }

    const rGain = (markPrice - pos.entryPrice) / r;
    if (beEnabled && !pos.exitPlan.breakEvenArmed && rGain >= cfg.breakEvenTriggerR) {
      const bePrice = pos.entryPrice + feeBuffer;
      if (bePrice > pos.exitPlan.activeStopLoss) {
        pos.exitPlan.activeStopLoss = bePrice;
      }
      pos.exitPlan.breakEvenArmed = true;
    }

    if (trailEnabled && rGain >= cfg.trailingActivationR && currentAtr > 0) {
      pos.exitPlan.trailingActive = true;
      const trailSl = pos.highestFavorablePrice - currentAtr * trailMult;
      if (trailSl > pos.exitPlan.activeStopLoss) {
        pos.exitPlan.activeStopLoss = trailSl;
      }
    }

    if (tpEnabled) {
      if (pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0) {
        const remainingWeightBefore = pos.exitPlan.tpTargets.reduce(
          (acc, x) => acc + (x.hit ? 0 : x.allocationPct),
          0
        );
        for (let i = 0; i < pos.exitPlan.tpTargets.length; i += 1) {
          const t = pos.exitPlan.tpTargets[i];
          if (!t.hit && markPrice >= t.targetPrice) {
            t.hit = true;
            const isLast =
              i === pos.exitPlan.tpTargets.length - 1 || pos.exitPlan.tpTargets.every((x) => x.hit);
            if (isLast) {
              return { type: 'FullClose', exitPrice: t.targetPrice, reason: 'TakeProfit2' };
            }
            const fracOfRemaining = remainingWeightBefore > 0 ? t.allocationPct / remainingWeightBefore : t.allocationPct / 100;
            return {
              type: 'PartialClose',
              ratio: Math.min(0.95, Math.max(0.05, fracOfRemaining)),
              exitPrice: t.targetPrice,
              reason: 'TakeProfit1',
            };
          }
        }
      } else {
        if (markPrice >= pos.exitPlan.takeProfit2) {
          return { type: 'FullClose', exitPrice: pos.exitPlan.takeProfit2, reason: 'TakeProfit2' };
        }

        if (!pos.exitPlan.tp1Hit && markPrice >= pos.exitPlan.takeProfit1) {
          pos.exitPlan.tp1Hit = true;
          if (cfg.tp1CloseRatio >= 0.999) {
            return { type: 'FullClose', exitPrice: pos.exitPlan.takeProfit1, reason: 'TakeProfit1' };
          }
          return {
            type: 'PartialClose',
            ratio: cfg.tp1CloseRatio,
            exitPrice: pos.exitPlan.takeProfit1,
            reason: 'TakeProfit1',
          };
        }
      }
    }
    return { type: 'Hold' };
  }

  // Short position management
  pos.highestFavorablePrice = Math.min(pos.highestFavorablePrice, markPrice);
  pos.unrealizedPnlUsdt = (pos.entryPrice - markPrice) * pos.remainingQuantity;

  if (markPrice >= pos.exitPlan.activeStopLoss) {
    const reason: ExitReason = pos.exitPlan.trailingActive
      ? 'TrailingStop'
      : pos.exitPlan.breakEvenArmed
        ? 'BreakEvenStop'
        : 'StopLoss';
    return { type: 'FullClose', exitPrice: pos.exitPlan.activeStopLoss, reason };
  }

  const rGain = (pos.entryPrice - markPrice) / r;
  if (beEnabled && !pos.exitPlan.breakEvenArmed && rGain >= cfg.breakEvenTriggerR) {
    const bePrice = pos.entryPrice - feeBuffer;
    if (bePrice < pos.exitPlan.activeStopLoss) {
      pos.exitPlan.activeStopLoss = bePrice;
    }
    pos.exitPlan.breakEvenArmed = true;
  }

  if (trailEnabled && rGain >= cfg.trailingActivationR && currentAtr > 0) {
    pos.exitPlan.trailingActive = true;
    const trailSl = pos.highestFavorablePrice + currentAtr * trailMult;
    if (trailSl < pos.exitPlan.activeStopLoss) {
      pos.exitPlan.activeStopLoss = trailSl;
    }
  }

  if (tpEnabled) {
    if (pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0) {
      const remainingWeightBefore = pos.exitPlan.tpTargets.reduce(
        (acc, x) => acc + (x.hit ? 0 : x.allocationPct),
        0
      );
      for (let i = 0; i < pos.exitPlan.tpTargets.length; i += 1) {
        const t = pos.exitPlan.tpTargets[i];
        if (!t.hit && markPrice <= t.targetPrice) {
          t.hit = true;
          const isLast =
            i === pos.exitPlan.tpTargets.length - 1 || pos.exitPlan.tpTargets.every((x) => x.hit);
          if (isLast) {
            return { type: 'FullClose', exitPrice: t.targetPrice, reason: 'TakeProfit2' };
          }
          const fracOfRemaining = remainingWeightBefore > 0 ? t.allocationPct / remainingWeightBefore : t.allocationPct / 100;
          return {
            type: 'PartialClose',
            ratio: Math.min(0.95, Math.max(0.05, fracOfRemaining)),
            exitPrice: t.targetPrice,
            reason: 'TakeProfit1',
          };
        }
      }
    } else {
      if (markPrice <= pos.exitPlan.takeProfit2) {
        return { type: 'FullClose', exitPrice: pos.exitPlan.takeProfit2, reason: 'TakeProfit2' };
      }

      if (!pos.exitPlan.tp1Hit && markPrice <= pos.exitPlan.takeProfit1) {
        pos.exitPlan.tp1Hit = true;
        if (cfg.tp1CloseRatio >= 0.999) {
          return { type: 'FullClose', exitPrice: pos.exitPlan.takeProfit1, reason: 'TakeProfit1' };
        }
        return {
          type: 'PartialClose',
          ratio: cfg.tp1CloseRatio,
          exitPrice: pos.exitPlan.takeProfit1,
          reason: 'TakeProfit1',
        };
      }
    }
  }

  return { type: 'Hold' };
}

export type PendingCancelReason =
  | 'SignalReversed'
  | 'MomentumExhaustion'
  | 'PriceRunaway'
  | 'ExpiredBars';

export type PendingOrderDynamicAction =
  | { type: 'Keep' }
  | { type: 'Cancel'; reason: PendingCancelReason; rationale: string };

/**
 * Evaluates whether a resting LIMIT / LIMIT_MAKER order should be dynamically cancelled
 * when signal direction reverses, RSI hits exhaustion, price runs away, or TTL expires.
 */
export function evaluatePendingOrderDynamicAction(params: {
  pending: PendingOrder;
  candle: Candle;
  ind: IndicatorSnapshot;
  automationCfg: AutomationConfig;
  currentBarIndex: number;
  opposingSignal?: EntrySignal | null;
}): PendingOrderDynamicAction {
  const { pending, candle, ind, automationCfg, currentBarIndex, opposingSignal } = params;
  if (
    pending.source === 'manual' &&
    automationCfg.applyDynamicCancelToManualOrders !== true
  ) {
    return { type: 'Keep' };
  }

  const cancelReversal = automationCfg.cancelPendingOnSignalReversal !== false;
  const cancelExhaustion = automationCfg.cancelPendingOnExhaustion !== false;
  const maxBars = Math.max(0, automationCfg.maxPendingOrderBars ?? 6);
  const maxRunawayAtr = Math.max(0, automationCfg.maxPendingRunawayAtr ?? 1.8);
  const rsiHigh = automationCfg.exhaustionRsiHigh ?? 76;
  const rsiLow = automationCfg.exhaustionRsiLow ?? 24;

  // 1. Signal reversal check (either explicit opposite EntrySignal or confirmed EMA/DI structural flip)
  if (cancelReversal) {
    if (opposingSignal && opposingSignal.side !== pending.side) {
      return {
        type: 'Cancel',
        reason: 'SignalReversed',
        rationale: `Auto-canceled pending ${pending.side} limit: confirmed opposing ${opposingSignal.side} signal (${opposingSignal.rationale})`,
      };
    }
    const structuralBearFlip =
      pending.side === 'Long' &&
      ind.emaFast !== null &&
      ind.emaMid !== null &&
      ind.emaSlow !== null &&
      ind.plusDi !== null &&
      ind.minusDi !== null &&
      ind.emaFast < ind.emaMid &&
      ind.emaMid < ind.emaSlow &&
      ind.minusDi > ind.plusDi &&
      candle.close < ind.emaMid;
    const structuralBullFlip =
      pending.side === 'Short' &&
      ind.emaFast !== null &&
      ind.emaMid !== null &&
      ind.emaSlow !== null &&
      ind.plusDi !== null &&
      ind.minusDi !== null &&
      ind.emaFast > ind.emaMid &&
      ind.emaMid > ind.emaSlow &&
      ind.plusDi > ind.minusDi &&
      candle.close > ind.emaMid;
    if (structuralBearFlip || structuralBullFlip) {
      return {
        type: 'Cancel',
        reason: 'SignalReversed',
        rationale: `Auto-canceled pending ${pending.side} limit: EMA stack & DI trend flipped opposite`,
      };
    }
  }

  // 2. Momentum exhaustion / saturation ("pair sudah jenuh")
  if (cancelExhaustion && ind.rsi !== null && ind.prevRsi !== null) {
    if (pending.side === 'Long' && ind.rsi >= rsiHigh && ind.rsi < ind.prevRsi) {
      return {
        type: 'Cancel',
        reason: 'MomentumExhaustion',
        rationale: `Auto-canceled pending Long limit: RSI exhausted (${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} ≥ ${rsiHigh})`,
      };
    }
    if (pending.side === 'Short' && ind.rsi <= rsiLow && ind.rsi > ind.prevRsi) {
      return {
        type: 'Cancel',
        reason: 'MomentumExhaustion',
        rationale: `Auto-canceled pending Short limit: RSI exhausted (${ind.prevRsi.toFixed(1)} → ${ind.rsi.toFixed(1)} ≤ ${rsiLow})`,
      };
    }
  }

  // 3. Price runaway away from resting limit price
  if (maxRunawayAtr > 0 && ind.atr !== null && ind.atr > 0) {
    const runawayDist =
      pending.side === 'Long'
        ? candle.close - pending.limitPrice
        : pending.limitPrice - candle.close;
    if (runawayDist > maxRunawayAtr * ind.atr) {
      return {
        type: 'Cancel',
        reason: 'PriceRunaway',
        rationale: `Auto-canceled pending ${pending.side} limit: price ran away ${(runawayDist / ind.atr).toFixed(2)}×ATR from limit $${pending.limitPrice.toFixed(4)}`,
      };
    }
  }

  // 4. Bar-count TTL expiry to free concurrency slot
  if (maxBars > 0 && typeof pending.createdBarIndex === 'number') {
    const elapsedBars = currentBarIndex - pending.createdBarIndex;
    if (elapsedBars >= maxBars) {
      return {
        type: 'Cancel',
        reason: 'ExpiredBars',
        rationale: `Auto-canceled pending ${pending.side} limit: TTL expired after ${elapsedBars} closed bars`,
      };
    }
  }

  return { type: 'Keep' };
}

export type OpenPositionDynamicAction =
  | { type: 'Hold' }
  | { type: 'TightenTrailing'; factor: number; rationale: string }
  | { type: 'EarlyReversalExit'; reason: 'SignalReversal'; opposingSignal: EntrySignal; rationale: string };

/**
 * Evaluates active open positions on closed bars for confirmed opposite-direction signal reversal
 * or profitable momentum exhaustion ("jenuh") trailing tightening.
 */
export function evaluateOpenPositionDynamicAction(params: {
  pos: Position;
  candle: Candle;
  ind: IndicatorSnapshot;
  automationCfg: AutomationConfig;
  opposingSignal?: EntrySignal | null;
}): OpenPositionDynamicAction {
  const { pos, candle, ind, automationCfg, opposingSignal } = params;
  if (automationCfg.exitPositionOnSignalReversal !== false && opposingSignal && opposingSignal.side !== pos.side) {
    return {
      type: 'EarlyReversalExit',
      reason: 'SignalReversal',
      opposingSignal,
      rationale: `Closed ${pos.side} early on confirmed opposing ${opposingSignal.side} signal (${opposingSignal.rationale})`,
    };
  }

  if (
    automationCfg.tightenTrailingOnExhaustion !== false &&
    ind.rsi !== null &&
    ind.prevRsi !== null
  ) {
    const r = Math.max(pos.exitPlan.riskDistanceR, 1e-9);
    const rGain =
      pos.side === 'Long'
        ? (candle.close - pos.entryPrice) / r
        : (pos.entryPrice - candle.close) / r;
    const minProfitR = automationCfg.exhaustionMinProfitR ?? 1.0;
    const rsiHigh = automationCfg.exhaustionRsiHigh ?? 76;
    const rsiLow = automationCfg.exhaustionRsiLow ?? 24;
    const factor = Math.max(0.2, Math.min(0.95, automationCfg.exhaustionTrailFactor ?? 0.55));

    const longExhausted = pos.side === 'Long' && ind.rsi >= rsiHigh && ind.rsi < ind.prevRsi;
    const shortExhausted = pos.side === 'Short' && ind.rsi <= rsiLow && ind.rsi > ind.prevRsi;
    if (rGain >= minProfitR && (longExhausted || shortExhausted)) {
      return {
        type: 'TightenTrailing',
        factor,
        rationale: `Tightened trailing stop (${(factor * 100).toFixed(0)}%) on RSI exhaustion at +${rGain.toFixed(2)}R`,
      };
    }
  }

  return { type: 'Hold' };
}
