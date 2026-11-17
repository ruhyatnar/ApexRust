import type { CircuitBreakerState, RiskConfig, RiskStatus, TradingConfig } from './types';

export class RiskManager {
  private riskCfg: RiskConfig;
  private tradingCfg: TradingConfig;
  private activeUtcDay: number;
  private startingDailyEquity: number;
  private currentEquity: number;
  private pairDailyPnl = new Map<string, number>();
  private quarantinedPairs = new Set<string>();
  private winStreak = 0;
  private loseStreak = 0;
  private state: CircuitBreakerState = 'Active';
  private haltReason: string | null = null;
  private cooldownUntilMs: number | null = null;

  constructor(riskCfg: RiskConfig, tradingCfg: TradingConfig, nowMs: number) {
    this.riskCfg = { ...riskCfg };
    this.tradingCfg = { ...tradingCfg };
    this.activeUtcDay = Math.floor(nowMs / 86_400_000);
    this.startingDailyEquity = tradingCfg.initialEquityUsdt;
    this.currentEquity = tradingCfg.initialEquityUsdt;
  }

  updateConfigs(riskCfg: RiskConfig, tradingCfg: TradingConfig): void {
    this.riskCfg = { ...riskCfg };
    this.tradingCfg = { ...tradingCfg };
  }

  setEquityBaseline(equityUsdt: number): void {
    const clean = Math.max(0, Number(equityUsdt) || 0);
    this.startingDailyEquity = clean;
    this.currentEquity = clean;
  }

  maybeRolloverUtcDay(nowMs: number): void {
    const day = Math.floor(nowMs / 86_400_000);
    if (day > this.activeUtcDay) {
      this.activeUtcDay = day;
      this.startingDailyEquity = this.currentEquity;
      this.pairDailyPnl.clear();
      this.quarantinedPairs.clear();
      this.winStreak = 0;
      this.loseStreak = 0;
      this.state = 'Active';
      this.haltReason = null;
      this.cooldownUntilMs = null;
    }
  }

  authorizeEntry(
    symbol: string,
    entryPrice: number,
    stopLossPrice: number,
    openPositionsCount: number,
    nowMs: number
  ): { ok: true; quantity: number } | { ok: false; reason: string } {
    this.maybeRolloverUtcDay(nowMs);

    if (this.cooldownUntilMs !== null) {
      if (nowMs < this.cooldownUntilMs) {
        return { ok: false, reason: this.haltReason ?? 'Streak cooldown active' };
      }
      this.cooldownUntilMs = null;
      if (this.state === 'Cooldown') {
        this.state = 'Active';
        this.haltReason = null;
      }
    }

    if (this.state === 'Halted') {
      return { ok: false, reason: this.haltReason ?? 'Circuit breaker halted' };
    }

    if (this.quarantinedPairs.has(symbol)) {
      return { ok: false, reason: `${symbol} quarantined after per-pair daily drawdown breach` };
    }

    if (openPositionsCount >= this.tradingCfg.maxConcurrentPositions) {
      return { ok: false, reason: 'Max concurrent positions reached' };
    }

    const stopDist = Math.abs(entryPrice - stopLossPrice);
    if (stopDist <= 1e-12) {
      return { ok: false, reason: 'Zero stop-loss distance' };
    }

    const riskUsdt = this.currentEquity * (this.tradingCfg.baseRiskPerTradePct / 100);
    return { ok: true, quantity: riskUsdt / stopDist };
  }

  recordRealizedPnl(symbol: string, pnlUsdt: number, nowMs: number): void {
    this.maybeRolloverUtcDay(nowMs);
    this.currentEquity += pnlUsdt;
    this.pairDailyPnl.set(symbol, (this.pairDailyPnl.get(symbol) ?? 0) + pnlUsdt);

    if (pnlUsdt >= 0) {
      this.winStreak += 1;
      this.loseStreak = 0;
    } else {
      this.loseStreak += 1;
      this.winStreak = 0;
    }

    const cumPnl = this.currentEquity - this.startingDailyEquity;
    const cumPct = this.startingDailyEquity > 0 ? (cumPnl / this.startingDailyEquity) * 100 : 0;

    if (cumPct <= -this.riskCfg.maxDailyDrawdownPct) {
      this.tripCircuitBreaker(
        `Cumulative daily drawdown ${cumPct.toFixed(2)}% breached -${this.riskCfg.maxDailyDrawdownPct.toFixed(2)}% limit`
      );
      return;
    }

    if (cumPct >= this.riskCfg.maxDailyProfitPct) {
      this.tripCircuitBreaker(
        `Max daily profit target +${cumPct.toFixed(2)}% achieved — gains locked`
      );
      return;
    }

    const pairPnl = this.pairDailyPnl.get(symbol) ?? 0;
    const pairPct = this.startingDailyEquity > 0 ? (pairPnl / this.startingDailyEquity) * 100 : 0;
    if (pairPct <= -this.riskCfg.maxPairDailyDrawdownPct) {
      this.quarantinedPairs.add(symbol);
    }

    // 4. Streak guards (do not downgrade an already Halted circuit breaker)
    if (this.state !== 'Halted') {
      if (this.loseStreak >= this.riskCfg.maxLoseStreak) {
        this.state = 'Cooldown';
        this.cooldownUntilMs = nowMs + this.riskCfg.streakCooldownMinutes * 60_000;
        this.haltReason = `Max lose streak (${this.loseStreak}) reached — ${this.riskCfg.streakCooldownMinutes}m cooldown`;
      } else if (this.winStreak >= this.riskCfg.maxWinStreak) {
        this.state = 'Cooldown';
        this.cooldownUntilMs = nowMs + this.riskCfg.streakCooldownMinutes * 60_000;
        this.haltReason = `Max win streak (${this.winStreak}) cap reached — protecting profits`;
      }
    }
  }

  tripCircuitBreaker(reason: string): void {
    this.state = 'Halted';
    this.haltReason = reason;
  }

  resetCircuitBreaker(): void {
    this.state = 'Active';
    this.haltReason = null;
    this.cooldownUntilMs = null;
    this.winStreak = 0;
    this.loseStreak = 0;
    this.quarantinedPairs.clear();
  }

  getPairDailyPnl(symbol: string): number {
    return this.pairDailyPnl.get(symbol) ?? 0;
  }

  status(): RiskStatus {
    const cumPnl = this.currentEquity - this.startingDailyEquity;
    const cumPct = this.startingDailyEquity > 0 ? (cumPnl / this.startingDailyEquity) * 100 : 0;
    return {
      state: this.state,
      haltReason: this.haltReason,
      cooldownUntilMs: this.cooldownUntilMs,
      startingDailyEquity: this.startingDailyEquity,
      currentEquity: this.currentEquity,
      cumulativeDailyPnlUsdt: cumPnl,
      cumulativeDailyPnlPct: cumPct,
      winStreak: this.winStreak,
      loseStreak: this.loseStreak,
      quarantinedPairs: Array.from(this.quarantinedPairs),
    };
  }
}
