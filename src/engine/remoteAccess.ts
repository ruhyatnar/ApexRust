/**
 * Security, Zero Trust mesh detection, CORS / Private Network Access (PNA),
 * Engine Gateway path allowlisting, and Single-Engine Authority guards for
 * Desktop ↔ Remote VPS connectivity.
 */

import crypto from 'node:crypto';

export type EngineAuthorityMode = 'browser' | 'daemon';

function stripIpv6BracketsAndZone(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'));
  } else if (host.includes(':') && host.indexOf(':') === host.lastIndexOf(':')) {
    // host:port IPv4 or hostname (single colon only; multi-colon is a bare IPv6 literal)
    host = host.slice(0, host.lastIndexOf(':'));
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx > 0) {
    host = host.slice(0, zoneIdx);
  }
  if (host.startsWith('::ffff:')) {
    host = host.slice('::ffff:'.length);
  }
  return host;
}

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

/**
 * Returns true for loopback bind addresses (`127.0.0.0/8`, `::1`, `localhost`).
 */
export function isLoopbackHost(rawHost: string): boolean {
  const host = stripIpv6BracketsAndZone(rawHost);
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const ipv4 = parseIpv4Octets(host);
  if (ipv4 && ipv4[0] === 127) {
    return true;
  }
  return false;
}

/**
 * Returns true for loopback, RFC1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
 * IPv6 Unique Local / Link-Local (`fc00::/7`, `fe80::/10`), and CGNAT / Zero Trust Mesh networks
 * (`100.64.0.0/10`, which covers Cloudflare One WARP `100.96.0.0/12` and Tailscale/WireGuard meshes).
 */
