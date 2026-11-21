#!/usr/bin/env node
// ApexRust Quant cross-platform setup, lifecycle, service, and diagnostics CLI.
// Uses only Node.js built-ins + local scripts/lib/*.mjs so it runs cleanly on fresh clones.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { botPortFromToml, readTomlValue, renderBotToml } from './lib/botToml.mjs';
import {
  DEFAULT_ENV_TEMPLATE,
  generateAccessToken,
  isPrivateOrLoopbackHost,
  maskAccessToken,
  parseEnv,
  renderEnv,
  validateAccessToken,
} from './lib/envFile.mjs';
import {
  COMPONENTS,
  IS_LINUX,
  IS_MAC,
  IS_WIN,
  PATHS,
  REPO_DIR,
  augmentPath,
  detectZeroTrustMeshIps,
  logFile,
} from './lib/paths.mjs';
import { checkPrerequisites, isPortFree, nextFreePort, runCapture, spawnPlatformSync } from './lib/prereqs.mjs';
import {
  ensureRuntimeDirs,
  fetchHealth,
  followFiles,
  formatHostPort,
  isAlive,
  killTree,
  removePid,
  resolveComponentLaunchConfig,
  runningPid,
  startDetached,
  tailFile,
  waitForHealth,
  writePid,
} from './lib/processes.mjs';
import { closePrompts, confirm, input, isInteractive, secret, select, setNonInteractive } from './lib/prompt.mjs';
import {
  launchdLabel,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskScript,
  systemdUnitName,
  windowsTaskName,
} from './lib/services.mjs';

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
};

const info = (msg) => console.log(`${C.cyan}==>${C.reset} ${msg}`);
const ok = (msg) => console.log(`${C.green}[OK]${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}[WARN]${C.reset} ${msg}`);
const fail = (msg) => console.error(`${C.red}[FAIL]${C.reset} ${msg}`);

function printBanner() {
  console.log(`${C.bold}ApexRust Quant — Setup & Operations CLI${C.reset}`);
  console.log(`${C.dim}Repository: ${REPO_DIR}${C.reset}\n`);
}

function printHelp() {
  console.log(`Usage: ${IS_WIN ? 'apexrust.cmd' : './apexrust'} <command> [options]

Commands:
  setup                 Interactive (or flag-driven) wizard to check prereqs, build, and configure
  start [target]        Start web, bot, or both in the background (supports --host, --lan, --web-port, --bot-port, --token)
  stop [target]         Stop running component(s) gracefully
  restart [target]      Restart component(s) (supports --host, --lan, --web-port, --bot-port, --token)
  status                Show running PIDs, health checks, URLs, and OS services
  logs [target]         Print or follow logs (-n <lines>, -f / --follow)
  doctor                Verify toolchains, configs, binaries, ports, and services
  update                git pull --ff-only, rebuild, and restart running services (--components, --no-restart)
  service <action>      Manage OS auto-start services: install | uninstall [web|bot|both]
  remote <action>       Manage Remote VPS connection: status | connect | use-local | use-vps
  token <action>        Manage Access Token (APEXRUST_PROXY_TOKEN): status | show | generate | rotate | clear
  uninstall             Stop processes and remove OS services / runtime state (--purge deletes build/config)
  run <component>       Internal foreground supervisor used by detached runner and OS services
  bot <command>         Run the Rust apexrust CLI (run, status, keygen, ws-api, config, order, ...)
                        Examples: ./apexrust bot status | ./apexrust bot keygen --label main | ./apexrust bot --help

Targets: web | bot | both (default uses saved state from setup)

Setup / Service Flags:
  -y, --yes, --non-interactive   Accept defaults without prompting (required flags/env override)
  --role <local|vps|client>      Machine role: local (This Computer), vps (24/7 Server), client (Desktop linked to VPS)
  --remote-url <url>             Remote VPS URL for --role client or remote connect (e.g. http://100.96.1.10:3000)
  --remote-name <name>           Friendly nickname for Remote VPS (default: Remote VPS)
  --remote-token <token>         Optional Access Token for Remote VPS (pass "" to clear)
  --allowed-origins <list>       Comma-separated Desktop PWA origins allowed by VPS CORS
  --components <web|bot|both>    Which components to build & configure
  --env <testnet|production>     Binance environment (bot.toml always starts with paper_trading=true)
  --venue <spot|futures>         Trading venue
  --pair-mode <mode>             Watchlist mode: static, hybrid (default), or dynamic
  --trending-category <cat>      Trending filter: hot_volume, top_gainers, top_losers, volatility_leaders
  --auth <hmac|ed25519|paper>    Credential auth method (paper clears live keys)
  --api-key <key>                Binance API key (optional)
  --api-secret <secret>          Binance API secret (for HMAC)
  --key-path <path>              PKCS#8 PEM path (for Ed25519)
  --leverage <1-20>              Futures default leverage (default: 3)
  --margin <ISOLATED|CROSSED>    Futures margin type (default: ISOLATED)
  --web-port <port>              Express/UI port (default: 3000)
  --bot-port <port>              Rust daemon port (default: 8080)
  --host <ip> / --lan            Bind host (default: 127.0.0.1; --lan sets 0.0.0.0)
  --token <token>                Access token for start/restart or token rotate (min 32 chars)
  --bytes <16-128>               Random byte length for token generate/rotate (default: 24 -> 48 hex chars)
  --no-build                     Skip npm/cargo build steps during setup
  --no-start                     Do not start services after setup
  --service / --no-service       Install OS auto-start service during setup
  --system                       Linux only: install system-wide /etc/systemd/system unit (asks sudo)
  --linger / --no-linger         Linux only: enable/skip loginctl enable-linger for systemd --user
  --no-restart                   For update: rebuild without restarting stopped components/services
  --purge                        For uninstall: also delete .env, bot.toml, node_modules, dist, rust-bot/target
  -n, --lines <n>                Log tail line count (default: 80)
  -f, --follow                   Stream logs until Ctrl+C
`);
}

