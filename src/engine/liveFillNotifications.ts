import type { BinanceExecutionRecord } from './types';

export interface LiveExecutionNotificationPayload {
  id: string;
  orderId: string;
  symbol: string;
  title: string;
  body: string;
  summary: string;
  tag: string;
  timestampMs: number;
}

export interface DesktopNotificationConstructor {
  readonly permission: NotificationPermission;
  new (title: string, options?: NotificationOptions): unknown;
}

export function buildLiveFillNotification(
  rec: BinanceExecutionRecord
): LiveExecutionNotificationPayload {
  const pxDecimals = rec.price >= 100 ? 2 : 4;
  const orderId = String(rec.orderId);
  const ocoPart = rec.orderListId > 0 ? ` · OCO #${rec.orderListId}` : '';

  let pnlPart = '';
  if (rec.realizedPnlUsdt !== null && Number.isFinite(rec.realizedPnlUsdt)) {
    const sign = rec.realizedPnlUsdt >= 0 ? '+' : '-';
    const rPart =
      rec.rMultiple !== null && Number.isFinite(rec.rMultiple)
        ? ` (${rec.rMultiple >= 0 ? '+' : ''}${rec.rMultiple.toFixed(2)}R)`
        : '';
    const reasonPart = rec.exitReason ? ` · ${rec.exitReason}` : '';
    pnlPart = ` · PnL ${sign}$${Math.abs(rec.realizedPnlUsdt).toFixed(2)}${rPart}${reasonPart}`;
  }

  const summary = `${rec.binanceSide} ${rec.executedQty.toFixed(4)} ${rec.symbol} @ $${rec.price.toFixed(pxDecimals)} ($${rec.cummulativeQuoteQty.toFixed(2)} USDT) · ${rec.orderType} ${rec.orderStatus} · ${rec.environment} ${rec.venue}${pnlPart}${ocoPart}`;

  return {
    id: rec.id,
    orderId,
    symbol: rec.symbol,
    title: `Live ${rec.lifecycle} Fill · ${rec.binanceSide} ${rec.symbol} (#${orderId})`,
    body: `Order #${orderId} · ${summary}`,
    summary,
    tag: `apexrust-live-fill-${rec.id}`,
    timestampMs: rec.transactTime,
  };
}

export function collectNewLiveFillNotifications(
  records: BinanceExecutionRecord[],
  notifiedIds: Set<string>
): LiveExecutionNotificationPayload[] {
  const fresh: BinanceExecutionRecord[] = [];
  for (const rec of records) {
    if (rec.accountMode !== 'Live') continue;
    if (rec.orderStatus !== 'FILLED' && rec.orderStatus !== 'PARTIALLY_FILLED') continue;
    if (rec.id.startsWith('binance-trade-')) continue;
    if (notifiedIds.has(rec.id)) continue;
    notifiedIds.add(rec.id);
    fresh.push(rec);
  }
  // executionHistory is stored newest-first; emit notifications chronologically
  return fresh.reverse().map(buildLiveFillNotification);
}

export function dispatchDesktopLiveFillNotifications(
  notifications: LiveExecutionNotificationPayload[],
  notificationCtor?: DesktopNotificationConstructor
): number {
  if (notifications.length === 0) return 0;
  const ctor =
    notificationCtor ??
    (typeof window !== 'undefined' && 'Notification' in window
      ? (window.Notification as unknown as DesktopNotificationConstructor)
      : undefined);

  if (!ctor || ctor.permission !== 'granted') {
    return 0;
  }

  let sent = 0;
  for (const note of notifications) {
    try {
      new ctor(note.title, {
        body: note.body,
        tag: note.tag,
      });
      sent += 1;
    } catch {
      // Ignore Notification constructor failures in restricted browser/iframe contexts
    }
  }
  return sent;
}
