import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';

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
const initialSecret =
  (initialAuth === 'Ed25519'
    ? process.env.BINANCE_ED25519_PRIVATE_KEY
    : process.env.BINANCE_API_SECRET) ?? '';

const vault: ServerVaultState = {
  environment: initialEnv,
  venue: initialVenue,
  leverage: 3,
  marginType: 'ISOLATED',
  authMethod: initialAuth,
  apiKey: initialKey,
  apiSecret: initialSecret.trim(),
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
    return env === 'Production'
      ? 'https://fapi.binance.com'
      : 'https://testnet.binancefuture.com';
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
  stepSize: number;
  stepDecimals: number;
  fetchedAtMs: number;
}

const symbolFilterCache = new Map<string, SymbolFilters>();

function countStepDecimals(stepStr: string): number {
  if (!stepStr || !stepStr.includes('.')) return 0;
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
          filters?: Array<{
            filterType?: string;
            tickSize?: string;
            stepSize?: string;
          }>;
        }>;
      };
      const symEntry =
        payload.symbols?.find((s) => s.symbol === symbol) ?? payload.symbols?.[0];
      const filters = symEntry?.filters ?? [];
      const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');
      const tickSize =
        Number(priceFilter?.tickSize ?? '0') || (fallbackPrice >= 100 ? 0.01 : 0.0001);
      const stepSize = Number(lotFilter?.stepSize ?? '0') || (venue === 'Futures' ? 0.001 : 0.00001);
      const resolved: SymbolFilters = {
        tickSize,
        tickDecimals: countStepDecimals(
          priceFilter?.tickSize ?? (fallbackPrice >= 100 ? '0.01' : '0.0001')
        ),
        stepSize,
        stepDecimals: countStepDecimals(lotFilter?.stepSize ?? (venue === 'Futures' ? '0.001' : '0.00001')),
        fetchedAtMs: Date.now(),
      };
      symbolFilterCache.set(key, resolved);
      return resolved;
    }
  } catch {
    // Fallback to heuristic precision below if exchangeInfo cannot be reached
  }

  const tickDecimals = fallbackPrice >= 100 ? 2 : 4;
  return {
    tickSize: Math.pow(10, -tickDecimals),
    tickDecimals,
    stepSize: venue === 'Futures' ? 0.001 : 0.00001,
    stepDecimals: venue === 'Futures' ? 3 : 5,
    fetchedAtMs: Date.now(),
  };
}