function parseCliArgs(argv) {
  const flags = {};
  const positionals = [];
  const valueFlags = new Set([
    'components', 'role', 'remote-url', 'remote-name', 'remote-token', 'allowed-origins',
    'env', 'venue', 'pair-mode', 'trending-category', 'auth', 'api-key', 'api-secret', 'key-path',
    'leverage', 'margin', 'web-port', 'bot-port', 'host', 'token', 'bytes', 'web-bind', 'lines', 'log',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg === '-y') { flags.yes = true; continue; }
    if (arg === '-f') { flags.follow = true; continue; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg.startsWith('-n') && arg.length > 2 && !arg.startsWith('--')) {
      flags.lines = arg.startsWith('-n=') ? arg.slice(3) : arg.slice(2);
      continue;
    }
    if (arg === '-n') {
      if (i + 1 >= argv.length) throw new Error('Missing value for -n');
      flags.lines = argv[++i];
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg.startsWith('--no-')) {
      flags[arg.slice(5)] = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.has(name)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for --${name}`);
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { command: positionals[0] ?? 'help', positionals: positionals.slice(1), flags };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  fs.mkdirSync(PATHS.stateDir, { recursive: true });
  const merged = { ...readState(), ...next };
  fs.writeFileSync(PATHS.stateFile, `${JSON.stringify(merged, null, 2)}\n`);
}

function readRemoteProfile() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.remoteProfileFile, 'utf8'));
  } catch {
    return { activeMode: 'local', name: 'Remote VPS', baseUrl: '' };
  }
}

function writeRemoteProfile(next) {
  fs.mkdirSync(PATHS.stateDir, { recursive: true });
  const merged = {
    ...readRemoteProfile(),
    ...next,
    updatedAtIso: new Date().toISOString(),
  };
  if (merged.token === '' || merged.token === null) {
    delete merged.token;
  }
  fs.writeFileSync(PATHS.remoteProfileFile, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return merged;
}

function normalizeRemoteUrlCli(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error(
      `Please provide a valid http(s):// Remote VPS URL: ${IS_WIN ? 'apexrust.cmd' : './apexrust'} remote connect --remote-url http://100.96.1.10:3000`
    );
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Remote VPS URL "${trimmed}". Example: http://100.96.1.10:3000`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote VPS URL must start with http:// or https:// (got "${trimmed}")`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not embed username/password in the Remote VPS URL; use --remote-token instead.');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api(\/engine)?$/, '');
  if (cleanPath.includes('..')) {
    throw new Error('Remote VPS URL path cannot contain "..".');
  }
  return `${parsed.origin}${cleanPath}`;
}

function resolveHealthCheckHost(rawHost) {
  const clean = String(rawHost || '').trim().replace(/^\[|\]$/g, '');
  if (!clean || clean === '0.0.0.0' || clean === '::') {
    return '127.0.0.1';
  }
  return clean;
}

function resolveStableNodePath() {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function readCurrentEnv() {
  try {
    return parseEnv(fs.readFileSync(PATHS.env, 'utf8'));
  } catch {
    return {};
  }
}

function readCurrentTomlText() {
  try {
    return fs.readFileSync(PATHS.botToml, 'utf8');
  } catch {
    return '';
  }
}

function resolveBasePorts() {
  const envMap = readCurrentEnv();
  const state = readState();
  const tomlText = readCurrentTomlText();
  const webPort = Number(envMap.PORT || state.webPort || 3000) || 3000;
  const host = envMap.HOST || state.host || '127.0.0.1';
  const botPort = tomlText ? botPortFromToml(tomlText, state.botPort || 8080) : Number(state.botPort || 8080) || 8080;
  const rawBind = tomlText ? String(readTomlValue(tomlText, 'web', 'bind_addr') || '') : '';
  const colonIdx = rawBind.lastIndexOf(':');
  const botHost = colonIdx > 0 ? rawBind.slice(0, colonIdx).replace(/^\[|\]$/g, '').trim() || '127.0.0.1' : '127.0.0.1';
  return { webPort, botPort, host, botHost };
}

function setRuntimeBindState(component, bindInfo) {
  const state = readState();
  const runtime = { ...(state.runtime || {}) };
  if (bindInfo) {
    runtime[component] = bindInfo;
  } else {
    delete runtime[component];
  }
  writeState({ runtime });
}

function resolvePorts() {
  const base = resolveBasePorts();
  const state = readState();
  const rtWeb = runningPid('web') ? state.runtime?.web : null;
  const rtBot = runningPid('bot') ? state.runtime?.bot : null;
  return {
    webPort: Number(rtWeb?.port) || base.webPort,
    botPort: Number(rtBot?.port) || base.botPort,
    host: rtWeb?.host || base.host,
    botHost: rtBot?.host || base.botHost,
  };
}

function resolveTargetComponents(target) {
  if (target === 'web' || target === 'bot') return [target];
  if (target === 'both' || target === 'all') return [...COMPONENTS];
  if (target) {
    throw new Error(`Unknown component target "${target}". Expected: web, bot, or both.`);
  }
  const state = readState();
  if (state.components === 'web') return ['web'];
  if (state.components === 'bot') return ['bot'];
  if (state.components === 'both') return [...COMPONENTS];
  return fs.existsSync(PATHS.botBinary) || fs.existsSync(PATHS.botToml) ? [...COMPONENTS] : ['web'];
}

function runStreaming(cmd, args, opts = {}) {
  const res = spawnPlatformSync(cmd, args, {
    cwd: opts.cwd ?? REPO_DIR,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? 'inherit',
  });
  if (res.error) return { ok: false, status: 1, error: res.error.message };
  return { ok: res.status === 0, status: res.status ?? 1 };
}

function npmCommand() {
  return IS_WIN ? 'npm.cmd' : 'npm';
}

function chmodOwnerOnly(filePath) {
  if (IS_WIN) return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore on filesystems without POSIX modes
  }
}

async function confirmSudoAndRun(cmdArgs) {
  const rendered = `sudo ${cmdArgs.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const res = spawnSync(cmdArgs[0], cmdArgs.slice(1), { encoding: 'utf8', stdio: 'inherit' });
    if (res.error || res.status !== 0) {
      throw new Error(`Command failed: ${cmdArgs.join(' ')}`);
    }
    return res;
  }
  console.log(`\n${C.yellow}Administrator approval required for:${C.reset}\n  ${rendered}`);
  if (!isInteractive()) {
    throw new Error(`Refusing to run sudo in non-interactive mode. Run manually:\n  ${rendered}`);
  }
  const approved = await confirm('Run this command with sudo?', false);
  if (!approved) {
    throw new Error('Cancelled by user.');
  }
  const res = spawnSync('sudo', cmdArgs, { encoding: 'utf8', stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    throw new Error(`Command failed: ${rendered}`);
  }
  return res;
}

function parseBooleanFlag(val, fallback) {
  if (typeof val === 'boolean') return val;
  return fallback;
}

function normalizeComponentsFlag(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v === 'web' || v === 'bot' || v === 'both') return v;
  throw new Error(`Invalid --components "${raw}". Choose web, bot, or both.`);
}

function validatePortNumber(raw, exclude = []) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`Invalid port "${raw}". Enter an integer between 1024 and 65535.`);
  }
  if (exclude.includes(n)) {
    throw new Error(`Port ${n} conflicts with the other service.`);
  }
  return n;
}

async function resolvePortChoice(label, preferred, host, exclude = [], ignoreBusy = false) {
  let candidate = preferred;
  const probeHost = host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const free = await isPortFree(candidate, probeHost);
  if (!free && !ignoreBusy) {
    const suggested = await nextFreePort(candidate + 1, probeHost, exclude);
    warn(`${label} port ${candidate} is already in use (suggested free port: ${suggested}).`);
    candidate = suggested;
  }
  if (!isInteractive()) return candidate;
  const chosen = await input(`${label} port`, String(candidate), (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return 'Enter a port between 1024 and 65535';
    if (exclude.includes(n)) return `Port ${n} conflicts with the other service`;
    return null;
  });
  return Number(chosen);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
async function cmdSetup(flags) {
  printBanner();
  augmentPath();

  const existingEnv = readCurrentEnv();
  const existingToml = readCurrentTomlText();
  const state = readState();

  const roleFlag = flags.role ? String(flags.role).toLowerCase() : null;
  if (roleFlag && roleFlag !== 'local' && roleFlag !== 'vps' && roleFlag !== 'client') {
    throw new Error(`Invalid --role "${flags.role}". Choose local, vps, or client.`);
  }
  const role = roleFlag ?? (isInteractive()
    ? await select(
        'How will you use this computer?',
        [
          { value: 'local', label: '🖥️ This Computer Only (Standalone Local Mode)' },
          { value: 'vps', label: '☁️ 24/7 Remote VPS Server (Cloudflare One / Zero Trust Host)' },
          { value: 'client', label: '💻 Desktop Client Connected to a Remote VPS' },
        ],
        state.role || 'local'
      )
    : (state.role || 'local'));

  const rustQuick = checkPrerequisites({ needRust: true });
  const rustReady = rustQuick.find((r) => r.id === 'rust')?.ok && rustQuick.find((r) => r.id === 'buildtools')?.ok;

  let components = normalizeComponentsFlag(flags.components);
  if (!components) {
    if (role === 'vps') {
      components = 'both';
    } else if (role === 'client') {
      components = state.components === 'both' ? 'web' : (state.components || 'web');
    } else {
      const defaultComp = state.components ?? (rustReady ? 'both' : 'web');
      components = await select(
        'Which components do you want to set up?',
        [
          { value: 'both', label: 'Web UI + Rust Trading Engine (full local stack)' },
          { value: 'web', label: 'Web UI & Express Proxy only (fastest — no Rust build)' },
          { value: 'bot', label: 'Rust Trading Engine Daemon only' },
        ],
        defaultComp
      );
    }
  }
  const needRust = components !== 'web';
  const needWeb = components !== 'bot';

  info('Checking system prerequisites...');
  const checks = checkPrerequisites({ needRust });
  let failed = 0;
  for (const item of checks) {
    if (item.ok) {
      ok(`${item.name}: ${item.detail}`);
    } else {
      failed += 1;
      fail(`${item.name}: ${item.detail}`);
      console.log(`       Fix: ${item.fix}`);
    }
  }
  if (failed > 0) {
    throw new Error('Missing required prerequisites. Install the missing item(s) above and re-run setup.');
  }
  console.log('');

  // Configuration choices
  const skipLocalTradingPrompts = role === 'client' && !needRust;
  const existingEnvName = (readTomlValue(existingToml, 'exchange', 'environment') || existingEnv.BINANCE_ENVIRONMENT || 'testnet').toLowerCase();
  const envFlag = flags.env ? String(flags.env).toLowerCase() : null;
  if (envFlag && envFlag !== 'production' && envFlag !== 'testnet') {
    throw new Error(`Invalid --env "${flags.env}". Choose testnet or production.`);
  }
  const environment = envFlag
    ?? (skipLocalTradingPrompts
      ? (existingEnvName === 'production' ? 'production' : 'testnet')
      : await select(
          'Binance API environment (Paper Trading stays ON in bot.toml for safety):',
          [
            { value: 'testnet', label: 'Testnet (Recommended for safe testing)' },
            { value: 'production', label: 'Production market data / paper mode' },
          ],
          existingEnvName === 'production' ? 'production' : 'testnet'
        ));

  const existingVenue = (readTomlValue(existingToml, 'exchange', 'venue') || existingEnv.BINANCE_VENUE || 'spot').toLowerCase();
  const venueFlag = flags.venue ? String(flags.venue).toLowerCase() : null;
  if (venueFlag && venueFlag !== 'spot' && venueFlag !== 'futures') {
    throw new Error(`Invalid --venue "${flags.venue}". Choose spot or futures.`);
  }
  const venue = venueFlag
    ?? (skipLocalTradingPrompts
      ? (existingVenue === 'futures' ? 'futures' : 'spot')
      : await select(
          'Trading venue:',
          [
            { value: 'spot', label: 'Spot' },
            { value: 'futures', label: 'USD-M Futures' },
          ],
          existingVenue === 'futures' ? 'futures' : 'spot'
        ));

  const existingPairMode = (readTomlValue(existingToml, 'trading', 'pair_selection_mode') || 'hybrid').toLowerCase();
  const pairModeFlag = flags['pair-mode'] ? String(flags['pair-mode']).toLowerCase() : null;
  if (pairModeFlag && !['static', 'hybrid', 'dynamic'].includes(pairModeFlag)) {
    throw new Error(`Invalid --pair-mode "${flags['pair-mode']}". Choose static, hybrid, or dynamic.`);
  }
  const pairSelectionMode = pairModeFlag
    ?? (skipLocalTradingPrompts
      ? (['static', 'dynamic'].includes(existingPairMode) ? existingPairMode : 'hybrid')
      : await select(
          'Pair discovery & watchlist mode:',
          [
            { value: 'hybrid', label: 'Hybrid (Pinned watchlist + auto-rotating Binance trending pairs) (Recommended)' },
            { value: 'static', label: 'Static Only (Trade only explicitly configured pairs)' },
            { value: 'dynamic', label: 'Dynamic Auto-Rotation (Rotate entire watchlist via live WS screener)' },
          ],
          ['static', 'dynamic'].includes(existingPairMode) ? existingPairMode : 'hybrid'
        ));

  const existingTrendCat = (readTomlValue(existingToml, 'trading', 'trending_category') || 'hot_volume').toLowerCase();
  const trendCatFlag = flags['trending-category'] ? String(flags['trending-category']).toLowerCase() : null;
  if (
    trendCatFlag &&
    !['hot_volume', 'top_gainers', 'top_losers', 'volatility_leaders'].includes(trendCatFlag)
  ) {
    throw new Error(
      `Invalid --trending-category "${flags['trending-category']}". Choose hot_volume, top_gainers, top_losers, or volatility_leaders.`
    );
  }
  const trendingCategory =
    trendCatFlag ??
    (['top_gainers', 'top_losers', 'volatility_leaders'].includes(existingTrendCat)
      ? existingTrendCat
      : 'hot_volume');

  let leverage = flags.leverage !== undefined
    ? Number(flags.leverage)
    : Number(readTomlValue(existingToml, 'exchange', 'leverage') ?? 3) || 3;
  const marginRaw = flags.margin ? String(flags.margin).toUpperCase() : null;
  if (marginRaw && marginRaw !== 'ISOLATED' && marginRaw !== 'CROSSED') {
    throw new Error(`Invalid --margin "${flags.margin}". Choose ISOLATED or CROSSED.`);
  }
  let marginType = marginRaw || String(readTomlValue(existingToml, 'exchange', 'margin_type') || 'ISOLATED').toUpperCase();
  if (venue === 'futures') {
    if (flags.leverage === undefined && isInteractive()) {
      const levStr = await input('Default Futures leverage (1-20)', String(leverage), (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 20 ? null : 'Enter an integer from 1 to 20';
      });
      leverage = Number(levStr);
    } else if (!Number.isInteger(leverage) || leverage < 1 || leverage > 20) {
      throw new Error(`Invalid --leverage "${flags.leverage}". Enter an integer between 1 and 20.`);
    }
    if (!flags.margin) {
      marginType = await select(
        'Default Futures margin type:',
        [
          { value: 'ISOLATED', label: 'ISOLATED (Recommended — limits risk per position)' },
          { value: 'CROSSED', label: 'CROSSED' },
        ],
        marginType === 'CROSSED' ? 'CROSSED' : 'ISOLATED'
      );
    }
  }

  // Credentials (optional)
  const hadKey = Boolean(existingEnv.BINANCE_API_KEY);
  const hadSecret = Boolean(existingEnv.BINANCE_API_SECRET);
  const hadKeyPath = Boolean(existingEnv.BINANCE_PRIVATE_KEY_PATH);
  const existingAuth = (existingEnv.BINANCE_AUTH_METHOD || readTomlValue(existingToml, 'exchange.credentials', 'auth_method') || 'hmac-sha256').toLowerCase();

  let credMode;
  if (flags.auth) {
    const a = String(flags.auth).toLowerCase();
    if (a === 'ed25519') credMode = 'ed25519';
    else if (a === 'hmac' || a === 'hmac-sha256') credMode = 'hmac';
    else if (a === 'paper' || a === 'none') credMode = 'paper';
    else throw new Error(`Invalid --auth "${flags.auth}". Choose hmac, ed25519, or paper.`);
  } else if (flags['api-key'] !== undefined) {
    credMode = flags['key-path'] ? 'ed25519' : 'hmac';
  } else if (!isInteractive() || skipLocalTradingPrompts) {
    credMode = hadKey && !skipLocalTradingPrompts ? (existingAuth.includes('ed25519') ? 'ed25519' : 'hmac') : 'paper';
  } else {
    credMode = await select(
      'Binance API credentials (you can leave empty and configure later in .env):',
      [
        { value: 'paper', label: 'Paper Sandbox only (no API keys needed now)' },
        { value: 'hmac', label: 'HMAC-SHA256 API Key & Secret' },
        { value: 'ed25519', label: 'Ed25519 API Key & PKCS#8 PEM file' },
      ],
      hadKey ? (existingAuth.includes('ed25519') ? 'ed25519' : 'hmac') : 'paper'
    );
  }

  let authMethod = 'hmac-sha256';
  let apiKey = existingEnv.BINANCE_API_KEY ?? '';
  let apiSecret = existingEnv.BINANCE_API_SECRET ?? '';
  let ed25519KeyPath = existingEnv.BINANCE_PRIVATE_KEY_PATH ?? '';

  if (credMode === 'paper') {
    apiKey = '';
    apiSecret = '';
    ed25519KeyPath = '';
  } else if (credMode === 'hmac') {
    authMethod = 'hmac-sha256';
    ed25519KeyPath = '';
    apiKey = flags['api-key'] !== undefined
      ? String(flags['api-key'])
      : (isInteractive() ? (await secret('Binance API Key', hadKey)) || apiKey : apiKey);
    apiSecret = flags['api-secret'] !== undefined
      ? String(flags['api-secret'])
      : (isInteractive() ? (await secret('Binance API Secret', hadSecret)) || apiSecret : apiSecret);
  } else if (credMode === 'ed25519') {
    authMethod = 'ed25519';
    apiSecret = '';
    apiKey = flags['api-key'] !== undefined
      ? String(flags['api-key'])
      : (isInteractive() ? (await secret('Binance API Key', hadKey)) || apiKey : apiKey);
    ed25519KeyPath = flags['key-path'] !== undefined
      ? String(flags['key-path'])
      : (isInteractive()
          ? await input('Path to Ed25519 PKCS#8 PEM private key', ed25519KeyPath || (hadKeyPath ? existingEnv.BINANCE_PRIVATE_KEY_PATH : ''))
          : ed25519KeyPath);
  }

  // Host & ports (with automatic Cloudflare One WARP / Zero Trust mesh IP detection)
  const detectedMeshIps = detectZeroTrustMeshIps();
  let host = flags.lan ? '0.0.0.0' : flags.host ? String(flags.host) : null;
  if (!host) {
    const defaultHost =
      role === 'vps' && detectedMeshIps.length > 0
        ? detectedMeshIps[0].ip
        : existingEnv.HOST || state.host || '127.0.0.1';
    const hostChoices = [
      {
        value: '127.0.0.1',
        label:
          role === 'vps'
            ? '127.0.0.1 — Localhost / cloudflared Private Tunnel (Recommended)'
            : '127.0.0.1 — This computer only (Recommended)',
      },
      ...detectedMeshIps.map((m) => ({
        value: m.ip,
        label: `${m.ip} — ${m.kind} (${m.iface})`,
      })),
      {
        value: '0.0.0.0',
        label: '0.0.0.0 — All network interfaces (Generates 32-byte Access Token)',
      },
    ];
    host = isInteractive()
      ? await select('Network bind address:', hostChoices, defaultHost)
      : defaultHost;
  }

  let remoteVpsUrl = flags['remote-url'] ? String(flags['remote-url']).trim() : '';
  let remoteVpsName = flags['remote-name'] ? String(flags['remote-name']).trim() : '';
  let remoteVpsToken = flags['remote-token'] !== undefined ? String(flags['remote-token']).trim() : undefined;
  if (role === 'client') {
    const prevProfile = readRemoteProfile();
    if (!remoteVpsUrl) {
      if (isInteractive()) {
        remoteVpsUrl = await input(
          'Remote VPS Address (Cloudflare One IP or URL, e.g. http://100.96.1.10:3000)',
          prevProfile.baseUrl || 'http://100.96.1.10:3000'
        );
      } else {
        remoteVpsUrl = prevProfile.baseUrl || '';
      }
    }
    if (!remoteVpsUrl) {
      throw new Error('Remote VPS URL is required for --role client. Pass --remote-url http://100.96.x.y:3000.');
    }
    remoteVpsUrl = normalizeRemoteUrlCli(remoteVpsUrl);
    if (!remoteVpsName) {
      remoteVpsName = isInteractive()
        ? await input('Remote VPS Nickname', prevProfile.name || 'Tokyo VPS')
        : (prevProfile.name || 'Remote VPS');
    }
    if (remoteVpsToken === undefined) {
      remoteVpsToken = isInteractive()
        ? await input('Optional Remote VPS Access Token (leave blank if trusted on Cloudflare One)', prevProfile.token || '')
        : (prevProfile.token || '');
    }
  }

  const webRunning = Boolean(runningPid('web'));
  const botRunning = Boolean(runningPid('bot'));
  const defaultWebPort = Number(flags['web-port'] || existingEnv.PORT || state.webPort || 3000) || 3000;
  const webPort = flags['web-port'] !== undefined
    ? validatePortNumber(flags['web-port'])
    : needWeb
      ? await resolvePortChoice('Web Command Center', defaultWebPort, resolveHealthCheckHost(host), [], webRunning)
      : defaultWebPort;

  const existingBotPort = botPortFromToml(existingToml, state.botPort || 8080);
  const defaultBotPort = Number(flags['bot-port'] || existingBotPort || 8080) || 8080;
  const botBindHost = needWeb ? '127.0.0.1' : host;
  const botPort = flags['bot-port'] !== undefined
    ? validatePortNumber(flags['bot-port'], needWeb ? [webPort] : [])
    : needRust
      ? await resolvePortChoice('Rust Bot API', defaultBotPort, resolveHealthCheckHost(botBindHost), needWeb ? [webPort] : [], botRunning)
      : defaultBotPort;

  // Build steps
  if (flags.build !== false) {
    if (needWeb) {
      info('Installing Node.js dependencies...');
      const hasLock = fs.existsSync(path.join(REPO_DIR, 'package-lock.json'));
      const installArgs = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
      const npmRes = runStreaming(npmCommand(), installArgs);
      if (!npmRes.ok) throw new Error('npm dependency installation failed.');

      info('Building WebApp production bundle (vite build)...');
      const buildRes = runStreaming(npmCommand(), ['run', 'build']);
      if (!buildRes.ok) throw new Error('WebApp production build failed.');
      ok('WebApp built at dist/index.html');
    }

    if (needRust) {
      info('Compiling Rust daemon and CLI in release mode (cargo build --release --bin bot-desktop --bin apexrust)...');
      if (botRunning) {
        info('Stopping running bot daemon before rebuilding binary...');
        await stopComponent('bot');
      }
      const cargoRes = runStreaming(
        'cargo',
        ['build', '--release', '--bin', 'bot-desktop', '--bin', 'apexrust'],
        { cwd: PATHS.rustDir }
      );
      if (!cargoRes.ok) throw new Error('Cargo release build failed.');
      ok(`Rust binary built at ${path.relative(REPO_DIR, PATHS.botBinary)}`);
      ok(`Rust CLI built at ${path.relative(REPO_DIR, path.join(PATHS.rustDir, 'target', 'release', IS_WIN ? 'apexrust.exe' : 'apexrust'))}`);
    }
  } else {
    warn('Skipping build steps (--no-build).');
  }

  // Render .env (backing up any existing one; falls back to built-in template if .env.example is absent)
  if (fs.existsSync(PATHS.env)) {
    fs.copyFileSync(PATHS.env, PATHS.envBackup);
    chmodOwnerOnly(PATHS.envBackup);
    ok(`Backed up existing .env -> ${path.relative(REPO_DIR, PATHS.envBackup)}`);
  }
  let envTemplate;
  if (fs.existsSync(PATHS.envExample)) {
    envTemplate = fs.readFileSync(PATHS.envExample, 'utf8');
  } else {
    warn(`${path.relative(REPO_DIR, PATHS.envExample)} not found; using built-in .env template fallback.`);
    envTemplate = DEFAULT_ENV_TEMPLATE;
  }
  const existingProxyTok = (existingEnv.APEXRUST_PROXY_TOKEN || '').trim();
  const proxyToken =
    !isPrivateOrLoopbackHost(host)
      ? (existingProxyTok.length >= 32 ? existingProxyTok : crypto.randomBytes(24).toString('hex'))
      : existingProxyTok;
  const existingEngineTok = (existingEnv.APEXRUST_WEB_TOKEN || existingEnv.APEXRUST_ENGINE_TOKEN || '').trim();
  const engineToken =
    role === 'vps'
      ? (existingEngineTok.length >= 32 ? existingEngineTok : crypto.randomBytes(24).toString('hex'))
      : existingEngineTok;
  const allowedOrigins =
    flags['allowed-origins']
      ? String(flags['allowed-origins'])
      : existingEnv.APEXRUST_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000';
  const nextEnvContent = renderEnv(envTemplate, {
    PORT: String(webPort),
    HOST: host,
    BINANCE_ENVIRONMENT: environment === 'production' ? 'Production' : 'Testnet',
    BINANCE_VENUE: venue === 'futures' ? 'Futures' : 'Spot',
    BINANCE_AUTH_METHOD: authMethod === 'ed25519' ? 'Ed25519' : 'HMAC-SHA256',
    BINANCE_API_KEY: apiKey,
    BINANCE_API_SECRET: apiSecret,
    BINANCE_PRIVATE_KEY_PATH: ed25519KeyPath,
    ...(role === 'vps'
      ? {
          APEXRUST_ENGINE_AUTHORITY: 'daemon',
          APEXRUST_ENGINE_URL: `http://127.0.0.1:${botPort}`,
          APEXRUST_PERSIST_VAULT: 'true',
          APEXRUST_ALLOWED_ORIGINS: allowedOrigins,
          APEXRUST_WEB_TOKEN: engineToken,
          APEXRUST_ENGINE_TOKEN: engineToken,
        }
      : {}),
    ...(proxyToken ? { APEXRUST_PROXY_TOKEN: proxyToken } : {}),
  });
  fs.writeFileSync(PATHS.env, nextEnvContent, 'utf8');
  chmodOwnerOnly(PATHS.env);
  ok(`Wrote ${path.relative(REPO_DIR, PATHS.env)} (safe permissions)`);

  // Render bot.toml (backing up any existing one; paper_trading = true, armed_for_live_orders = false)
  if (fs.existsSync(PATHS.botExample)) {
    if (fs.existsSync(PATHS.botToml)) {
      fs.copyFileSync(PATHS.botToml, PATHS.botTomlBackup);
      chmodOwnerOnly(PATHS.botTomlBackup);
      ok(`Backed up existing bot.toml -> ${path.relative(REPO_DIR, PATHS.botTomlBackup)}`);
    }
    const botTemplate = fs.readFileSync(PATHS.botExample, 'utf8');
    const nextToml = renderBotToml(botTemplate, {
      environment,
      venue,
      leverage,
      marginType,
      authMethod,
      ed25519KeyPath,
      botHost: botBindHost,
      botPort,
      webPort,
      pairSelectionMode,
      trendingCategory,
    });
    fs.writeFileSync(PATHS.botToml, nextToml, 'utf8');
    chmodOwnerOnly(PATHS.botToml);
    ok(`Wrote ${path.relative(REPO_DIR, PATHS.botToml)} (paper_trading = true, armed_for_live_orders = false, pair_mode=${pairSelectionMode})`);
  }

  writeState({
    role,
    components,
    webPort,
    botPort,
    host,
    environment,
    venue,
    installedAt: new Date().toISOString(),
  });

  if (role === 'client' && remoteVpsUrl) {
    writeRemoteProfile({
      activeMode: 'remote',
      name: remoteVpsName || 'Remote VPS',
      baseUrl: remoteVpsUrl.replace(/\/+$/, ''),
      token: remoteVpsToken ?? '',
    });
    ok(`Linked Desktop Client to ☁️ ${remoteVpsName || 'Remote VPS'} (${remoteVpsUrl})`);
  } else {
    writeRemoteProfile({
      activeMode: 'local',
    });
  }

  const activeComponentsToRun =
    role === 'client' && needWeb ? 'web' : (components === 'both' ? 'both' : components);

  // Optional auto-start OS service
  let installSvc = parseBooleanFlag(flags.service, undefined);
  if (installSvc === undefined && isInteractive()) {
    installSvc = await confirm('Register background auto-start service at login/boot?', false);
  }
  let startedByService = false;
  if (installSvc) {
    await cmdServiceInstall(activeComponentsToRun, flags);
    startedByService = true;
  }

  // Optional immediate start when not already started as OS service
  if (!startedByService && flags.start !== false) {
    const startNow = flags.start === true || (!isInteractive() ? true : await confirm('Start ApexRust now?', true));
    if (startNow) {
      await cmdStart(activeComponentsToRun, { ...flags, forceRestart: true });
    }
  }

  console.log(`\n${C.bold}${C.green}Setup complete!${C.reset}`);
  const cliHint = IS_WIN ? 'apexrust.cmd' : './apexrust';
  if (needWeb) {
    const urlHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`  Web UI:     http://${urlHost}:${webPort}`);
  }
  if (needRust) {
    console.log(`  Rust API:   http://${botBindHost}:${botPort}/api/health`);
  }
  if (role === 'vps') {
    const connectHost = host === '0.0.0.0' ? '<vps-cloudflare-one-ip>' : host;
    console.log(`  VPS Gateway: http://${connectHost}:${webPort} (authority=daemon)`);
    if (proxyToken) {
      console.log(`  Access Token saved to .env (APEXRUST_PROXY_TOKEN) — keep it private!`);
      console.log(`  Token tools: ${cliHint} token show  |  ${cliHint} token rotate`);
    }
    console.log('  Remember to add this VPS outbound IP to your Binance API key IP whitelist.');
  } else if (role === 'client' && remoteVpsUrl) {
    console.log(`  Connected Remote VPS: ☁️ ${remoteVpsName} (${remoteVpsUrl})`);
  }
  console.log(`  Useful commands: ${cliHint} status | token | remote status | logs -f | doctor | stop | uninstall\n`);
}

