// Pure bot.toml renderer: edits rust-bot/config/bot.example.toml line-by-line within
// [section] scope so every comment and default is preserved.

export const ENDPOINTS = {
  spot: {
    testnet: {
      ws_stream_url: 'wss://stream.testnet.binance.vision/stream',
      ws_api_url: 'wss://ws-api.testnet.binance.vision/ws-api/v3',
      rest_base_url: 'https://testnet.binance.vision',
    },
    production: {
      ws_stream_url: 'wss://stream.binance.com:9443/stream',
      ws_api_url: 'wss://ws-api.binance.com:443/ws-api/v3',
      rest_base_url: 'https://api.binance.com',
    },
  },
  futures: {
    testnet: {
      ws_stream_url: 'wss://stream.binancefuture.com/stream',
      ws_api_url: 'wss://testnet.binancefuture.com/ws-fapi/v1',
      rest_base_url: 'https://testnet.binancefuture.com',
    },
    production: {
      ws_stream_url: 'wss://fstream.binance.com/stream',
      ws_api_url: 'wss://ws-fapi.binance.com/ws-fapi/v1',
      rest_base_url: 'https://fapi.binance.com',
    },
  },
};

const SECTION_LINE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

function tomlLiteral(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function keyRegex(key) {
  return new RegExp(`^(\\s*${key}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^#\\s]+)(\\s*(#.*)?)$`);
}

/** Read a scalar value from `[section] key = ...` (first `[section]`, not array tables). */
export function readTomlValue(text, section, key) {
  let current = '';
  let isArrayTable = false;
  const re = keyRegex(key);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const sec = SECTION_LINE.exec(line);
    if (sec) {
      current = sec[1];
      isArrayTable = line.trim().startsWith('[[');
      continue;
    }
    if (current !== section || isArrayTable) continue;
    const m = re.exec(line);
    if (m) {
      const raw = m[2];
      if (raw.startsWith('"')) return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
      if (raw.startsWith("'")) return raw.slice(1, -1);
      if (raw === 'true' || raw === 'false') return raw === 'true';
      const num = Number(raw);
      return Number.isFinite(num) ? num : raw;
    }
  }
  return undefined;
}

/**
 * Apply `{ section: { key: value } }` edits. Existing keys keep their trailing comments;
 * missing keys are appended at the end of their section.
 */
export function applyTomlEdits(text, edits) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  const pending = new Map(
    Object.entries(edits).map(([sec, kv]) => [sec, new Map(Object.entries(kv))])
  );
  let current = null;
  let isArrayTable = false;

  const flushMissing = () => {
    if (current === null || isArrayTable) return;
    const remaining = pending.get(current);
    if (!remaining || remaining.size === 0) return;
    // Insert before trailing blank lines of the section
    let insertAt = out.length;
    while (insertAt > 0 && out[insertAt - 1].trim() === '') insertAt -= 1;
    const additions = [...remaining.entries()].map(([k, v]) => `${k} = ${tomlLiteral(v)}`);
    out.splice(insertAt, 0, ...additions);
    remaining.clear();
  };

  for (const line of lines) {
    const sec = SECTION_LINE.exec(line);
    if (sec) {
      flushMissing();
      current = sec[1];
      isArrayTable = line.trim().startsWith('[[');
      out.push(line);
      continue;
    }
    const remaining = current !== null && !isArrayTable ? pending.get(current) : undefined;
    if (remaining && remaining.size > 0) {
      let replaced = false;
      for (const [key, value] of remaining) {
        const m = keyRegex(key).exec(line);
        if (m) {
          out.push(`${m[1]}${tomlLiteral(value)}${m[3] ?? ''}`);
          remaining.delete(key);
          replaced = true;
          break;
        }
      }
      if (replaced) continue;
    }
    out.push(line);
  }
  flushMissing();

  // Sections that never appeared get appended in full
  for (const [sec, kv] of pending) {
    if (kv.size === 0) continue;
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
    out.push('', `[${sec}]`);
    for (const [k, v] of kv) out.push(`${k} = ${tomlLiteral(v)}`);
  }

  let result = out.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

/**
 * Render a safe bot.toml from the example template.
 * Always forces paper_trading = true and armed_for_live_orders = false.
 */
export function renderBotToml(exampleText, opts) {
  const environment = opts.environment === 'production' ? 'production' : 'testnet';
  const venue = opts.venue === 'futures' ? 'futures' : 'spot';
  const leverage = Math.min(20, Math.max(1, Math.round(Number(opts.leverage ?? 3)) || 3));
  const marginType = opts.marginType === 'CROSSED' ? 'CROSSED' : 'ISOLATED';
  const authMethod = opts.authMethod === 'ed25519' ? 'ed25519' : 'hmac-sha256';
  const rawBotHost = String(opts.botHost ?? '127.0.0.1').trim();
  const botHost = rawBotHost || '127.0.0.1';
  const botPort = Number(opts.botPort ?? 8080) || 8080;
  const webPort = Number(opts.webPort ?? 3000) || 3000;

  const credentials = {
    auth_method: authMethod,
    armed_for_live_orders: false,
  };
  if (authMethod === 'ed25519' && opts.ed25519KeyPath) {
    credentials.ed25519_key_path = String(opts.ed25519KeyPath);
  }

  const endpoints = { ...ENDPOINTS[venue][environment] };
  if (environment === 'testnet' && venue === 'futures') {
    const customFutRest = String(opts.futuresTestnetRest ?? process.env.BINANCE_FUTURES_TESTNET_REST ?? '').trim().replace(/\/+$/, '');
    if (customFutRest) {
      endpoints.rest_base_url = customFutRest;
      if (customFutRest.includes('demo-fapi.binance.com')) {
        endpoints.ws_stream_url = 'wss://demo-fstream.binance.com/stream';
      }
    }
  } else if (environment === 'testnet' && venue === 'spot') {
    const customSpotRest = String(opts.spotTestnetRest ?? process.env.BINANCE_SPOT_TESTNET_REST ?? '').trim().replace(/\/+$/, '');
    if (customSpotRest) {
      endpoints.rest_base_url = customSpotRest;
      if (customSpotRest.includes('demo-api.binance.com')) {
        endpoints.ws_stream_url = 'wss://demo-stream.binance.com/stream';
        endpoints.ws_api_url = 'wss://demo-ws-api.binance.com/ws-api/v3';
      }
    }
  }

  return applyTomlEdits(exampleText, {
    exchange: {
      environment,
      venue,
      leverage,
      margin_type: marginType,
      paper_trading: true,
      ...endpoints,
    },
    'exchange.credentials': credentials,
    web: {
      bind_addr: `${botHost}:${botPort}`,
      allowed_origin: `http://localhost:${webPort}`,
      auth_token: '',
    },
  });
}

/** Extract the port from `[web] bind_addr = "host:port"`. */
export function botPortFromToml(text, fallback = 8080) {
  const addr = readTomlValue(text, 'web', 'bind_addr');
  const port = Number(String(addr ?? '').split(':').pop());
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
