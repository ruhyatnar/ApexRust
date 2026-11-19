// Pure .env parsing / rendering that preserves the template's comments and key order.
import crypto from 'node:crypto';

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENTED_KEY_LINE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"(?:\s*(?:#.*)?)?$/.exec(value);
    if (m) {
      // Single-pass unescape so `\\n` decodes to `\n` (literal backslash + n), never `<newline>`
      return m[1].replace(/\\([rn"\\])/g, (_, ch) => {
        if (ch === 'r') return '\r';
        if (ch === 'n') return '\n';
        return ch;
      });
    }
  }
  if (value.startsWith("'")) {
    const m = /^'([^']*)'(?:\s*(?:#.*)?)?$/.exec(value);
    if (m) return m[1];
  }
  // Strip trailing inline comment on unquoted values (`KEY=value # note`)
  const hashIdx = value.search(/\s#/);
  return (hashIdx >= 0 ? value.slice(0, hashIdx) : value).trim();
}

/** Parse dotenv text into a plain object (later keys win, like dotenv). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = KEY_LINE.exec(line);
    if (match) out[match[1]] = unquote(match[2]);
  }
  return out;
}

/** Quote values only when needed so dotenv parses them back identically. */
export function formatEnvValue(value) {
  const str = value === undefined || value === null ? '' : String(value);
  if (str === '') return '';
  if (/[\s#"'=\\\r]/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  }
  return str;
}

/**
 * Render `values` onto `template` text:
 * - active `KEY=` lines are replaced when the key is present in `values`
 * - commented `# KEY=` lines are uncommented only when `values[KEY]` is a non-empty string
 * - keys missing from the template are appended at the end
 */
export function renderEnv(template, values) {
  const used = new Set();
  const lines = String(template ?? '').split(/\r?\n/).map((line) => {
    const active = KEY_LINE.exec(line);
    if (active && !line.trim().startsWith('#')) {
      const key = active[1];
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        used.add(key);
        return `${key}=${formatEnvValue(values[key])}`;
      }
      return line;
    }
    const commented = COMMENTED_KEY_LINE.exec(line);
    if (commented) {
      const key = commented[1];
      const val = values[key];
      if (typeof val === 'string' && val !== '') {
        used.add(key);
        return `${key}=${formatEnvValue(val)}`;
      }
      if (Object.prototype.hasOwnProperty.call(values, key)) used.add(key);
    }
    return line;
  });

  const extras = Object.keys(values).filter(
    (k) => !used.has(k) && values[k] !== undefined && values[k] !== null && values[k] !== ''
  );
  if (extras.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '# --- Additional settings ---');
    for (const key of extras) lines.push(`${key}=${formatEnvValue(values[key])}`);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** Generate a cryptographically random hex access token (default 24 bytes = 48 hex chars; minimum 16 bytes = 32 chars). */
export function generateAccessToken(byteLength = 24) {
  const bytes = Number(byteLength);
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new Error('Token byte length must be an integer between 16 (32 chars) and 128.');
  }
  return crypto.randomBytes(bytes).toString('hex');
}

/** Validate a user-supplied access token (must be >= 32 non-whitespace characters). */
export function validateAccessToken(rawToken) {
  const clean = String(rawToken ?? '').trim();
  if (clean.length < 32) {
    throw new Error('Access token must be at least 32 characters long.');
  }
  if (/\s/.test(clean)) {
    throw new Error('Access token cannot contain spaces or newline characters.');
  }
  return clean;
}

/** Mask an access token for safe terminal display (`abcd...wxyz (48 chars)`). */
export function maskAccessToken(rawToken) {
  const clean = String(rawToken ?? '').trim();
  if (!clean) return '(not set)';
  if (clean.length <= 10) return `**** (${clean.length} chars)`;
  return `${clean.slice(0, 4)}...${clean.slice(-4)} (${clean.length} chars)`;
}

/** True for loopback, RFC1918 private LAN, and CGNAT / Cloudflare One WARP hosts (`100.64.0.0/10`); false for `0.0.0.0`, `::`, and public IPs. */
export function isPrivateOrLoopbackHost(rawHost) {
  let host = String(rawHost ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']')) {
    host = host.slice(1, host.indexOf(']'));
  }
  if (!host || host === '0.0.0.0' || host === '::') return false;
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.ts.net') ||
    host.endsWith('.cfargotunnel.com')
  ) {
    return true;
  }
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export const DEFAULT_ENV_TEMPLATE = `# ApexRust Quant — environment configuration
# Copy to \`.env\` (or run ./install.sh / install.ps1, which generates it for you).
# \`.env\` is gitignored. Never commit real API keys.

# --- WebApp / Express proxy (server.ts) ---
PORT=3000
HOST=127.0.0.1

# --- Binance credentials (optional; leave empty for Paper Sandbox only) ---
BINANCE_ENVIRONMENT=Testnet
BINANCE_VENUE=Spot
BINANCE_AUTH_METHOD=HMAC-SHA256
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_PRIVATE_KEY_PATH=
# BINANCE_ED25519_PRIVATE_KEY=
# BINANCE_FUTURES_TESTNET_REST=
# BINANCE_SPOT_TESTNET_REST=
# BINANCE_LEVERAGE=3
# BINANCE_MARGIN_TYPE=ISOLATED
# BINANCE_RECV_WINDOW_MS=5000
# APEXRUST_MAX_ORDER_NOTIONAL_USDT=250
# APEXRUST_REQUIRE_PREFLIGHT=true
# APEXRUST_ORDER_DB_PATH=.apexrust-orders.sqlite

# --- 24/7 Remote VPS & Cloudflare One (Zero Trust) Options ---
# APEXRUST_ENGINE_AUTHORITY=browser
# APEXRUST_ENGINE_URL=http://127.0.0.1:8080
# APEXRUST_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
# APEXRUST_PERSIST_VAULT=false
# Optional >= 32-char Access Token (manage via ./apexrust token show | generate | rotate | clear)
# APEXRUST_PROXY_TOKEN=
# APEXRUST_WEB_TOKEN=
# APEXRUST_ENGINE_TOKEN=
# APEXRUST_REMOTE_URL=
# APEXRUST_REMOTE_TOKEN=
# APEXRUST_TRUST_ZERO_TRUST_MESH=false
# APEXRUST_TRUST_PROXY=loopback
`;
