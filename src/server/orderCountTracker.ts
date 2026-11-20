/**
 * Tracks Binance per-account order-rate headers so the proxy can refuse orders
 * before the exchange answers with a ban-triggering 429/418.
 *
 * Binance documents the ceilings per venue; we block at 80% of each to leave
 * headroom for concurrent clients and clock skew.
 */

export type OrderRateVerdict = {
  constrained: boolean;
  retryAfterSeconds?: number;
  reason?: string;
};

type Snapshot = {
  count10s: number;
  count1m: number;
  updatedAtMs: number;
};

type VenueKey = `${string}:${string}`;

const TEN_SECOND_LIMIT: Record<'Spot' | 'Futures', number> = {
  Spot: 100,
  Futures: 300,
};
const ONE_MINUTE_LIMIT: Record<'Spot' | 'Futures', number> = {
  Spot: 1_200,
  Futures: 1_200,
};
const CEILING_RATIO = 0.8;
const STALE_AFTER_MS = 90_000;

export class OrderCountTracker {
  private readonly entries = new Map<VenueKey, Snapshot>();

  report(
    environment: string,
    venue: 'Spot' | 'Futures',
    headers: { get(name: string): string | null }
  ): void {
    const raw10s = Number(
      headers.get('x-mbx-order-count-10s') ?? headers.get('X-MBX-ORDER-COUNT-10S') ?? 0
    );
    const raw1m = Number(
      headers.get('x-mbx-order-count-1m') ?? headers.get('X-MBX-ORDER-COUNT-1M') ?? 0
    );
    if (!Number.isFinite(raw10s) && !Number.isFinite(raw1m)) return;
    const count10s = Number.isFinite(raw10s) && raw10s > 0 ? raw10s : 0;
    const count1m = Number.isFinite(raw1m) && raw1m > 0 ? raw1m : 0;
    if (count10s === 0 && count1m === 0) return;
    this.entries.set(`${environment}:${venue}`, {
      count10s,
      count1m,
      updatedAtMs: Date.now(),
    });
  }

  get(environment: string, venue: 'Spot' | 'Futures'): Snapshot | null {
    const entry = this.entries.get(`${environment}:${venue}`);
    if (!entry) return null;
    if (Date.now() - entry.updatedAtMs > STALE_AFTER_MS) return null;
    return entry;
  }

  check(environment: string, venue: 'Spot' | 'Futures'): OrderRateVerdict {
    const entry = this.get(environment, venue);
    if (!entry) return { constrained: false };
    const tenSecondCeiling = TEN_SECOND_LIMIT[venue] * CEILING_RATIO;
    if (entry.count10s >= tenSecondCeiling) {
      return {
        constrained: true,
        retryAfterSeconds: 10,
        reason: `Order rate near Binance 10s limit (${entry.count10s}/${TEN_SECOND_LIMIT[venue]}). Retry in ~10s.`,
      };
    }
    const minuteCeiling = ONE_MINUTE_LIMIT[venue] * CEILING_RATIO;
    if (entry.count1m >= minuteCeiling) {
      const elapsedSec = Math.floor((Date.now() - entry.updatedAtMs) / 1000);
      return {
        constrained: true,
        retryAfterSeconds: Math.max(5, 60 - elapsedSec),
        reason: `Order rate near Binance 1m limit (${entry.count1m}/${ONE_MINUTE_LIMIT[venue]}).`,
      };
    }
    return { constrained: false };
  }
}
