import type {
  Candle,
  DirectionPolicy,
  EntrySignal,
  ExitConfig,
  ExitPlan,
  ExitReason,
  FeatureToggles,
  IndicatorConfig,
  IndicatorSnapshot,
  Position,
  Side,
  StrategyProfile,
  TradingConfig,
} from './types';

export interface StrategyEvalOptions {
  strategyProfile?: StrategyProfile;
  directionPolicy?: DirectionPolicy;
  recentCandles?: Candle[];
  features?: Partial<FeatureToggles>;
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
  const allowShort = (options?.directionPolicy ?? 'both') === 'both';
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

  if (profile === 'vwap_reversion') {
    if (
      useVwap &&
      (ind.vwap === null || (useAdx && ind.adx > Math.max(38, indCfg.adxMinTrend + 12)))
    ) {
      return null;
    }
    const refAnchor = useVwap && ind.vwap !== null ? ind.vwap : ind.emaMid;
    const stretch = Math.abs(candle.close - refAnchor);
    const minStretch = ind.atr * 1.1;

    if (
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

    if (
      allowShort &&
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

  if (useAdx && ind.adx < indCfg.adxMinTrend) {
    return null;
  }

  const macroLongOk =
    !useEma ||
    (tradingCfg.mode === 'intraday' && ind.emaMacro !== null
      ? candle.close > ind.emaMacro
      : true);
  const macroShortOk =
    !useEma ||
    (tradingCfg.mode === 'intraday' && ind.emaMacro !== null
      ? candle.close < ind.emaMacro
      : true);

  const vwapLongOk =
    !useVwap || !indCfg.requireVwapAlignment || ind.vwap === null || candle.close >= ind.vwap;
  const vwapShortOk =
    !useVwap || !indCfg.requireVwapAlignment || ind.vwap === null || candle.close <= ind.vwap;

  if (profile === 'ema_breakout') {
    const history = (options?.recentCandles ?? []).slice(-11, -1);
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
      candle.close > priorHigh &&
      emaLongOk &&
      macroLongOk &&
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
        rationale: `Momentum Breakout Long · Close > 10-bar High · ADX ${ind.adx.toFixed(1)} · Vol ${(candle.volume / Math.max(avgVol, 1)).toFixed(2)}×`,
        timestampMs: nowMs,
      };
    }

    if (
      allowShort &&
      candle.close < priorLow &&
      emaShortOk &&
      macroShortOk &&
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
        rationale: `Momentum Breakout Short · Close < 10-bar Low · ADX ${ind.adx.toFixed(1)} · Vol ${(candle.volume / Math.max(avgVol, 1)).toFixed(2)}×`,
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

  if (emaPullLongOk && macroLongOk && diLongOk && rsiPullLongOk && vwapLongOk) {
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

  if (allowShort && emaPullShortOk && macroShortOk && diShortOk && rsiPullShortOk && vwapShortOk) {
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

export function buildExitPlan(
  side: Side,
  entryPrice: number,
  atr: number,
  cfg: ExitConfig
): ExitPlan {
  const slDist = atr * cfg.atrSlMultiplier;
  const tp1Dist = atr * cfg.atrTp1Multiplier;
  const tp2Dist = atr * cfg.atrTp2Multiplier;

  if (side === 'Long') {
    return {
      initialStopLoss: entryPrice - slDist,
      activeStopLoss: entryPrice - slDist,
      takeProfit1: entryPrice + tp1Dist,
      takeProfit2: entryPrice + tp2Dist,
      tp1Hit: false,
      breakEvenArmed: false,
      trailingActive: false,
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
    trailingActive: false,
    riskDistanceR: slDist,
  };
}

export type PositionTickAction =
  | { type: 'Hold' }
  | { type: 'PartialClose'; ratio: number; exitPrice: number; reason: ExitReason }
  | { type: 'FullClose'; exitPrice: number; reason: ExitReason };

export function managePositionTick(
  pos: Position,
  markPrice: number,
  currentAtr: number,
  cfg: ExitConfig,
  features?: Partial<FeatureToggles>
): PositionTickAction {
  const r = Math.max(pos.exitPlan.riskDistanceR, 1e-9);
  const feeBuffer = pos.entryPrice * (cfg.breakEvenFeeBufferBps / 10_000);
  const atrEnabled = features?.atrDynamicExits !== false;
  const tpEnabled = features?.takeProfitLadder !== false;
  const beEnabled = atrEnabled && features?.breakEvenStop !== false;
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

    if (tpEnabled) {
      if (pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0) {
        for (let i = 0; i < pos.exitPlan.tpTargets.length; i += 1) {
          const t = pos.exitPlan.tpTargets[i];
          if (!t.hit && markPrice >= t.targetPrice) {
            t.hit = true;
            const isLast =
              i === pos.exitPlan.tpTargets.length - 1 || pos.exitPlan.tpTargets.every((x) => x.hit);
            if (isLast) {
              return { type: 'FullClose', exitPrice: t.targetPrice, reason: 'TakeProfit2' };
            }
            return {
              type: 'PartialClose',
              ratio: Math.min(0.95, Math.max(0.05, t.allocationPct / 100)),
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
          return {
            type: 'PartialClose',
            ratio: cfg.tp1CloseRatio,
            exitPrice: pos.exitPlan.takeProfit1,
            reason: 'TakeProfit1',
          };
        }
      }
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
      const trailSl = pos.highestFavorablePrice - currentAtr * cfg.atrTrailingMultiplier;
      if (trailSl > pos.exitPlan.activeStopLoss) {
        pos.exitPlan.activeStopLoss = trailSl;
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

  if (tpEnabled) {
    if (pos.exitPlan.tpTargets && pos.exitPlan.tpTargets.length > 0) {
      for (let i = 0; i < pos.exitPlan.tpTargets.length; i += 1) {
        const t = pos.exitPlan.tpTargets[i];
        if (!t.hit && markPrice <= t.targetPrice) {
          t.hit = true;
          const isLast =
            i === pos.exitPlan.tpTargets.length - 1 || pos.exitPlan.tpTargets.every((x) => x.hit);
          if (isLast) {
            return { type: 'FullClose', exitPrice: t.targetPrice, reason: 'TakeProfit2' };
          }
          return {
            type: 'PartialClose',
            ratio: Math.min(0.95, Math.max(0.05, t.allocationPct / 100)),
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
        return {
          type: 'PartialClose',
          ratio: cfg.tp1CloseRatio,
          exitPrice: pos.exitPlan.takeProfit1,
          reason: 'TakeProfit1',
        };
      }
    }
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
    const trailSl = pos.highestFavorablePrice + currentAtr * cfg.atrTrailingMultiplier;
    if (trailSl < pos.exitPlan.activeStopLoss) {
      pos.exitPlan.activeStopLoss = trailSl;
    }
  }

  return { type: 'Hold' };
}