async function fetchPublicPrice(symbol: string, venue: ExchangeVenue): Promise<number> {
  try {
    const baseUrl = getRestBaseUrl(vault.environment, venue);
    const tickerPath =
      venue === 'Futures'
        ? `${baseUrl}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`
        : `${baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(tickerPath, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const json = (await resp.json()) as { price?: string };
      const px = Number(json.price ?? 0);
      if (Number.isFinite(px) && px > 0) return px;
    }
  } catch {
    // Ignore transient errors
  }
  return 0;
}

const serverTimeOffsetCache = new Map<string, { offsetMs: number; syncedAtMs: number }>();

async function getSyncedBinanceTimestamp(venue: ExchangeVenue): Promise<number> {
  const key = `${vault.environment}:${venue}`;
  const cached = serverTimeOffsetCache.get(key);
  if (cached && Date.now() - cached.syncedAtMs < 300_000) {
    return Date.now() + cached.offsetMs;
  }
  try {
    const baseUrl = getRestBaseUrl(vault.environment, venue);
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
  venue: ExchangeVenue = vault.venue
) {
  const baseUrl = getRestBaseUrl(vault.environment, venue);
  const syncedTimestamp = await getSyncedBinanceTimestamp(venue);
  const allParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    allParams.set(k, String(v));
  }
  allParams.set('recvWindow', String(vault.recvWindowMs));
  allParams.set('timestamp', String(syncedTimestamp));

  const query = allParams.toString();
  const signature = signPayload(query, vault.authMethod, vault.apiSecret);
  const signedQuery = `${query}&signature=${encodeURIComponent(signature)}`;

  const url =
    method === 'GET' || method === 'DELETE'
      ? `${baseUrl}${endpointPath}?${signedQuery}`
      : `${baseUrl}${endpointPath}`;

  const startedAt = Date.now();
  const resp = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': vault.apiKey,
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
  const required = ['.env', '.env.*', '*.pem', 'node_modules/', 'dist/'];
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

function buildSyncedTomlFromPayload(body: Record<string, unknown>): string {
  const cfg = (body.config ?? {}) as Record<string, unknown>;
  const trading = (cfg.trading ?? {}) as Record<string, unknown>;
  const automation = (cfg.automation ?? {}) as Record<string, unknown>;
  const exits = (cfg.exits ?? {}) as Record<string, unknown>;
  const risk = (cfg.risk ?? {}) as Record<string, unknown>;
  const features = (cfg.features ?? {}) as Record<string, unknown>;
  const pairs = Array.isArray(trading.pairs) ? (trading.pairs as string[]) : ['BTCUSDT', 'ETHUSDT'];

  return [
    '# Auto-generated by ApexRust Web Control Plane Git Backup Sync',
    `# Generated At: ${new Date().toISOString()}`,
    '# NOTE: API secrets are intentionally excluded and must stay in environment variables.',
    '',
    '[exchange]',
    `environment = "${vault.environment.toLowerCase()}"`,
    `venue = "${String(trading.venue ?? vault.venue).toLowerCase()}"`,
    `leverage = ${Number(trading.leverage ?? vault.leverage)}`,
    `margin_type = "${String(trading.marginType ?? vault.marginType)}"`,
    '',
    '[trading]',
    `mode = "${String(trading.mode ?? 'scalping')}"`,
    `timeframe = "${String(trading.timeframe ?? '5m')}"`,
    `pairs = [${pairs.map((p) => `"${p}"`).join(', ')}]`,
    `max_concurrent_positions = ${Number(trading.maxConcurrentPositions ?? 3)}`,
    `base_risk_per_trade_pct = ${Number(trading.baseRiskPerTradePct ?? 0.75)}`,
    '',
    '[automation]',
    `enabled = ${Boolean(automation.enabled ?? true)}`,
    `strategy_profile = "${String(automation.strategyProfile ?? 'trend_pullback')}"`,
    `direction_policy = "${String(automation.directionPolicy ?? 'long_only')}"`,
    `order_method = "${String(automation.orderMethod ?? 'MARKET')}"`,
    `auto_order_notional_usdt = ${Number(automation.autoOrderNotionalUsdt ?? 150)}`,
    '',
    '[exits]',
    `atr_sl_multiplier = ${Number(exits.atrSlMultiplier ?? 1.5)}`,
    `atr_tp1_multiplier = ${Number(exits.atrTp1Multiplier ?? 2.25)}`,
    `atr_tp2_multiplier = ${Number(exits.atrTp2Multiplier ?? 3.75)}`,
    `break_even_trigger_r = ${Number(exits.breakEvenTriggerR ?? 1.0)}`,
    `atr_trailing_multiplier = ${Number(exits.atrTrailingMultiplier ?? 1.4)}`,
    '',
    '[risk]',
    `max_daily_drawdown_pct = ${Number(risk.maxDailyDrawdownPct ?? 3.0)}`,
    `max_pair_daily_drawdown_pct = ${Number(risk.maxPairDailyDrawdownPct ?? 1.25)}`,
    `max_daily_profit_pct = ${Number(risk.maxDailyProfitPct ?? 5.0)}`,
    `max_win_streak = ${Number(risk.maxWinStreak ?? 5)}`,
    `max_lose_streak = ${Number(risk.maxLoseStreak ?? 3)}`,
    '',
    '[features]',
    ...Object.entries(features).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ${Boolean(v)}`),
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

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'apexrust-control-proxy',
      environment: vault.environment,
      venue: vault.venue,
    });
  });

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

    const nextEnv: BinanceEnv = body.environment === 'Production' ? 'Production' : 'Testnet';
    const nextVenue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : 'Spot';
    const nextMargin: MarginType = body.marginType === 'CROSSED' ? 'CROSSED' : 'ISOLATED';
    const nextAuth: AuthMethod = body.authMethod === 'Ed25519' ? 'Ed25519' : 'HMAC-SHA256';
    const nextKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const nextSecret = typeof body.apiSecret === 'string' ? body.apiSecret.trim() : '';

    const keyChanged = nextKey.length > 0 && nextKey !== vault.apiKey;
    const secretChanged = nextSecret.length > 0 && nextSecret !== vault.apiSecret;
    const envChanged =
      nextEnv !== vault.environment ||
      nextVenue !== vault.venue ||
      nextAuth !== vault.authMethod;

    vault.environment = nextEnv;
    vault.venue = nextVenue;
    vault.marginType = nextMargin;
    vault.authMethod = nextAuth;
    if (typeof body.leverage === 'number' && Number.isFinite(body.leverage)) {
      vault.leverage = Math.min(20, Math.max(1, Math.round(body.leverage)));
    }
    if (nextKey.length > 0) vault.apiKey = nextKey;
    if (nextSecret.length > 0) vault.apiSecret = nextSecret;

    if (typeof body.recvWindowMs === 'number' && Number.isFinite(body.recvWindowMs)) {
      vault.recvWindowMs = Math.min(60_000, Math.max(1000, Math.round(body.recvWindowMs)));
    }
    if (typeof body.maxOrderNotionalUsdt === 'number' && Number.isFinite(body.maxOrderNotionalUsdt)) {
      vault.maxOrderNotionalUsdt = Math.max(10, Number(body.maxOrderNotionalUsdt.toFixed(2)));
    }
    if (typeof body.requirePreflightTestOrder === 'boolean') {
      vault.requirePreflightTestOrder = body.requirePreflightTestOrder;
    }

    if (keyChanged || secretChanged || envChanged) {
      vault.armedForLiveOrders = false;
      vault.verificationStatus = 'unverified';
      vault.verificationMessage = `Vault updated (${vault.environment} · ${vault.venue}) — run Verify Connection before arming.`;
      vault.lastVerifiedAt = null;
      vault.canTrade = false;
      vault.permissions = [];
      vault.syncedBalances = [];
    }

    // Allow venue/leverage-only updates if credentials were not requested when keys already exist or during pre-config
    if (!vault.apiKey || !vault.apiSecret) {
      if (nextKey || nextSecret) {
        res.status(400).json({
          error: 'Both API Key and Secret / Private Key are required to configure live credentials.',
          status: getSafeStatus(),
        });
        return;
      }
    }

    res.json({ ok: true, status: getSafeStatus() });
  });

  app.post('/api/live/verify', async (_req, res) => {
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
      vault.verificationMessage =
        err instanceof Error
          ? `Unable to reach ${getRestBaseUrl(vault.environment, vault.venue)}: ${err.message}`
          : 'Network error contacting Binance API';
      res.status(200).json({ ok: false, status: getSafeStatus() });
    }
  });

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

  app.post('/api/live/order', async (req, res) => {
    const body = (req.body ?? {}) as {
      venue?: ExchangeVenue;
      symbol?: string;
      side?: 'BUY' | 'SELL';
      type?: 'MARKET' | 'LIMIT' | 'LIMIT_MAKER' | 'OCO';
      quoteOrderQty?: number;
      quantity?: number;
      price?: number;
      takeProfitPrice?: number;
      stopLossPrice?: number;
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

    const venue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : body.venue === 'Spot' ? 'Spot' : vault.venue;
    const symbol = (body.symbol ?? 'BTCUSDT').toUpperCase();
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

    const baseEntryType = orderType === 'OCO' ? 'MARKET' : orderType;
    const orderParams: Record<string, string | number> = {
      symbol,
      side,
      type:
        venue === 'Futures' && baseEntryType === 'LIMIT_MAKER'
          ? 'LIMIT'
          : baseEntryType,
      newOrderRespType: 'RESULT',
    };

    let refPrice = requestedPrice > 0 ? requestedPrice : 0;
    if (refPrice <= 0 && (venue === 'Futures' || orderType === 'OCO')) {
      refPrice = await fetchPublicPrice(symbol, venue);
    }
    const filters = await getSymbolFilters(symbol, refPrice > 0 ? refPrice : 100, venue);

    if (baseEntryType === 'MARKET') {
      if (Number.isFinite(requestedQty) && requestedQty > 0) {
        const formattedQty = floorToStep(requestedQty, filters.stepSize, filters.stepDecimals);
        if (Number(formattedQty) <= 0) {
          res.status(400).json({ error: 'Formatted MARKET quantity rounds to 0 under Binance LOT_SIZE.' });
          return;
        }
        orderParams.quantity = formattedQty;
      } else {
        if (!Number.isFinite(requestedNotional) || requestedNotional <= 0) {
          res.status(400).json({ error: 'quoteOrderQty or quantity must be greater than 0.' });
          return;
        }
        if (requestedNotional > vault.maxOrderNotionalUsdt) {
          res.status(400).json({
            error: `Order notional $${requestedNotional.toFixed(2)} exceeds server safety cap ($${vault.maxOrderNotionalUsdt.toFixed(2)}).`,
          });
          return;
        }
        if (venue === 'Futures') {
          if (refPrice <= 0) {
            res.status(400).json({ error: 'Futures MARKET order requires reference price or explicit quantity.' });
            return;
          }
          const formattedQty = floorToStep(
            requestedNotional / refPrice,
            filters.stepSize,
            filters.stepDecimals
          );
          if (Number(formattedQty) <= 0) {
            res.status(400).json({ error: 'Computed Futures quantity rounds to 0 under LOT_SIZE.' });
            return;
          }
          orderParams.quantity = formattedQty;
        } else {
          orderParams.quoteOrderQty = requestedNotional.toFixed(2);
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
      if (effectiveNotional > vault.maxOrderNotionalUsdt) {
        res.status(400).json({
          error: `Order notional $${effectiveNotional.toFixed(2)} exceeds server safety cap ($${vault.maxOrderNotionalUsdt.toFixed(2)}).`,
        });
        return;
      }
      const formattedPrice = floorToStep(requestedPrice, filters.tickSize, filters.tickDecimals);
      const rawQty =
        Number.isFinite(requestedQty) && requestedQty > 0
          ? requestedQty
          : effectiveNotional / Number(formattedPrice || requestedPrice);
      const formattedQty = floorToStep(rawQty, filters.stepSize, filters.stepDecimals);
      if (Number(formattedPrice) <= 0 || Number(formattedQty) <= 0) {
        res.status(400).json({
          error: `Formatted ${orderType} price/quantity invalid under Binance filters.`,
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
      if (venue === 'Futures' && !preflightOnly) {
        // Align marginType (/fapi/v1/marginType) and leverage (/fapi/v1/leverage) per Binance USD-M Futures docs
        await signedBinanceRequest(
          'POST',
          '/fapi/v1/marginType',
          { symbol, marginType: vault.marginType },
          'Futures'
        ).catch(() => null);
        await signedBinanceRequest(
          'POST',
          '/fapi/v1/leverage',
          { symbol, leverage: desiredLeverage },
          'Futures'
        ).catch(() => null);
      }

      if (preflightOnly || vault.requirePreflightTestOrder) {
        const testRes = await signedBinanceRequest('POST', testEndpoint, orderParams, venue);
        if (!testRes.ok) {
          const msg =
            typeof testRes.data.msg === 'string'
              ? `Binance Preflight ${testRes.data.code ?? testRes.status}: ${testRes.data.msg}`
              : `Preflight failed with HTTP ${testRes.status}`;
          res.status(400).json({ error: msg });
          return;
        }
        if (preflightOnly) {
          res.json({
            ok: true,
            preflight: true,
            environment: vault.environment,
            venue,
            latencyMs: testRes.latencyMs,
            usedWeight1m: testRes.usedWeight1m,
            message: `Signed ${testEndpoint} passed for ${symbol} ${side} ${orderType} (${venue})`,
          });
          return;
        }
      }

      const liveRes = await signedBinanceRequest('POST', orderEndpoint, orderParams, venue);
      if (!liveRes.ok) {
        const msg =
          typeof liveRes.data.msg === 'string'
            ? `Binance Order ${liveRes.data.code ?? liveRes.status}: ${liveRes.data.msg}`
            : `Order failed with HTTP ${liveRes.status}`;
        res.status(400).json({ error: msg });
        return;
      }

      const executedQty = Number(liveRes.data.executedQty ?? 0) || 0;
      const cumQuote = Number(liveRes.data.cummulativeQuoteQty ?? liveRes.data.cumQuote ?? 0) || 0;
      const avgPrice =
        executedQty > 0 && cumQuote > 0
          ? cumQuote / executedQty
          : Number(liveRes.data.avgPrice ?? liveRes.data.price ?? refPrice ?? 0) || 0;

      // Attach Spot /api/v3/orderList/oco or Futures TP/SL bracket when OCO requested
      let ocoAttached = false;
      let ocoNote: string | undefined;
      if (
        orderType === 'OCO' &&
        Number(body.takeProfitPrice) > 0 &&
        Number(body.stopLossPrice) > 0 &&
        executedQty > 0
      ) {
        const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
        const tpFmt = floorToStep(Number(body.takeProfitPrice), filters.tickSize, filters.tickDecimals);
        const slFmt = floorToStep(Number(body.stopLossPrice), filters.tickSize, filters.tickDecimals);
        const exitQtyFmt = floorToStep(executedQty, filters.stepSize, filters.stepDecimals);

        if (venue === 'Spot' && Number(exitQtyFmt) > 0) {
          const ocoParams: Record<string, string | number> =
            exitSide === 'SELL'
              ? {
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
                  newOrderRespType: 'RESULT',
                }
              : {
                  symbol,
                  side: 'BUY',
                  quantity: exitQtyFmt,
                  aboveType: 'STOP_LOSS_LIMIT',
                  aboveStopPrice: slFmt,
                  abovePrice: floorToStep(
                    Number(body.stopLossPrice) * 1.002,
                    filters.tickSize,
                    filters.tickDecimals
                  ),
                  aboveTimeInForce: 'GTC',
                  belowType: 'LIMIT_MAKER',
                  belowPrice: tpFmt,
                  newOrderRespType: 'RESULT',
                };
          const ocoRes = await signedBinanceRequest('POST', '/api/v3/orderList/oco', ocoParams, 'Spot');
          ocoAttached = ocoRes.ok;
          ocoNote = ocoRes.ok
            ? `Attached Spot /api/v3/orderList/oco (${exitSide}) TP @ ${tpFmt} / SL @ ${slFmt}`
            : `Spot OCO leg note: ${String(ocoRes.data.msg ?? ocoRes.status)}`;
        } else if (venue === 'Futures') {
          const [tpRes, slRes] = await Promise.all([
            signedBinanceRequest(
              'POST',
              '/fapi/v1/order',
              {
                symbol,
                side: exitSide,
                type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpFmt,
                closePosition: 'true',
                workingType: 'MARK_PRICE',
                priceProtect: 'TRUE',
              },
              'Futures'
            ),
            signedBinanceRequest(
              'POST',
              '/fapi/v1/order',
              {
                symbol,
                side: exitSide,
                type: 'STOP_MARKET',
                stopPrice: slFmt,
                closePosition: 'true',
                workingType: 'MARK_PRICE',
                priceProtect: 'TRUE',
              },
              'Futures'
            ),
          ]);
          ocoAttached = tpRes.ok && slRes.ok;
          ocoNote = ocoAttached
            ? `Attached Futures TP @ ${tpFmt} + SL @ ${slFmt} (workingType=MARK_PRICE)`
            : `Futures bracket note: TP(${tpRes.status}) SL(${slRes.status})`;
        }
      }

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
        ocoAttached,
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
  });

  app.delete('/api/live/order', async (req, res) => {
    const body = (req.body ?? {}) as { symbol?: string; orderId?: string; venue?: ExchangeVenue };
    if (!vault.apiKey || !vault.apiSecret) {
      res.status(400).json({ error: 'Live API credentials are not configured.' });
      return;
    }
    if (!vault.armedForLiveOrders) {
      res.status(403).json({ error: 'Live execution is disarmed.' });
      return;
    }
    const symbol = (body.symbol ?? '').toUpperCase();
    const orderId = (body.orderId ?? '').trim();
    const venue: ExchangeVenue = body.venue === 'Futures' ? 'Futures' : body.venue === 'Spot' ? 'Spot' : vault.venue;
    if (!symbol || !orderId) {
      res.status(400).json({ error: 'symbol and orderId are required to cancel a live order.' });
      return;
    }
    try {
      const cancelPath = venue === 'Futures' ? '/fapi/v1/order' : '/api/v3/order';
      const cancelRes = await signedBinanceRequest(
        'DELETE',
        cancelPath,
        { symbol, orderId },
        venue
      );
      if (!cancelRes.ok) {
        const msg =
          typeof cancelRes.data.msg === 'string'
            ? `Binance Cancel ${cancelRes.data.code ?? cancelRes.status}: ${cancelRes.data.msg}`
            : `Cancel failed with HTTP ${cancelRes.status}`;
        res.status(400).json({ error: msg });
        return;
      }
      res.json({ ok: true, latencyMs: cancelRes.latencyMs, data: cancelRes.data });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to reach Binance cancel endpoint',
      });
    }
  });

  app.get('/api/live/trades', async (req, res) => {
    const symbolParam = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : 'BTCUSDT';
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
        const realizedPnl = raw.realizedPnl !== undefined ? Number(raw.realizedPnl) : 0;
        const isExitFill = Math.abs(realizedPnl) > 1e-8;
        const binanceSide: 'BUY' | 'SELL' = isBuyer ? 'BUY' : 'SELL';
        const side: 'Long' | 'Short' = isExitFill
          ? binanceSide === 'SELL'
            ? 'Long'
            : 'Short'
          : binanceSide === 'BUY'
            ? 'Long'
            : 'Short';

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
          leverage: 1,
          marginType: 'ISOLATED' as const,
          realizedPnlUsdt: isExitFill ? realizedPnl : null,
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
  });

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

  // ---------- Git Sync Backup APIs ----------

  app.get('/api/git/status', async (_req, res) => {
    const status = await getGitStatusSummary();
    res.json({ ok: true, status });
  });

  app.post('/api/git/init', async (_req, res) => {
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
  });

  app.post('/api/git/remote', async (req, res) => {
    const body = (req.body ?? {}) as { remoteUrl?: string };
    const cleanUrl = (body.remoteUrl ?? '').trim();
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
  });

  app.post('/api/git/backup', async (req, res) => {
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

    const diffCheck = await runGit(['diff', '--cached', '--quiet']);
    let committed = false;
    let commitNote = 'Working tree backup already up to date';
    if (!diffCheck.ok) {
      const commitRes = await runGit(['commit', '-m', msg]);
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
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
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
  app.listen(port, '0.0.0.0', () => {
    console.log(`ApexRust server listening on http://0.0.0.0:${port}`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start ApexRust server:', err);
  process.exit(1);
});
