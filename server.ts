import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const execFileAsync = promisify(execFile);

type BinanceEnv = 'Testnet' | 'Production';
type ExchangeVenue = 'Spot' | 'Futures';
type MarginType = 'ISOLATED' | 'CROSSED';
type AuthMethod = 'HMAC-SHA256' | 'Ed25519';

interface ServerVaultState {
  environment: BinanceEnv;
  venue: ExchangeVenue;
  leverage: number;
  marginType: MarginType;
  authMethod: AuthMethod;
  apiKey: string;
  apiSecret: string;
  recvWindowMs: number;
  maxOrderNotionalUsdt: number;
  requirePreflightTestOrder: boolean;
  armedForLiveOrders: boolean;
  verificationStatus: 'unverified' | 'verified' | 'error';
  verificationMessage: string | null;
  lastVerifiedAt: string | null;
  canTrade: boolean;
  permissions: string[];
  latencyMs: number | null;
  syncedBalances: Array<{ asset: string; free: number; locked: number }>;
}

const TRACKED_ASSETS = new Set(['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'AVAX']);

const initialEnv: BinanceEnv =
  process.env.BINANCE_ENVIRONMENT === 'Production' ? 'Production' : 'Testnet';
const initialVenue: ExchangeVenue =
  process.env.BINANCE_VENUE === 'Futures' ? 'Futures' : 'Spot';
const initialAuth: AuthMethod =
  process.env.BINANCE_AUTH_METHOD === 'Ed25519' ? 'Ed25519' : 'HMAC-SHA256';
const initialKey = (process.env.BINANCE_API_KEY ?? '').trim();
function loadInitialSecret(): string {
  if (initialAuth === 'Ed25519') {
    const inlineKey = (process.env.BINANCE_ED25519_PRIVATE_KEY ?? '').trim();
    if (inlineKey) return inlineKey;
    const keyPath = (process.env.BINANCE_PRIVATE_KEY_PATH ?? '').trim();
    if (keyPath) {
      try {
        return fs.readFileSync(path.resolve(process.cwd(), keyPath), 'utf8').trim();
      } catch (err) {
        console.warn(
          `[server] Failed to read BINANCE_PRIVATE_KEY_PATH (${keyPath}):`,
          err instanceof Error ? err.message : String(err)
        );
        return '';
      }
    }
    return '';
  }
  return (process.env.BINANCE_API_SECRET ?? '').trim();
}
const initialSecret = loadInitialSecret();

const vault: ServerVaultState = {
  environment: initialEnv,
  venue: initialVenue,
  leverage: 3,
  marginType: 'ISOLATED',
  authMethod: initialAuth,
  apiKey: initialKey,
  apiSecret: initialSecret,
  recvWindowMs: 5000,
  maxOrderNotionalUsdt: 250,
  requirePreflightTestOrder: true,
  armedForLiveOrders: false,
  verificationStatus: 'unverified',
  verificationMessage: null,
  lastVerifiedAt: null,
  canTrade: false,
  permissions: [],
  latencyMs: null,
  syncedBalances: [],
};

interface BackendOrderExecutionLog {
  id: string;
  orderId: string;
  clientOrderId: string;
  orderListId?: number;
  algoOrderIds?: string[];
  symbol: string;
  venue: ExchangeVenue;
  environment: BinanceEnv;
  accountMode: 'Paper' | 'Live';
  source: 'paper_engine' | 'live_proxy' | 'binance_all_orders';
  lifecycle: 'ENTRY' | 'EXIT' | 'CANCEL' | 'PREFLIGHT';
  side: 'Long' | 'Short';
  binanceSide: 'BUY' | 'SELL';
  orderType: string;
  timeInForce: string;
  status: 'FILLED' | 'PARTIALLY_FILLED' | 'NEW' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  price: number;
  executedQty: number;
  origQty: number;
  quoteQty: number;
  commission: number;
  commissionAsset: string;
  isMaker: boolean;
  realizedPnlUsdt: number | null;
  rMultiple: number | null;
  exitReason: string | null;
  latencyMs: number | null;
  endpoint: string;
  rationale: string;
  errorMessage?: string;
  timestampMs: number;
}

const ORDER_LOGS_FILE = path.resolve(process.cwd(), '.apexrust-order-logs.json');

function buildInitialPaperOrderLogs(): BackendOrderExecutionLog[] {
  const now = Date.now();
  return [
    {
      id: 'paper-seed-btc-exit',
      orderId: '510941',
      clientOrderId: 'apex_btc_tp2_510941',
      symbol: 'BTCUSDT',
      venue: 'Spot',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'EXIT',
      side: 'Long',
      binanceSide: 'SELL',
      orderType: 'LIMIT_MAKER',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 93840.25,
      executedQty: 0.032,
      origQty: 0.032,
      quoteQty: 3002.89,
      commission: 2.2522,
      commissionAsset: 'USDT',
      isMaker: true,
      realizedPnlUsdt: 124.5,
      rMultiple: 1.85,
      exitReason: 'TakeProfit2',
      latencyMs: 14,
      endpoint: 'POST /api/v3/orderList/oco',
      rationale: 'Paper Sandbox TP2 runner fill · EMA Stack Long',
      timestampMs: now - 42 * 60 * 1000,
    },
    {
      id: 'paper-seed-btc-entry',
      orderId: '510940',
      clientOrderId: 'apex_btc_entry_510940',
      orderListId: 21019,
      symbol: 'BTCUSDT',
      venue: 'Spot',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'ENTRY',
      side: 'Long',
      binanceSide: 'BUY',
      orderType: 'MARKET',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 90020.0,
      executedQty: 0.032,
      origQty: 0.032,
      quoteQty: 2880.64,
      commission: 2.8806,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      latencyMs: 18,
      endpoint: 'POST /api/v3/order',
      rationale: 'EMA 9>21>50 Stack · ADX 34.2 · RSI curl 48->53',
      timestampMs: now - 74 * 60 * 1000,
    },
    {
      id: 'paper-seed-eth-exit',
      orderId: '510943',
      clientOrderId: 'apex_eth_trail_510943',
      symbol: 'ETHUSDT',
      venue: 'Spot',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'EXIT',
      side: 'Long',
      binanceSide: 'SELL',
      orderType: 'STOP_LOSS_LIMIT',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 3348.6,
      executedQty: 1.5,
      origQty: 1.5,
      quoteQty: 5022.9,
      commission: 5.0229,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: 68.4,
      rMultiple: 0.91,
      exitReason: 'TrailingStop',
      latencyMs: 16,
      endpoint: 'POST /api/v3/order',
      rationale: 'Monotonic 1.4x ATR trailing stop lock',
      timestampMs: now - 95 * 60 * 1000,
    },
    {
      id: 'paper-seed-eth-entry',
      orderId: '510942',
      clientOrderId: 'apex_eth_entry_510942',
      orderListId: 21021,
      symbol: 'ETHUSDT',
      venue: 'Spot',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'ENTRY',
      side: 'Long',
      binanceSide: 'BUY',
      orderType: 'MARKET',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 3299.6,
      executedQty: 1.5,
      origQty: 1.5,
      quoteQty: 4949.4,
      commission: 4.9494,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      latencyMs: 21,
      endpoint: 'POST /api/v3/order',
      rationale: 'Session VWAP reclaim + ADX 31.4 Long entry',
      timestampMs: now - 130 * 60 * 1000,
    },
    {
      id: 'paper-seed-avax-exit',
      orderId: '510945',
      clientOrderId: 'apex_avax_sl_510945',
      symbol: 'AVAXUSDT',
      venue: 'Futures',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'EXIT',
      side: 'Short',
      binanceSide: 'BUY',
      orderType: 'STOP_MARKET',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 41.02,
      executedQty: 22.0,
      origQty: 22.0,
      quoteQty: 902.44,
      commission: 0.361,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: -52.1,
      rMultiple: -0.7,
      exitReason: 'StopLoss',
      latencyMs: 23,
      endpoint: 'POST /fapi/v1/algoOrder',
      rationale: 'Initial 1.5x ATR Stop Loss trigger',
      timestampMs: now - 165 * 60 * 1000,
    },
    {
      id: 'paper-seed-avax-entry',
      orderId: '510944',
      clientOrderId: 'apex_avax_entry_510944',
      symbol: 'AVAXUSDT',
      venue: 'Futures',
      environment: 'Testnet',
      accountMode: 'Paper',
      source: 'paper_engine',
      lifecycle: 'ENTRY',
      side: 'Short',
      binanceSide: 'SELL',
      orderType: 'MARKET',
      timeInForce: 'GTC',
      status: 'FILLED',
      price: 38.67,
      executedQty: 22.0,
      origQty: 22.0,
      quoteQty: 850.74,
      commission: 0.3403,
      commissionAsset: 'USDT',
      isMaker: false,
      realizedPnlUsdt: null,
      rMultiple: null,
      exitReason: null,
      latencyMs: 19,
      endpoint: 'POST /fapi/v1/order',
      rationale: 'Downtrend pullback Short below VWAP',
      timestampMs: now - 190 * 60 * 1000,
    },
  ];
}

function loadOrderLogsFromDisk(): BackendOrderExecutionLog[] {
  try {
    if (fs.existsSync(ORDER_LOGS_FILE)) {
      const raw = fs.readFileSync(ORDER_LOGS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (x): x is BackendOrderExecutionLog =>
            typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string'
        );
      }
    }
  } catch {
    // Fall through to deterministic Paper seed on corrupt/missing file
  }
  const seeded = buildInitialPaperOrderLogs();
  saveOrderLogsToDisk(seeded);
  return seeded;
}

function sanitizeSymbol(raw: unknown, fallback = ''): string {
  const clean = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  return clean || fallback;
}

function saveOrderLogsToDisk(logs: BackendOrderExecutionLog[]): void {
  try {
    const tmpFile = `${ORDER_LOGS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(logs.slice(0, 500), null, 2), 'utf8');
    fs.renameSync(tmpFile, ORDER_LOGS_FILE);
  } catch {
    // Ignore read-only filesystem errors
  }
}

let orderExecutionLogs: BackendOrderExecutionLog[] = loadOrderLogsFromDisk();

function upsertOrderLogs(entries: BackendOrderExecutionLog[]): number {
  let added = 0;
  const byId = new Map<string, BackendOrderExecutionLog>();
  const byComposite = new Map<string, string>();
  for (const existing of orderExecutionLogs) {
    byId.set(existing.id, existing);
    byComposite.set(
      `${existing.accountMode}:${existing.environment}:${existing.venue}:${existing.symbol}:${existing.orderId}:${existing.lifecycle}`,
      existing.id
    );
  }
  for (const item of entries) {
    const composite = `${item.accountMode}:${item.environment}:${item.venue}:${item.symbol}:${item.orderId}:${item.lifecycle}`;
    const existingId = byId.has(item.id) ? item.id : byComposite.get(composite);
    if (!existingId) {
      added += 1;
      byId.set(item.id, item);
      byComposite.set(composite, item.id);
    } else {
      const prev = byId.get(existingId)!;
      const fromClientLive = item.id.startsWith('client-live-') && prev.source === 'live_proxy';
      byId.set(existingId, {
        ...prev,
        ...item,
        latencyMs: fromClientLive ? prev.latencyMs : item.latencyMs ?? prev.latencyMs,
        endpoint: fromClientLive ? prev.endpoint : item.endpoint,
        algoOrderIds: item.algoOrderIds ?? prev.algoOrderIds,
        orderListId: item.orderListId ?? prev.orderListId,
        id: existingId,
      });
    }
  }
  orderExecutionLogs = Array.from(byId.values())
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 500);
  saveOrderLogsToDisk(orderExecutionLogs);
  return added;
}

function maskApiKey(key: string): string | null {
  const clean = key.trim();
  if (!clean) return null;
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  return `${clean.slice(0, 4)}••••••${clean.slice(-4)}`;
}

function getSafeStatus() {
  return {
    configured: vault.apiKey.length > 0 && vault.apiSecret.length > 0,
    environment: vault.environment,
    venue: vault.venue,
    leverage: vault.leverage,
    marginType: vault.marginType,
    authMethod: vault.authMethod,
    apiKeyMasked: maskApiKey(vault.apiKey),
    recvWindowMs: vault.recvWindowMs,
    maxOrderNotionalUsdt: vault.maxOrderNotionalUsdt,
    requirePreflightTestOrder: vault.requirePreflightTestOrder,
    armedForLiveOrders: vault.armedForLiveOrders,
    verificationStatus: vault.verificationStatus,
    verificationMessage: vault.verificationMessage,
    lastVerifiedAt: vault.lastVerifiedAt,
    canTrade: vault.canTrade,
    permissions: vault.permissions,
    latencyMs: vault.latencyMs,
    syncedBalances: vault.syncedBalances,
  };
}

function getRestBaseUrl(env: BinanceEnv, venue: ExchangeVenue = vault.venue): string {
  if (venue === 'Futures') {
    if (env === 'Production') return 'https://fapi.binance.com';
    const override = (process.env.BINANCE_FUTURES_TESTNET_REST ?? '').trim();
    return override || 'https://testnet.binancefuture.com';
  }
  return env === 'Production'
    ? 'https://api.binance.com'
    : 'https://testnet.binance.vision';
}

function signPayload(queryString: string, authMethod: AuthMethod, secret: string): string {
  if (authMethod === 'Ed25519') {
    const keyObj = crypto.createPrivateKey(secret);
    return crypto.sign(null, Buffer.from(queryString, 'utf8'), keyObj).toString('base64');
  }
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

interface SymbolFilters {
  tickSize: number;
  tickDecimals: number;
  minPrice: number;
  maxPrice: number;
  stepSize: number;
  stepDecimals: number;
  minQty: number;
  maxQty: number;
  marketStepSize: number;
  marketStepDecimals: number;
  marketMinQty: number;
  marketMaxQty: number;
  minNotional: number;
  maxNotional: number;
  quoteDecimals: number;
  fetchedAtMs: number;
}

const symbolFilterCache = new Map<string, SymbolFilters>();

function countStepDecimals(stepStr: string): number {
  if (!stepStr) return 0;
  const sciMatch = stepStr.trim().match(/^(\d+(?:\.(\d+))?)e-(\d+)$/i);
  if (sciMatch) {
    const mantissaFrac = (sciMatch[2] ?? '').replace(/0+$/, '').length;
    return (Number(sciMatch[3]) || 0) + mantissaFrac;
  }
  if (!stepStr.includes('.')) return 0;
  const trimmed = stepStr.replace(/0+$/, '');
  const parts = trimmed.split('.');
  return parts[1] ? parts[1].length : 0;
}

function floorToStep(value: number, stepSize: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (stepSize > 0) {
    const steps = Math.floor((value + stepSize * 1e-9) / stepSize);
    const floored = steps * stepSize;
    return floored.toFixed(decimals);
  }
  return value.toFixed(decimals);
}

async function getSymbolFilters(
  symbol: string,
  fallbackPrice: number,
  venue: ExchangeVenue = vault.venue
): Promise<SymbolFilters> {
  const key = `${vault.environment}:${venue}:${symbol}`;
  const cached = symbolFilterCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < 600_000) {
    return cached;
  }

  try {
    const baseUrl = getRestBaseUrl(vault.environment, venue);
    const infoPath =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/exchangeInfo`
        : `${baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(infoPath, {
      signal: AbortSignal.timeout(4000),
    });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        symbols?: Array<{
          symbol?: string;
          quotePrecision?: number;
          quoteAssetPrecision?: number;
          filters?: Array<{
            filterType?: string;
            tickSize?: string;
            minPrice?: string;
            maxPrice?: string;
            stepSize?: string;
            minQty?: string;
            maxQty?: string;
            minNotional?: string;
            notional?: string;
            maxNotional?: string;
          }>;
        }>;
      };
      const symEntry = payload.symbols?.find((s) => s.symbol === symbol);
      if (symEntry) {
        const filters = symEntry.filters ?? [];
        const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
        const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
        const marketLotFilter = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') ?? lotFilter;
        const notionalFilter = filters.find(
          (f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL'
        );

        const defaultTickStr = fallbackPrice >= 100 ? '0.01' : '0.0001';
        const defaultStepStr = venue === 'Futures' ? '0.001' : '0.00001';
        const tickStr = priceFilter?.tickSize ?? defaultTickStr;
        const stepStr = lotFilter?.stepSize ?? defaultStepStr;
        const mktStepStr = marketLotFilter?.stepSize ?? stepStr;

        const tickSize = Number(tickStr) || Number(defaultTickStr);
        const stepSize = Number(stepStr) || Number(defaultStepStr);
        const marketStepSize = Number(mktStepStr) || stepSize;
        const rawQuotePrec = Number(symEntry.quoteAssetPrecision ?? symEntry.quotePrecision ?? 2);
        const quoteDecimals = Number.isFinite(rawQuotePrec)
          ? Math.min(8, Math.max(2, rawQuotePrec))
          : 2;

        const resolved: SymbolFilters = {
          tickSize,
          tickDecimals: countStepDecimals(tickStr),
          minPrice: Number(priceFilter?.minPrice ?? 0) || 0,
          maxPrice: Number(priceFilter?.maxPrice ?? 0) || 0,
          stepSize,
          stepDecimals: countStepDecimals(stepStr),
          minQty: Number(lotFilter?.minQty ?? 0) || 0,
          maxQty: Number(lotFilter?.maxQty ?? 0) || 0,
          marketStepSize,
          marketStepDecimals: countStepDecimals(mktStepStr),
          marketMinQty: Number(marketLotFilter?.minQty ?? lotFilter?.minQty ?? 0) || 0,
          marketMaxQty: Number(marketLotFilter?.maxQty ?? lotFilter?.maxQty ?? 0) || 0,
          minNotional:
            Number(notionalFilter?.minNotional ?? notionalFilter?.notional ?? 0) || 5,
          maxNotional: Number(notionalFilter?.maxNotional ?? 0) || 0,
          quoteDecimals,
          fetchedAtMs: Date.now(),
        };
        symbolFilterCache.set(key, resolved);
        return resolved;
      }
    }
  } catch {
    // Fallback to heuristic precision below if exchangeInfo cannot be reached
  }

  const tickDecimals = fallbackPrice >= 100 ? 2 : 4;
  const stepSize = venue === 'Futures' ? 0.001 : 0.00001;
  const stepDecimals = venue === 'Futures' ? 3 : 5;
  return {
    tickSize: Math.pow(10, -tickDecimals),
    tickDecimals,
    minPrice: 0,
    maxPrice: 0,
    stepSize,
    stepDecimals,
    minQty: stepSize,
    maxQty: 0,
    marketStepSize: stepSize,
    marketStepDecimals: stepDecimals,
    marketMinQty: stepSize,
    marketMaxQty: 0,
    minNotional: 5,
    maxNotional: 0,
    quoteDecimals: 2,
    fetchedAtMs: Date.now(),
  };
}

async function fetchPublicTicker(
  symbol: string,
  venue: ExchangeVenue,
  env: BinanceEnv = vault.environment
): Promise<{ price: number; bidPrice: number; askPrice: number }> {
  const baseUrl = getRestBaseUrl(env, venue);
  try {
    const bookPath =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`
        : `${baseUrl}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(bookPath, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const json = (await resp.json()) as { bidPrice?: string; askPrice?: string };
      const bid = Number(json.bidPrice ?? 0);
      const ask = Number(json.askPrice ?? 0);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return { price: (bid + ask) / 2, bidPrice: bid, askPrice: ask };
      }
    }
  } catch {
    // Fallback to /ticker/price
  }
  try {
    const tickerPath =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`
        : `${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(tickerPath, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const json = (await resp.json()) as { price?: string };
      const px = Number(json.price ?? 0);
      if (Number.isFinite(px) && px > 0) {
        return { price: px, bidPrice: px, askPrice: px };
      }
    }
  } catch {
    // Ignore transient errors
  }
  return { price: 0, bidPrice: 0, askPrice: 0 };
}

async function fetchPublicPrice(symbol: string, venue: ExchangeVenue): Promise<number> {
  const ticker = await fetchPublicTicker(symbol, venue, vault.environment);
  return ticker.price;
}

const serverTimeOffsetCache = new Map<string, { offsetMs: number; syncedAtMs: number }>();

interface VaultAuthSnapshot {
  environment: BinanceEnv;
  authMethod: AuthMethod;
  apiKey: string;
  apiSecret: string;
  recvWindowMs: number;
}

function captureVaultAuthSnapshot(): VaultAuthSnapshot {
  return {
    environment: vault.environment,
    authMethod: vault.authMethod,
    apiKey: vault.apiKey,
    apiSecret: vault.apiSecret,
    recvWindowMs: vault.recvWindowMs,
  };
}

function safeTokenMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getSyncedBinanceTimestamp(
  venue: ExchangeVenue,
  env: BinanceEnv = vault.environment,
  forceRefresh = false
): Promise<number> {
  const key = `${env}:${venue}`;
  const cached = !forceRefresh ? serverTimeOffsetCache.get(key) : undefined;
  if (cached && Date.now() - cached.syncedAtMs < 300_000) {
    return Date.now() + cached.offsetMs;
  }
  try {
    const baseUrl = getRestBaseUrl(env, venue);
    const timePath = venue === 'Futures' ? `${baseUrl}/fapi/v1/time` : `${baseUrl}/api/v3/time`;
    const before = Date.now();
    const resp = await fetch(timePath, { signal: AbortSignal.timeout(2500) });
    if (resp.ok) {
      const after = Date.now();
      const json = (await resp.json()) as { serverTime?: number };
      if (typeof json.serverTime === 'number' && json.serverTime > 0) {
        const midpoint = Math.round((before + after) / 2);
        const offsetMs = json.serverTime - midpoint;
        serverTimeOffsetCache.set(key, { offsetMs, syncedAtMs: after });
        return Date.now() + offsetMs;
      }
    }
  } catch {
    // Fallback to local clock if time endpoint is unreachable
  }
  return Date.now();
}

async function signedBinanceRequest(
  method: 'GET' | 'POST' | 'DELETE',
  endpointPath: string,
  params: Record<string, string | number>,
  venue: ExchangeVenue = vault.venue,
  authSnap: VaultAuthSnapshot = captureVaultAuthSnapshot()
) {
  const baseUrl = getRestBaseUrl(authSnap.environment, venue);

  const attempt = async (forceTimeResync: boolean) => {
    const syncedTimestamp = await getSyncedBinanceTimestamp(venue, authSnap.environment, forceTimeResync);
    const allParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      allParams.set(k, String(v));
    }
    allParams.set('recvWindow', String(authSnap.recvWindowMs));
    allParams.set('timestamp', String(syncedTimestamp));

    const query = allParams.toString();
    const signature = signPayload(query, authSnap.authMethod, authSnap.apiSecret);
    const signedQuery = `${query}&signature=${encodeURIComponent(signature)}`;

    const url =
      method === 'GET' || method === 'DELETE'
        ? `${baseUrl}${endpointPath}?${signedQuery}`
        : `${baseUrl}${endpointPath}`;

    const startedAt = Date.now();
    const resp = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': authSnap.apiKey,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: signedQuery } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - startedAt;
    const usedWeight1m = Number(resp.headers.get('x-mbx-used-weight-1m') ?? 0) || undefined;
    const rawText = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      data = { rawText };
    }
    return { ok: resp.ok, status: resp.status, latencyMs, usedWeight1m, data };
  };

  const first = await attempt(false);
  if (!first.ok && Number(first.data.code) === -1021) {
    serverTimeOffsetCache.delete(`${authSnap.environment}:${venue}`);
    return attempt(true);
  }
  return first;
}

const futuresDualSideCache = new Map<string, { dualSide: boolean; checkedAtMs: number }>();

async function getFuturesDualSideMode(): Promise<boolean> {
  const key = `${vault.environment}:${vault.apiKey.slice(0, 8)}`;
  const cached = futuresDualSideCache.get(key);
  if (cached && Date.now() - cached.checkedAtMs < 120_000) {
    return cached.dualSide;
  }
  try {
    const res = await signedBinanceRequest('GET', '/fapi/v1/positionSide/dual', {}, 'Futures');
    if (res.ok) {
      const dualSide = res.data.dualSidePosition === true || res.data.dualSidePosition === 'true';
      futuresDualSideCache.set(key, { dualSide, checkedAtMs: Date.now() });
      return dualSide;
    }
  } catch {
    // Fallback to One-Way mode if check fails
  }
  return false;
}

function parseFillMetrics(data: Record<string, unknown>, refPrice: number, baseAsset = '') {
  const executedQty = Number(data.executedQty ?? 0) || 0;
  const cumQuote = Number(data.cummulativeQuoteQty ?? data.cumQuote ?? 0) || 0;
  const fills = Array.isArray(data.fills)
    ? (data.fills as Array<{
        price?: string;
        qty?: string;
        commission?: string;
        commissionAsset?: string;
      }>)
    : [];

  let weightedQuote = 0;
  let weightedQty = 0;
  let totalCommission = 0;
  let baseCommission = 0;
  let commissionAsset = 'USDT';
  for (const f of fills) {
    const fq = Number(f.qty ?? 0) || 0;
    const fp = Number(f.price ?? 0) || 0;
    const fc = Number(f.commission ?? 0) || 0;
    if (fq > 0 && fp > 0) {
      weightedQty += fq;
      weightedQuote += fq * fp;
    }
    totalCommission += fc;
    if (f.commissionAsset) {
      commissionAsset = f.commissionAsset;
      if (baseAsset && f.commissionAsset.toUpperCase() === baseAsset.toUpperCase()) {
        baseCommission += fc;
      }
    }
  }

  let avgPrice = 0;
  if (executedQty > 0 && cumQuote > 0) {
    avgPrice = cumQuote / executedQty;
  } else if (weightedQty > 0 && weightedQuote > 0) {
    avgPrice = weightedQuote / weightedQty;
  } else {
    avgPrice = Number(data.avgPrice ?? data.price ?? refPrice ?? 0) || 0;
  }

  return {
    executedQty: executedQty > 0 ? executedQty : weightedQty,
    avgPrice,
    commission: totalCommission,
    baseCommission,
    commissionAsset,
  };
}

// ---------- Git Sync Helpers (Safe execFile strictly in workspace root) ----------

async function runGit(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const cwd = process.cwd();
    const res = await execFileAsync('git', ['-c', `safe.directory=${cwd}`, ...args], {
      cwd,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? 'git error').trim(),
    };
  }
}

function sanitizeRemoteUrl(url: string): string {
  // Strip any embedded credentials like https://user:token@github.com/...
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

function isValidGitRemote(url: string): boolean {
  const clean = url.trim();
  return (
    /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/.test(clean) ||
    /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+(\.git)?$/.test(clean) ||
    /^ssh:\/\/[A-Za-z0-9._~:/@+-]+$/.test(clean)
  );
}

function ensureGitIgnoreDefaults(): void {
  const giPath = path.resolve(process.cwd(), '.gitignore');
  const required = [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    'node_modules/',
    'dist/',
    'target/',
    'rust-bot/target/',
    'rust-bot/config/bot.toml',
    '.apexrust-order-logs.json',
  ];
  let current = '';
  if (fs.existsSync(giPath)) {
    current = fs.readFileSync(giPath, 'utf8');
  }
  const lines = new Set(
    current
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  );
  let changed = false;
  for (const item of required) {
    if (!lines.has(item)) {
      current += (current.endsWith('\n') || current === '' ? '' : '\n') + item + '\n';
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(giPath, current, 'utf8');
  }
}

function tomlStr(val: unknown): string {
  return String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function tomlNum(val: unknown, fallback: number): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULT_FEATURE_TOGGLES: Record<string, boolean> = {
  automated_trading: true,
  manual_trading: true,
  signal_generator: true,
  ws_primary_feed: true,
  rest_fallback: true,
  ema_trend_filter: true,
  rsi_momentum_filter: true,
  adx_strength_filter: true,
  vwap_bias_filter: true,
  volume_confirmation_filter: false,
  session_window_filter: false,
  atr_dynamic_exits: true,
  take_profit_ladder: true,
  break_even_stop: true,
  trailing_stop: true,
  circuit_breaker: true,
  spot_market: true,
  futures_market: true,
  git_auto_backup: true,
};

function buildSyncedTomlFromPayload(body: Record<string, unknown>): string {
  const cfg = (body.config ?? {}) as Record<string, unknown>;
  const trading = (cfg.trading ?? {}) as Record<string, unknown>;
  const indicators = (cfg.indicators ?? {}) as Record<string, unknown>;
  const automation = (cfg.automation ?? {}) as Record<string, unknown>;
  const exits = (cfg.exits ?? {}) as Record<string, unknown>;
  const risk = (cfg.risk ?? {}) as Record<string, unknown>;
  const rawFeatures = (cfg.features ?? {}) as Record<string, unknown>;
  const rawPairs = Array.isArray(trading.pairs)
    ? (trading.pairs as unknown[]).map((p) => sanitizeSymbol(p)).filter(Boolean)
    : [];
  const pairs = rawPairs.length > 0 ? rawPairs : ['BTCUSDT', 'ETHUSDT'];
  const envLower = vault.environment.toLowerCase();
  const venueLower = String(trading.venue ?? vault.venue).toLowerCase() === 'futures' ? 'futures' : 'spot';
  const isFutures = venueLower === 'futures';
  const isProd = envLower === 'production';
  const wsStreamUrl = isFutures
    ? isProd
      ? 'wss://fstream.binance.com/stream'
      : 'wss://stream.binancefuture.com/stream'
    : isProd
      ? 'wss://stream.binance.com:9443/stream'
      : 'wss://stream.testnet.binance.vision/stream';
  const wsApiUrl = isFutures
    ? isProd
      ? 'wss://ws-fapi.binance.com/ws-fapi/v1'
      : 'wss://testnet.binancefuture.com/ws-fapi/v1'
    : isProd
      ? 'wss://ws-api.binance.com:443/ws-api/v3'
      : 'wss://ws-api.testnet.binance.vision/ws-api/v3';
  const restBaseUrl = getRestBaseUrl(vault.environment, isFutures ? 'Futures' : 'Spot');

  const marginUpper = String(trading.marginType ?? vault.marginType).toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED';
  const modeLower = String(trading.mode ?? 'scalping').toLowerCase() === 'intraday' ? 'intraday' : 'scalping';
  const sizingLower = String(trading.positionSizingMode ?? 'fixed_usdt').toLowerCase();
  const profileLower = String(automation.strategyProfile ?? 'trend_pullback').toLowerCase();
  const dirLower = String(automation.directionPolicy ?? 'long_only').toLowerCase();
  const rawMethod = String(automation.orderMethod ?? 'MARKET').toUpperCase();
  const orderMethodUpper =
    rawMethod === 'LIMIT' || rawMethod === 'LIMIT_MAKER' || rawMethod === 'OCO' ? rawMethod : 'MARKET';
  const tifUpper =
    String(automation.timeInForce ?? 'GTC').toUpperCase() === 'IOC'
      ? 'IOC'
      : String(automation.timeInForce ?? 'GTC').toUpperCase() === 'FOK'
        ? 'FOK'
        : 'GTC';

  const normalizedFeatures: Record<string, boolean> = { ...DEFAULT_FEATURE_TOGGLES };
  for (const [k, v] of Object.entries(rawFeatures)) {
    const snake = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`).replace(/[^a-z0-9_]/g, '');
    if (snake in normalizedFeatures) {
      normalizedFeatures[snake] = Boolean(v);
    }
  }

  const sessionWindows = Array.isArray(automation.sessionWindows)
    ? (automation.sessionWindows as Array<Record<string, unknown>>)
    : [];

  return [
    '# Auto-generated by ApexRust Web Control Plane Git Backup Sync',
    `# Generated At: ${new Date().toISOString()}`,
    '# NOTE: API secrets are intentionally excluded and must stay in environment variables.',
    '',
    '[exchange]',
    `environment = "${tomlStr(envLower)}"`,
    `venue = "${tomlStr(venueLower)}"`,
    `leverage = ${Math.min(20, Math.max(1, Math.round(tomlNum(trading.leverage, vault.leverage))))}`,
    `margin_type = "${marginUpper}"`,
    `paper_trading = ${!vault.armedForLiveOrders}`,
    `ws_stream_url = "${wsStreamUrl}"`,
    `ws_api_url = "${wsApiUrl}"`,
    `rest_base_url = "${restBaseUrl}"`,
    'ws_heartbeat_timeout_ms = 4500',
    'rest_poll_interval_ms = 1500',
    'ws_reconnect_initial_ms = 1000',
    'ws_reconnect_max_ms = 30000',
    'max_consecutive_rest_failures = 5',
    '',
    '[trading]',
    `mode = "${modeLower}"`,
    `timeframe = "${tomlStr(trading.timeframe ?? '5m')}"`,
    `pairs = [${pairs.map((p) => `"${tomlStr(p)}"`).join(', ')}]`,
    `max_concurrent_positions = ${Math.max(1, Math.round(tomlNum(trading.maxConcurrentPositions, 3)))}`,
    `base_risk_per_trade_pct = ${tomlNum(trading.baseRiskPerTradePct, 0.75)}`,
    `position_sizing_mode = "${tomlStr(sizingLower)}"`,
    `initial_equity_usdt = ${Math.max(1, tomlNum(trading.initialEquityUsdt, 10000))}`,
    `taker_fee_bps = ${Math.max(0, tomlNum(trading.takerFeeBps, 10))}`,
    '',
    '[automation]',
    `enabled = ${Boolean(automation.enabled ?? true)}`,
    `strategy_profile = "${tomlStr(profileLower)}"`,
    `direction_policy = "${tomlStr(dirLower)}"`,
    `order_method = "${orderMethodUpper}"`,
    `limit_offset_bps = ${Math.max(0, tomlNum(automation.limitOffsetBps, 5))}`,
    `time_in_force = "${tifUpper}"`,
    `signal_cooldown_bars = ${Math.max(0, Math.round(tomlNum(automation.signalCooldownBars, 2)))}`,
    `auto_order_notional_usdt = ${Math.max(10, tomlNum(automation.autoOrderNotionalUsdt, 150))}`,
    `auto_close_on_exit = ${Boolean(automation.autoCloseOnExit ?? true)}`,
    ...sessionWindows.flatMap((w) => [
      '',
      '[[automation.session_windows]]',
      `id = "${tomlStr(w.id ?? 'custom')}"`,
      `label = "${tomlStr(w.label ?? 'Session')}"`,
      `start_utc = "${tomlStr(w.startUtc ?? '07:00')}"`,
      `end_utc = "${tomlStr(w.endUtc ?? '11:00')}"`,
      `enabled = ${Boolean(w.enabled ?? true)}`,
    ]),
    '',
    '[indicators]',
    `ema_fast = ${Math.max(2, Math.round(tomlNum(indicators.emaFast, 9)))}`,
    `ema_mid = ${Math.max(3, Math.round(tomlNum(indicators.emaMid, 21)))}`,
    `ema_slow = ${Math.max(5, Math.round(tomlNum(indicators.emaSlow, 50)))}`,
    `ema_macro = ${Math.max(20, Math.round(tomlNum(indicators.emaMacro, 200)))}`,
    `rsi_period = ${Math.max(2, Math.round(tomlNum(indicators.rsiPeriod, 14)))}`,
    `rsi_long_pullback_min = ${tomlNum(indicators.rsiLongPullbackMin, 42)}`,
    `rsi_long_pullback_max = ${tomlNum(indicators.rsiLongPullbackMax, 58)}`,
    `rsi_short_pullback_min = ${tomlNum(indicators.rsiShortPullbackMin, 42)}`,
    `rsi_short_pullback_max = ${tomlNum(indicators.rsiShortPullbackMax, 58)}`,
    `adx_period = ${Math.max(2, Math.round(tomlNum(indicators.adxPeriod, 14)))}`,
    `adx_min_trend = ${tomlNum(indicators.adxMinTrend, 25)}`,
    `atr_period = ${Math.max(2, Math.round(tomlNum(indicators.atrPeriod, 14)))}`,
    `require_vwap_alignment = ${Boolean(indicators.requireVwapAlignment ?? true)}`,
    `min_volume_expansion_mult = ${tomlNum(indicators.minVolumeExpansionMult, 1.5)}`,
    `volatility_alerts_enabled = ${Boolean(indicators.volatilityAlertsEnabled ?? true)}`,
    `atr_spike_pct_threshold = ${tomlNum(indicators.atrSpikePctThreshold, 0.45)}`,
    `atr_expansion_ratio_threshold = ${tomlNum(indicators.atrExpansionRatioThreshold, 1.25)}`,
    `volatility_alert_cooldown_sec = ${Math.max(0, Math.round(tomlNum(indicators.volatilityAlertCooldownSec, 60)))}`,
    '',
    '[exits]',
    `atr_sl_multiplier = ${Math.max(0.1, tomlNum(exits.atrSlMultiplier, 1.5))}`,
    `atr_tp1_multiplier = ${Math.max(0.1, tomlNum(exits.atrTp1Multiplier, 2.25))}`,
    `atr_tp2_multiplier = ${Math.max(0.1, tomlNum(exits.atrTp2Multiplier, 3.75))}`,
    `tp1_close_ratio = ${Math.min(1, Math.max(0.05, tomlNum(exits.tp1CloseRatio, 0.5)))}`,
    `break_even_trigger_r = ${Math.max(0.1, tomlNum(exits.breakEvenTriggerR, 1.0))}`,
    `break_even_fee_buffer_bps = ${Math.max(0, tomlNum(exits.breakEvenFeeBufferBps, 25))}`,
    `trailing_activation_r = ${Math.max(0.1, tomlNum(exits.trailingActivationR, 1.2))}`,
    `atr_trailing_multiplier = ${Math.max(0.1, tomlNum(exits.atrTrailingMultiplier, 1.4))}`,
    '',
    '[risk]',
    `max_daily_drawdown_pct = ${Math.max(0.1, tomlNum(risk.maxDailyDrawdownPct, 3.0))}`,
    `max_pair_daily_drawdown_pct = ${Math.max(0.1, tomlNum(risk.maxPairDailyDrawdownPct, 1.25))}`,
    `max_daily_profit_pct = ${Math.max(0.1, tomlNum(risk.maxDailyProfitPct, 5.0))}`,
    `max_win_streak = ${Math.max(1, Math.round(tomlNum(risk.maxWinStreak, 5)))}`,
    `max_lose_streak = ${Math.max(1, Math.round(tomlNum(risk.maxLoseStreak, 3)))}`,
    `streak_cooldown_minutes = ${Math.max(1, Math.round(tomlNum(risk.streakCooldownMinutes, 30)))}`,
    `flatten_on_circuit_breaker = ${Boolean(risk.flattenOnCircuitBreaker ?? true)}`,
    '',
    '[features]',
    ...Object.entries(normalizedFeatures).map(([k, v]) => `${k} = ${v}`),
    '',
    '[git_backup]',
    'enabled = true',
    'remote_name = "origin"',
    'branch = "main"',
    'auto_push = false',
    'backup_dir = "backups"',
    '',
    '[web]',
    'bind_addr = "127.0.0.1:8080"',
    'allowed_origin = "http://localhost:3000"',
    '',
  ].join('\n');
}

