import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import express from 'express';
import { OrderHistoryDatabase } from './src/engine/orderDatabase';
import { validateRemoteBaseUrl } from './src/engine/apiClient';
import {
  aggregateTradesByOrderId,
  buildBinanceSyncTimeWindows,
  detectOrphanPairs,
  lookbackPresetToMs,
} from './src/engine/orderHistoryAnalytics';
import {
  AuthFailureLimiter,
  type EngineAuthorityMode,
  LiveExecutionLeaseManager,
  evaluateBindSafety,
  evaluateEngineAuthorityGuard,
  isEnginePathAllowed,
  isOriginAllowed,
  parseAllowedOrigins,
} from './src/engine/remoteAccess';
import type {
  OrderExecutionLog,
  OrphanResolutionAction,
  SyncLookbackPreset,
} from './src/engine/types';

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

const initialLeverageRaw = Number(process.env.BINANCE_LEVERAGE ?? 3);
const initialLeverage = Number.isFinite(initialLeverageRaw)
  ? Math.min(20, Math.max(1, Math.round(initialLeverageRaw)))
  : 3;
const initialMarginType: MarginType =
  (process.env.BINANCE_MARGIN_TYPE ?? '').trim().toUpperCase() === 'CROSSED'
    ? 'CROSSED'
    : 'ISOLATED';
const initialRecvWindowRaw = Number(process.env.BINANCE_RECV_WINDOW_MS ?? 5000);
const initialRecvWindowMs = Number.isFinite(initialRecvWindowRaw)
  ? Math.min(60_000, Math.max(1000, Math.round(initialRecvWindowRaw)))
  : 5000;
const initialMaxNotionalRaw = Number(process.env.APEXRUST_MAX_ORDER_NOTIONAL_USDT ?? 250);
const initialMaxNotionalUsdt = Number.isFinite(initialMaxNotionalRaw)
  ? Math.max(10, Number(initialMaxNotionalRaw.toFixed(2)))
  : 250;
const initialRequirePreflight =
  (process.env.APEXRUST_REQUIRE_PREFLIGHT ?? 'true').trim().toLowerCase() !== 'false';

const vault: ServerVaultState = {
  environment: initialEnv,
  venue: initialVenue,
  leverage: initialLeverage,
  marginType: initialMarginType,
  authMethod: initialAuth,
  apiKey: initialKey,
  apiSecret: initialSecret,
  recvWindowMs: initialRecvWindowMs,
  maxOrderNotionalUsdt: initialMaxNotionalUsdt,
  requirePreflightTestOrder: initialRequirePreflight,
  armedForLiveOrders: false,
  verificationStatus: 'unverified',
  verificationMessage: null,
  lastVerifiedAt: null,
  canTrade: false,
  permissions: [],
  latencyMs: null,
  syncedBalances: [],
};

type BackendOrderExecutionLog = OrderExecutionLog;

const ORDER_DB_FILE = path.resolve(
  process.cwd(),
  process.env.APEXRUST_ORDER_DB_PATH?.trim() || '.apexrust-orders.sqlite'
);
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

function sanitizeSymbol(raw: unknown, fallback = ''): string {
  const clean = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  return clean || fallback;
}

const orderHistoryDb = new OrderHistoryDatabase({
  dbPath: ORDER_DB_FILE,
  legacyJsonPath: ORDER_LOGS_FILE,
  maxLiveQuota: 5000,
  maxPaperQuota: 1000,
  seedInitialPaperLogs: buildInitialPaperOrderLogs,
});

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
  if (env === 'Production') return 'https://api.binance.com';
  const spotOverride = (process.env.BINANCE_SPOT_TESTNET_REST ?? '').trim();
  return spotOverride || 'https://testnet.binance.vision';
}

const KNOWN_QUOTE_SUFFIXES = [
  'USDT',
  'USDC',
  'FDUSD',
  'TUSD',
  'BUSD',
  'EUR',
  'TRY',
  'JPY',
  'BRL',
  'AUD',
  'GBP',
  'BNB',
  'ETH',
  'BTC',
];

function extractBaseAssetFromSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  for (const quote of KNOWN_QUOTE_SUFFIXES) {
    if (upper.length > quote.length && upper.endsWith(quote)) {
      return upper.slice(0, -quote.length);
    }
  }
  return upper;
}