// ---------------------------------------------------------------------------
// run (internal supervisor used by detached starter and OS service managers)
// ---------------------------------------------------------------------------
function loadDotEnvInto(targetEnv) {
  for (const [k, v] of Object.entries(readCurrentEnv())) {
    if (targetEnv[k] === undefined || targetEnv[k] === '') {
      targetEnv[k] = v;
    }
  }
}

async function cmdRun(component, flags) {
  if (!COMPONENTS.includes(component)) {
    throw new Error(`Usage: apexrust run <web|bot>`);
  }
  augmentPath();
  ensureRuntimeDirs();

  const childEnv = { ...process.env };
  const directLaunch = resolveComponentLaunchConfig({
    component,
    target: component,
    flags,
    basePorts: resolveBasePorts(),
  });
  Object.assign(childEnv, directLaunch.envOverrides);
  loadDotEnvInto(childEnv);

  let cmd;
  let args;
  if (component === 'web') {
    if (!fs.existsSync(PATHS.tsxCli)) {
      throw new Error(`Missing ${PATHS.tsxCli}. Run \`npm install\` or \`./apexrust setup\` first.`);
    }
    childEnv.NODE_ENV = childEnv.NODE_ENV || 'production';
    cmd = process.execPath;
    args = [PATHS.tsxCli, PATHS.serverEntry];
  } else {
    if (!fs.existsSync(PATHS.botBinary)) {
      throw new Error(`Missing Rust binary at ${PATHS.botBinary}. Run \`./apexrust setup\` first.`);
    }
    if (!fs.existsSync(PATHS.botToml)) {
      throw new Error(`Missing ${PATHS.botToml}. Run \`./apexrust setup\` first.`);
    }
    cmd = PATHS.botBinary;
    args = ['--daemon', '--config', PATHS.botToml];
    const webBind =
      (flags['web-bind'] ? String(flags['web-bind']).trim() : '') ||
      (childEnv.BOT_WEB_BIND || '').trim();
    if (webBind) {
      args.push('--web-bind', webBind);
    }
  }

  let logFd = null;
  let stdio = 'inherit';
  if (flags.log) {
    const resolvedLog = path.resolve(String(flags.log));
    fs.mkdirSync(path.dirname(resolvedLog), { recursive: true });
    logFd = fs.openSync(resolvedLog, 'a');
    stdio = ['ignore', logFd, logFd];
  }

  writePid(component, process.pid);

  await new Promise((resolve) => {
    let intentionalStop = false;
    const child = spawn(cmd, args, {
      cwd: REPO_DIR,
      env: childEnv,
      stdio,
      windowsHide: true,
    });

    const forwardStop = (signal) => {
      if (intentionalStop) return;
      intentionalStop = true;
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 10000).unref();
    };

    process.on('SIGTERM', () => forwardStop('SIGTERM'));
    process.on('SIGINT', () => forwardStop('SIGINT'));
    if (!IS_WIN) process.on('SIGHUP', () => forwardStop('SIGTERM'));

    child.on('error', (err) => {
      console.error(`[${component}] Failed to spawn process: ${err.message}`);
      removePid(component, process.pid);
      if (logFd !== null) fs.closeSync(logFd);
      process.exitCode = 1;
      resolve();
    });

    child.on('exit', (code, signal) => {
      removePid(component, process.pid);
      if (logFd !== null) fs.closeSync(logFd);
      if (intentionalStop) {
        process.exitCode = 0;
      } else if (typeof code === 'number') {
        process.exitCode = code;
      } else {
        console.error(`[${component}] Exited on signal ${signal}`);
        process.exitCode = 1;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// start / stop / restart
// ---------------------------------------------------------------------------
async function startComponent(component, flags = {}, target = undefined) {
  const normFlags = typeof flags === 'boolean' ? { forceRestart: flags } : flags;
  const launch = resolveComponentLaunchConfig({
    component,
    target,
    flags: normFlags,
    basePorts: resolveBasePorts(),
  });

  const existing = runningPid(component);
  if (existing) {
    if (launch.shouldRestart) {
      await stopComponent(component);
    } else {
      const activePorts = resolvePorts();
      const activeHost = component === 'web' ? activePorts.host : activePorts.botHost;
      const activePort = component === 'web' ? activePorts.webPort : activePorts.botPort;
      ok(`${component} is already running (pid ${existing}) -> ${formatHostPort(activeHost, activePort)}.`);
      return;
    }
  }

  const port = launch.port;
  const probeHost = resolveHealthCheckHost(launch.bindHost);

  if (component === 'web') {
    if (!fs.existsSync(PATHS.tsxCli)) {
      throw new Error(`Web dependencies missing (${PATHS.tsxCli}). Run setup first.`);
    }
    if (!fs.existsSync(PATHS.distIndex)) {
      warn('dist/index.html not found — run `npm run build` for production UI assets.');
    }
  } else {
    if (!fs.existsSync(PATHS.botBinary)) {
      throw new Error(`Rust binary not found (${PATHS.botBinary}). Run setup first.`);
    }
    if (!fs.existsSync(PATHS.botToml)) {
      throw new Error(`Missing ${PATHS.botToml}. Run setup first.`);
    }
  }

  if (!(await isPortFree(port, probeHost))) {
    throw new Error(`Port ${port} on ${probeHost} for ${component} is already in use by another process.`);
  }

  const spawnEnv = { ...process.env, ...launch.envOverrides };
  if (component === 'bot' && !launch.envOverrides.BOT_WEB_BIND) {
    delete spawnEnv.BOT_WEB_BIND;
  }

  info(`Starting ${component} (bind ${formatHostPort(launch.bindHost, port)})...`);
  const pid = startDetached(component, spawnEnv);
  writePid(component, pid);
  setRuntimeBindState(component, { host: launch.bindHost, port });

  const healthUrl = `http://${probeHost}:${port}/api/health`;
  const health = await waitForHealth(healthUrl, 45000, () => isAlive(pid));
  if (!health.ok) {
    const tail = tailFile(logFile(component), 25);
    await killTree(pid, 3000);
    removePid(component, pid);
    setRuntimeBindState(component, null);
    const nonPrivateHint =
      launch.bindHost === '0.0.0.0' || launch.bindHost === '::'
        ? `\nHint: Binding "${launch.bindHost}" requires a >= 32-char token. Run \`./apexrust token rotate\` (or pass \`--token <TOKEN>\`), or bind to your Cloudflare One WARP IP.`
        : '';
    throw new Error(
      `${component} failed health check at ${healthUrl} (${health.error ?? `HTTP ${health.status}`}).${nonPrivateHint}\n` +
        (tail ? `Recent log output:\n${tail}` : `See ${logFile(component)}`)
    );
  }
  const boundDisplay = formatHostPort(launch.bindHost, port);
  const endpointMsg =
    launch.bindHost === probeHost ? healthUrl : `${boundDisplay} (health: ${healthUrl})`;
  ok(`${component} started (pid ${pid}) -> ${endpointMsg}`);
}

async function stopComponent(component) {
  setRuntimeBindState(component, null);
  const pid = runningPid(component);
  if (!pid) {
    removePid(component);
    info(`${component} is not running.`);
    return false;
  }
  info(`Stopping ${component} (pid ${pid})...`);
  const stopped = await killTree(pid, 15000);
  removePid(component);
  if (stopped) {
    ok(`${component} stopped.`);
  } else {
    warn(`${component} (pid ${pid}) may still be exiting.`);
  }
  return true;
}

async function cmdStart(target, flags = {}) {
  augmentPath();
  for (const c of resolveTargetComponents(target)) {
    await startComponent(c, flags, target);
  }
}

async function cmdStop(target) {
  for (const c of resolveTargetComponents(target)) {
    await stopComponent(c);
  }
}

async function cmdRestart(target, flags = {}) {
  const list = resolveTargetComponents(target);
  for (const c of list) await stopComponent(c);
  for (const c of list) await startComponent(c, flags, target);
}

// ---------------------------------------------------------------------------
// status & logs
// ---------------------------------------------------------------------------
function systemdUserSupported() {
  return IS_LINUX && runCapture('systemctl', ['--user', 'show-environment']).ok;
}

function getServiceStatus(component) {
  if (IS_LINUX) {
    const unit = systemdUnitName(component);
    if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', unit))) {
      const enabled = runCapture('systemctl', ['--user', 'is-enabled', unit]);
      const active = runCapture('systemctl', ['--user', 'is-active', unit]);
      return `systemd --user (${enabled.stdout || 'installed'}, ${active.stdout || 'unknown'})`;
    }
    if (fs.existsSync(path.join('/etc/systemd/system', unit))) {
      const enabled = runCapture('systemctl', ['is-enabled', unit]);
      const active = runCapture('systemctl', ['is-active', unit]);
      return `systemd system (${enabled.stdout || 'installed'}, ${active.stdout || 'unknown'})`;
    }
    return 'not installed';
  }
  if (IS_MAC) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(component)}.plist`);
    if (!fs.existsSync(plist)) return 'not installed';
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    const loaded = runCapture('launchctl', ['print', `gui/${uid}/${launchdLabel(component)}`]).ok;
    return loaded ? 'launchd (loaded)' : 'launchd (plist present, not loaded)';
  }
  if (IS_WIN) {
    const query = runCapture('schtasks', ['/Query', '/TN', windowsTaskName(component)]);
    return query.ok ? `Scheduled Task (${windowsTaskName(component)})` : 'not installed';
  }
  return 'unsupported';
}

async function cmdStatus() {
  const { webPort, botPort, host, botHost } = resolvePorts();
  const tomlText = readCurrentTomlText();
  const envName = tomlText ? readTomlValue(tomlText, 'exchange', 'environment') : undefined;
  const venue = tomlText ? readTomlValue(tomlText, 'exchange', 'venue') : undefined;
  const paper = tomlText ? readTomlValue(tomlText, 'exchange', 'paper_trading') : undefined;
  const armed = tomlText ? readTomlValue(tomlText, 'exchange.credentials', 'armed_for_live_orders') : undefined;

  console.log(`${C.bold}ApexRust Status${C.reset}`);
  if (tomlText) {
    console.log(`  Profile: ${envName ?? 'unknown'} / ${venue ?? 'unknown'} | paper_trading=${paper} | armed_for_live_orders=${armed}`);
  } else {
    console.log('  Profile: bot.toml not yet created (run setup if using Rust daemon)');
  }
  console.log('');

  for (const c of COMPONENTS) {
    const port = c === 'web' ? webPort : botPort;
    const rawHost = c === 'web' ? host : botHost;
    const probeHost = resolveHealthCheckHost(rawHost);
    const pid = runningPid(c);
    const health = await fetchHealth(`http://${probeHost}:${port}/api/health`, 1500);
    const stateLabel = health.ok
      ? `${C.green}HEALTHY${C.reset}`
      : pid
        ? `${C.yellow}STARTING/UNHEALTHY${C.reset}`
        : `${C.dim}STOPPED${C.reset}`;
    const url =
      rawHost === '0.0.0.0' || rawHost === '::'
        ? `${formatHostPort(rawHost, port)} (local: http://localhost:${port})`
        : `http://${formatHostPort(rawHost, port)}`;
    console.log(`  [${c}] ${stateLabel} | pid: ${pid ?? '-'} | url: ${url} | service: ${getServiceStatus(c)}`);
  }
  console.log('');
}

function cmdLogs(target, flags) {
  const list = resolveTargetComponents(target);
  const rawLines = flags.lines !== undefined ? Number(flags.lines) : 80;
  const lines = Number.isInteger(rawLines) && rawLines >= 0 ? rawLines : 80;
  for (const c of list) {
    const file = logFile(c);
    console.log(`${C.bold}=== ${c} (${path.relative(REPO_DIR, file)}) ===${C.reset}`);
    if (!fs.existsSync(file)) {
      console.log('(no log file yet)\n');
      continue;
    }
    const content = tailFile(file, lines);
    console.log(content || '(empty)');
    console.log('');
  }
  if (flags.follow) {
    const files = list.map((c) => ({ component: c, file: logFile(c) }));
    info(`Following logs (${list.join(', ')})... Press Ctrl+C to exit.`);
    followFiles(files);
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor() {
  printBanner();
  augmentPath();
  const state = readState();
  const needRust = state.components !== 'web';
  const needWeb = state.components !== 'bot';
  let issues = 0;

  info('Toolchain & Build Checks');
  for (const item of checkPrerequisites({ needRust: true })) {
    if (item.ok) {
      ok(`${item.name}: ${item.detail}`);
    } else if (!needRust && (item.id === 'rust' || item.id === 'buildtools')) {
      warn(`${item.name}: ${item.detail} (optional because components=${state.components})`);
    } else {
      issues += 1;
      fail(`${item.name}: ${item.detail} -> ${item.fix}`);
    }
  }

  console.log('');
  info('Configuration & Build Artifacts');
  if (fs.existsSync(PATHS.env)) {
    let permNote = '';
    if (!IS_WIN) {
      const mode = fs.statSync(PATHS.env).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        warn(`.env permissions are ${mode.toString(8)}; recommended 600 (chmod 600 .env)`);
      } else {
        permNote = ' (mode 600)';
      }
    }
    ok(`.env present${permNote}`);
  } else {
    issues += 1;
    fail(`.env missing (run ./apexrust setup)`);
  }

  if (fs.existsSync(PATHS.botToml)) {
    const toml = readCurrentTomlText();
    const paper = readTomlValue(toml, 'exchange', 'paper_trading');
    const armed = readTomlValue(toml, 'exchange.credentials', 'armed_for_live_orders');
    const pairMode = readTomlValue(toml, 'trading', 'pair_selection_mode') ?? 'hybrid';
    const docEnv = readCurrentEnv();
    const sqlitePath = path.resolve(REPO_DIR, (docEnv.APEXRUST_ORDER_DB_PATH || '').trim() || '.apexrust-orders.sqlite');
    const sqliteExists = fs.existsSync(sqlitePath);
    ok(`rust-bot/config/bot.toml present (paper_trading=${paper}, armed_for_live_orders=${armed}, pair_mode=${pairMode})`);
    info(`SQLite WAL order database (${path.relative(REPO_DIR, sqlitePath)}): ${sqliteExists ? 'initialized' : 'will auto-create on first start'}`);
  } else if (needRust) {
    issues += 1;
    fail('rust-bot/config/bot.toml missing (run ./apexrust setup)');
  } else {
    info('rust-bot/config/bot.toml not present (web-only setup)');
  }

  if (fs.existsSync(PATHS.tsxCli) && fs.existsSync(PATHS.distIndex)) {
    ok('WebApp built (node_modules + dist/index.html)');
  } else if (needWeb) {
    issues += 1;
    fail('WebApp build incomplete (run npm install && npm run build)');
  } else {
    info('WebApp bundle not built (bot-only setup)');
  }

  if (fs.existsSync(PATHS.botBinary)) {
    ok(`Rust release binary built (${path.relative(REPO_DIR, PATHS.botBinary)})`);
  } else if (needRust) {
    issues += 1;
    fail(`Rust binary missing (${path.relative(REPO_DIR, PATHS.botBinary)})`);
  }

  console.log('');
  info('Network, Cloudflare One Zero Trust & Remote VPS Checks');
  const currentEnv = readCurrentEnv();
  const bindHost = currentEnv.HOST || state.host || '127.0.0.1';
  const proxyTok = (currentEnv.APEXRUST_PROXY_TOKEN || '').trim();
  const meshIps = detectZeroTrustMeshIps();
  if (meshIps.length > 0) {
    for (const m of meshIps) {
      ok(`Detected ${m.kind} (${m.iface}): ${m.ip}`);
    }
  } else {
    info('No Cloudflare One / CGNAT (100.64.0.0/10) mesh interface detected locally');
  }
  if (!isPrivateOrLoopbackHost(bindHost) && proxyTok.length < 32 && currentEnv.APEXRUST_TRUST_ZERO_TRUST_MESH !== 'true') {
    issues += 1;
    fail(`Non-private bind HOST="${bindHost}" requires a >= 32-char APEXRUST_PROXY_TOKEN (or set HOST=127.0.0.1 / Cloudflare One WARP IP)`);
  } else {
    ok(`Bind safety OK (HOST=${bindHost}, authority=${currentEnv.APEXRUST_ENGINE_AUTHORITY || 'browser'})`);
  }

  try {
    const t0 = Date.now();
    const timeResp = await fetch('https://api.binance.com/api/v3/time', {
      signal: AbortSignal.timeout(2500),
    });
    if (timeResp.ok) {
      const rttMs = Math.max(1, Date.now() - t0);
      const timeJson = await timeResp.json();
      const driftMs = Math.abs(Date.now() - Number(timeJson.serverTime || Date.now()));
      if (driftMs > 1000) {
        warn(`System clock drift vs Binance API is ${driftMs} ms (> 1000 ms, RTT ${rttMs} ms) — enable NTP/chrony sync`);
      } else {
        ok(`Binance REST clock drift: ${driftMs} ms (RTT ${rttMs} ms, within 1000 ms)`);
      }
    }
  } catch {
    info('Skipping Binance REST clock check (offline or sandboxed network)');
  }

  const remoteProf = readRemoteProfile();
  if (remoteProf.activeMode === 'remote' && remoteProf.baseUrl) {
    info(`Remote VPS Profile active: ☁️ ${remoteProf.name || 'Remote VPS'} -> ${remoteProf.baseUrl}`);
    const rHealth = await fetchHealth(`${remoteProf.baseUrl}/api/health`, 2000);
    if (rHealth.ok) {
      ok(`Remote VPS reachable at ${remoteProf.baseUrl}`);
    } else {
      warn(`Remote VPS unreachable at ${remoteProf.baseUrl} (verify Cloudflare One Client is connected)`);
    }
  }

  console.log('');
  info('Ports, Runtime & Services');
  const { webPort, botPort, host, botHost } = resolvePorts();
  for (const [c, port, rawHost] of [['web', webPort, host], ['bot', botPort, botHost]]) {
    const probeHost = resolveHealthCheckHost(rawHost);
    const pid = runningPid(c);
    const health = await fetchHealth(`http://${probeHost}:${port}/api/health`, 1500);
    const free = await isPortFree(port, probeHost);
    if (health.ok) {
      ok(`${c} responding on ${probeHost}:${port} (pid ${pid ?? 'external'})`);
      if (c === 'web') {
        try {
          const headers = proxyTok ? { Authorization: `Bearer ${proxyTok}` } : {};
          const scr = await fetch(`http://${probeHost}:${port}/api/market/screener?limit=5`, {
            headers,
            signal: AbortSignal.timeout(2000),
          });
          if (scr.ok) {
            const payload = await scr.json();
            ok(`Binance !miniTicker@arr screener endpoint ready (stream=${Boolean(payload.streamConnected)}, tradable=${payload.totalTradableSymbols ?? 0})`);
          }
        } catch {
          // Ignore optional screener check failure
        }
      }
    } else if (!free) {
      warn(`Port ${port} (${c}) on ${probeHost} is occupied by a process not answering /api/health`);
    } else {
      info(`${c} stopped (port ${port} on ${probeHost} is free)`);
    }
    info(`${c} service: ${getServiceStatus(c)}`);
  }

  if (IS_LINUX && systemdUserSupported()) {
    const user = os.userInfo().username;
    const linger = runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
    if (linger.ok) {
      info(`Linux systemd --user linger (${user}): ${linger.stdout || 'no'}`);
    }
  }

  console.log('');
  if (issues > 0) {
    throw new Error(`Doctor found ${issues} blocking issue(s).`);
  }
  ok('Doctor passed with no blocking issues.');
}

// ---------------------------------------------------------------------------
// service install / uninstall
// ---------------------------------------------------------------------------
async function installLinuxSystemd(components, flags) {
  const pathEnv = process.env.PATH;
  const user = os.userInfo().username;
  const stableNodePath = resolveStableNodePath();
  if (flags.system) {
    ensureRuntimeDirs();
    for (const c of components) {
      const unit = systemdUnitName(c);
      const dest = `/etc/systemd/system/${unit}`;
      const content = renderSystemdUnit({
        component: c,
        repoDir: REPO_DIR,
        nodePath: stableNodePath,
        system: true,
        user,
        pathEnv,
      });
      const tmpUnit = path.join(PATHS.runDir, unit);
      fs.writeFileSync(tmpUnit, content, { mode: 0o600 });
      try {
        await confirmSudoAndRun(['install', '-m', '0644', tmpUnit, dest]);
        ok(`Wrote ${dest}`);
      } finally {
        try { fs.unlinkSync(tmpUnit); } catch { /* ignore */ }
      }
    }
    await confirmSudoAndRun(['systemctl', 'daemon-reload']);
    await confirmSudoAndRun(['systemctl', 'enable', '--now', ...components.map(systemdUnitName)]);
    ok(`Enabled and started system service(s): ${components.map(systemdUnitName).join(', ')}`);
    return;
  }

  if (!systemdUserSupported()) {
    throw new Error('systemd --user session bus is unavailable here. Use `--system` for a system-wide unit or manage processes with `./apexrust start`.');
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  for (const c of components) {
    const unit = systemdUnitName(c);
    const dest = path.join(unitDir, unit);
    fs.writeFileSync(
      dest,
      renderSystemdUnit({
        component: c,
        repoDir: REPO_DIR,
        nodePath: stableNodePath,
        system: false,
        pathEnv,
      }),
      'utf8'
    );
    ok(`Wrote ${dest}`);
  }
  const reload = runStreaming('systemctl', ['--user', 'daemon-reload']);
  if (!reload.ok) throw new Error('systemctl --user daemon-reload failed.');
  const enable = runStreaming('systemctl', ['--user', 'enable', '--now', ...components.map(systemdUnitName)]);
  if (!enable.ok) throw new Error('systemctl --user enable --now failed.');
  ok(`Enabled and started systemd user service(s): ${components.map(systemdUnitName).join(', ')}`);

  // Optional loginctl enable-linger
  const lingerRes = runCapture('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
  const alreadyLinger = lingerRes.ok && lingerRes.stdout === 'yes';
  if (!alreadyLinger) {
    let wantLinger = parseBooleanFlag(flags.linger, undefined);
    if (wantLinger === undefined && isInteractive()) {
      wantLinger = await confirm(
        `Enable user linger (loginctl enable-linger ${user}) so services survive SSH logout?`,
        false
      );
    }
    if (wantLinger) {
      const direct = runCapture('loginctl', ['enable-linger', user]);
      if (direct.ok) {
        ok(`Enabled linger for ${user}.`);
      } else {
        await confirmSudoAndRun(['loginctl', 'enable-linger', user]);
        ok(`Enabled linger for ${user} via sudo.`);
      }
    }
  }
}

async function uninstallLinuxSystemd(components) {
  const userDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  for (const c of components) {
    const unit = systemdUnitName(c);
    const userPath = path.join(userDir, unit);
    if (fs.existsSync(userPath)) {
      runCapture('systemctl', ['--user', 'disable', '--now', unit]);
      fs.unlinkSync(userPath);
      ok(`Removed ${userPath}`);
    }
    const sysPath = path.join('/etc/systemd/system', unit);
    if (fs.existsSync(sysPath)) {
      await confirmSudoAndRun(['systemctl', 'disable', '--now', unit]);
      await confirmSudoAndRun(['rm', '-f', sysPath]);
      await confirmSudoAndRun(['systemctl', 'daemon-reload']);
      ok(`Removed ${sysPath}`);
    }
  }
  if (systemdUserSupported()) runCapture('systemctl', ['--user', 'daemon-reload']);
}

function installMacLaunchd(components) {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  ensureRuntimeDirs();
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const stableNodePath = resolveStableNodePath();
  for (const c of components) {
    const label = launchdLabel(c);
    const plist = path.join(dir, `${label}.plist`);
    fs.writeFileSync(
      plist,
      renderLaunchdPlist({
        component: c,
        repoDir: REPO_DIR,
        nodePath: stableNodePath,
        logPath: logFile(c),
        pathEnv: process.env.PATH,
      }),
      'utf8'
    );
    runCapture('launchctl', ['bootout', `gui/${uid}`, plist]);
    const res = runStreaming('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (!res.ok) throw new Error(`launchctl bootstrap failed for ${plist}`);
    ok(`Installed and started LaunchAgent ${label}`);
  }
}

function uninstallMacLaunchd(components) {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  for (const c of components) {
    const plist = path.join(dir, `${launchdLabel(c)}.plist`);
    if (fs.existsSync(plist)) {
      runCapture('launchctl', ['bootout', `gui/${uid}`, plist]);
      fs.unlinkSync(plist);
      ok(`Removed ${plist}`);
    }
  }
}

function installWindowsTasks(components) {
  ensureRuntimeDirs();
  for (const c of components) {
    const ps1 = renderWindowsTaskScript({
      component: c,
      repoDir: REPO_DIR,
      nodePath: process.execPath,
      logPath: logFile(c),
    });
    const tmpFile = path.join(PATHS.runDir, `register-${c}.ps1`);
    fs.writeFileSync(tmpFile, ps1, 'utf8');
    try {
      const reg = runStreaming('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
      if (!reg.ok) throw new Error(`Failed to register Windows Scheduled Task ${windowsTaskName(c)}`);
      const runRes = runCapture('schtasks', ['/Run', '/TN', windowsTaskName(c)]);
      if (!runRes.ok) {
        warn(`Scheduled Task ${windowsTaskName(c)} registered, but failed immediate start: ${runRes.stderr || 'unknown error'}`);
      }
      ok(`Registered Windows Scheduled Task ${windowsTaskName(c)}`);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  }
}

async function uninstallWindowsTasks(components) {
  for (const c of components) {
    const name = windowsTaskName(c);
    const exists = runCapture('schtasks', ['/Query', '/TN', name]);
    if (exists.ok) {
      runCapture('schtasks', ['/End', '/TN', name]);
      if (runningPid(c)) await stopComponent(c);
      runCapture('schtasks', ['/Delete', '/TN', name, '/F']);
      ok(`Removed Scheduled Task ${name}`);
    }
  }
}

async function cmdServiceInstall(target, flags) {
  const components = resolveTargetComponents(target);
  // Stop manual detached PIDs before handing over to OS service manager
  for (const c of components) {
    if (runningPid(c)) await stopComponent(c);
  }
  if (IS_LINUX) {
    await installLinuxSystemd(components, flags);
  } else if (IS_MAC) {
    installMacLaunchd(components);
  } else if (IS_WIN) {
    installWindowsTasks(components);
  } else {
    throw new Error(`OS auto-start services are not supported on ${process.platform}.`);
  }

  const { webPort, botPort, host, botHost } = resolvePorts();
  for (const c of components) {
    const port = c === 'web' ? webPort : botPort;
    const probeHost = resolveHealthCheckHost(c === 'web' ? host : botHost);
    const healthUrl = `http://${probeHost}:${port}/api/health`;
    info(`Waiting for ${c} service health at ${healthUrl}...`);
    const health = await waitForHealth(healthUrl, 45000);
    if (!health.ok) {
      throw new Error(`${c} service did not respond at ${healthUrl} (${health.error ?? `HTTP ${health.status}`}). Check OS service logs.`);
    }
    ok(`${c} service is healthy (${healthUrl})`);
  }
}

async function cmdServiceUninstall(target) {
  const components = resolveTargetComponents(target ?? 'both');
  if (IS_LINUX) return uninstallLinuxSystemd(components);
  if (IS_MAC) return uninstallMacLaunchd(components);
  if (IS_WIN) return uninstallWindowsTasks(components);
  throw new Error(`OS auto-start services are not supported on ${process.platform}.`);
}

async function cmdService(args, flags) {
  const action = args[0];
  const target = args[1] ?? (typeof flags.components === 'string' ? flags.components : undefined);
  if (action === 'install') return cmdServiceInstall(target, flags);
  if (action === 'uninstall' || action === 'remove') return cmdServiceUninstall(target);
  throw new Error('Usage: ./apexrust service <install|uninstall> [web|bot|both] [--components ...] [--system] [--linger]');
}

function restartInstalledService(component) {
  if (IS_LINUX) {
    const unit = systemdUnitName(component);
    if (fs.existsSync(path.join(os.homedir(), '.config', 'systemd', 'user', unit))) {
      return runStreaming('systemctl', ['--user', 'restart', unit]).ok;
    }
    if (fs.existsSync(path.join('/etc/systemd/system', unit))) {
      return runStreaming('systemctl', ['restart', unit]).ok;
    }
  } else if (IS_MAC) {
    const label = launchdLabel(component);
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (fs.existsSync(plist)) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '';
      return runStreaming('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]).ok;
    }
  } else if (IS_WIN) {
    const name = windowsTaskName(component);
    if (runCapture('schtasks', ['/Query', '/TN', name]).ok) {
      runCapture('schtasks', ['/End', '/TN', name]);
      return runCapture('schtasks', ['/Run', '/TN', name]).ok;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// update & uninstall
// ---------------------------------------------------------------------------
async function cmdUpdate(flags) {
  printBanner();
  augmentPath();

  const components = resolveTargetComponents(flags.components);
  const needWeb = components.includes('web');
  const needRust = components.includes('bot');
  const managedServices = components.filter((c) => {
    const st = getServiceStatus(c);
    return st !== 'not installed' && st !== 'unsupported';
  });
  const wasRunning = components.filter((c) => Boolean(runningPid(c)) && !managedServices.includes(c));

  if (wasRunning.length > 0) {
    info(`Stopping running component(s) before update: ${wasRunning.join(', ')}`);
    for (const c of wasRunning) await stopComponent(c);
  }

  info('Pulling latest commits (git pull --ff-only)...');
  const pull = runStreaming('git', ['pull', '--ff-only']);
  if (!pull.ok) throw new Error('git pull --ff-only failed. Resolve local changes first.');

  if (needWeb) {
    info('Updating Node.js dependencies & rebuilding WebApp...');
    const hasLock = fs.existsSync(path.join(REPO_DIR, 'package-lock.json'));
    const npmRes = runStreaming(npmCommand(), [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund']);
    if (!npmRes.ok) throw new Error('npm install failed.');

    const buildRes = runStreaming(npmCommand(), ['run', 'build']);
    if (!buildRes.ok) throw new Error('WebApp build failed.');
  }

  if (needRust) {
    info('Rebuilding Rust release binaries (daemon + CLI)...');
    const cargoRes = runStreaming(
      'cargo',
      ['build', '--release', '--bin', 'bot-desktop', '--bin', 'apexrust'],
      { cwd: PATHS.rustDir }
    );
    if (!cargoRes.ok) throw new Error('Cargo build failed.');
  }

  if (flags.restart !== false) {
    for (const c of managedServices) {
      info(`Restarting installed OS service for ${c}...`);
      if (restartInstalledService(c)) {
        ok(`Restarted OS service for ${c}`);
      } else {
        warn(`Could not auto-restart OS service for ${c}; restart manually via OS service manager.`);
      }
    }
    for (const c of wasRunning) await startComponent(c);
  }
  ok('Update complete.');
}

async function cmdRemote(positionals, flags) {
  printBanner();
  const action = (positionals[0] || 'status').toLowerCase();
  const profile = readRemoteProfile();

  if (action === 'use-local' || action === 'local') {
    const next = writeRemoteProfile({ activeMode: 'local' });
    ok(`Switched active target to: 🖥️ This Computer (Local Mode) [${next.updatedAtIso}]`);
    return;
  }

  if (action === 'use-vps' || action === 'use-remote' || action === 'remote') {
    if (!profile.baseUrl) {
      throw new Error(
        `No Remote VPS URL saved yet. Run: ${IS_WIN ? 'apexrust.cmd' : './apexrust'} remote connect --remote-url http://100.96.x.y:3000`
      );
    }
    const next = writeRemoteProfile({ activeMode: 'remote' });
    ok(`Switched active target to: ☁️ Remote VPS (${next.name} -> ${next.baseUrl})`);
    return;
  }

  if (action === 'connect') {
    const rawUrl = String(flags['remote-url'] || positionals[1] || profile.baseUrl || '').trim();
    const cleanUrl = normalizeRemoteUrlCli(rawUrl);
    const name = String(flags['remote-name'] || profile.name || 'Remote VPS').trim();
    const rawTokFlag = flags['remote-token'] ?? flags.token;
    const token = rawTokFlag !== undefined ? String(rawTokFlag).trim() : (profile.token || '');
    const saved = writeRemoteProfile({
      activeMode: 'remote',
      name,
      baseUrl: cleanUrl,
      token,
    });
    ok(`Saved Remote VPS profile: ☁️ ${saved.name} (${saved.baseUrl})`);
  }

  const current = readRemoteProfile();
  const meshIps = detectZeroTrustMeshIps();
  console.log(`${C.bold}Active Execution Location:${C.reset} ${
    current.activeMode === 'remote'
      ? `${C.cyan}☁️ Remote VPS (${current.name} -> ${current.baseUrl})${C.reset}`
      : `${C.green}🖥️ This Computer (Local Mode)${C.reset}`
  }`);
  if (meshIps.length > 0) {
    for (const m of meshIps) {
      ok(`Detected ${m.kind} interface (${m.iface}): ${m.ip}`);
    }
  }
  if (current.baseUrl) {
    try {
      const headers = {};
      if (current.token) {
        headers.Authorization = `Bearer ${current.token}`;
        headers['X-ApexRust-Token'] = current.token;
      }
      const started = Date.now();
      const resp = await fetch(`${current.baseUrl}/api/connection/info`, {
        headers,
        signal: AbortSignal.timeout(4000),
      });
      const latency = Date.now() - started;
      if (resp.ok) {
        const infoData = await resp.json();
        ok(`1. VPS Server Reachable    : ${current.baseUrl} (${latency} ms)`);
        ok(`2. Access Permission       : Verified (${infoData.zeroTrustUser || 'Cloudflare One / Token OK'})`);
        ok(`3. 24/7 VPS Trading Daemon : ${infoData.engineReachable ? (infoData.engineRunning ? 'Online & Running' : 'Online (Paused)') : 'Web Proxy Only'}`);
        ok(`4. Binance Account Mode    : ${infoData.venue} · ${infoData.environment} (authority=${infoData.engineAuthority})`);
      } else {
        warn(`Remote VPS returned HTTP ${resp.status} from ${current.baseUrl}/api/connection/info`);
      }
    } catch (err) {
      warn(`Could not reach Remote VPS at ${current.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function restartWebAfterTokenChange(flags, hostOverride = undefined) {
  if (flags.restart === false) {
    info('Skipped automatic web restart (--no-restart). Run `./apexrust restart web` to apply.');
    return;
  }
  const webSvc = getServiceStatus('web');
  if (webSvc !== 'not installed') {
    info('Restarting installed web service...');
    if (restartInstalledService('web')) {
      ok('Restarted web OS service.');
    } else {
      warn('Could not auto-restart web service; restart manually to apply the updated token.');
    }
    return;
  }
  if (runningPid('web')) {
    const active = resolvePorts();
    await startComponent(
      'web',
      {
        ...flags,
        forceRestart: true,
        host: hostOverride ?? active.host,
        'web-port': active.webPort,
      },
      'web'
    );
  }
}

function writeEnvUpdates(updates) {
  const baseText = fs.existsSync(PATHS.env)
    ? fs.readFileSync(PATHS.env, 'utf8')
    : fs.existsSync(PATHS.envExample)
      ? fs.readFileSync(PATHS.envExample, 'utf8')
      : DEFAULT_ENV_TEMPLATE;
  if (fs.existsSync(PATHS.env)) {
    fs.copyFileSync(PATHS.env, PATHS.envBackup);
    chmodOwnerOnly(PATHS.envBackup);
  }
  const rendered = renderEnv(baseText, updates);
  fs.writeFileSync(PATHS.env, rendered, 'utf8');
  chmodOwnerOnly(PATHS.env);
}

async function cmdToken(positionals, flags) {
  const action = (positionals[0] || (flags.reveal ? 'show' : 'status')).toLowerCase();
  const cliHint = IS_WIN ? 'apexrust.cmd' : './apexrust';

  if (action === 'generate' || action === 'gen') {
    const rawBytes = flags.bytes !== undefined ? Number(flags.bytes) : 24;
    const generated = generateAccessToken(rawBytes);
    console.log(generated);
    return;
  }

  if (action === 'status') {
    printBanner();
    const envMap = readCurrentEnv();
    const proxyTok = (envMap.APEXRUST_PROXY_TOKEN || '').trim();
    const webTok = (envMap.APEXRUST_WEB_TOKEN || envMap.APEXRUST_ENGINE_TOKEN || '').trim();
    const { host, webPort } = resolvePorts();
    console.log(`${C.bold}Access Token Status (.env)${C.reset}`);
    console.log(`  Bind Address         : ${formatHostPort(host, webPort)}`);
    console.log(`  APEXRUST_PROXY_TOKEN : ${flags.reveal ? (proxyTok || '(not set)') : maskAccessToken(proxyTok)}`);
    console.log(`  APEXRUST_WEB_TOKEN   : ${flags.reveal ? (webTok || '(not set)') : maskAccessToken(webTok)}`);
    console.log('');
    console.log(`  Show full token : ${cliHint} token show`);
    console.log(`  Rotate / change : ${cliHint} token rotate [--token <32+-char-token>]`);
    console.log(`  Generate random : ${cliHint} token generate`);
    console.log(`  Disable token   : ${cliHint} token clear --host 127.0.0.1`);
    console.log('');
    return;
  }

  if (action === 'show' || action === 'reveal') {
    const envMap = readCurrentEnv();
    const proxyTok = (envMap.APEXRUST_PROXY_TOKEN || '').trim();
    if (!proxyTok) {
      warn('APEXRUST_PROXY_TOKEN is not set in .env.');
      console.log(`Run \`${cliHint} token rotate\` to generate and save a 48-char token.`);
      return;
    }
    console.log(`APEXRUST_PROXY_TOKEN=${proxyTok}`);
    const webTok = (envMap.APEXRUST_WEB_TOKEN || envMap.APEXRUST_ENGINE_TOKEN || '').trim();
    if (webTok && (flags.all || flags.reveal)) {
      console.log(`APEXRUST_WEB_TOKEN=${webTok}`);
    }
    return;
  }

  if (action === 'rotate' || action === 'set' || action === 'new' || action === 'change') {
    printBanner();
    const supplied = flags.token !== undefined ? flags.token : positionals[1];
    const nextToken =
      supplied !== undefined
        ? validateAccessToken(supplied)
        : generateAccessToken(flags.bytes !== undefined ? Number(flags.bytes) : 24);
    const updates = { APEXRUST_PROXY_TOKEN: nextToken };
    const nextHost = flags.lan ? '0.0.0.0' : flags.host ? String(flags.host).trim() : undefined;
    if (nextHost) {
      updates.HOST = nextHost;
    }
    writeEnvUpdates(updates);
    ok(`Updated APEXRUST_PROXY_TOKEN in ${path.relative(REPO_DIR, PATHS.env)} (${nextToken.length} chars, chmod 600)`);
    console.log(`  New Token: ${C.bold}${nextToken}${C.reset}`);
    await restartWebAfterTokenChange(flags, nextHost);
    console.log('  Paste this token into the browser Unlock bar or Bot -> VPS & Server Connection.');
    return;
  }

  if (action === 'clear' || action === 'unset' || action === 'remove' || action === 'disable') {
    printBanner();
    const envMap = readCurrentEnv();
    const active = resolvePorts();
    const targetHost = flags.host
      ? String(flags.host).trim()
      : (envMap.HOST || active.host || '127.0.0.1').trim();
    const trustMesh = String(envMap.APEXRUST_TRUST_ZERO_TRUST_MESH || '').toLowerCase() === 'true';
    if (!trustMesh && !isPrivateOrLoopbackHost(targetHost)) {
      throw new Error(
        `Refusing to clear APEXRUST_PROXY_TOKEN while HOST="${targetHost}" (non-private binds require a >= 32-char token).\n` +
          `Pass a safe bind host, e.g.: ${cliHint} token clear --host 127.0.0.1 (or your Cloudflare One WARP IP).`
      );
    }
    const updates = { APEXRUST_PROXY_TOKEN: '' };
    if (flags.host) {
      updates.HOST = targetHost;
    }
    writeEnvUpdates(updates);
    ok(`Cleared APEXRUST_PROXY_TOKEN in ${path.relative(REPO_DIR, PATHS.env)} (bind host: ${targetHost})`);
    await restartWebAfterTokenChange(flags, flags.host ? targetHost : undefined);
    return;
  }

  throw new Error(
    `Unknown token action "${action}". Expected: status, show, generate, rotate, or clear.`
  );
}

async function cmdUninstall(flags) {
  printBanner();
  for (const c of COMPONENTS) await stopComponent(c);
  try {
    await cmdServiceUninstall('both');
  } catch (err) {
    warn(`Service cleanup incomplete: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (fs.existsSync(PATHS.stateDir)) {
    fs.rmSync(PATHS.stateDir, { recursive: true, force: true });
    ok('Removed .apexrust/ runtime state, PIDs, and logs.');
  }

  let purge = Boolean(flags.purge);
  if (!purge && isInteractive()) {
    purge = await confirm('Also delete local configs (.env, bot.toml) and build caches (dist, node_modules, rust-bot/target)?', false);
  }

  if (purge) {
    const targets = [
      PATHS.env,
      PATHS.envBackup,
      PATHS.botToml,
      PATHS.botTomlBackup,
      path.join(REPO_DIR, '.apexrust-order-logs.json'),
      path.join(REPO_DIR, '.apexrust-orders.sqlite'),
      path.join(REPO_DIR, '.apexrust-orders.sqlite-wal'),
      path.join(REPO_DIR, '.apexrust-orders.sqlite-shm'),
      path.join(REPO_DIR, '.apexrust-orders.sqlite.json'),
      path.join(REPO_DIR, 'dist'),
      path.join(REPO_DIR, 'node_modules'),
      path.join(PATHS.rustDir, 'target'),
    ];
    for (const t of targets) {
      if (fs.existsSync(t)) {
        fs.rmSync(t, { recursive: true, force: true });
        ok(`Removed ${path.relative(REPO_DIR, t)}`);
      }
    }
    ok('Full purge complete. Only git-tracked repository files remain.');
  } else {
    info('Preserved .env and rust-bot/config/bot.toml (pass --purge to remove everything).');
  }
}

// ---------------------------------------------------------------------------
// Rust CLI delegation (`./apexrust bot <command> ...`)
// ---------------------------------------------------------------------------
function rustCliCandidates() {
  const names = IS_WIN ? ['apexrust.exe'] : ['apexrust'];
  const candidates = [];
  const override = process.env.APEXRUST_CLI;
  if (override && override.trim()) candidates.push(override.trim());
  for (const profile of ['release', 'debug']) {
    for (const name of names) {
      candidates.push(path.join(PATHS.rustDir, 'target', profile, name));
    }
  }
  return candidates;
}

function resolveRustCli() {
  for (const candidate of rustCliCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable candidates and keep looking.
    }
  }
  return null;
}

async function cmdBot(rustArgs) {
  const binary = resolveRustCli();
  if (!binary) {
    fail('Rust CLI `apexrust` belum di-build.');
    info('Build sekali saja: (cd rust-bot && cargo build --release --bin apexrust)');
    info('Atau jalankan `./apexrust setup` yang kini juga membangun binary CLI.');
    process.exitCode = 1;
    return;
  }
  const child = spawn(binary, rustArgs, { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 0;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'bot') {
    await cmdBot(rawArgs.slice(1));
    return;
  }
  const { command, positionals, flags } = parseCliArgs(rawArgs);
  if (flags.yes || flags['non-interactive']) {
    setNonInteractive(true);
  }
  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'setup':
      await cmdSetup(flags);
      break;
    case 'run':
      await cmdRun(positionals[0], flags);
      break;
    case 'start':
      await cmdStart(positionals[0], flags);
      break;
    case 'stop':
      await cmdStop(positionals[0]);
      break;
    case 'restart':
      await cmdRestart(positionals[0], flags);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      cmdLogs(positionals[0], flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'update':
      await cmdUpdate(flags);
      break;
    case 'service':
      await cmdService(positionals, flags);
      break;
    case 'remote':
      await cmdRemote(positionals, flags);
      break;
    case 'token':
      await cmdToken(positionals, flags);
      break;
    case 'uninstall':
      await cmdUninstall(flags);
      break;
    default:
      fail(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closePrompts();
}