async function getGitStatusSummary() {
  const gitDirExists = fs.existsSync(path.resolve(process.cwd(), '.git'));
  if (!gitDirExists) {
    return {
      initialized: false,
      branch: null,
      remoteUrl: null,
      dirtyCount: 0,
      changedFiles: [] as string[],
      commits: [] as Array<{ hash: string; message: string }>,
    };
  }

  const [branchRes, remoteRes, statusRes, logRes] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(['remote', 'get-url', 'origin']),
    runGit(['status', '--porcelain']),
    runGit(['log', '-n', '6', '--pretty=format:%h|%s']),
  ]);

  const changedFiles = statusRes.ok && statusRes.stdout
    ? statusRes.stdout.split('\n').filter(Boolean).slice(0, 25)
    : [];

  const commits =
    logRes.ok && logRes.stdout
      ? logRes.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const sep = line.indexOf('|');
            return {
              hash: sep >= 0 ? line.slice(0, sep) : line,
              message: sep >= 0 ? line.slice(sep + 1) : '',
            };
          })
      : [];

  return {
    initialized: true,
    branch: branchRes.ok && branchRes.stdout ? branchRes.stdout : 'main',
    remoteUrl: remoteRes.ok && remoteRes.stdout ? sanitizeRemoteUrl(remoteRes.stdout) : null,
    dirtyCount: statusRes.ok && statusRes.stdout ? statusRes.stdout.split('\n').filter(Boolean).length : 0,
    changedFiles,
    commits,
  };
}