export function isPrivateOrZeroTrustHost(rawHost: string): boolean {
  if (isLoopbackHost(rawHost)) return true;
  const host = stripIpv6BracketsAndZone(rawHost);
  if (!host || host === '0.0.0.0' || host === '::') {
    return false;
  }
  const ipv4 = parseIpv4Octets(host);
  if (ipv4) {
    const [a, b] = ipv4;
    // RFC1918 10.0.0.0/8
    if (a === 10) return true;
    // RFC1918 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // RFC1918 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // RFC6598 CGNAT 100.64.0.0/10 (100.64.x.x - 100.127.x.x) -> Cloudflare One WARP (100.96.0.0/12) & Tailscale
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 ULA (fc00::/7 -> fc00..fdff) and Link-Local (fe80::/10 -> fe80..febf)
  if (host.includes(':') && (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host))) {
    return true;
  }
  // Private Zero Trust / internal DNS suffixes
  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.ts.net') ||
    host.endsWith('.cfargotunnel.com')
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether a server bind host + token configuration is safe to boot.
 * - Loopback (`127.0.0.1`), RFC1918, and Cloudflare One Zero Trust mesh IPs (`100.64.0.0/10`) are safe even without a token.
 * - Wildcard (`0.0.0.0` / `::`) or public IPs require `token.trim().length >= 32` unless running in Cloud Run (`isCloudRun`)
 *   or `trustZeroTrustMesh` (`APEXRUST_TRUST_ZERO_TRUST_MESH=true`) is explicitly enabled.
 */
export function evaluateBindSafety(
  host: string,
  token: string,
  opts?: { isCloudRun?: boolean; trustZeroTrustMesh?: boolean }
): { ok: true } | { ok: false; reason: string } {
  const cleanHost = (host || '127.0.0.1').trim();
  const cleanToken = (token || '').trim();

  if (cleanToken.length > 0 && cleanToken.length < 32) {
    return {
      ok: false,
      reason:
        'APEXRUST_PROXY_TOKEN is shorter than 32 characters. Use at least 32 characters (or leave empty on loopback / Cloudflare One Zero Trust mesh).',
    };
  }

  if (isPrivateOrZeroTrustHost(cleanHost)) {
    return { ok: true };
  }

  if (opts?.isCloudRun || opts?.trustZeroTrustMesh) {
    return { ok: true };
  }

  if (cleanToken.length >= 32) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Refusing to bind non-private address "${cleanHost}" without a >= 32 character APEXRUST_PROXY_TOKEN (or set HOST=127.0.0.1 / Cloudflare One WARP IP 100.96.x.y / APEXRUST_TRUST_ZERO_TRUST_MESH=true).`,
  };
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function isCgnatZeroTrustOriginIp(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  // CGNAT 100.64.0.0/10 (Cloudflare One WARP 100.96.0.0/12 & Tailscale)
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }
  if (trimmed === '*') {
    return ['*'];
  }
  const items = trimmed
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set([...items, ...DEFAULT_ALLOWED_ORIGINS])) : [...DEFAULT_ALLOWED_ORIGINS];
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  for (const candidate of allowedOrigins) {
    if (candidate.toLowerCase() === normalized) {
      return true;
    }
  }
  // Auto-allow loopback (any port) and verified CGNAT WARP mesh IPs (100.64.0.0/10);
  // other LAN/custom hosts must be listed explicitly in APEXRUST_ALLOWED_ORIGINS.
  try {
    const parsed = new URL(normalized);
    if (isLoopbackHost(parsed.hostname) || isCgnatZeroTrustOriginIp(parsed.hostname)) {
      return true;
    }
  } catch {
    // Ignore malformed origin URL
  }
  return false;
}

/**
 * Per-IP authentication failure rate limiter (default: 10 failed attempts per 5 minutes -> HTTP 429).
 */
export class AuthFailureLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly records = new Map<string, { count: number; firstAttemptMs: number }>();

  constructor(maxFailures = 10, windowMs = 5 * 60 * 1000) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, rec] of this.records.entries()) {
      if (nowMs - rec.firstAttemptMs > this.windowMs) {
        this.records.delete(key);
      }
    }
  }

  isLocked(ip: string, nowMs = Date.now()): boolean {
    const key = (ip || 'unknown').trim();
    const rec = this.records.get(key);
    if (!rec) return false;
    if (nowMs - rec.firstAttemptMs > this.windowMs) {
      this.records.delete(key);
      return false;
    }
    return rec.count >= this.maxFailures;
  }

  recordFailure(ip: string, nowMs = Date.now()): { locked: boolean; remainingAttempts: number } {
    if (this.records.size >= 256) {
      this.pruneExpired(nowMs);
    }
    const key = (ip || 'unknown').trim();
    const rec = this.records.get(key);
    if (!rec || nowMs - rec.firstAttemptMs > this.windowMs) {
      this.records.set(key, { count: 1, firstAttemptMs: nowMs });
      return { locked: false, remainingAttempts: Math.max(0, this.maxFailures - 1) };
    }
    rec.count += 1;
    return {
      locked: rec.count >= this.maxFailures,
      remainingAttempts: Math.max(0, this.maxFailures - rec.count),
    };
  }

  recordSuccess(ip: string): void {
    const key = (ip || 'unknown').trim();
    this.records.delete(key);
  }

  /**
   * Seconds remaining until the current lockout window expires (0 when not locked).
   */
  retryAfterSeconds(ip: string, nowMs = Date.now()): number {
    const key = (ip || 'unknown').trim();
    const rec = this.records.get(key);
    if (!rec) return 0;
    const remainingMs = rec.firstAttemptMs + this.windowMs - nowMs;
    if (remainingMs <= 0) {
      this.records.delete(key);
      return 0;
    }
    if (rec.count < this.maxFailures) return 0;
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }
}

function safeTokenMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const TOKEN_LOCKOUT_ERROR =
  'Too many failed token attempts from this IP. Try again in 5 minutes.';

const TOKEN_INVALID_ERROR =
  'Unauthorized: missing or invalid Access Token (APEXRUST_PROXY_TOKEN).';

export type TokenAuthDecision =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 429;
      error: string;
      recordFailure: boolean;
      retryAfterSeconds: number;
    };

/**
 * Pure token-auth decision shared by the HTTP guard and the WebSocket upgrade guard.
 *
 * Ordering matters: a valid token always wins, even for a locked-out IP, because a
 * rate limiter is meant to slow guessing rather than reject the correct answer.
 * Missing tokens and probe requests are never charged against the failure budget;
 * only a wrong token supplied to a real route is.
 */
export function decideTokenAuth(input: {
  configuredToken: string;
  candidates: Array<string | undefined | null>;
  locked: boolean;
  retryAfterSeconds: number;
  isProbe?: boolean;
}): TokenAuthDecision {
  const expected = (input.configuredToken || '').trim();
  if (!expected) {
    return { ok: true };
  }

  const provided = input.candidates
    .map((candidate) => String(candidate ?? '').trim())
    .filter(Boolean);

  if (provided.some((candidate) => safeTokenMatch(candidate, expected))) {
    return { ok: true };
  }

  const retryAfterSeconds = Math.max(0, Math.floor(input.retryAfterSeconds));

  // No token supplied, or an unauthenticated health probe: deny without penalty.
  if (provided.length === 0 || input.isProbe) {
    return {
      ok: false,
      status: 401,
      error: TOKEN_INVALID_ERROR,
      recordFailure: false,
      retryAfterSeconds,
    };
  }

  if (input.locked) {
    return {
      ok: false,
      status: 429,
      error: TOKEN_LOCKOUT_ERROR,
      recordFailure: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  return {
    ok: false,
    status: 401,
    error: TOKEN_INVALID_ERROR,
    recordFailure: true,
    retryAfterSeconds: 0,
  };
}

const ALLOWED_ENGINE_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/config' },
  { method: 'GET', path: '/snapshot' },
  { method: 'GET', path: '/market/screener' },
  { method: 'GET', path: '/orders/history' },
  { method: 'DELETE', path: '/orders/history' },
  { method: 'GET', path: '/orders/orphans' },
  { method: 'POST', path: '/control' },
  { method: 'POST', path: '/watchlist' },
];

/**
 * Strict allowlist for `/api/engine/*` gateway requests forwarded from `server.ts` to `bot-web` (`127.0.0.1:8080`).
 */
export function isEnginePathAllowed(method: string, subPath: string): boolean {
  const normMethod = (method || '').trim().toUpperCase();
  const cleanPath = (subPath || '').split('?')[0].trim().replace(/\/+$/, '') || '/';
  const normalizedPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
  if (normalizedPath.includes('..') || normalizedPath.includes('//')) {
    return false;
  }
  return ALLOWED_ENGINE_ROUTES.some(
    (route) => route.method === normMethod && route.path === normalizedPath
  );
}

/**
 * Single-writer Engine Authority guard:
 * When `authority === 'daemon'` (24/7 VPS Rust Daemon owns live trading), browser clients cannot submit
 * direct new-entry orders to `/api/live/order` (they must route manual entries through `/api/engine/control`
 * so the 24/7 VPS daemon tracks the position and manages its ATR exits).
 * Emergency `reduceOnly` closes and preflight test checks remain allowed.
 */
export function evaluateEngineAuthorityGuard(
  authority: EngineAuthorityMode,
  body: { reduceOnly?: boolean; preflightOnly?: boolean }
):
  | { allowed: true }
  | { allowed: false; status: 409; code: 'ENGINE_AUTHORITY_DAEMON'; error: string } {
  if (authority !== 'daemon') {
    return { allowed: true };
  }
  if (body?.reduceOnly === true || body?.preflightOnly === true) {
    return { allowed: true };
  }
  return {
    allowed: false,
    status: 409,
    code: 'ENGINE_AUTHORITY_DAEMON',
    error:
      '24/7 Automated Trading is managed by the Remote VPS Daemon. Route new live entries through the VPS Bot (/api/engine/control) so 24/7 ATR exits manage the position.',
  };
}

/**
 * Coordinates single-browser lease ownership when `authority === 'browser'`, preventing two open
 * desktop/browser windows from simultaneously firing duplicate live entry orders.
 */
export class LiveExecutionLeaseManager {
  private holderClientId: string | null = null;
  private expiresAtMs = 0;
  private readonly ttlMs: number;

  constructor(ttlMs = 20_000) {
    this.ttlMs = ttlMs;
  }

  acquireOrRenew(
    clientId: string,
    nowMs = Date.now(),
    forceTakeover = false
  ): { acquired: boolean; holderClientId: string | null; expiresAtMs: number } {
    const clean = (clientId || '').trim();
    if (!clean) {
      return { acquired: false, holderClientId: this.holderClientId, expiresAtMs: this.expiresAtMs };
    }
    if (
      forceTakeover ||
      !this.holderClientId ||
      this.holderClientId === clean ||
      nowMs >= this.expiresAtMs
    ) {
      this.holderClientId = clean;
      this.expiresAtMs = nowMs + this.ttlMs;
      return { acquired: true, holderClientId: this.holderClientId, expiresAtMs: this.expiresAtMs };
    }
    return { acquired: false, holderClientId: this.holderClientId, expiresAtMs: this.expiresAtMs };
  }

  verifyEntryLease(
    clientId: string | undefined,
    nowMs = Date.now()
  ): { allowed: true } | { allowed: false; holderClientId: string } {
    const clean = (clientId || '').trim();
    if (!this.holderClientId || nowMs >= this.expiresAtMs) {
      if (clean) {
        this.holderClientId = clean;
        this.expiresAtMs = nowMs + this.ttlMs;
      }
      return { allowed: true };
    }
    if (!clean || clean === this.holderClientId) {
      this.expiresAtMs = nowMs + this.ttlMs;
      return { allowed: true };
    }
    return { allowed: false, holderClientId: this.holderClientId };
  }
}