function signPayload(queryString: string, authMethod: AuthMethod, secret: string): string {
  if (authMethod === 'Ed25519') {
    const keyObj = crypto.createPrivateKey(secret);
    return crypto.sign(null, Buffer.from(queryString, 'utf8'), keyObj).toString('base64');
  }
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

interface SymbolFilters {
  baseAsset?: string;
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
  venue: ExchangeVenue = vault.venue,
  env: BinanceEnv = vault.environment
): Promise<SymbolFilters> {
  const key = `${env}:${venue}:${symbol}`;
  const cached = symbolFilterCache.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < 600_000) {
    return cached;
  }

  try {
    const baseUrl = getRestBaseUrl(env, venue);
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
          baseAsset?: string;
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
      const defaultTickStr = fallbackPrice >= 100 ? '0.01' : '0.0001';
      const defaultStepStr = venue === 'Futures' ? '0.001' : '0.00001';
      const nowMs = Date.now();
      for (const sEntry of payload.symbols ?? []) {
        if (!sEntry.symbol) continue;
        const filters = sEntry.filters ?? [];
        const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
        const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
        const marketLotFilter = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') ?? lotFilter;
        const notionalFilter = filters.find(
          (f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL'
        );
        const tickStr = priceFilter?.tickSize ?? defaultTickStr;
        const stepStr = lotFilter?.stepSize ?? defaultStepStr;
        const mktStepStr = marketLotFilter?.stepSize ?? stepStr;
        const tickSize = Number(tickStr) || Number(defaultTickStr);
        const stepSize = Number(stepStr) || Number(defaultStepStr);
        const marketStepSize = Number(mktStepStr) || stepSize;
        const rawQuotePrec = Number(sEntry.quoteAssetPrecision ?? sEntry.quotePrecision ?? 2);
        const quoteDecimals = Number.isFinite(rawQuotePrec)
          ? Math.min(8, Math.max(2, rawQuotePrec))
          : 2;
        const resolvedEntry: SymbolFilters = {
          baseAsset: typeof sEntry.baseAsset === 'string' ? sEntry.baseAsset.toUpperCase() : undefined,
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
          minNotional: Number(notionalFilter?.minNotional ?? notionalFilter?.notional ?? 0) || 5,
          maxNotional: Number(notionalFilter?.maxNotional ?? 0) || 0,
          quoteDecimals,
          fetchedAtMs: nowMs,
        };
        symbolFilterCache.set(`${env}:${venue}:${sEntry.symbol}`, resolvedEntry);
      }
      const matched = symbolFilterCache.get(key);
      if (matched) return matched;
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

async function fetchPublicPrice(
  symbol: string,
  venue: ExchangeVenue,
  env: BinanceEnv = vault.environment
): Promise<number> {
  const ticker = await fetchPublicTicker(symbol, venue, env);
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

async function getFuturesDualSideMode(
  authSnap: VaultAuthSnapshot = captureVaultAuthSnapshot()
): Promise<boolean> {
  const key = `${authSnap.environment}:${authSnap.apiKey.slice(0, 8)}`;
  const cached = futuresDualSideCache.get(key);
  if (cached && Date.now() - cached.checkedAtMs < 120_000) {
    return cached.dualSide;
  }
  try {
    const res = await signedBinanceRequest('GET', '/fapi/v1/positionSide/dual', {}, 'Futures', authSnap);
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
    'rust-bot/config/bot.toml.bak',
    '.apexrust-order-logs.json',
    '.apexrust-orders.sqlite',
    '.apexrust-orders.sqlite-*',
    '.apexrust-orders.sqlite.json',
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
  git_auto_backup: false,
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
  const restBaseUrl = getRestBaseUrl(vault.environment, isFutures ? 'Futures' : 'Spot');
  const isFuturesDemo = !isProd && isFutures && restBaseUrl.includes('demo-fapi.binance.com');
  const isSpotDemo = !isProd && !isFutures && restBaseUrl.includes('demo-api.binance.com');
  const wsStreamUrl = isFutures
    ? isProd
      ? 'wss://fstream.binance.com/stream'
      : isFuturesDemo
        ? 'wss://demo-fstream.binance.com/stream'
        : 'wss://stream.binancefuture.com/stream'
    : isProd
      ? 'wss://stream.binance.com:9443/stream'
      : isSpotDemo
        ? 'wss://demo-stream.binance.com/stream'
        : 'wss://stream.testnet.binance.vision/stream';
  const wsApiUrl = isFutures
    ? isProd
      ? 'wss://ws-fapi.binance.com/ws-fapi/v1'
      : 'wss://testnet.binancefuture.com/ws-fapi/v1'
    : isProd
      ? 'wss://ws-api.binance.com:443/ws-api/v3'
      : isSpotDemo
        ? 'wss://demo-ws-api.binance.com/ws-api/v3'
        : 'wss://ws-api.testnet.binance.vision/ws-api/v3';

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
    'auth_token = ""',
    '',
  ].join('\n');
}

const API_VERSION = '2.0.0';
const authFailureLimiter = new AuthFailureLimiter(10, 5 * 60 * 1000);
const liveLeaseManager = new LiveExecutionLeaseManager(20_000);

function getEngineAuthority(): EngineAuthorityMode {
  return (process.env.APEXRUST_ENGINE_AUTHORITY ?? '').trim().toLowerCase() === 'daemon'
    ? 'daemon'
    : 'browser';
}

function getEngineBaseUrl(): string {
  return (process.env.APEXRUST_ENGINE_URL ?? 'http://127.0.0.1:8080').trim().replace(/\/+$/, '');
}

function getEngineAuthToken(): string {
  return (
    process.env.APEXRUST_ENGINE_TOKEN ??
    process.env.APEXRUST_WEB_TOKEN ??
    ''
  ).trim();
}

function formatDotEnvScalar(value: string): string {
  if (value === '') return '';
  if (/[\s#"'=\\\r\n]/.test(value)) {
    return `"${value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')}"`;
  }
  return value;
}

function persistVaultToDotEnvIfEnabled(): boolean {
  if ((process.env.APEXRUST_PERSIST_VAULT ?? '').trim().toLowerCase() !== 'true') {
    return false;
  }
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const lines = raw ? raw.split(/\r?\n/) : [];
    const updates: Record<string, string> = {
      BINANCE_ENVIRONMENT: vault.environment,
      BINANCE_VENUE: vault.venue,
      BINANCE_LEVERAGE: String(vault.leverage),
      BINANCE_MARGIN_TYPE: vault.marginType,
      BINANCE_RECV_WINDOW_MS: String(vault.recvWindowMs),
      APEXRUST_MAX_ORDER_NOTIONAL_USDT: String(vault.maxOrderNotionalUsdt),
      APEXRUST_REQUIRE_PREFLIGHT: vault.requirePreflightTestOrder ? 'true' : 'false',
      BINANCE_AUTH_METHOD: vault.authMethod,
      BINANCE_API_KEY: vault.apiKey,
      BINANCE_API_SECRET: vault.authMethod === 'HMAC-SHA256' ? vault.apiSecret : '',
      BINANCE_ED25519_PRIVATE_KEY: vault.authMethod === 'Ed25519' ? vault.apiSecret : '',
      BINANCE_PRIVATE_KEY_PATH: '',
    };
    const seen = new Set<string>();
    const nextLines = lines.map((line) => {
      const trimmed = line.trim();
      const isCommented = trimmed.startsWith('#');
      for (const [k, v] of Object.entries(updates)) {
        const re = new RegExp(`^\\s*#?\\s*${k}\\s*=`);
        if (re.test(line)) {
          seen.add(k);
          // Do not uncomment commented template lines when persisting an empty/cleared value
          if (isCommented && v === '') {
            return line;
          }
          return `${k}=${formatDotEnvScalar(v)}`;
        }
      }
      return line;
    });
    for (const [k, v] of Object.entries(updates)) {
      if (!seen.has(k) && v !== '') {
        nextLines.push(`${k}=${formatDotEnvScalar(v)}`);
      }
    }
    fs.writeFileSync(envPath, `${nextLines.join('\n').replace(/\n+$/, '')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // Ignore chmod error on Windows
    }
    return true;
  } catch (err) {
    console.warn('[server] Failed to persist vault to .env:', err instanceof Error ? err.message : String(err));
    return false;
  }
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
  const trustProxyRaw = (process.env.APEXRUST_TRUST_PROXY ?? '').trim().toLowerCase();
  if (trustProxyRaw === 'true' || trustProxyRaw === '1') {
    app.set('trust proxy', true);
  } else if (
    trustProxyRaw === 'loopback' ||
    (process.env.APEXRUST_TRUST_ZERO_TRUST_MESH ?? '').trim().toLowerCase() === 'true'
  ) {
    app.set('trust proxy', 'loopback');
  }
  app.use(express.json({ limit: '256kb' }));

  function resolveClientIp(req: express.Request): string {
    const remoteAddr = String(req.socket.remoteAddress ?? '').trim();
    const isLoopbackPeer =
      remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    const hasCloudflareProxyHeader =
      Boolean(req.headers['cf-ray']) || Boolean(req.headers['cf-access-authenticated-user-email']);
    const cfConnectingIp =
      typeof req.headers['cf-connecting-ip'] === 'string'
        ? req.headers['cf-connecting-ip'].trim()
        : '';
    if ((isLoopbackPeer || trustProxyRaw === 'true' || trustProxyRaw === '1') && hasCloudflareProxyHeader && cfConnectingIp) {
      return cfConnectingIp;
    }
    return String(req.ip || remoteAddr || 'unknown');
  }

  const asyncRoute =
    (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };

  // CORS + Chromium Private Network Access (PNA) support for Desktop PWA <-> Cloudflare One Zero Trust VPS
  app.use('/api', (req, res, next) => {
    const allowedOrigins = parseAllowedOrigins(process.env.APEXRUST_ALLOWED_ORIGINS);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    const isSelfOrigin =
      Boolean(origin) &&
      Boolean(hostHeader) &&
      (origin.toLowerCase() === `http://${hostHeader}` ||
        origin.toLowerCase() === `https://${hostHeader}`);
    if (origin && (isSelfOrigin || isOriginAllowed(origin, allowedOrigins))) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-ApexRust-Token, X-ApexRust-Client-Id'
      );
      if (String(req.headers['access-control-request-private-network'] ?? '').trim().toLowerCase() === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  function isRequestTokenAuthorized(req: express.Request): {
    ok: boolean;
    status?: number;
    error?: string;
  } {
    const configuredToken = (process.env.APEXRUST_PROXY_TOKEN ?? '').trim();
    if (!configuredToken) {
      return { ok: true };
    }
    const clientIp = resolveClientIp(req);
    if (authFailureLimiter.isLocked(clientIp)) {
      return {
        ok: false,
        status: 429,
        error: 'Too many failed token attempts from this IP. Try again in 5 minutes.',
      };
    }
    const headerToken = String(req.headers['x-apexrust-token'] ?? '').trim();
    const authHeader = String(req.headers.authorization ?? '').trim();
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (
      !safeTokenMatch(headerToken, configuredToken) &&
      !safeTokenMatch(bearerToken, configuredToken)
    ) {
      authFailureLimiter.recordFailure(clientIp);
      return {
        ok: false,
        status: 401,
        error: 'Unauthorized: missing or invalid Access Token (APEXRUST_PROXY_TOKEN).',
      };
    }
    authFailureLimiter.recordSuccess(clientIp);
    return { ok: true };
  }

  // Reject unapproved cross-origin browser requests (both reads & writes) and enforce optional APEXRUST_PROXY_TOKEN
  app.use(['/api/live', '/api/git', '/api/orders', '/api/engine', '/api/remote-profile', '/api/market'], (req, res, next) => {
    const allowedOrigins = parseAllowedOrigins(process.env.APEXRUST_ALLOWED_ORIGINS);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const fetchSite = req.headers['sec-fetch-site'];
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
    const isSelfOrigin =
      Boolean(origin) &&
      Boolean(hostHeader) &&
      (origin.toLowerCase() === `http://${hostHeader}` ||
        origin.toLowerCase() === `https://${hostHeader}`);
    if (origin && !isSelfOrigin && !isOriginAllowed(origin, allowedOrigins)) {
      res.status(403).json({
        error: 'Cross-origin request blocked. Add your Desktop origin to APEXRUST_ALLOWED_ORIGINS.',
      });
      return;
    }
    if (req.method !== 'GET' && fetchSite === 'cross-site' && !origin && !isOriginAllowed(origin, allowedOrigins)) {
      res.status(403).json({
        error: 'Cross-site request blocked. Add your Desktop origin to APEXRUST_ALLOWED_ORIGINS.',
      });
      return;
    }
    const authCheck = isRequestTokenAuthorized(req);
    if (!authCheck.ok) {
      res.status(authCheck.status ?? 401).json({ error: authCheck.error });
      return;
    }
    next();
  });

  app.get(['/api/health', '/_ah/health'], (_req, res) => {
    res.json({
      ok: true,
      service: 'apexrust-control-proxy',
      apiVersion: API_VERSION,
      environment: vault.environment,
      venue: vault.venue,
      engineAuthority: getEngineAuthority(),
    });
  });

  app.get('/api/connection/info', asyncRoute(async (req, res) => {
    const configuredToken = (process.env.APEXRUST_PROXY_TOKEN ?? '').trim();
    const authCheck = isRequestTokenAuthorized(req);
    const zeroTrustEmail =
      typeof req.headers['cf-access-authenticated-user-email'] === 'string'
        ? req.headers['cf-access-authenticated-user-email'].trim()
        : null;

    if (!authCheck.ok) {
      res.status(authCheck.status ?? 401).json({
        ok: false,
        service: 'apexrust-control-proxy',
        apiVersion: API_VERSION,
        authRequired: configuredToken.length > 0,
        error: authCheck.error,
      });
      return;
    }

    let engineReachable = false;
    let engineRunning: boolean | null = null;
    let engineTransportMode: string | null = null;
    try {
      const headers: Record<string, string> = {};
      const engTok = getEngineAuthToken();
      if (engTok) headers.Authorization = `Bearer ${engTok}`;
      const engResp = await fetch(`${getEngineBaseUrl()}/api/health`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (engResp.ok) {
        engineReachable = true;
        const data = (await engResp.json()) as {
          running?: boolean;
          transport_mode?: string;
        };
        if (typeof data.running === 'boolean') engineRunning = data.running;
        if (typeof data.transport_mode === 'string') engineTransportMode = data.transport_mode;
      }
    } catch {
      engineReachable = false;
    }

    res.json({
      ok: true,
      service: 'apexrust-control-proxy',
      apiVersion: API_VERSION,
      authRequired: configuredToken.length > 0,
      engineAuthority: getEngineAuthority(),
      engineReachable,
      engineRunning,
      engineTransportMode,
      environment: vault.environment,
      venue: vault.venue,
      configuredCredentials: Boolean(vault.apiKey && vault.apiSecret),
      armedForLiveOrders: vault.armedForLiveOrders,
      persistVaultEnabled: (process.env.APEXRUST_PERSIST_VAULT ?? '').trim().toLowerCase() === 'true',
      zeroTrustUser: zeroTrustEmail,
      serverTimeMs: Date.now(),
    });
  }));

  // Shared local profile file (.apexrust/remote-profile.json) so Desktop PWA, bot-desktop, and apexrust CLI stay in sync
  const remoteProfilePath = path.resolve(process.cwd(), '.apexrust', 'remote-profile.json');
  app.get('/api/remote-profile', (_req, res) => {
    try {
      if (fs.existsSync(remoteProfilePath)) {
        const raw = JSON.parse(fs.readFileSync(remoteProfilePath, 'utf8')) as Record<string, unknown>;
        res.json({ ok: true, profile: raw });
        return;
      }
    } catch {
      // Ignore corrupt profile file
    }
    res.json({
      ok: true,
      profile: {
        activeMode: 'local',
        name: 'Remote VPS',
        baseUrl: '',
      },
    });
  });

  app.post('/api/remote-profile', (req, res) => {
    const body = (req.body ?? {}) as {
      activeMode?: 'local' | 'remote';
      name?: string;
      baseUrl?: string;
      token?: string;
    };
    let existing: { activeMode?: string; name?: string; baseUrl?: string; token?: string } = {};
    try {
      if (fs.existsSync(remoteProfilePath)) {
        existing = JSON.parse(fs.readFileSync(remoteProfilePath, 'utf8')) as typeof existing;
      }
    } catch {
      existing = {};
    }

    let nextBaseUrl = typeof existing.baseUrl === 'string' ? existing.baseUrl : '';
    if (typeof body.baseUrl === 'string') {
      const trimmedUrl = body.baseUrl.trim();
      if (trimmedUrl.length > 0) {
        const checked = validateRemoteBaseUrl(trimmedUrl);
        if (!checked.ok) {
          res.status(400).json({ ok: false, error: checked.error });
          return;
        }
        nextBaseUrl = checked.normalizedUrl;
      } else {
        nextBaseUrl = '';
      }
    }

    const nextToken =
      typeof body.token === 'string'
        ? body.token.trim()
        : typeof existing.token === 'string'
          ? existing.token.trim()
          : '';
    const nextProfile = {
      activeMode: body.activeMode === 'remote' ? 'remote' : 'local',
      name:
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim().slice(0, 64)
          : typeof existing.name === 'string' && existing.name.trim()
            ? existing.name.trim().slice(0, 64)
            : 'Remote VPS',
      baseUrl: nextBaseUrl,
      ...(nextToken ? { token: nextToken } : {}),
      updatedAtIso: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(remoteProfilePath), { recursive: true });
      fs.writeFileSync(remoteProfilePath, `${JSON.stringify(nextProfile, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // Ignore read-only filesystem
    }
    res.json({ ok: true, profile: nextProfile });
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
        : nextAuth !== vault.authMethod
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

    const persistedToEnv = persistVaultToDotEnvIfEnabled();
    const changedFields = [
      envChanged ? 'environment' : null,
      body.venue !== undefined ? 'venue' : null,
      keyChanged ? 'apiKey' : null,
      secretChanged ? 'apiSecret' : null,
      body.maxOrderNotionalUsdt !== undefined ? 'maxOrderNotionalUsdt' : null,
    ].filter(Boolean);
    if (changedFields.length > 0) {
      const zeroTrustUser = req.headers['cf-access-authenticated-user-email'] ?? 'direct';
      console.log(
        `[audit]POST /api/live/config ip=${req.ip} origin=${req.headers.origin ?? 'same-origin'} zt=${String(zeroTrustUser)} fields=${changedFields.join(',')} persistedEnv=${persistedToEnv}`
      );
    }

    res.json({ ok: true, persistedToEnv, status: getSafeStatus() });
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
    console.log(
      `[audit]POST /api/live/arm ARMED=true env=${vault.environment} venue=${vault.venue} ip=${req.ip}`
    );
    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/lease', (req, res) => {
    const body = (req.body ?? {}) as { clientId?: string; forceTakeover?: boolean };
    const headerClientId =
      typeof req.headers['x-apexrust-client-id'] === 'string'
        ? req.headers['x-apexrust-client-id'].trim()
        : '';
    const clientId = (body.clientId ?? headerClientId).trim();
    const outcome = liveLeaseManager.acquireOrRenew(clientId, Date.now(), Boolean(body.forceTakeover));
    res.json({
      ok: outcome.acquired,
      engineAuthority: getEngineAuthority(),
      ...outcome,
    });
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

    // Single-Engine Authority guard: prevent browser auto-trader from placing duplicate live entries when VPS daemon is active
    const authorityCheck = evaluateEngineAuthorityGuard(getEngineAuthority(), {
      reduceOnly: body.reduceOnly,
      preflightOnly: body.preflightOnly,
    });
    if (!authorityCheck.allowed) {
      res.status(authorityCheck.status).json({
        ok: false,
        code: authorityCheck.code,
        error: authorityCheck.error,
      });
      return;
    }

    // Single-browser lease check when browser is the engine authority
    if (!body.reduceOnly && !body.preflightOnly && getEngineAuthority() === 'browser') {
      const clientId =
        typeof req.headers['x-apexrust-client-id'] === 'string'
          ? req.headers['x-apexrust-client-id'].trim()
          : undefined;
      const leaseCheck = liveLeaseManager.verifyEntryLease(clientId);
      if (!leaseCheck.allowed) {
        res.status(409).json({
          ok: false,
          code: 'LIVE_LEASE_HELD_BY_OTHER_CLIENT',
          error: `Another Desktop/Browser session (${leaseCheck.holderClientId}) currently holds the active Live Trading lease.`,
        });
        return;
      }
    }

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

    if (venue === 'Spot' && side === 'SELL' && !body.reduceOnly) {
      res.status(400).json({
        error: 'Spot short-entry (non-reduceOnly SELL) is unsupported on Binance Spot. Use USD-M Futures for Short entries.',
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
      refPrice = await fetchPublicPrice(symbol, venue, authSnap.environment);
    }
    const filters = await getSymbolFilters(symbol, refPrice > 0 ? refPrice : 100, venue, authSnap.environment);

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
        const dualSide = await getFuturesDualSideMode(authSnap);
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
          orderHistoryDb.upsertLogs([
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
          orderHistoryDb.upsertLogs([
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
        orderHistoryDb.upsertLogs([
          {
            id: `live-rej-${symbol}-${Date.now()}`,
            orderId: `rej-${Date.now()}`,
            clientOrderId: `live_${symbol.toLowerCase()}`,
            symbol,
            venue,
            environment: authSnap.environment,
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

      const baseAsset = filters.baseAsset || extractBaseAssetFromSymbol(symbol);
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
          const belowLimitFmt = floorToStep(
            Number(body.stopLossPrice) * 0.998,
            filters.tickSize,
            filters.tickDecimals
          );
          const tpNum = Number(tpFmt);
          const slNum = Number(slFmt);
          const belowNum = Number(belowLimitFmt);
          const exitQtyNum = Number(exitQtyFmt);
          const minPriceViolated =
            filters.minPrice > 0 && (tpNum < filters.minPrice || slNum < filters.minPrice || belowNum < filters.minPrice);
          const maxPriceViolated =
            filters.maxPrice > 0 && (tpNum > filters.maxPrice || slNum > filters.maxPrice || belowNum > filters.maxPrice);
          const minNotionalViolated =
            filters.minNotional > 0 &&
            (tpNum * exitQtyNum < filters.minNotional || belowNum * exitQtyNum < filters.minNotional);
          if (minPriceViolated || maxPriceViolated || minNotionalViolated) {
            ocoWarning = `Spot OCO leg skipped: TP (${tpFmt}) / SL (${slFmt}/${belowLimitFmt}) or exit notional fails Binance filters (minPrice=${filters.minPrice}, maxPrice=${filters.maxPrice}, minNotional=${filters.minNotional}).`;
            ocoNote = ocoWarning;
          } else {
            const ocoParams: Record<string, string | number> = {
              symbol,
              side: 'SELL',
              quantity: exitQtyFmt,
              aboveType: 'LIMIT_MAKER',
              abovePrice: tpFmt,
              belowType: 'STOP_LOSS_LIMIT',
              belowStopPrice: slFmt,
              belowPrice: belowLimitFmt,
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
            // Roll back any half-attached algo leg (DELETE /fapi/v1/algoOrder takes algoId only; symbol causes -1106)
            for (const id of ids) {
              await signedBinanceRequest('DELETE', '/fapi/v1/algoOrder', { algoId: id }, 'Futures', authSnap).catch(() => {});
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

      orderHistoryDb.upsertLogs([
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
          environment: authSnap.environment,
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
        environment: authSnap.environment,
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
        const algoRes = await signedBinanceRequest('GET', '/fapi/v1/openAlgoOrders', params, 'Futures');
        if (algoRes.ok) {
          algoOrders = extractBinanceAlgoOrders(algoRes.data);
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
    const isAlgoQuery = String(req.query.orderType ?? '').toUpperCase() === 'ALGO';
    if (!symbol || !orderId) {
      res.status(400).json({ ok: false, error: 'symbol and orderId are required.' });
      return;
    }
    try {
      const endpoint = venue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
      let queryRes = isAlgoQuery && venue === 'Futures'
        ? await signedBinanceRequest('GET', '/fapi/v1/algoOrder', { algoId: orderId }, 'Futures')
        : await signedBinanceRequest('GET', endpoint, { symbol, orderId }, venue);
      if (!queryRes.ok && venue === 'Futures' && !isAlgoQuery && Number(queryRes.data?.code) === -2013) {
        const algoFallback = await signedBinanceRequest('GET', '/fapi/v1/algoOrder', { algoId: orderId }, 'Futures');
        if (algoFallback.ok) {
          queryRes = algoFallback;
        }
      }
      if (!queryRes.ok) {
        res.status(400).json({
          ok: false,
          error: `Binance ${queryRes.data.code ?? queryRes.status}: ${String(queryRes.data.msg ?? 'Order query failed')}`,
        });
        return;
      }
      const executedQty = Number(queryRes.data.executedQty ?? 0) || 0;
      const cumQuote = Number(queryRes.data.cummulativeQuoteQty ?? queryRes.data.cumQuote ?? 0) || 0;
      const rawPrice = Number(queryRes.data.avgPrice ?? queryRes.data.price ?? queryRes.data.triggerPrice ?? 0) || 0;
      const avgPrice = executedQty > 0 && cumQuote > 0 ? cumQuote / executedQty : rawPrice;
      res.json({
        ok: true,
        venue,
        symbol,
        orderId: String(queryRes.data.orderId ?? queryRes.data.algoId ?? orderId),
        status: String(queryRes.data.algoStatus ?? queryRes.data.status ?? 'UNKNOWN').toUpperCase(),
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
              { algoId: String(algoId) },
              'Futures'
            );
            if (delRes.ok) cancelled += 1;
            else errors.push(`algo #${algoId}: ${String(delRes.data.msg ?? delRes.status)}`);
          }
        } else {
          const openAlgoRes = await signedBinanceRequest('GET', '/fapi/v1/openAlgoOrders', { symbol }, 'Futures');
          const extractedAlgo = openAlgoRes.ok ? extractBinanceAlgoOrders(openAlgoRes.data) : [];
          const openCount = extractedAlgo.length > 0 ? extractedAlgo.length : 1;
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
        cancelParams = { algoId: algoId || orderId };
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
      orderHistoryDb.upsertLogs([
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

  app.delete('/api/live/config', (req, res) => {
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
    const persistedToEnv = persistVaultToDotEnvIfEnabled();
    console.log(`[audit]DELETE /api/live/config ip=${req.ip} clearedVault=true persistedEnv=${persistedToEnv}`);
    res.json({ ok: true, persistedToEnv, status: getSafeStatus() });
  });

  // ---------- Order Execution History, Binance Lookback Sync & Orphan Pair APIs ----------

  function normalizeLookbackPreset(raw: unknown): SyncLookbackPreset {
    const val = String(raw ?? '7d').trim().toLowerCase();
    if (val === '1d') return '1d';
    if (val === '3d') return '3d';
    if (val === '30d' || val === '1m' || val === '1month') return '30d';
    return '7d';
  }

  async function syncSymbolHistoryFromBinance(
    targetSymbol: string,
    targetVenue: ExchangeVenue,
    lookback: SyncLookbackPreset
  ): Promise<{ syncedCount: number; latencyMs?: number; endpoint: string; error?: string }> {
    const authSnap = captureVaultAuthSnapshot();
    const sym = sanitizeSymbol(targetSymbol);
    const endpoint = targetVenue === 'Futures' ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
    const tradesEndpoint = targetVenue === 'Futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
    const nowMs = Date.now();
    const windowStartMs = Math.max(0, nowMs - lookbackPresetToMs(lookback));
    let lastLatencyMs: number | undefined;
    const collectedRawOrders = new Map<string, Record<string, unknown>>();
    const collectedAlgoOrders = new Map<string, Record<string, unknown>>();

    if (targetVenue === 'Spot') {
      // Official Binance Spot rule: sending startTime + endTime > 24h fails with -1127.
      // First query up to 1000 recent orders without endTime in 1 call (weight 20).
      const recentRes = await signedBinanceRequest(
        'GET',
        endpoint,
        { symbol: sym, limit: '1000' },
        'Spot',
        authSnap
      );
      lastLatencyMs = recentRes.latencyMs;
      if (!recentRes.ok) {
        return {
          syncedCount: 0,
          latencyMs: lastLatencyMs,
          endpoint,
          error: `Binance ${recentRes.data.code ?? recentRes.status}: ${String(recentRes.data.msg ?? 'Query failed')}`,
        };
      }
      const list = Array.isArray(recentRes.data)
        ? (recentRes.data as Array<Record<string, unknown>>)
        : [];
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const raw of list) {
        const ts = Number(raw.updateTime ?? raw.time ?? 0);
        if (ts > 0 && ts < oldestMs) oldestMs = ts;
        if (ts >= windowStartMs) {
          collectedRawOrders.set(String(raw.orderId ?? ''), raw);
        }
      }
      // Only if all 1000 returned orders are still newer than windowStartMs, paginate <24h slices within [windowStartMs, oldestMs - 1]
      if (list.length >= 1000 && Number.isFinite(oldestMs) && oldestMs > windowStartMs) {
        const slices = buildBinanceSyncTimeWindows('Spot', lookback, oldestMs - 1)
          .filter((win) => win.endTime > windowStartMs)
          .map((win) => ({
            startTime: Math.max(windowStartMs, win.startTime),
            endTime: win.endTime,
          }));
        for (const win of slices) {
          const sliceRes = await signedBinanceRequest(
            'GET',
            endpoint,
            { symbol: sym, startTime: win.startTime, endTime: win.endTime, limit: '1000' },
            'Spot',
            authSnap
          );
          lastLatencyMs = sliceRes.latencyMs;
          if (!sliceRes.ok || !Array.isArray(sliceRes.data)) break;
          for (const raw of sliceRes.data as Array<Record<string, unknown>>) {
            collectedRawOrders.set(String(raw.orderId ?? ''), raw);
          }
        }
      }
    } else {
      // Official Binance USD-M Futures rule: startTime..endTime cannot exceed 7 days,
      // and omitting timestamps returns only the last 7 days. Slice into <= 7d windows.
      const windows = buildBinanceSyncTimeWindows('Futures', lookback, nowMs);
      let anyOk = false;
      let firstErr: string | undefined;
      for (const win of windows) {
        let cursorStart = win.startTime;
        for (let page = 0; page < 10 && cursorStart <= win.endTime; page += 1) {
          const sliceRes = await signedBinanceRequest(
            'GET',
            endpoint,
            { symbol: sym, startTime: cursorStart, endTime: win.endTime, limit: '1000' },
            'Futures',
            authSnap
          );
          lastLatencyMs = sliceRes.latencyMs;
          if (!sliceRes.ok) {
            if (!firstErr) {
              firstErr = `Binance ${sliceRes.data.code ?? sliceRes.status}: ${String(sliceRes.data.msg ?? 'Query failed')}`;
            }
            break;
          }
          anyOk = true;
          const list = Array.isArray(sliceRes.data)
            ? (sliceRes.data as Array<Record<string, unknown>>)
            : [];
          let maxTs = cursorStart;
          for (const raw of list) {
            const oid = String(raw.orderId ?? '');
            if (oid) collectedRawOrders.set(oid, raw);
            const ts = Number(raw.time ?? raw.updateTime ?? 0);
            if (ts > maxTs) maxTs = ts;
          }
          if (list.length < 1000 || maxTs < cursorStart) break;
          cursorStart = maxTs + 1;
        }

        // Also query Futures Algo historical orders (TAKE_PROFIT_MARKET / STOP_MARKET / TRAILING_STOP_MARKET)
        const algoSliceRes = await signedBinanceRequest(
          'GET',
          '/fapi/v1/allAlgoOrders',
          { symbol: sym, startTime: win.startTime, endTime: win.endTime, limit: '1000' },
          'Futures',
          authSnap
        );
        if (algoSliceRes.ok) {
          for (const rawAlgo of extractBinanceAlgoOrders(algoSliceRes.data)) {
            const aid = String(rawAlgo.algoId ?? rawAlgo.clientAlgoId ?? '');
            if (aid) collectedAlgoOrders.set(aid, rawAlgo);
          }
        }
      }
      if (!anyOk && firstErr) {
        return { syncedCount: 0, latencyMs: lastLatencyMs, endpoint, error: firstErr };
      }
    }

    const rawOrders = Array.from(collectedRawOrders.values());
    const hasFilled = rawOrders.some((r) => Number(r.executedQty ?? 0) > 0);
    const tradeMetricsMap = new Map<
      string,
      { commission: number; commissionAsset: string; isMaker: boolean; realizedPnlUsdt: number | null }
    >();

    if (hasFilled) {
      if (targetVenue === 'Spot') {
        const trRes = await signedBinanceRequest(
          'GET',
          tradesEndpoint,
          { symbol: sym, limit: '1000' },
          'Spot',
          authSnap
        );
        if (trRes.ok && Array.isArray(trRes.data)) {
          const agg = aggregateTradesByOrderId(
            trRes.data as Array<Record<string, unknown>>,
            'Spot'
          );
          for (const [k, v] of agg.entries()) tradeMetricsMap.set(k, v);
        }
        // Fallback: if any filled Spot orders were older than the latest 1,000 trades, query by orderId (with limit=1000)
        const missingFilledIds = rawOrders
          .filter((r) => Number(r.executedQty ?? 0) > 0)
          .map((r) => String(r.orderId ?? ''))
          .filter((oid) => oid && !tradeMetricsMap.has(oid))
          .slice(0, 50);
        for (const oid of missingFilledIds) {
          const byOrdRes = await signedBinanceRequest(
            'GET',
            tradesEndpoint,
            { symbol: sym, orderId: oid, limit: '1000' },
            'Spot',
            authSnap
          );
          if (byOrdRes.ok && Array.isArray(byOrdRes.data)) {
            const agg = aggregateTradesByOrderId(
              byOrdRes.data as Array<Record<string, unknown>>,
              'Spot'
            );
            for (const [k, v] of agg.entries()) tradeMetricsMap.set(k, v);
          }
        }
      } else {
        const filledTimes = rawOrders
          .filter((r) => Number(r.executedQty ?? 0) > 0)
          .map((r) => Number(r.updateTime ?? r.time ?? nowMs));
        const windows = buildBinanceSyncTimeWindows('Futures', lookback, nowMs).filter((win) =>
          filledTimes.some((ts) => ts >= win.startTime - 60_000 && ts <= win.endTime + 60_000)
        );
        const allTrades: Array<Record<string, unknown>> = [];
        for (const win of windows) {
          let cursorStart = win.startTime;
          for (let page = 0; page < 10 && cursorStart <= win.endTime; page += 1) {
            const trRes = await signedBinanceRequest(
              'GET',
              tradesEndpoint,
              { symbol: sym, startTime: cursorStart, endTime: win.endTime, limit: '1000' },
              'Futures',
              authSnap
            );
            if (!trRes.ok || !Array.isArray(trRes.data)) break;
            const list = trRes.data as Array<Record<string, unknown>>;
            allTrades.push(...list);
            const lastTs = list.reduce((mx, row) => Math.max(mx, Number(row.time ?? 0)), cursorStart);
            if (list.length < 1000 || lastTs < cursorStart) break;
            cursorStart = lastTs + 1;
          }
        }
        const agg = aggregateTradesByOrderId(allTrades, 'Futures');
        for (const [k, v] of agg.entries()) tradeMetricsMap.set(k, v);
      }
    }

    const mapped: BackendOrderExecutionLog[] = rawOrders.map((raw, idx) => {
      const ordId = String(raw.orderId ?? Date.now() + idx);
      const binSide: 'BUY' | 'SELL' =
        String(raw.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const executedQty = Number(raw.executedQty ?? 0) || 0;
      const origQty = Number(raw.origQty ?? executedQty) || 0;
      const quoteQtyRaw = Number(raw.cummulativeQuoteQty ?? raw.cumQuote ?? 0);
      const quoteQty = quoteQtyRaw > 0 ? quoteQtyRaw : 0;
      const limitPrice = Number(raw.price ?? 0) || 0;
      const rawAvgPrice = Number(raw.avgPrice ?? 0) || 0;
      const effAvgPrice =
        rawAvgPrice > 0
          ? rawAvgPrice
          : executedQty > 0 && quoteQty > 0
            ? quoteQty / executedQty
            : limitPrice;
      const stopPrice = Number(raw.stopPrice ?? 0) || 0;
      const activatePrice =
        raw.activatePrice !== undefined && Number(raw.activatePrice) > 0
          ? Number(raw.activatePrice)
          : null;
      const priceRate =
        raw.priceRate !== undefined && Number(raw.priceRate) > 0
          ? Number(raw.priceRate)
          : null;
      const statusRaw = String(raw.status ?? 'NEW').toUpperCase();
      const normStatus: BackendOrderExecutionLog['status'] =
        statusRaw === 'FILLED' ||
        statusRaw === 'PARTIALLY_FILLED' ||
        statusRaw === 'NEW' ||
        statusRaw === 'CANCELED' ||
        statusRaw === 'PENDING_CANCEL' ||
        statusRaw === 'REJECTED' ||
        statusRaw === 'EXPIRED' ||
        statusRaw === 'EXPIRED_IN_MATCH'
          ? statusRaw
          : 'NEW';
      const orderTimeMs = Number(raw.time ?? raw.updateTime ?? nowMs);
      const updateTimeMs = Number(raw.updateTime ?? raw.time ?? nowMs);
      const workingTimeMs =
        raw.workingTime !== undefined && Number(raw.workingTime) > 0
          ? Number(raw.workingTime)
          : null;
      const isReduceOnly = Boolean(raw.reduceOnly);
      const closePosition = Boolean(raw.closePosition);
      const priceProtect = Boolean(raw.priceProtect);
      const posSideRaw = String(raw.positionSide ?? 'BOTH').toUpperCase();
      const positionSide: 'BOTH' | 'LONG' | 'SHORT' =
        posSideRaw === 'LONG' || posSideRaw === 'SHORT' ? posSideRaw : 'BOTH';
      const isHedgeExit =
        (positionSide === 'LONG' && binSide === 'SELL') ||
        (positionSide === 'SHORT' && binSide === 'BUY');
      const isSpotExit = targetVenue === 'Spot' && binSide === 'SELL';
      const isExit = isReduceOnly || closePosition || isSpotExit || isHedgeExit;
      const tradeEnrich = tradeMetricsMap.get(ordId);
      const orderType = String(raw.type ?? 'MARKET').toUpperCase();
      const origType = String(raw.origType ?? orderType).toUpperCase();
      const timeInForce = String(raw.timeInForce ?? 'GTC').toUpperCase();
      const workingType =
        targetVenue === 'Futures'
          ? String(raw.workingType ?? 'MARK_PRICE').toUpperCase() === 'CONTRACT_PRICE'
            ? 'CONTRACT_PRICE'
            : 'MARK_PRICE'
          : undefined;
      const stpMode = String(raw.selfTradePreventionMode ?? 'NONE').toUpperCase();

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
        environment: authSnap.environment,
        accountMode: 'Live',
        source: 'binance_all_orders',
        lifecycle:
          normStatus === 'CANCELED' || normStatus === 'EXPIRED' || normStatus === 'EXPIRED_IN_MATCH'
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
        positionSide,
        orderType,
        origType,
        timeInForce,
        status: normStatus,
        price: limitPrice > 0 ? limitPrice : effAvgPrice,
        avgPrice: effAvgPrice,
        stopPrice,
        activatePrice,
        priceRate,
        executedQty,
        origQty,
        quoteQty: quoteQty > 0 ? quoteQty : effAvgPrice * executedQty,
        commission: tradeEnrich?.commission ?? 0,
        commissionAsset: tradeEnrich?.commissionAsset ?? 'USDT',
        isMaker:
          tradeEnrich?.isMaker ??
          (orderType === 'LIMIT_MAKER' || timeInForce === 'GTX'),
        reduceOnly: isReduceOnly,
        closePosition,
        priceProtect,
        workingType,
        selfTradePreventionMode: stpMode,
        realizedPnlUsdt: tradeEnrich?.realizedPnlUsdt ?? null,
        rMultiple: null,
        exitReason: null,
        latencyMs: lastLatencyMs ?? null,
        endpoint: `GET ${endpoint} (${lookback})`,
        rationale: `Synced from Binance ${targetVenue} ${endpoint} (${lookback})`,
        orderTimeMs,
        updateTimeMs,
        workingTimeMs,
        timestampMs: updateTimeMs,
      };
    });

    const mappedAlgo: BackendOrderExecutionLog[] = Array.from(collectedAlgoOrders.values())
      .filter((raw) => {
        // Avoid duplicating triggered algo orders whose actualOrderId already appears in regular allOrders
        const actualOid = raw.actualOrderId !== undefined ? String(raw.actualOrderId) : '';
        return !actualOid || !collectedRawOrders.has(actualOid);
      })
      .map((raw, idx) => {
        const algoIdStr = String(raw.algoId ?? Date.now() + idx);
        const binSide: 'BUY' | 'SELL' =
          String(raw.side ?? 'SELL').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
        const algoStatusRaw = String(raw.algoStatus ?? raw.status ?? 'NEW').toUpperCase();
        const normStatus: BackendOrderExecutionLog['status'] =
          algoStatusRaw === 'FILLED' || algoStatusRaw === 'TRIGGERED'
            ? 'FILLED'
            : algoStatusRaw === 'CANCELED' || algoStatusRaw === 'CANCELLED'
              ? 'CANCELED'
              : algoStatusRaw === 'REJECTED'
                ? 'REJECTED'
                : algoStatusRaw === 'EXPIRED'
                  ? 'EXPIRED'
                  : 'NEW';
        const triggerPrice = Number(raw.triggerPrice ?? raw.stopPrice ?? 0) || 0;
        const limitPrice = Number(raw.price ?? 0) || 0;
        const origQty = Number(raw.quantity ?? raw.origQty ?? 0) || 0;
        const createTime = Number(raw.createTime ?? raw.time ?? raw.updateTime ?? nowMs);
        const updateTime = Number(raw.updateTime ?? createTime);
        const posSideRaw = String(raw.positionSide ?? 'BOTH').toUpperCase();
        const positionSide: 'BOTH' | 'LONG' | 'SHORT' =
          posSideRaw === 'LONG' || posSideRaw === 'SHORT' ? posSideRaw : 'BOTH';
        const isExit =
          Boolean(raw.reduceOnly) ||
          Boolean(raw.closePosition) ||
          (positionSide === 'LONG' && binSide === 'SELL') ||
          (positionSide === 'SHORT' && binSide === 'BUY');
        return {
          id: `binance-algo-futures-${sym}-${algoIdStr}`,
          orderId: algoIdStr,
          algoId: algoIdStr,
          clientOrderId: String(raw.clientAlgoId ?? `algo_${algoIdStr}`),
          symbol: sym,
          venue: 'Futures',
          environment: authSnap.environment,
          accountMode: 'Live',
          source: 'binance_all_orders',
          lifecycle:
            normStatus === 'CANCELED' || normStatus === 'EXPIRED'
              ? 'CANCEL'
              : isExit
                ? 'EXIT'
                : 'ENTRY',
          side: isExit
            ? binSide === 'SELL'
              ? 'Long'
              : 'Short'
            : binSide === 'BUY'
              ? 'Long'
              : 'Short',
          binanceSide: binSide,
          positionSide,
          orderType: String(raw.orderType ?? raw.type ?? 'STOP_MARKET').toUpperCase(),
          origType: String(raw.orderType ?? raw.type ?? 'STOP_MARKET').toUpperCase(),
          timeInForce: String(raw.timeInForce ?? 'GTC').toUpperCase(),
          status: normStatus,
          price: limitPrice > 0 ? limitPrice : triggerPrice,
          avgPrice: limitPrice > 0 ? limitPrice : triggerPrice,
          stopPrice: triggerPrice,
          activatePrice: raw.activatePrice !== undefined ? Number(raw.activatePrice) || null : null,
          priceRate: raw.priceRate !== undefined ? Number(raw.priceRate) || null : null,
          executedQty: 0,
          origQty,
          quoteQty: origQty * (limitPrice > 0 ? limitPrice : triggerPrice),
          commission: 0,
          commissionAsset: 'USDT',
          isMaker: false,
          reduceOnly: Boolean(raw.reduceOnly),
          closePosition: Boolean(raw.closePosition),
          priceProtect: Boolean(raw.priceProtect),
          workingType:
            String(raw.workingType ?? 'MARK_PRICE').toUpperCase() === 'CONTRACT_PRICE'
              ? 'CONTRACT_PRICE'
              : 'MARK_PRICE',
          selfTradePreventionMode: String(raw.selfTradePreventionMode ?? 'NONE').toUpperCase(),
          realizedPnlUsdt: null,
          rMultiple: null,
          exitReason: null,
          latencyMs: lastLatencyMs ?? null,
          endpoint: `GET /fapi/v1/allAlgoOrders (${lookback})`,
          rationale: `Synced from Binance Futures /fapi/v1/allAlgoOrders (${lookback})`,
          orderTimeMs: createTime,
          updateTimeMs: updateTime,
          workingTimeMs: null,
          timestampMs: updateTime,
        };
      });

    const combinedMapped = [...mapped, ...mappedAlgo];
    if (combinedMapped.length > 0) {
      orderHistoryDb.upsertLogs(combinedMapped);
    }
    orderHistoryDb.recordSyncWatermark({
      symbol: sym,
      venue: targetVenue,
      environment: authSnap.environment,
      lookback,
      windowStartMs,
      syncedCount: combinedMapped.length,
      nowMs,
    });

    return {
      syncedCount: combinedMapped.length,
      latencyMs: lastLatencyMs,
      endpoint,
    };
  }

  function extractBinanceAlgoOrders(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) {
      return data as Array<Record<string, unknown>>;
    }
    if (
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { orders?: unknown[] }).orders)
    ) {
      return (data as { orders: Array<Record<string, unknown>> }).orders;
    }
    return [];
  }

  async function scanAccountOrphanPairs(
    configuredPairs: string[],
    targetVenue: ExchangeVenue
  ) {
    let exchangeOpenOrders: Array<Record<string, unknown>> = [];
    let exchangeAlgoOrders: Array<Record<string, unknown>> = [];
    let exchangePositions: Array<Record<string, unknown>> = [];
    let exchangeSpotBalances: Array<{ asset: string; free: number; locked: number }> = [];

    if (vault.apiKey && vault.apiSecret) {
      const openEndpoint = targetVenue === 'Futures' ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
      const openRes = await signedBinanceRequest('GET', openEndpoint, {}, targetVenue);
      if (openRes.ok && Array.isArray(openRes.data)) {
        exchangeOpenOrders = openRes.data as Array<Record<string, unknown>>;
      }
      if (targetVenue === 'Futures') {
        const algoRes = await signedBinanceRequest('GET', '/fapi/v1/openAlgoOrders', {}, 'Futures');
        if (algoRes.ok) {
          exchangeAlgoOrders = extractBinanceAlgoOrders(algoRes.data);
        }
        const posRes = await signedBinanceRequest('GET', '/fapi/v2/positionRisk', {}, 'Futures');
        if (posRes.ok && Array.isArray(posRes.data)) {
          exchangePositions = posRes.data as Array<Record<string, unknown>>;
        }
      } else {
        const accRes = await signedBinanceRequest('GET', '/api/v3/account', {}, 'Spot');
        if (accRes.ok && Array.isArray(accRes.data.balances)) {
          exchangeSpotBalances = (accRes.data.balances as Array<Record<string, unknown>>).map((b) => ({
            asset: String(b.asset ?? ''),
            free: Number(b.free ?? 0) || 0,
            locked: Number(b.locked ?? 0) || 0,
          }));
        }
      }
    }

    return detectOrphanPairs({
      configuredPairs,
      venue: targetVenue,
      environment: vault.environment,
      dbLogs: orderHistoryDb.getAllLogs(),
      exchangeOpenOrders,
      exchangeAlgoOrders,
      exchangePositions,
      exchangeSpotBalances,
    });
  }

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
    const lookback = normalizeLookbackPreset(req.query.lookback);
    const includeOrphans = req.query.includeOrphans === '1' || req.query.includeOrphans === 'true';
    const limitParam = Math.min(2000, Math.max(1, Number(req.query.limit ?? 500) || 500));

    let syncResult:
      | {
          synced: boolean;
          count?: number;
          lookback?: SyncLookbackPreset;
          symbolsSynced?: string[];
          orphanCount?: number;
          latencyMs?: number;
          endpoint?: string;
          error?: string;
        }
      | undefined;

    if (syncBinance) {
      if (!vault.apiKey || !vault.apiSecret) {
        syncResult = {
          synced: false,
          lookback,
          error:
            'Live API credentials are not configured in the server vault. Add credentials in Bot -> Live Credentials to pull Binance allOrders.',
        };
      } else {
        const targetVenue = venueParam ?? vault.venue;
        const symbolsQuery =
          typeof req.query.symbols === 'string' && req.query.symbols.trim().length > 0
            ? req.query.symbols
                .split(',')
                .map((s) => sanitizeSymbol(s))
                .filter(Boolean)
            : null;
        const baseSymbols = symbolParam
          ? [symbolParam]
          : symbolsQuery && symbolsQuery.length > 0
            ? symbolsQuery
            : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'];
        const targetSet = new Set<string>(baseSymbols);
        let orphanCount = 0;

        if (includeOrphans && !symbolParam) {
          try {
            const orphans = await scanAccountOrphanPairs(baseSymbols, targetVenue);
            orphanCount = orphans.length;
            for (const o of orphans) {
              targetSet.add(o.symbol);
            }
          } catch {
            // Continue syncing base symbols
          }
        }

        const targetSymbols = Array.from(targetSet);
        const endpoint = targetVenue === 'Futures' ? '/fapi/v1/allOrders' : '/api/v3/allOrders';
        try {
          let totalSynced = 0;
          let lastLatencyMs: number | undefined;
          let firstError: string | undefined;

          for (const targetSymbol of targetSymbols) {
            const resSync = await syncSymbolHistoryFromBinance(targetSymbol, targetVenue, lookback);
            if (resSync.latencyMs !== undefined) lastLatencyMs = resSync.latencyMs;
            if (resSync.error && !firstError) firstError = resSync.error;
            totalSynced += resSync.syncedCount;
          }

          if (totalSynced === 0 && firstError) {
            syncResult = {
              synced: false,
              lookback,
              symbolsSynced: targetSymbols,
              orphanCount,
              latencyMs: lastLatencyMs,
              endpoint,
              error: firstError,
            };
          } else {
            syncResult = {
              synced: true,
              count: totalSynced,
              lookback,
              symbolsSynced: targetSymbols,
              orphanCount,
              latencyMs: lastLatencyMs,
              endpoint,
            };
          }
        } catch (err) {
          syncResult = {
            synced: false,
            lookback,
            endpoint,
            error: err instanceof Error ? err.message : 'Failed to query Binance allOrders',
          };
        }
      }
    }

    const filtered = orderHistoryDb.queryLogs({
      symbol: symbolParam,
      venue: venueParam,
      environment: envParam,
      status: statusParam,
      accountMode: accountModeParam,
      limit: limitParam,
    });

    res.json({
      ok: true,
      total: filtered.length,
      logs: filtered,
      dbSummary: orderHistoryDb.getSummary(),
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

    const { added, updated, total } = orderHistoryDb.upsertLogs(valid);
    res.json({ ok: true, added, updated, total, dbSummary: orderHistoryDb.getSummary() });
  });

  app.post('/api/orders/history/import', (req, res) => {
    const body = req.body as { logs?: unknown[] } | undefined;
    const rawItems = Array.isArray(body?.logs) ? body!.logs : [];
    const valid = rawItems
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
        venue: String(item.venue ?? '').toLowerCase() === 'futures' ? ('Futures' as const) : ('Spot' as const),
        environment: item.environment === 'Production' ? ('Production' as const) : ('Testnet' as const),
        accountMode: item.accountMode === 'Live' ? ('Live' as const) : ('Paper' as const),
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
      res.status(400).json({ ok: false, error: 'No valid order logs found in import payload.' });
      return;
    }
    const { added, updated, total } = orderHistoryDb.upsertLogs(valid);
    res.json({ ok: true, added, updated, total, dbSummary: orderHistoryDb.getSummary() });
  });

  app.delete('/api/orders/history', (req, res) => {
    const mode =
      req.query.accountMode === 'Live'
        ? 'Live'
        : req.query.accountMode === 'Paper'
          ? 'Paper'
          : 'ALL';
    const symbol =
      typeof req.query.symbol === 'string' && req.query.symbol
        ? sanitizeSymbol(req.query.symbol)
        : undefined;
    const olderThanDays =
      typeof req.query.olderThanDays === 'string' && Number(req.query.olderThanDays) > 0
        ? Number(req.query.olderThanDays)
        : undefined;
    const confirmAll =
      String(req.query.confirmAll ?? req.body?.confirmAll ?? '')
        .trim()
        .toLowerCase() === 'true' || req.body?.confirmAll === true;
    if (mode === 'ALL' && !symbol && !olderThanDays && !confirmAll) {
      res.status(400).json({
        ok: false,
        error:
          'Refusing unfiltered DELETE without accountMode (Paper|Live), symbol, olderThanDays, or confirmAll=true',
      });
      return;
    }
    const { deleted, remaining } = orderHistoryDb.deleteLogs({
      accountMode: mode,
      symbol,
      olderThanDays,
    });
    res.json({ ok: true, deleted, remaining, dbSummary: orderHistoryDb.getSummary() });
  });

  app.get('/api/orders/orphans', asyncRoute(async (req, res) => {
    const targetVenue: ExchangeVenue =
      req.query.venue === 'Futures' ? 'Futures' : req.query.venue === 'Spot' ? 'Spot' : vault.venue;
    const configuredPairs =
      typeof req.query.configuredPairs === 'string' && req.query.configuredPairs.trim().length > 0
        ? req.query.configuredPairs
            .split(',')
            .map((s) => sanitizeSymbol(s))
            .filter(Boolean)
        : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'];

    const orphans = await scanAccountOrphanPairs(configuredPairs, targetVenue);
    res.json({
      ok: true,
      venue: targetVenue,
      environment: vault.environment,
      configured: Boolean(vault.apiKey && vault.apiSecret),
      orphans,
      dbSummary: orderHistoryDb.getSummary(),
    });
  }));

  app.post('/api/orders/orphans/resolve', asyncRoute(async (req, res) => {
    const body = req.body as
      | {
          symbol?: string;
          venue?: ExchangeVenue;
          action?: OrphanResolutionAction;
          lookback?: SyncLookbackPreset;
        }
      | undefined;
    const symbol = sanitizeSymbol(body?.symbol);
    const targetVenue: ExchangeVenue =
      body?.venue === 'Futures' ? 'Futures' : body?.venue === 'Spot' ? 'Spot' : vault.venue;
    const action = body?.action;
    if (!symbol || !action) {
      res.status(400).json({ ok: false, error: 'symbol and action are required.' });
      return;
    }

    if (action === 'purge_local_records') {
      const { deleted, remaining } = orderHistoryDb.deleteLogs({
        accountMode: 'Live',
        symbol,
      });
      res.json({
        ok: true,
        action,
        symbol,
        message: `Purged ${deleted} local record(s) for ${symbol} (${remaining} remaining).`,
        dbSummary: orderHistoryDb.getSummary(),
      });
      return;
    }

    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({
        ok: false,
        error: 'Live Binance API credentials are required in the server vault for exchange reconciliation.',
      });
      return;
    }

    if (action === 'sync_history' || action === 'adopt_pair') {
      const lookback = normalizeLookbackPreset(body?.lookback ?? '7d');
      const syncRes = await syncSymbolHistoryFromBinance(symbol, targetVenue, lookback);
      res.json({
        ok: !syncRes.error,
        action,
        symbol,
        syncedCount: syncRes.syncedCount,
        message: syncRes.error
          ? syncRes.error
          : `Synced ${syncRes.syncedCount} order(s) for ${symbol} (${lookback}).`,
        dbSummary: orderHistoryDb.getSummary(),
      });
      return;
    }

    if (action === 'reconcile_orders') {
      const staleLogs = orderHistoryDb
        .getAllLogs()
        .filter(
          (l) =>
            l.accountMode === 'Live' &&
            l.venue === targetVenue &&
            l.environment === vault.environment &&
            l.symbol === symbol &&
            (l.status === 'NEW' || l.status === 'PARTIALLY_FILLED')
        );
      const endpoint = targetVenue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
      const updatedEntries: BackendOrderExecutionLog[] = [];
      const reconcileErrors: string[] = [];
      for (const stale of staleLogs) {
        const isAlgoRecord = Boolean(stale.algoId) || stale.endpoint.includes('algoOrder');
        let qRes =
          targetVenue === 'Futures' && isAlgoRecord
            ? await signedBinanceRequest('GET', '/fapi/v1/algoOrder', { algoId: stale.algoId || stale.orderId }, 'Futures')
            : await signedBinanceRequest('GET', endpoint, { symbol, orderId: stale.orderId }, targetVenue);
        if (!qRes.ok && targetVenue === 'Futures' && !isAlgoRecord && Number(qRes.data?.code) === -2013) {
          const algoLookup = await signedBinanceRequest('GET', '/fapi/v1/algoOrder', { algoId: stale.orderId }, 'Futures');
          if (algoLookup.ok) {
            qRes = algoLookup;
          }
        }
        if (qRes.ok) {
          const statusRaw = String(qRes.data.algoStatus ?? qRes.data.status ?? stale.status).toUpperCase();
          const executedQty = Number(qRes.data.executedQty ?? stale.executedQty) || 0;
          const quoteQty = Number(qRes.data.cummulativeQuoteQty ?? qRes.data.cumQuote ?? stale.quoteQty) || 0;
          const avgPrice =
            executedQty > 0 && quoteQty > 0
              ? quoteQty / executedQty
              : Number(qRes.data.avgPrice ?? qRes.data.price ?? qRes.data.triggerPrice ?? stale.price) || stale.price;
          updatedEntries.push({
            ...stale,
            status: (statusRaw as BackendOrderExecutionLog['status']) || 'CANCELED',
            executedQty,
            quoteQty,
            avgPrice,
            updateTimeMs: Number(qRes.data.updateTime ?? Date.now()),
            timestampMs: Number(qRes.data.updateTime ?? Date.now()),
            rationale: `${stale.rationale} · Reconciled (${statusRaw})`,
          });
        } else if (Number(qRes.data?.code) === -2013) {
          // Official Binance error -2013 ("Order does not exist.") -> mark CANCELED so it no longer blocks as a ghost open order
          updatedEntries.push({
            ...stale,
            status: 'CANCELED',
            updateTimeMs: Date.now(),
            timestampMs: Date.now(),
            rationale: `${stale.rationale} · Marked CANCELED (-2013 order does not exist on exchange)`,
          });
        } else {
          reconcileErrors.push(
            `Order #${stale.orderId}: Binance ${qRes.data?.code ?? qRes.status} (${String(qRes.data?.msg ?? 'Query failed')})`
          );
        }
      }
      if (updatedEntries.length > 0) {
        orderHistoryDb.upsertLogs(updatedEntries);
      }
      const allFailed = updatedEntries.length === 0 && reconcileErrors.length > 0;
      res.json({
        ok: !allFailed,
        action,
        symbol,
        reconciledCount: updatedEntries.length,
        message: allFailed
          ? reconcileErrors.join('; ')
          : reconcileErrors.length > 0
            ? `Reconciled ${updatedEntries.length} order(s) for ${symbol} (${reconcileErrors.join('; ')}).`
            : `Reconciled ${updatedEntries.length} stale order(s) for ${symbol} via ${endpoint}.`,
        dbSummary: orderHistoryDb.getSummary(),
      });
      return;
    }

    if (action === 'cancel_exchange_orders') {
      const cancelEndpoint =
        targetVenue === 'Futures' ? '/fapi/v1/allOpenOrders' : '/api/v3/openOrders';
      const cancelRes = await signedBinanceRequest(
        'DELETE',
        cancelEndpoint,
        { symbol },
        targetVenue
      );
      let algoCancelOk = targetVenue !== 'Futures';
      let algoErrMsg = '';
      if (targetVenue === 'Futures') {
        const algoDelRes = await signedBinanceRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }, 'Futures');
        const benignNoAlgo = Number(algoDelRes.data?.code) === -2011;
        algoCancelOk = algoDelRes.ok || benignNoAlgo;
        if (!algoCancelOk) {
          algoErrMsg = `algoOpenOrders: Binance ${algoDelRes.data?.code ?? algoDelRes.status} (${String(algoDelRes.data?.msg ?? 'Cancel failed')})`;
        }
      }
      // Binance returns -2011 ("Unknown order sent") when a symbol has 0 regular open orders
      const isBenignNoOpenOrders = Number(cancelRes.data?.code) === -2011;
      const regularOk = cancelRes.ok || isBenignNoOpenOrders;
      const effectiveOk = regularOk && algoCancelOk;
      if (effectiveOk) {
        const staleLogs = orderHistoryDb
          .getAllLogs()
          .filter(
            (l) =>
              l.accountMode === 'Live' &&
              l.venue === targetVenue &&
              l.environment === vault.environment &&
              l.symbol === symbol &&
              (l.status === 'NEW' || l.status === 'PARTIALLY_FILLED')
          )
          .map((l) => ({
            ...l,
            status: 'CANCELED' as const,
            updateTimeMs: Date.now(),
            timestampMs: Date.now(),
          }));
        if (staleLogs.length > 0) {
          orderHistoryDb.upsertLogs(staleLogs);
        }
      }
      res.json({
        ok: effectiveOk,
        action,
        symbol,
        message: effectiveOk
          ? `Canceled open exchange & algo orders for ${symbol}.`
          : [
              !regularOk
                ? `Binance ${cancelRes.data.code ?? cancelRes.status}: ${String(cancelRes.data.msg ?? 'Cancel failed')}`
                : null,
              algoErrMsg || null,
            ]
              .filter(Boolean)
              .join('; '),
        dbSummary: orderHistoryDb.getSummary(),
      });
      return;
    }

    res.status(400).json({ ok: false, error: `Unsupported orphan resolution action: ${String(action)}` });
  }));

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

  // ---------- 24/7 VPS Rust Daemon Engine Gateway (/api/engine/* -> bot-web 127.0.0.1:8080) ----------

  app.use('/api/engine', asyncRoute(async (req, res) => {
    const subPath = req.path || '/';
    if (!isEnginePathAllowed(req.method, subPath)) {
      res.status(404).json({
        ok: false,
        error: `Disallowed or unknown VPS Engine Gateway route: ${req.method} /api/engine${subPath}`,
      });
      return;
    }

    const rawSubUrl = req.url || subPath || '/';
    const normalizedSubUrl = rawSubUrl.startsWith('/') ? rawSubUrl : `/${rawSubUrl}`;
    const upstreamUrl = `${getEngineBaseUrl()}/api${normalizedSubUrl}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const engTok = getEngineAuthToken();
    if (engTok) {
      headers.Authorization = `Bearer ${engTok}`;
      headers['X-ApexRust-Token'] = engTok;
    }
    const hasBody = req.method === 'POST' || req.method === 'DELETE';
    let bodyStr: string | undefined;
    if (hasBody && req.body && Object.keys(req.body as Record<string, unknown>).length > 0) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(req.body);
    }

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(5000),
      });
      const text = await upstreamResp.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }
      res.status(upstreamResp.status).json(parsed);
    } catch (err) {
      res.status(502).json({
        ok: false,
        engineReachable: false,
        error:
          err instanceof Error
            ? `24/7 VPS Rust Trading Daemon is not reachable at ${getEngineBaseUrl()}: ${err.message}`
            : `24/7 VPS Rust Trading Daemon is not reachable at ${getEngineBaseUrl()}`,
      });
    }
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
  const isCloudRun = Boolean(process.env.K_SERVICE);
  const defaultHost = isCloudRun ? '0.0.0.0' : '127.0.0.1';
  const host = (process.env.HOST || defaultHost).trim() || defaultHost;
  const configuredToken = (process.env.APEXRUST_PROXY_TOKEN ?? '').trim();
  const trustZeroTrustMesh =
    (process.env.APEXRUST_TRUST_ZERO_TRUST_MESH ?? '').trim().toLowerCase() === 'true';

  const bindSafety = evaluateBindSafety(host, configuredToken, {
    isCloudRun,
    trustZeroTrustMesh,
  });
  if (!bindSafety.ok) {
    console.error(`[server] Security bind check failed: ${bindSafety.reason}`);
    process.exit(1);
  }

  app.listen(port, host, () => {
    console.log(
      `ApexRust server listening on http://${host}:${port} (authority=${getEngineAuthority()}, tokenAuth=${
        configuredToken ? 'enabled' : 'mesh-trusted'
      })`
    );
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start ApexRust server:', err);
  process.exit(1);
});