async function bootstrapServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const asyncRoute =
    (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };

  // Reject cross-site mutating requests and enforce optional APEXRUST_PROXY_TOKEN on sensitive routes
  app.use(['/api/live', '/api/git', '/api/orders'], (req, res, next) => {
    const fetchSite = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && fetchSite === 'cross-site') {
      res.status(403).json({ error: 'Cross-site request blocked for live trading and git safety.' });
      return;
    }
    const configuredToken = (process.env.APEXRUST_PROXY_TOKEN ?? '').trim();
    if (configuredToken) {
      const headerToken = String(req.headers['x-apexrust-token'] ?? '').trim();
      const authHeader = String(req.headers.authorization ?? '').trim();
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!safeTokenMatch(headerToken, configuredToken) && !safeTokenMatch(bearerToken, configuredToken)) {
        res.status(401).json({ error: 'Unauthorized: missing or invalid APEXRUST_PROXY_TOKEN.' });
        return;
      }
    }
    next();
  });

  app.get(['/api/health', '/_ah/health'], (_req, res) => {
    res.json({
      ok: true,
      service: 'apexrust-control-proxy',
      environment: vault.environment,
      venue: vault.venue,
    });
  });

  // Public Binance Market Data Proxies (avoids browser CORS issues on Futures & Testnet endpoints)
  app.get('/api/market/klines', asyncRoute(async (req, res) => {
    const symbol = sanitizeSymbol(req.query.symbol, 'BTCUSDT');
    const interval = String(req.query.interval ?? '5m').replace(/[^0-9a-zA-Z]/g, '');
    const venue: ExchangeVenue = req.query.venue === 'Futures' ? 'Futures' : 'Spot';
    const env: BinanceEnv = req.query.environment === 'Production' ? 'Production' : 'Testnet';
    const limit = Math.min(500, Math.max(2, Number(req.query.limit ?? 3) || 3));
    const baseUrl = getRestBaseUrl(env, venue);
    const klinesPath =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
        : `${baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    try {
      const resp = await fetch(klinesPath, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) {
        res.status(resp.status).json({ error: `Binance klines HTTP ${resp.status}` });
        return;
      }
      const rows = (await resp.json()) as unknown[];
      res.json({ ok: true, symbol, interval, venue, environment: env, rows });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to fetch Binance klines',
      });
    }
  }));

  app.get('/api/market/ticker', asyncRoute(async (req, res) => {
    const symbol = sanitizeSymbol(req.query.symbol, 'BTCUSDT');
    const venue: ExchangeVenue = req.query.venue === 'Futures' ? 'Futures' : 'Spot';
    const env: BinanceEnv = req.query.environment === 'Production' ? 'Production' : 'Testnet';
    const ticker = await fetchPublicTicker(symbol, venue, env);
    if (ticker.price <= 0) {
      res.status(502).json({ ok: false, error: 'Ticker unavailable' });
      return;
    }
    res.json({ ok: true, symbol, venue, environment: env, ...ticker });
  }));

  app.get('/api/live/config', (_req, res) => {
    res.json(getSafeStatus());
  });

  app.post('/api/live/config', (req, res) => {
    const body = (req.body ?? {}) as {
      environment?: BinanceEnv;
      venue?: ExchangeVenue;
      leverage?: number;
      marginType?: MarginType;
      authMethod?: AuthMethod;
      apiKey?: string;
      apiSecret?: string;
      recvWindowMs?: number;
      maxOrderNotionalUsdt?: number;
      requirePreflightTestOrder?: boolean;
    };

    const nextEnv: BinanceEnv =
      body.environment !== undefined
        ? body.environment === 'Production'
          ? 'Production'
          : 'Testnet'
        : vault.environment;
    const nextVenue: ExchangeVenue =
      body.venue !== undefined
        ? body.venue === 'Futures'
          ? 'Futures'
          : 'Spot'
        : vault.venue;
    const nextMargin: MarginType =
      body.marginType !== undefined
        ? body.marginType === 'CROSSED'
          ? 'CROSSED'
          : 'ISOLATED'
        : vault.marginType;
    const nextAuth: AuthMethod =
      body.authMethod !== undefined
        ? body.authMethod === 'Ed25519'
          ? 'Ed25519'
          : 'HMAC-SHA256'
        : vault.authMethod;
    const nextKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const nextSecret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';

    if (nextAuth === 'Ed25519') {
      const candidateSecret = nextSecret.length > 0 ? nextSecret : nextAuth === vault.authMethod ? vault.apiSecret : '';
      if (candidateSecret.length > 0) {
        try {
          const keyObj = crypto.createPrivateKey(candidateSecret);
          if (keyObj.asymmetricKeyType !== 'ed25519') {
            res.status(400).json({
              error: `Expected an Ed25519 PKCS#8 PEM private key, received ${keyObj.asymmetricKeyType ?? 'unsupported'}.`,
              status: getSafeStatus(),
            });
            return;
          }
        } catch {
          res.status(400).json({
            error: 'Invalid Ed25519 private key PEM. Paste the PKCS#8 PEM block starting with -----BEGIN PRIVATE KEY-----.',
            status: getSafeStatus(),
          });
          return;
        }
      } else if (nextKey.length > 0 || vault.apiKey.length > 0) {
        res.status(400).json({
          error: 'Switching to Ed25519 requires an Ed25519 PKCS#8 PEM private key.',
          status: getSafeStatus(),
        });
        return;
      }
    }

    const resultingKey = nextKey.length > 0 ? nextKey : vault.apiKey;
    const resultingSecret =
      nextSecret.length > 0
        ? nextSecret
        : nextAuth !== vault.authMethod && nextAuth === 'Ed25519'
          ? ''
          : vault.apiSecret;

    if ((!resultingKey || !resultingSecret) && (nextKey.length > 0 || nextSecret.length > 0)) {
      res.status(400).json({
        error: 'Both API Key and Secret / Private Key are required to configure live credentials.',
        status: getSafeStatus(),
      });
      return;
    }

    const keyChanged = nextKey.length > 0 && nextKey !== vault.apiKey;
    const secretChanged = nextSecret.length > 0 && nextSecret !== vault.apiSecret;
    const envChanged =
      nextEnv !== vault.environment ||
      nextVenue !== vault.venue ||
      nextAuth !== vault.authMethod;
    const nextMaxNotional =
      typeof body.maxOrderNotionalUsdt === 'number' && Number.isFinite(body.maxOrderNotionalUsdt)
        ? Math.max(10, Number(body.maxOrderNotionalUsdt.toFixed(2)))
        : vault.maxOrderNotionalUsdt;
    const nextPreflight =
      typeof body.requirePreflightTestOrder === 'boolean'
        ? body.requirePreflightTestOrder
        : vault.requirePreflightTestOrder;
    const riskRelaxed =
      nextMaxNotional > vault.maxOrderNotionalUsdt || (!nextPreflight && vault.requirePreflightTestOrder);

    vault.environment = nextEnv;
    vault.venue = nextVenue;
    vault.marginType = nextMargin;
    vault.authMethod = nextAuth;
    if (typeof body.leverage === 'number' && Number.isFinite(body.leverage)) {
      vault.leverage = Math.min(20, Math.max(1, Math.round(body.leverage)));
    }
    vault.apiKey = resultingKey;
    vault.apiSecret = resultingSecret;

    if (typeof body.recvWindowMs === 'number' && Number.isFinite(body.recvWindowMs)) {
      vault.recvWindowMs = Math.min(60_000, Math.max(1000, Math.round(body.recvWindowMs)));
    }
    vault.maxOrderNotionalUsdt = nextMaxNotional;
    vault.requirePreflightTestOrder = nextPreflight;

    if (keyChanged || secretChanged || envChanged) {
      vault.armedForLiveOrders = false;
      vault.verificationStatus = 'unverified';
      vault.verificationMessage = `Vault updated (${vault.environment} · ${vault.venue}) — run Verify Connection before arming.`;
      vault.lastVerifiedAt = null;
      vault.canTrade = false;
      vault.permissions = [];
      vault.syncedBalances = [];
      futuresDualSideCache.clear();
    } else if (riskRelaxed && vault.armedForLiveOrders) {
      vault.armedForLiveOrders = false;
      vault.verificationMessage = 'Live safety caps were relaxed — re-arm explicitly before sending live orders.';
    }

    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/verify', asyncRoute(async (_req, res) => {
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        error: 'Live credentials are not configured yet.',
        status: getSafeStatus(),
      });
      return;
    }

    try {
      const accountPath = vault.venue === 'Futures' ? '/fapi/v2/account' : '/api/v3/account';
      const result = await signedBinanceRequest('GET', accountPath, {}, vault.venue);
      vault.latencyMs = result.latencyMs;

      if (!result.ok) {
        const errMsg =
          typeof result.data.msg === 'string'
            ? `Binance ${result.data.code ?? result.status}: ${result.data.msg}`
            : `HTTP ${result.status} from ${getRestBaseUrl(vault.environment, vault.venue)}`;
        vault.verificationStatus = 'error';
        vault.verificationMessage = errMsg;
        vault.canTrade = false;
        vault.armedForLiveOrders = false;
        res.status(200).json({ ok: false, status: getSafeStatus() });
        return;
      }

      if (vault.venue === 'Futures') {
        const rawAssets = Array.isArray(result.data.assets)
          ? (result.data.assets as Array<{
              asset: string;
              availableBalance?: string;
              initialMargin?: string;
              walletBalance?: string;
            }>)
          : [];
        vault.syncedBalances = rawAssets
          .filter(
            (a) =>
              TRACKED_ASSETS.has(a.asset) ||
              Number(a.walletBalance ?? 0) > 0 ||
              Number(a.availableBalance ?? 0) > 0
          )
          .slice(0, 12)
          .map((a) => ({
            asset: a.asset,
            free: Number(a.availableBalance ?? a.walletBalance ?? 0) || 0,
            locked: Number(a.initialMargin ?? 0) || 0,
          }));
        vault.canTrade = Boolean(result.data.canTrade ?? true);
        vault.permissions = ['USDM_FUTURES', `${vault.leverage}x_${vault.marginType}`];
      } else {
        const rawBalances = Array.isArray(result.data.balances)
          ? (result.data.balances as Array<{ asset: string; free: string; locked: string }>)
          : [];
        vault.syncedBalances = rawBalances
          .filter((b) => TRACKED_ASSETS.has(b.asset) || Number(b.free) > 0 || Number(b.locked) > 0)
          .slice(0, 12)
          .map((b) => ({
            asset: b.asset,
            free: Number(b.free) || 0,
            locked: Number(b.locked) || 0,
          }));

        vault.canTrade = Boolean(result.data.canTrade);
        vault.permissions = Array.isArray(result.data.permissions)
          ? (result.data.permissions as string[])
          : ['SPOT'];
      }

      vault.verificationStatus = 'verified';
      vault.lastVerifiedAt = new Date().toISOString();
      vault.verificationMessage = `Signed ${vault.authMethod} check succeeded on ${vault.environment} ${vault.venue} (${result.latencyMs}ms)`;

      res.json({ ok: true, status: getSafeStatus() });
    } catch (err) {
      vault.verificationStatus = 'error';
      vault.canTrade = false;
      vault.armedForLiveOrders = false;
      const errMsg = err instanceof Error ? err.message : 'Network error contacting Binance API';
      vault.verificationMessage =
        errMsg.toLowerCase().includes('key') || errMsg.toLowerCase().includes('pem') || errMsg.toLowerCase().includes('asn1')
          ? `Credential signing error (${vault.authMethod}): ${errMsg}`
          : `Unable to reach ${getRestBaseUrl(vault.environment, vault.venue)}: ${errMsg}`;
      res.status(200).json({ ok: false, status: getSafeStatus() });
    }
  }));

  app.post('/api/live/arm', (req, res) => {
    const body = (req.body ?? {}) as { armed?: boolean; confirmProduction?: boolean };
    const wantArm = Boolean(body.armed);

    if (!wantArm) {
      vault.armedForLiveOrders = false;
      res.json({ ok: true, status: getSafeStatus() });
      return;
    }

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        error: 'Configure live credentials before arming live execution.',
        status: getSafeStatus(),
      });
      return;
    }

    if (vault.environment === 'Production' && !body.confirmProduction) {
      res.status(400).json({
        error: 'Production live arming requires explicit real-funds confirmation.',
        status: getSafeStatus(),
      });
      return;
    }

    vault.armedForLiveOrders = true;
    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/order', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as {
      venue?: ExchangeVenue;
      symbol?: string;
      side?: 'BUY' | 'SELL';
      positionSide?: 'BOTH' | 'LONG' | 'SHORT';
      reduceOnly?: boolean;
      type?: 'MARKET' | 'LIMIT' | 'LIMIT_MAKER' | 'OCO';
      quoteOrderQty?: number;
      quantity?: number;
      price?: number;
      takeProfitPrice?: number;
      stopLossPrice?: number;
      workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
      leverage?: number;
      timeInForce?: 'GTC' | 'IOC' | 'FOK';
      preflightOnly?: boolean;
    };

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ error: 'Live API credentials are not configured.' });
      return;
    }

    const preflightOnly = Boolean(body.preflightOnly);
    if (!preflightOnly && !vault.armedForLiveOrders) {
      res.status(403).json({
        error: 'Live execution is disarmed. Arm Live Execution or run a signed preflight test order.',
      });
      return;
    }

    const authSnap = captureVaultAuthSnapshot();
    const maxOrderNotionalCap = vault.maxOrderNotionalUsdt;
    const requirePreflight = vault.requirePreflightTestOrder;
    const desiredMarginType: MarginType = vault.marginType;
    const venue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : body.venue === 'Spot' ? 'Spot' : vault.venue;
    const symbol = sanitizeSymbol(body.symbol, 'BTCUSDT');
    const side = body.side === 'SELL' ? 'SELL' : 'BUY';
    const orderType =
      body.type === 'LIMIT_MAKER'
        ? 'LIMIT_MAKER'
        : body.type === 'LIMIT'
          ? 'LIMIT'
          : body.type === 'OCO'
            ? 'OCO'
            : 'MARKET';
    const tif = body.timeInForce === 'IOC' ? 'IOC' : body.timeInForce === 'FOK' ? 'FOK' : 'GTC';

    const requestedQty = Number(body.quantity ?? 0);
    const requestedPrice = Number(body.price ?? 0);
    const requestedNotional = Number(body.quoteOrderQty ?? 0);
    const desiredLeverage = Math.min(20, Math.max(1, Math.round(Number(body.leverage ?? vault.leverage))));

    if (venue === 'Spot' && side === 'SELL' && orderType === 'OCO') {
      res.status(400).json({
        error: 'Spot OCO short-entry is unsupported on Binance Spot. Use USD-M Futures for Short brackets.',
      });
      return;
    }

    const baseEntryType = orderType === 'OCO' ? 'MARKET' : orderType;
    const orderParams: Record<string, string | number> = {
      symbol,
      side,
      type:
        venue === 'Futures' && baseEntryType === 'LIMIT_MAKER'
          ? 'LIMIT'
          : baseEntryType,
      // USD-M Futures /fapi/v1/order only supports ACK | RESULT (FULL is Spot-only)
      newOrderRespType: venue === 'Futures' ? 'RESULT' : 'FULL',
    };

    let refPrice = baseEntryType === 'MARKET' ? 0 : requestedPrice > 0 ? requestedPrice : 0;
    if (refPrice <= 0) {
      refPrice = await fetchPublicPrice(symbol, venue);
    }
    const filters = await getSymbolFilters(symbol, refPrice > 0 ? refPrice : 100, venue);

    if (baseEntryType === 'MARKET') {
      const mStep = filters.marketStepSize || filters.stepSize;
      const mDec = filters.marketStepDecimals;
      const mMin = filters.marketMinQty || filters.minQty;
      const mMax = filters.marketMaxQty || filters.maxQty;

      if (Number.isFinite(requestedQty) && requestedQty > 0) {
        const formattedQty = floorToStep(requestedQty, mStep, mDec);
        const qtyNum = Number(formattedQty);
        if (qtyNum <= 0 || (mMin > 0 && qtyNum < mMin)) {
          res.status(400).json({
            error: `MARKET quantity ${formattedQty} is below Binance minQty (${mMin}) for ${symbol}.`,
          });
          return;
        }
        if (mMax > 0 && qtyNum > mMax) {
          res.status(400).json({ error: `MARKET quantity ${formattedQty} exceeds maxQty (${mMax}).` });
          return;
        }
        if (!body.reduceOnly) {
          if (refPrice <= 0) {
            res.status(400).json({ error: `Unable to determine live reference price for ${symbol} notional safety check.` });
            return;
          }
          const estNotional = qtyNum * refPrice;
          if (filters.minNotional > 0 && estNotional < filters.minNotional) {
            res.status(400).json({
              error: `Order notional ~$${estNotional.toFixed(2)} is below Binance MIN_NOTIONAL ($${filters.minNotional}).`,
            });
            return;
          }
          if (filters.maxNotional > 0 && estNotional > filters.maxNotional) {
            res.status(400).json({
              error: `Order notional ~$${estNotional.toFixed(2)} exceeds Binance maxNotional ($${filters.maxNotional}).`,
            });
            return;
          }
          if (estNotional > maxOrderNotionalCap) {
            res.status(400).json({
              error: `Order notional ~$${estNotional.toFixed(2)} exceeds server safety cap ($${maxOrderNotionalCap.toFixed(2)}).`,
            });
            return;
          }
        }
        orderParams.quantity = formattedQty;
      } else {
        if (!Number.isFinite(requestedNotional) || requestedNotional <= 0) {
          res.status(400).json({ error: 'quoteOrderQty or quantity must be greater than 0.' });
          return;
        }
        if (!body.reduceOnly && filters.minNotional > 0 && requestedNotional < filters.minNotional) {
          res.status(400).json({
            error: `Order notional $${requestedNotional.toFixed(2)} is below Binance MIN_NOTIONAL ($${filters.minNotional}).`,
          });
          return;
        }
        if (!body.reduceOnly && filters.maxNotional > 0 && requestedNotional > filters.maxNotional) {
          res.status(400).json({
            error: `Order notional $${requestedNotional.toFixed(2)} exceeds Binance maxNotional ($${filters.maxNotional}).`,
          });
          return;
        }
        if (!body.reduceOnly && requestedNotional > maxOrderNotionalCap) {
          res.status(400).json({
            error: `Order notional $${requestedNotional.toFixed(2)} exceeds server safety cap ($${maxOrderNotionalCap.toFixed(2)}).`,
          });
          return;
        }
        if (venue === 'Futures') {
          if (refPrice <= 0) {
            res.status(400).json({ error: 'Futures MARKET order requires reference price or explicit quantity.' });
            return;
          }
          const formattedQty = floorToStep(requestedNotional / refPrice, mStep, mDec);
          const qtyNum = Number(formattedQty);
          if (qtyNum <= 0 || (mMin > 0 && qtyNum < mMin)) {
            res.status(400).json({
              error: `Computed Futures quantity ${formattedQty} is below Binance minQty (${mMin}).`,
            });
            return;
          }
          if (mMax > 0 && qtyNum > mMax) {
            res.status(400).json({ error: `Computed Futures quantity ${formattedQty} exceeds maxQty (${mMax}).` });
            return;
          }
          orderParams.quantity = formattedQty;
        } else {
          orderParams.quoteOrderQty = requestedNotional.toFixed(filters.quoteDecimals);
        }
      }
    } else {
      if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
        res.status(400).json({ error: `${orderType} order requires a valid positive price.` });
        return;
      }
      const effectiveNotional =
        Number.isFinite(requestedQty) && requestedQty > 0
          ? requestedQty * requestedPrice
          : requestedNotional;
      if (!Number.isFinite(effectiveNotional) || effectiveNotional <= 0) {
        res.status(400).json({ error: `${orderType} order requires positive notional or quantity.` });
        return;
      }
      if (!body.reduceOnly && effectiveNotional > maxOrderNotionalCap) {
        res.status(400).json({
          error: `Order notional $${effectiveNotional.toFixed(2)} exceeds server safety cap ($${maxOrderNotionalCap.toFixed(2)}).`,
        });
        return;
      }
      const formattedPrice = floorToStep(requestedPrice, filters.tickSize, filters.tickDecimals);
      const priceNum = Number(formattedPrice);
      const rawQty =
        Number.isFinite(requestedQty) && requestedQty > 0
          ? requestedQty
          : effectiveNotional / Math.max(priceNum, 1e-9);
      const formattedQty = floorToStep(rawQty, filters.stepSize, filters.stepDecimals);
      const qtyNum = Number(formattedQty);
      if (priceNum <= 0 || qtyNum <= 0) {
        res.status(400).json({
          error: `Formatted ${orderType} price/quantity invalid under Binance filters.`,
        });
        return;
      }
      if (filters.minPrice > 0 && priceNum < filters.minPrice) {
        res.status(400).json({ error: `Price ${formattedPrice} below Binance minPrice (${filters.minPrice}).` });
        return;
      }
      if (filters.maxPrice > 0 && priceNum > filters.maxPrice) {
        res.status(400).json({ error: `Price ${formattedPrice} exceeds Binance maxPrice (${filters.maxPrice}).` });
        return;
      }
      if (filters.minQty > 0 && qtyNum < filters.minQty) {
        res.status(400).json({ error: `Quantity ${formattedQty} below Binance minQty (${filters.minQty}).` });
        return;
      }
      if (filters.maxQty > 0 && qtyNum > filters.maxQty) {
        res.status(400).json({ error: `Quantity ${formattedQty} exceeds Binance maxQty (${filters.maxQty}).` });
        return;
      }
      if (!body.reduceOnly && filters.minNotional > 0 && priceNum * qtyNum < filters.minNotional) {
        res.status(400).json({
          error: `Limit notional $${(priceNum * qtyNum).toFixed(2)} below Binance MIN_NOTIONAL ($${filters.minNotional}).`,
        });
        return;
      }
      if (!body.reduceOnly && filters.maxNotional > 0 && priceNum * qtyNum > filters.maxNotional) {
        res.status(400).json({
          error: `Limit notional $${(priceNum * qtyNum).toFixed(2)} exceeds Binance maxNotional ($${filters.maxNotional}).`,
        });
        return;
      }
      orderParams.price = formattedPrice;
      orderParams.quantity = formattedQty;
      if (venue === 'Futures') {
        orderParams.timeInForce = baseEntryType === 'LIMIT_MAKER' ? 'GTX' : tif;
      } else if (baseEntryType === 'LIMIT') {
        orderParams.timeInForce = tif;
      }
    }

    const orderEndpoint = venue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
    const testEndpoint = venue === 'Futures' ? '/fapi/v1/order/test' : '/api/v3/order/test';

    try {
      let futuresPositionSide: 'BOTH' | 'LONG' | 'SHORT' = 'BOTH';
      if (venue === 'Futures') {
        const dualSide = await getFuturesDualSideMode();
        if (dualSide) {
          futuresPositionSide =
            body.positionSide === 'LONG' || body.positionSide === 'SHORT'
              ? body.positionSide
              : side === 'BUY'
                ? body.reduceOnly
                  ? 'SHORT'
                  : 'LONG'
                : body.reduceOnly
                  ? 'LONG'
                  : 'SHORT';
          orderParams.positionSide = futuresPositionSide;
        } else {
          orderParams.positionSide = 'BOTH';
          if (body.reduceOnly) {
            orderParams.reduceOnly = 'true';
          }
        }

        if (!preflightOnly && !body.reduceOnly) {
          const marginRes = await signedBinanceRequest(
            'POST',
            '/fapi/v1/marginType',
            { symbol, marginType: desiredMarginType },
            'Futures',
            authSnap
          );
          const marginCode = Number(marginRes.data.code);
          if (!marginRes.ok && marginCode !== -4046 && marginCode !== -4048) {
            res.status(400).json({
              error: `Futures marginType error (${marginRes.data.code ?? marginRes.status}): ${String(marginRes.data.msg ?? 'Rejected')}`,
            });
            return;
          }

          const levRes = await signedBinanceRequest(
            'POST',
            '/fapi/v1/leverage',
            { symbol, leverage: desiredLeverage },
            'Futures',
            authSnap
          );
          if (!levRes.ok) {
            res.status(400).json({
              error: `Futures leverage error (${levRes.data.code ?? levRes.status}): ${String(levRes.data.msg ?? 'Rejected')}`,
            });
            return;
          }
        }
      }

      if (preflightOnly || requirePreflight) {
        const testRes = await signedBinanceRequest('POST', testEndpoint, orderParams, venue, authSnap);
        if (!testRes.ok) {
          const msg =
            typeof testRes.data.msg === 'string'
              ? `Binance Preflight ${testRes.data.code ?? testRes.status}: ${testRes.data.msg}`
              : `Preflight failed with HTTP ${testRes.status}`;
          upsertOrderLogs([
            {
              id: `live-preflight-err-${symbol}-${Date.now()}`,
              orderId: `pre-${Date.now()}`,
              clientOrderId: `preflight_${symbol.toLowerCase()}`,
              symbol,
              venue,
              environment: authSnap.environment,
              accountMode: 'Live',
              source: 'live_proxy',
              lifecycle: 'PREFLIGHT',
              side: side === 'BUY' ? 'Long' : 'Short',
              binanceSide: side,
              orderType,
              timeInForce: tif,
              status: 'REJECTED',
              price: refPrice,
              executedQty: 0,
              origQty: requestedQty,
              quoteQty: requestedNotional,
              commission: 0,
              commissionAsset: 'USDT',
              isMaker: false,
              realizedPnlUsdt: null,
              rMultiple: null,
              exitReason: null,
              latencyMs: testRes.latencyMs,
              endpoint: `POST ${testEndpoint}`,
              rationale: 'Signed preflight order check',
              errorMessage: msg,
              timestampMs: Date.now(),
            },
          ]);
          res.status(400).json({ error: msg });
          return;
        }
        if (preflightOnly) {
          upsertOrderLogs([
            {
              id: `live-preflight-ok-${symbol}-${Date.now()}`,
              orderId: `pre-${Date.now()}`,
              clientOrderId: `preflight_${symbol.toLowerCase()}`,
              symbol,
              venue,
              environment: authSnap.environment,
              accountMode: 'Live',
              source: 'live_proxy',
              lifecycle: 'PREFLIGHT',
              side: side === 'BUY' ? 'Long' : 'Short',
              binanceSide: side,
              orderType,
              timeInForce: tif,
              status: 'NEW',
              price: refPrice,
              executedQty: 0,
              origQty: requestedQty > 0 ? requestedQty : refPrice > 0 ? requestedNotional / refPrice : 0,
              quoteQty: requestedNotional,
              commission: 0,
              commissionAsset: 'USDT',
              isMaker: false,
              realizedPnlUsdt: null,
              rMultiple: null,
              exitReason: null,
              latencyMs: testRes.latencyMs,
              endpoint: `POST ${testEndpoint}`,
              rationale: `Signed preflight validation (${venue}) passed (simulated — not executed)`,
              timestampMs: Date.now(),
            },
          ]);
          res.json({
            ok: true,
            preflight: true,
            environment: authSnap.environment,
            venue,
            latencyMs: testRes.latencyMs,
            usedWeight1m: testRes.usedWeight1m,
            message: `Signed ${testEndpoint} passed for ${symbol} ${side} ${orderType} (${venue})`,
          });
          return;
        }
      }

      if (!vault.armedForLiveOrders) {
        res.status(403).json({
          error: 'Live execution was disarmed before submitting the order to Binance.',
        });
        return;
      }

      const liveRes = await signedBinanceRequest('POST', orderEndpoint, orderParams, venue, authSnap);
      if (!liveRes.ok) {
        const msg =
          typeof liveRes.data.msg === 'string'
            ? `Binance Order ${liveRes.data.code ?? liveRes.status}: ${liveRes.data.msg}`
            : `Order failed with HTTP ${liveRes.status}`;
        upsertOrderLogs([
          {
            id: `live-rej-${symbol}-${Date.now()}`,
            orderId: `rej-${Date.now()}`,
            clientOrderId: `live_${symbol.toLowerCase()}`,
            symbol,
            venue,
            environment: vault.environment,
            accountMode: 'Live',
            source: 'live_proxy',
            lifecycle: body.reduceOnly ? 'EXIT' : 'ENTRY',
            side: side === 'BUY' ? 'Long' : 'Short',
            binanceSide: side,
            orderType,
            timeInForce: tif,
            status: 'REJECTED',
            price: refPrice,
            executedQty: 0,
            origQty: requestedQty,
            quoteQty: requestedNotional,
            commission: 0,
            commissionAsset: 'USDT',
            isMaker: false,
            realizedPnlUsdt: null,
            rMultiple: null,
            exitReason: null,
            latencyMs: liveRes.latencyMs,
            endpoint: `POST ${orderEndpoint}`,
            rationale: `${venue} Live order attempt`,
            errorMessage: msg,
            timestampMs: Date.now(),
          },
        ]);
        res.status(400).json({ error: msg });
        return;
      }

      const baseAsset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
      const fillMetrics = parseFillMetrics(liveRes.data, refPrice, venue === 'Spot' ? baseAsset : '');
      const executedQty = fillMetrics.executedQty;
      const avgPrice = fillMetrics.avgPrice;

      // Attach Spot /api/v3/orderList/oco or Futures /fapi/v1/algoOrder conditional TP/SL brackets
      let ocoAttached = false;
      let ocoWarning: string | undefined;
      let ocoNote: string | undefined;
      let ocoOrderListId: number | undefined;
      let algoOrderIds: string[] | undefined;

      if (
        orderType === 'OCO' &&
        Number(body.takeProfitPrice) > 0 &&
        Number(body.stopLossPrice) > 0 &&
        executedQty > 0
      ) {
        const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
        const tpFmt = floorToStep(Number(body.takeProfitPrice), filters.tickSize, filters.tickDecimals);
        const slFmt = floorToStep(Number(body.stopLossPrice), filters.tickSize, filters.tickDecimals);
        const netSpotQty = Math.max(0, executedQty - fillMetrics.baseCommission);
        const exitQtyFmt = floorToStep(
          venue === 'Spot' ? netSpotQty : executedQty,
          filters.stepSize,
          filters.stepDecimals
        );
        const workingType = body.workingType === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE';

        if (venue === 'Spot' && Number(exitQtyFmt) > 0) {
          const ocoParams: Record<string, string | number> = {
            symbol,
            side: 'SELL',
            quantity: exitQtyFmt,
            aboveType: 'LIMIT_MAKER',
            abovePrice: tpFmt,
            belowType: 'STOP_LOSS_LIMIT',
            belowStopPrice: slFmt,
            belowPrice: floorToStep(
              Number(body.stopLossPrice) * 0.998,
              filters.tickSize,
              filters.tickDecimals
            ),
            belowTimeInForce: 'GTC',
            newOrderRespType: 'FULL',
          };
          const ocoRes = await signedBinanceRequest('POST', '/api/v3/orderList/oco', ocoParams, 'Spot', authSnap);
          ocoAttached = ocoRes.ok;
          if (ocoRes.ok) {
            if (ocoRes.data.orderListId != null) {
              ocoOrderListId = Number(ocoRes.data.orderListId);
            }
            ocoNote = `Attached Spot /api/v3/orderList/oco (#${ocoOrderListId ?? 'ok'} · SELL) TP @ ${tpFmt} / SL @ ${slFmt}`;
          } else {
            ocoWarning = `Spot OCO leg failed (${ocoRes.data.code ?? ocoRes.status}): ${String(ocoRes.data.msg ?? 'Position has no exchange OCO bracket')}`;
            ocoNote = ocoWarning;
          }
        } else if (venue === 'Futures') {
          const [tpRes, slRes] = await Promise.all([
            signedBinanceRequest(
              'POST',
              '/fapi/v1/algoOrder',
              {
                algoType: 'CONDITIONAL',
                symbol,
                side: exitSide,
                positionSide: futuresPositionSide,
                type: 'TAKE_PROFIT_MARKET',
                triggerPrice: tpFmt,
                closePosition: 'true',
                workingType,
                priceProtect: 'true',
              },
              'Futures',
              authSnap
            ),
            signedBinanceRequest(
              'POST',
              '/fapi/v1/algoOrder',
              {
                algoType: 'CONDITIONAL',
                symbol,
                side: exitSide,
                positionSide: futuresPositionSide,
                type: 'STOP_MARKET',
                triggerPrice: slFmt,
                closePosition: 'true',
                workingType,
                priceProtect: 'true',
              },
              'Futures',
              authSnap
            ),
          ]);
          ocoAttached = tpRes.ok && slRes.ok;
          const ids: string[] = [];
          if (tpRes.ok && tpRes.data.algoId != null) ids.push(String(tpRes.data.algoId));
          if (slRes.ok && slRes.data.algoId != null) ids.push(String(slRes.data.algoId));

          if (ocoAttached) {
            if (ids.length > 0) algoOrderIds = ids;
            ocoNote = `Attached Futures /fapi/v1/algoOrder TP @ ${tpFmt} + SL @ ${slFmt} (${workingType})`;
          } else {
            // Roll back any half-attached algo leg so no stray unpaired closePosition trigger lingers
            for (const id of ids) {
              await signedBinanceRequest('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: id }, 'Futures', authSnap).catch(() => {});
            }
            const tpErr = tpRes.ok ? 'OK' : `${tpRes.data.code ?? tpRes.status}: ${String(tpRes.data.msg ?? 'Err')}`;
            const slErr = slRes.ok ? 'OK' : `${slRes.data.code ?? slRes.status}: ${String(slRes.data.msg ?? 'Err')}`;
            ocoWarning = `Futures conditional bracket warning — TP(${tpErr}) / SL(${slErr})`;
            ocoNote = ocoWarning;
          }
        }
      }

      const resolvedOrderId =
        liveRes.data.orderId != null ? String(liveRes.data.orderId) : `live-${Date.now()}`;
      const resolvedStatusRaw =
        typeof liveRes.data.status === 'string' ? liveRes.data.status.toUpperCase() : 'FILLED';
      const resolvedStatus: BackendOrderExecutionLog['status'] =
        resolvedStatusRaw === 'NEW' ||
        resolvedStatusRaw === 'PARTIALLY_FILLED' ||
        resolvedStatusRaw === 'CANCELED' ||
        resolvedStatusRaw === 'REJECTED' ||
        resolvedStatusRaw === 'EXPIRED'
          ? resolvedStatusRaw
          : 'FILLED';

      upsertOrderLogs([
        {
          id: `live-order-${symbol}-${resolvedOrderId}`,
          orderId: resolvedOrderId,
          clientOrderId:
            typeof liveRes.data.clientOrderId === 'string'
              ? liveRes.data.clientOrderId
              : `binance_${venue.toLowerCase()}_${resolvedOrderId}`,
          orderListId: ocoOrderListId,
          algoOrderIds,
          symbol,
          venue,
          environment: vault.environment,
          accountMode: 'Live',
          source: 'live_proxy',
          lifecycle: body.reduceOnly || (venue === 'Spot' && side === 'SELL') ? 'EXIT' : 'ENTRY',
          side: side === 'BUY' ? 'Long' : 'Short',
          binanceSide: side,
          orderType,
          timeInForce:
            typeof liveRes.data.timeInForce === 'string'
              ? liveRes.data.timeInForce
              : venue === 'Futures' && orderType === 'LIMIT_MAKER'
                ? 'GTX'
                : tif,
          status: resolvedStatus,
          price: avgPrice > 0 ? avgPrice : refPrice,
          executedQty,
          origQty:
            liveRes.data.origQty != null && Number(liveRes.data.origQty) > 0
              ? Number(liveRes.data.origQty)
              : executedQty > 0
                ? executedQty
                : requestedQty,
          quoteQty:
            executedQty > 0 && (avgPrice > 0 || refPrice > 0)
              ? executedQty * (avgPrice > 0 ? avgPrice : refPrice)
              : requestedNotional,
          commission: fillMetrics.commission,
          commissionAsset: fillMetrics.commissionAsset,
          isMaker: orderType === 'LIMIT_MAKER' || (orderType === 'LIMIT' && resolvedStatus === 'NEW'),
          realizedPnlUsdt: null,
          rMultiple: null,
          exitReason: null,
          latencyMs: liveRes.latencyMs,
          endpoint: `POST ${orderEndpoint}`,
          rationale: ocoNote ?? `Live ${venue} ${orderType} ${side}`,
          errorMessage: ocoWarning,
          timestampMs: Date.now(),
        },
      ]);

      res.json({
        ok: true,
        preflight: false,
        environment: vault.environment,
        venue,
        latencyMs: liveRes.latencyMs,
        orderId: liveRes.data.orderId != null ? String(liveRes.data.orderId) : undefined,
        orderStatus: typeof liveRes.data.status === 'string' ? liveRes.data.status : 'FILLED',
        executedQty,
        avgPrice,
        commission: fillMetrics.commission,
        commissionAsset: fillMetrics.commissionAsset,
        ocoAttached,
        ocoOrderListId,
        algoOrderIds,
        ocoWarning,
        ocoNote,
        order: liveRes.data,
      });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? `Binance request failed: ${err.message}`
            : 'Failed to reach Binance REST API',
      });
    }
  }));

  app.get('/api/live/open-orders', asyncRoute(async (req, res) => {
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ ok: false, error: 'Live API credentials are not configured.', orders: [] });
      return;
    }
    const venue: ExchangeVenue = req.query.venue === 'Futures' ? 'Futures' : req.query.venue === 'Spot' ? 'Spot' : vault.venue;
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? sanitizeSymbol(req.query.symbol) : undefined;
    try {
      const endpoint = venue === 'Futures' ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
      const params: Record<string, string | number> = symbol ? { symbol } : {};
      const ordersRes = await signedBinanceRequest('GET', endpoint, params, venue);
      if (!ordersRes.ok) {
        res.status(400).json({
          ok: false,
          error: `Binance ${ordersRes.data.code ?? ordersRes.status}: ${String(ordersRes.data.msg ?? 'Query failed')}`,
          orders: [],
        });
        return;
      }
      const orders = Array.isArray(ordersRes.data) ? ordersRes.data : [];
      let algoOrders: unknown[] = [];
      if (venue === 'Futures') {
        const algoRes = await signedBinanceRequest('GET', '/fapi/v1/algoOpenOrders', params, 'Futures');
        if (algoRes.ok && Array.isArray(algoRes.data)) {
          algoOrders = algoRes.data;
        }
      }
      res.json({ ok: true, venue, environment: vault.environment, orders, algoOrders });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to query open orders',
        orders: [],
      });
    }
  }));

  app.get('/api/live/order-status', asyncRoute(async (req, res) => {
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ ok: false, error: 'Live API credentials are not configured.' });
      return;
    }
    const venue: ExchangeVenue = req.query.venue === 'Futures' ? 'Futures' : req.query.venue === 'Spot' ? 'Spot' : vault.venue;
    const symbol = sanitizeSymbol(req.query.symbol);
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
    if (!symbol || !orderId) {
      res.status(400).json({ ok: false, error: 'symbol and orderId are required.' });
      return;
    }
    try {
      const endpoint = venue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
      const queryRes = await signedBinanceRequest('GET', endpoint, { symbol, orderId }, venue);
      if (!queryRes.ok) {
        res.status(400).json({
          ok: false,
          error: `Binance ${queryRes.data.code ?? queryRes.status}: ${String(queryRes.data.msg ?? 'Order query failed')}`,
        });
        return;
      }
      const executedQty = Number(queryRes.data.executedQty ?? 0) || 0;
      const cumQuote = Number(queryRes.data.cummulativeQuoteQty ?? queryRes.data.cumQuote ?? 0) || 0;
      const rawPrice = Number(queryRes.data.avgPrice ?? queryRes.data.price ?? 0) || 0;
      const avgPrice = executedQty > 0 && cumQuote > 0 ? cumQuote / executedQty : rawPrice;
      res.json({
        ok: true,
        venue,
        symbol,
        orderId: String(queryRes.data.orderId ?? orderId),
        status: String(queryRes.data.status ?? 'UNKNOWN').toUpperCase(),
        executedQty,
        avgPrice,
        order: queryRes.data,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to query order status',
      });
    }
  }));

  app.post('/api/live/cancel-open-brackets', asyncRoute(async (req, res) => {
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ ok: false, error: 'Live API credentials are not configured.' });
      return;
    }
    if (!vault.armedForLiveOrders) {
      res.status(403).json({ ok: false, error: 'Live execution is disarmed.' });
      return;
    }
    const body = (req.body ?? {}) as {
      symbol?: string;
      venue?: ExchangeVenue;
      orderListId?: number | string;
      algoOrderIds?: string[];
    };
    const symbol = sanitizeSymbol(body.symbol);
    const venue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : body.venue === 'Spot' ? 'Spot' : vault.venue;
    if (!symbol) {
      res.status(400).json({ ok: false, error: 'symbol is required' });
      return;
    }

    try {
      let cancelled = 0;
      const errors: string[] = [];
      if (venue === 'Spot') {
        if (body.orderListId != null && Number(body.orderListId) > 0) {
          const r = await signedBinanceRequest(
            'DELETE',
            '/api/v3/orderList',
            { symbol, orderListId: String(body.orderListId) },
            'Spot'
          );
          if (r.ok) cancelled += 1;
          else errors.push(`OCO #${body.orderListId}: ${String(r.data.msg ?? r.status)}`);
        } else {
          const listRes = await signedBinanceRequest('GET', '/api/v3/openOrderList', {}, 'Spot');
          if (!listRes.ok) {
            errors.push(`openOrderList: ${String(listRes.data.msg ?? listRes.status)}`);
          } else if (Array.isArray(listRes.data)) {
            for (const entry of listRes.data as Array<{ symbol?: string; orderListId?: number }>) {
              if (entry.symbol === symbol && entry.orderListId != null) {
                const delRes = await signedBinanceRequest(
                  'DELETE',
                  '/api/v3/orderList',
                  { symbol, orderListId: String(entry.orderListId) },
                  'Spot'
                );
                if (delRes.ok) cancelled += 1;
                else errors.push(`OCO #${entry.orderListId}: ${String(delRes.data.msg ?? delRes.status)}`);
              }
            }
          }
        }
      } else {
        if (Array.isArray(body.algoOrderIds) && body.algoOrderIds.length > 0) {
          for (const algoId of body.algoOrderIds) {
            const delRes = await signedBinanceRequest(
              'DELETE',
              '/fapi/v1/algoOrder',
              { symbol, algoId: String(algoId) },
              'Futures'
            );
            if (delRes.ok) cancelled += 1;
            else errors.push(`algo #${algoId}: ${String(delRes.data.msg ?? delRes.status)}`);
          }
        } else {
          const openAlgoRes = await signedBinanceRequest('GET', '/fapi/v1/algoOpenOrders', { symbol }, 'Futures');
          const openCount = openAlgoRes.ok && Array.isArray(openAlgoRes.data) ? openAlgoRes.data.length : 1;
          const delAll = await signedBinanceRequest(
            'DELETE',
            '/fapi/v1/algoOpenOrders',
            { symbol },
            'Futures'
          );
          if (delAll.ok) cancelled += Math.max(0, openCount);
          else errors.push(`algoOpenOrders: ${String(delAll.data.msg ?? delAll.status)}`);
        }
      }
      if (cancelled === 0 && errors.length > 0) {
        res.status(400).json({ ok: false, cancelled: 0, error: errors.join('; ') });
        return;
      }
      res.json({ ok: true, cancelled, warnings: errors.length > 0 ? errors : undefined });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to cancel open brackets',
      });
    }
  }));

  app.delete('/api/live/order', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as {
      symbol?: string;
      orderId?: string;
      orderListId?: string;
      algoId?: string;
      side?: 'BUY' | 'SELL' | 'Long' | 'Short';
      orderType?: 'ORDER' | 'OCO' | 'ALGO';
      venue?: ExchangeVenue;
    };
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ error: 'Live API credentials are not configured.' });
      return;
    }
    if (!vault.armedForLiveOrders) {
      res.status(403).json({ error: 'Live execution is disarmed.' });
      return;
    }
    const symbol = sanitizeSymbol(body.symbol);
    const orderId = String(body.orderId ?? '').trim();
    const orderListId = String(body.orderListId ?? '').trim();
    const algoId = String(body.algoId ?? '').trim();
    const venue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : body.venue === 'Spot' ? 'Spot' : vault.venue;

    if (!symbol || (!orderId && !orderListId && !algoId)) {
      res.status(400).json({ error: 'symbol and orderId/orderListId/algoId are required to cancel a live order.' });
      return;
    }

    try {
      let cancelPath = venue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
      let cancelParams: Record<string, string | number> = { symbol, orderId };

      if ((body.orderType === 'OCO' || orderListId) && venue === 'Spot') {
        cancelPath = '/api/v3/orderList';
        cancelParams = { symbol, orderListId: orderListId || orderId };
      } else if ((body.orderType === 'ALGO' || algoId) && venue === 'Futures') {
        cancelPath = '/fapi/v1/algoOrder';
        cancelParams = { symbol, algoId: algoId || orderId };
      }

      const cancelRes = await signedBinanceRequest('DELETE', cancelPath, cancelParams, venue);
      if (!cancelRes.ok) {
        const msg =
          typeof cancelRes.data.msg === 'string'
            ? `Binance Cancel ${cancelRes.data.code ?? cancelRes.status}: ${cancelRes.data.msg}`
            : `Cancel failed with HTTP ${cancelRes.status}`;
        res.status(400).json({ error: msg });
        return;
      }
      const fallbackSide: 'BUY' | 'SELL' =
        body.side === 'SELL' || body.side === 'Short'
          ? 'SELL'
          : venue === 'Spot' && (body.orderType === 'OCO' || orderListId)
            ? 'SELL'
            : 'BUY';
      const canceledBinanceSide: 'BUY' | 'SELL' =
        cancelRes.data.side !== undefined
          ? String(cancelRes.data.side).toUpperCase() === 'SELL'
            ? 'SELL'
            : 'BUY'
          : fallbackSide;
      upsertOrderLogs([
        {
          id: `live-cancel-${symbol}-${orderId || orderListId || algoId}-${Date.now()}`,
          orderId: orderId || orderListId || algoId,
          clientOrderId: `cancel_${symbol.toLowerCase()}`,
          symbol,
          venue,
          environment: vault.environment,
          accountMode: 'Live',
          source: 'live_proxy',
          lifecycle: 'CANCEL',
          side:
            venue === 'Spot' && canceledBinanceSide === 'SELL'
              ? 'Long'
              : canceledBinanceSide === 'BUY'
                ? 'Long'
                : 'Short',
          binanceSide: canceledBinanceSide,
          orderType: body.orderType ?? 'ORDER',
          timeInForce: 'GTC',
          status: 'CANCELED',
          price: Number(cancelRes.data.price ?? 0) || 0,
          executedQty: Number(cancelRes.data.executedQty ?? 0) || 0,
          origQty: Number(cancelRes.data.origQty ?? 0) || 0,
          quoteQty: 0,
          commission: 0,
          commissionAsset: 'USDT',
          isMaker: false,
          realizedPnlUsdt: null,
          rMultiple: null,
          exitReason: 'Canceled',
          latencyMs: cancelRes.latencyMs,
          endpoint: `DELETE ${cancelPath}`,
          rationale: `Canceled resting ${venue} order`,
          timestampMs: Date.now(),
        },
      ]);
      res.json({ ok: true, latencyMs: cancelRes.latencyMs, data: cancelRes.data });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach Binance cancel endpoint',
      });
    }
  }));

  app.get('/api/live/trades', asyncRoute(async (req, res) => {
    const symbolParam = sanitizeSymbol(req.query.symbol, 'BTCUSDT');
    const venueParam = req.query.venue === 'Futures' ? 'Futures' : req.query.venue === 'Spot' ? 'Spot' : vault.venue;
    const limitParam = typeof req.query.limit === 'string' ? Math.min(50, Math.max(1, Number(req.query.limit) || 25)) : 25;

    if (!vault.apiKey || !vault.apiSecret) {
      res.json({
        ok: false,
        configured: false,
        venue: venueParam,
        environment: vault.environment,
        error:
          'Live API credentials are not configured in the server vault. Configure Spot/Futures keys in Live Credentials to sync real account myTrades / userTrades.',
        trades: [],
      });
      return;
    }

    try {
      const tradePath = venueParam === 'Futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
      const tradeRes = await signedBinanceRequest(
        'GET',
        tradePath,
        { symbol: symbolParam, limit: String(limitParam) },
        venueParam
      );

      if (!tradeRes.ok) {
        const msg =
          typeof tradeRes.data.msg === 'string'
            ? `Binance ${tradeRes.data.code ?? tradeRes.status}: ${tradeRes.data.msg}`
            : `Binance ${tradePath} returned HTTP ${tradeRes.status}`;
        res.json({
          ok: false,
          configured: true,
          venue: venueParam,
          environment: vault.environment,
          latencyMs: tradeRes.latencyMs,
          error: msg,
          trades: [],
        });
        return;
      }

      const rawList = Array.isArray(tradeRes.data) ? tradeRes.data : [];
      const trades = rawList.map((raw: Record<string, unknown>, idx: number) => {
        const tradeId = Number(raw.id ?? Date.now() + idx);
        const orderId = Number(raw.orderId ?? tradeId);
        const orderListId = typeof raw.orderListId === 'number' ? raw.orderListId : -1;
        const price = Number(raw.price ?? 0);
        const qty = Number(raw.qty ?? 0);
        const quoteQty = Number(raw.quoteQty ?? price * qty);
        const commission = Number(raw.commission ?? 0);
        const commissionAsset = typeof raw.commissionAsset === 'string' ? raw.commissionAsset : 'USDT';
        const time = Number(raw.time ?? Date.now());
        const isMaker = Boolean(raw.isMaker ?? raw.maker ?? false);
        const isBuyer =
          typeof raw.isBuyer === 'boolean'
            ? raw.isBuyer
            : typeof raw.buyer === 'boolean'
              ? raw.buyer
              : String(raw.side ?? 'BUY').toUpperCase() === 'BUY';
        const binanceSide: 'BUY' | 'SELL' = isBuyer ? 'BUY' : 'SELL';

        let isExitFill = false;
        let side: 'Long' | 'Short' = 'Long';
        let realizedPnlOut: number | null = null;

        if (venueParam === 'Spot') {
          // Spot has no margin shorting or exchange-computed realizedPnl: BUY = Entry Long, SELL = Exit Long
          isExitFill = binanceSide === 'SELL';
          side = 'Long';
          realizedPnlOut = null;
        } else {
          const realizedPnl = raw.realizedPnl !== undefined ? Number(raw.realizedPnl) : 0;
          const posSide = typeof raw.positionSide === 'string' ? raw.positionSide.toUpperCase() : 'BOTH';
          const hedgeExit =
            (posSide === 'LONG' && binanceSide === 'SELL') ||
            (posSide === 'SHORT' && binanceSide === 'BUY');
          isExitFill = Math.abs(realizedPnl) > 1e-8 || Boolean(raw.reduceOnly) || hedgeExit;
          side = isExitFill
            ? binanceSide === 'SELL'
              ? 'Long'
              : 'Short'
            : binanceSide === 'BUY'
              ? 'Long'
              : 'Short';
          realizedPnlOut = isExitFill ? realizedPnl : null;
        }

        return {
          id: `live-sync-${symbolParam}-${tradeId}`,
          tradeId,
          orderId,
          orderListId,
          clientOrderId: `binance_${venueParam.toLowerCase()}_${orderId}`,
          symbol: String(raw.symbol ?? symbolParam),
          venue: venueParam,
          environment: vault.environment,
          accountMode: 'Live' as const,
          lifecycle: isExitFill ? ('EXIT' as const) : ('ENTRY' as const),
          side,
          binanceSide,
          positionSide:
            typeof raw.positionSide === 'string' &&
            (raw.positionSide === 'LONG' || raw.positionSide === 'SHORT' || raw.positionSide === 'BOTH')
              ? raw.positionSide
              : ('BOTH' as const),
          orderType: isMaker ? ('LIMIT' as const) : ('MARKET' as const),
          uiOrderType: isMaker ? ('LIMIT' as const) : ('MARKET' as const),
          execType: 'TRADE' as const,
          orderStatus: 'FILLED' as const,
          timeInForce: 'GTC' as const,
          price,
          entryPrice: price,
          origQty: qty,
          executedQty: qty,
          cummulativeQuoteQty: quoteQty,
          commission,
          commissionAsset,
          isMaker,
          leverage: venueParam === 'Futures' ? vault.leverage : 1,
          marginType: venueParam === 'Futures' ? vault.marginType : ('ISOLATED' as const),
          realizedPnlUsdt: realizedPnlOut,
          rMultiple: null,
          exitReason: isExitFill ? ('ManualClose' as const) : null,
          strategyRationale: `Synced from Binance ${venueParam} ${tradePath} (#${tradeId})`,
          transactTime: time,
        };
      });

      res.json({
        ok: true,
        configured: true,
        venue: venueParam,
        environment: vault.environment,
        endpoint: tradePath,
        latencyMs: tradeRes.latencyMs,
        trades,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        configured: true,
        error: err instanceof Error ? err.message : 'Failed to query Binance user trades',
        trades: [],
      });
    }
  }));

  app.delete('/api/live/config', (_req, res) => {
    vault.apiKey = '';
    vault.apiSecret = '';
    vault.armedForLiveOrders = false;
    vault.verificationStatus = 'unverified';
    vault.verificationMessage = null;
    vault.lastVerifiedAt = null;
    vault.canTrade = false;
    vault.permissions = [];
    vault.latencyMs = null;
    vault.syncedBalances = [];
    res.json({ ok: true, status: getSafeStatus() });
  });

  // ---------- Order Execution History & Binance allOrders Sync APIs ----------

  app.get('/api/orders/history', asyncRoute(async (req, res) => {
    const symbolParam =
      typeof req.query.symbol === 'string' && req.query.symbol && req.query.symbol !== 'ALL'
        ? sanitizeSymbol(req.query.symbol)
        : undefined;
    const venueParam =
      req.query.venue === 'Futures' ? 'Futures' : req.query.venue === 'Spot' ? 'Spot' : undefined;
    const envParam =
      req.query.environment === 'Production'
        ? 'Production'
        : req.query.environment === 'Testnet'
          ? 'Testnet'
          : undefined;
    const statusParam =
      typeof req.query.status === 'string' && req.query.status && req.query.status !== 'ALL'
        ? req.query.status.toUpperCase()
        : undefined;
    const accountModeParam =
      req.query.accountMode === 'Live'
        ? 'Live'
        : req.query.accountMode === 'Paper'
          ? 'Paper'
          : undefined;
    const syncBinance = req.query.syncBinance === '1' || req.query.syncBinance === 'true';
    const limitParam = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200));

    let syncResult:
      | { synced: boolean; count?: number; latencyMs?: number; endpoint?: string; error?: string }
      | undefined;

    if (syncBinance) {
      if (!vault.apiKey || !vault.apiSecret) {
        syncResult = {
          synced: false,
          error:
            'Live API credentials are not configured in the server vault. Add credentials in Bot -> Live Credentials to pull Binance allOrders.',
        };
      } else {
        const targetVenue = venueParam ?? vault.venue;
        const symbolsQuery =
          typeof req.query.symbols === 'string' && req.query.symbols.trim().length > 0
            ? req.query.symbols
                .split(',')
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean)
            : null;
        const targetSymbols = symbolParam
          ? [symbolParam]
          : symbolsQuery && symbolsQuery.length > 0
            ? symbolsQuery
            : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'];
        const endpoint = targetVenue === 'Futures' ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
        try {
          let totalSynced = 0;
          let lastLatencyMs: number | undefined;
          let firstError: string | undefined;

          for (const targetSymbol of targetSymbols) {
            const allOrdersRes = await signedBinanceRequest(
              'GET',
              endpoint,
              { symbol: targetSymbol, limit: '50' },
              targetVenue
            );
            lastLatencyMs = allOrdersRes.latencyMs;
            if (!allOrdersRes.ok) {
              if (!firstError) {
                firstError = `Binance ${allOrdersRes.data.code ?? allOrdersRes.status}: ${String(allOrdersRes.data.msg ?? 'Query failed')}`;
              }
              continue;
            }
            const rawList = Array.isArray(allOrdersRes.data)
              ? (allOrdersRes.data as Array<Record<string, unknown>>)
              : [];
            const mapped: BackendOrderExecutionLog[] = rawList.map((raw, idx) => {
              const ordId = String(raw.orderId ?? Date.now() + idx);
              const sym = String(raw.symbol ?? targetSymbol);
              const binSide: 'BUY' | 'SELL' =
                String(raw.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
              const executedQty = Number(raw.executedQty ?? 0) || 0;
              const origQty = Number(raw.origQty ?? executedQty) || 0;
              const quoteQty = Number(
                raw.cummulativeQuoteQty ?? raw.cumQuote ?? 0
              );
              const rawPrice = Number(raw.avgPrice ?? raw.price ?? 0);
              const effPrice =
                executedQty > 0 && quoteQty > 0
                  ? quoteQty / executedQty
                  : rawPrice > 0
                    ? rawPrice
                    : 0;
              const statusRaw = String(raw.status ?? 'NEW').toUpperCase();
              const normStatus: BackendOrderExecutionLog['status'] =
                statusRaw === 'FILLED' ||
                statusRaw === 'PARTIALLY_FILLED' ||
                statusRaw === 'NEW' ||
                statusRaw === 'CANCELED' ||
                statusRaw === 'REJECTED' ||
                statusRaw === 'EXPIRED'
                  ? statusRaw
                  : 'NEW';
              const ts = Number(raw.updateTime ?? raw.time ?? Date.now());
              const isReduceOnly = Boolean(raw.reduceOnly);
              const posSide = String(raw.positionSide ?? 'BOTH').toUpperCase();
              const isHedgeExit =
                (posSide === 'LONG' && binSide === 'SELL') ||
                (posSide === 'SHORT' && binSide === 'BUY');
              const isSpotExit = targetVenue === 'Spot' && binSide === 'SELL';
              const isExit = isReduceOnly || isSpotExit || isHedgeExit;
              return {
                id: `binance-ord-${targetVenue.toLowerCase()}-${sym}-${ordId}`,
                orderId: ordId,
                clientOrderId: String(raw.clientOrderId ?? `binance_${ordId}`),
                orderListId:
                  typeof raw.orderListId === 'number' && raw.orderListId >= 0
                    ? raw.orderListId
                    : undefined,
                symbol: sym,
                venue: targetVenue,
                environment: vault.environment,
                accountMode: 'Live',
                source: 'binance_all_orders',
                lifecycle:
                  normStatus === 'CANCELED'
                    ? 'CANCEL'
                    : isExit
                      ? 'EXIT'
                      : 'ENTRY',
                side:
                  isExit
                    ? binSide === 'SELL'
                      ? 'Long'
                      : 'Short'
                    : binSide === 'BUY'
                      ? 'Long'
                      : 'Short',
                binanceSide: binSide,
                orderType: String(raw.type ?? 'MARKET'),
                timeInForce: String(raw.timeInForce ?? 'GTC'),
                status: normStatus,
                price: effPrice,
                executedQty,
                origQty,
                quoteQty: quoteQty > 0 ? quoteQty : effPrice * executedQty,
                commission: 0,
                commissionAsset: 'USDT',
                isMaker: String(raw.type ?? '') === 'LIMIT_MAKER' || String(raw.timeInForce ?? '') === 'GTX',
                realizedPnlUsdt: null,
                rMultiple: null,
                exitReason: null,
                latencyMs: allOrdersRes.latencyMs,
                endpoint: `GET ${endpoint}`,
                rationale: `Synced from Binance ${targetVenue} ${endpoint}`,
                timestampMs: ts,
              };
            });
            upsertOrderLogs(mapped);
            totalSynced += mapped.length;
          }

          if (totalSynced === 0 && firstError) {
            syncResult = {
              synced: false,
              latencyMs: lastLatencyMs,
              endpoint,
              error: firstError,
            };
          } else {
            syncResult = {
              synced: true,
              count: totalSynced,
              latencyMs: lastLatencyMs,
              endpoint,
            };
          }
        } catch (err) {
          syncResult = {
            synced: false,
            endpoint,
            error: err instanceof Error ? err.message : 'Failed to query Binance allOrders',
          };
        }
      }
    }

    const filtered = orderExecutionLogs
      .filter((log) => {
        if (symbolParam && log.symbol !== symbolParam) return false;
        if (venueParam && log.venue !== venueParam) return false;
        if (envParam && log.environment !== envParam) return false;
        if (statusParam && log.status !== statusParam) return false;
        if (accountModeParam && log.accountMode !== accountModeParam) return false;
        return true;
      })
      .slice(0, limitParam);

    res.json({
      ok: true,
      total: filtered.length,
      logs: filtered,
      syncResult,
    });
  }));

  app.post('/api/orders/history', (req, res) => {
    const body = req.body as
      | BackendOrderExecutionLog
      | { logs?: BackendOrderExecutionLog[] }
      | undefined;
    const rawItems: unknown[] =
      body && Array.isArray((body as { logs?: unknown[] }).logs)
        ? (body as { logs: unknown[] }).logs
        : body
          ? [body]
          : [];

    const valid: BackendOrderExecutionLog[] = rawItems
      .filter(
        (item): item is BackendOrderExecutionLog =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { id?: unknown }).id === 'string' &&
          typeof (item as { symbol?: unknown }).symbol === 'string' &&
          sanitizeSymbol((item as { symbol?: unknown }).symbol).length > 0
      )
      .map((item) => ({
        ...item,
        symbol: sanitizeSymbol(item.symbol, 'BTCUSDT'),
        venue: item.venue === 'Futures' ? 'Futures' : 'Spot',
        environment: item.environment === 'Production' ? 'Production' : 'Testnet',
        accountMode: item.accountMode === 'Live' ? 'Live' : 'Paper',
        price: Number.isFinite(Number(item.price)) ? Number(item.price) : 0,
        executedQty: Number.isFinite(Number(item.executedQty)) ? Number(item.executedQty) : 0,
        origQty: Number.isFinite(Number(item.origQty)) ? Number(item.origQty) : 0,
        quoteQty: Number.isFinite(Number(item.quoteQty)) ? Number(item.quoteQty) : 0,
        commission: Number.isFinite(Number(item.commission)) ? Number(item.commission) : 0,
        timestampMs:
          typeof item.timestampMs === 'number' && Number.isFinite(item.timestampMs)
            ? item.timestampMs
            : Date.now(),
      }));

    if (valid.length === 0) {
      res.status(400).json({ ok: false, error: 'Valid order execution log payload is required.' });
      return;
    }

    const added = upsertOrderLogs(valid);
    res.json({ ok: true, added, total: orderExecutionLogs.length });
  });

  app.delete('/api/orders/history', (req, res) => {
    const mode = req.query.accountMode === 'Live' ? 'Live' : req.query.accountMode === 'Paper' ? 'Paper' : 'ALL';
    if (mode === 'ALL') {
      orderExecutionLogs = [];
    } else {
      orderExecutionLogs = orderExecutionLogs.filter((l) => l.accountMode !== mode);
    }
    saveOrderLogsToDisk(orderExecutionLogs);
    res.json({ ok: true, remaining: orderExecutionLogs.length });
  });

  // ---------- Git Sync Backup APIs ----------

  app.get('/api/git/status', asyncRoute(async (_req, res) => {
    const status = await getGitStatusSummary();
    res.json({ ok: true, status });
  }));

  app.post('/api/git/init', asyncRoute(async (_req, res) => {
    ensureGitIgnoreDefaults();
    if (!fs.existsSync(path.resolve(process.cwd(), '.git'))) {
      const initRes = await runGit(['init', '-b', 'main']);
      if (!initRes.ok) {
        const fallback = await runGit(['init']);
        if (!fallback.ok) {
          res.status(500).json({ ok: false, error: fallback.stderr || initRes.stderr });
          return;
        }
      }
    }
    const nameRes = await runGit(['config', 'user.name']);
    if (!nameRes.ok || !nameRes.stdout) {
      await runGit(['config', 'user.name', 'ApexRust Backup']);
    }
    const emailRes = await runGit(['config', 'user.email']);
    if (!emailRes.ok || !emailRes.stdout) {
      await runGit(['config', 'user.email', 'backup@apexrust.local']);
    }

    const status = await getGitStatusSummary();
    res.json({ ok: true, status });
  }));

  app.post('/api/git/remote', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { remoteUrl?: unknown };
    const cleanUrl = typeof body.remoteUrl === 'string' ? body.remoteUrl.trim() : '';
    if (!cleanUrl || !isValidGitRemote(cleanUrl)) {
      res.status(400).json({
        ok: false,
        error: 'Provide a valid HTTPS or SSH git remote URL (e.g., https://github.com/user/apexrust-backup.git).',
      });
      return;
    }

    if (!fs.existsSync(path.resolve(process.cwd(), '.git'))) {
      res.status(400).json({ ok: false, error: 'Initialize the Git repository first.' });
      return;
    }

    const existing = await runGit(['remote', 'get-url', 'origin']);
    const result = existing.ok
      ? await runGit(['remote', 'set-url', 'origin', cleanUrl])
      : await runGit(['remote', 'add', 'origin', cleanUrl]);

    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.stderr || 'Failed to configure origin remote' });
      return;
    }

    const status = await getGitStatusSummary();
    res.json({ ok: true, status });
  }));

  app.post('/api/git/backup', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as {
      commitMessage?: string;
      push?: boolean;
      includeRustWorkspace?: boolean;
      config?: Record<string, unknown>;
      summary?: Record<string, unknown>;
    };

    if (!fs.existsSync(path.resolve(process.cwd(), '.git'))) {
      ensureGitIgnoreDefaults();
      await runGit(['init', '-b', 'main']);
      await runGit(['config', 'user.name', 'ApexRust Backup']);
      await runGit(['config', 'user.email', 'backup@apexrust.local']);
    } else {
      ensureGitIgnoreDefaults();
      const nameRes = await runGit(['config', 'user.name']);
      if (!nameRes.ok || !nameRes.stdout) await runGit(['config', 'user.name', 'ApexRust Backup']);
      const emailRes = await runGit(['config', 'user.email']);
      if (!emailRes.ok || !emailRes.stdout) await runGit(['config', 'user.email', 'backup@apexrust.local']);
    }

    // Write sanitized config backup + synced TOML for Rust crate parity (never includes secrets)
    const backupsDir = path.resolve(process.cwd(), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const sanitizedJsonPath = path.join(backupsDir, 'bot-config-backup.json');
    fs.writeFileSync(
      sanitizedJsonPath,
      JSON.stringify(
        {
          backedUpAt: new Date().toISOString(),
          environment: vault.environment,
          venue: vault.venue,
          leverage: vault.leverage,
          marginType: vault.marginType,
          config: body.config ?? {},
          summary: body.summary ?? {},
        },
        null,
        2
      ),
      'utf8'
    );

    const syncedTomlPath = path.resolve(process.cwd(), 'rust-bot', 'config', 'bot.synced.toml');
    fs.mkdirSync(path.dirname(syncedTomlPath), { recursive: true });
    fs.writeFileSync(syncedTomlPath, buildSyncedTomlFromPayload(body as Record<string, unknown>), 'utf8');

    const addTargets = ['.gitignore', 'backups/bot-config-backup.json', 'rust-bot/config/bot.synced.toml'];
    if (body.includeRustWorkspace) {
      addTargets.push('rust-bot');
    }

    const addRes = await runGit(['add', ...addTargets]);
    if (!addRes.ok) {
      res.status(500).json({ ok: false, error: addRes.stderr || 'Failed to stage backup files' });
      return;
    }

    const msg =
      typeof body.commitMessage === 'string' && body.commitMessage.trim().length > 0
        ? body.commitMessage.trim().slice(0, 140)
        : `chore(backup): sync ApexRust config & strategy snapshot (${new Date().toISOString().slice(0, 16)}Z)`;

    const diffCheck = await runGit(['diff', '--cached', '--quiet', '--', ...addTargets]);
    let committed = false;
    let commitNote = 'Working tree backup already up to date';
    if (!diffCheck.ok) {
      // `--only` commits strictly the backup targets without sweeping unrelated staged index changes
      const commitRes = await runGit(['commit', '--only', '-m', msg, '--', ...addTargets]);
      if (!commitRes.ok) {
        res.status(500).json({ ok: false, error: commitRes.stderr || 'git commit failed' });
        return;
      }
      committed = true;
      commitNote = commitRes.stdout || 'Committed backup snapshot';
    }

    let pushed = false;
    let pushError: string | null = null;
    const statusAfterCommit = await getGitStatusSummary();

    if (body.push) {
      if (!statusAfterCommit.remoteUrl) {
        pushError = 'Snapshot committed locally, but no origin remote is configured for push.';
      } else {
        const pushRes = await runGit(['push', '-u', 'origin', statusAfterCommit.branch ?? 'main']);
        if (pushRes.ok) {
          pushed = true;
        } else {
          pushError = pushRes.stderr || 'git push failed';
        }
      }
    }

    res.json({
      ok: true,
      committed,
      pushed,
      pushError,
      message: pushError ?? commitNote,
      status: statusAfterCommit,
    });
  }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'API endpoint not found.' });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    res.status(500).json({ ok: false, error: message });
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  const distIndex = path.join(distDir, 'index.html');
  const isDevLifecycle =
    process.env.npm_lifecycle_event === 'dev' || process.env.NODE_ENV === 'development';
  const useStaticDist =
    fs.existsSync(distIndex) &&
    (process.env.NODE_ENV === 'production' ||
      Boolean(process.env.K_SERVICE) ||
      process.env.npm_lifecycle_event === 'start' ||
      !isDevLifecycle);

  if (useStaticDist) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(distIndex);
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      plugins: [
        {
          name: 'silence-vite-hmr-websocket',
          enforce: 'post',
          transform(code, id) {
            if (id.includes('vite/dist/client/client.mjs')) {
              return code
                .replace(
                  'reject(/* @__PURE__ */ new Error("WebSocket closed without opened."));',
                  'resolve();'
                )
                .replace(
                  'else throw new SendBeforeConnectError("send was called before connect");',
                  'else return;'
                )
                .replace(
                  'transport.connect(createHMRHandler(handleMessage));',
                  '/* HMR WebSocket disabled in middleware mode */'
                );
            }
            return null;
          },
        },
      ],
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 3000);
  const host = (process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`ApexRust server listening on http://${host}:${port}`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start ApexRust server:', err);
  process.exit(1);
});
