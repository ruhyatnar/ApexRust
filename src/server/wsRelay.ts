import crypto from 'node:crypto';
import type http from 'node:http';
import type net from 'node:net';
import type { ExchangeVenue, TrendingCategory, TrendingRankingSource } from '../engine/types';
import { BinanceScreenerHub, type BinanceEnv, type ScreenerQueryOptions } from './binanceScreenerHub';

interface WsClient {
  id: string;
  socket: net.Socket;
  buffer: Buffer;
  fragmentedChunks: Buffer[];
  fragmentOpcode: number;
  closed: boolean;
}

export interface WsRelayContext {
  screenerHub: BinanceScreenerHub;
  getDefaultVenue: () => ExchangeVenue;
  getDefaultEnv: () => BinanceEnv;
  getEngineBaseUrl: () => string;
  getEngineAuthToken: () => string;
  authorizeUpgrade: (
    req: http.IncomingMessage,
    tokenFromQuery: string,
    ticketFromQuery: string
  ) => { ok: boolean; status?: number; reason?: string };
}

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendWsText(client: WsClient, text: string): void {
  if (client.closed || client.socket.destroyed) return;
  try {
    client.socket.write(encodeWsFrame(0x01, Buffer.from(text, 'utf8')));
  } catch {
    closeWsClient(client);
  }
}

function sendWsPong(client: WsClient, payload: Buffer): void {
  if (client.closed || client.socket.destroyed) return;
  try {
    client.socket.write(encodeWsFrame(0x0a, payload));
  } catch {
    closeWsClient(client);
  }
}

function sendWsPing(client: WsClient): void {
  if (client.closed || client.socket.destroyed) return;
  try {
    client.socket.write(encodeWsFrame(0x09, Buffer.alloc(0)));
  } catch {
    closeWsClient(client);
  }
}

function closeWsClient(client: WsClient): void {
  if (client.closed) return;
  client.closed = true;
  try {
    client.socket.write(encodeWsFrame(0x08, Buffer.alloc(0)));
  } catch {
    // Ignore write error on close
  }
  try {
    client.socket.destroy();
  } catch {
    // Ignore destroy error
  }
}

// Clean RFC-6455 frame parser extracting mask bytes BEFORE mutating client.buffer!
function processClientBuffer(client: WsClient, onText: (text: string) => void): void {
  while (client.buffer.length >= 2) {
    const buf = client.buffer;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < 4) return;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) return;
      const bigLen = buf.readBigUInt64BE(2);
      if (bigLen > BigInt(MAX_CLIENT_FRAME_BYTES)) {
        closeWsClient(client);
        return;
      }
      payloadLen = Number(bigLen);
      offset = 10;
    }

    if (payloadLen > MAX_CLIENT_FRAME_BYTES) {
      closeWsClient(client);
      return;
    }

    const maskStart = offset;
    const payloadStart = masked ? offset + 4 : offset;
    const frameEnd = payloadStart + payloadLen;
    if (buf.length < frameEnd) {
      return;
    }

    const payload = Buffer.allocUnsafe(payloadLen);
    buf.copy(payload, 0, payloadStart, frameEnd);
    if (masked) {
      const m0 = buf[maskStart];
      const m1 = buf[maskStart + 1];
      const m2 = buf[maskStart + 2];
      const m3 = buf[maskStart + 3];
      for (let i = 0; i < payloadLen; i += 1) {
        const m = i % 4 === 0 ? m0 : i % 4 === 1 ? m1 : i % 4 === 2 ? m2 : m3;
        payload[i] ^= m;
      }
    }

    client.buffer = buf.subarray(frameEnd);

    if (opcode === 0x08) {
      closeWsClient(client);
      return;
    }
    if (opcode === 0x09) {
      sendWsPong(client, payload);
      continue;
    }
    if (opcode === 0x0a) {
      continue;
    }

    if (opcode === 0x01 || opcode === 0x02) {
      if (fin) {
        client.fragmentOpcode = 0;
        client.fragmentedChunks = [];
        if (opcode === 0x01) onText(payload.toString('utf8'));
      } else {
        client.fragmentOpcode = opcode;
        client.fragmentedChunks = [payload];
      }
    } else if (opcode === 0x00) {
      if (client.fragmentOpcode === 0) {
        continue;
      }
      client.fragmentedChunks.push(payload);
      const total = client.fragmentedChunks.reduce((acc, c) => acc + c.length, 0);
      if (total > MAX_CLIENT_FRAME_BYTES) {
        closeWsClient(client);
        return;
      }
      if (fin) {
        const activeOpcode = client.fragmentOpcode;
        const chunks = client.fragmentedChunks;
        client.fragmentOpcode = 0;
        client.fragmentedChunks = [];
        if (activeOpcode === 0x01) {
          onText(Buffer.concat(chunks).toString('utf8'));
        }
      }
    }
  }
}

function rejectHttpUpgrade(socket: net.Socket, statusCode: number, message: string): void {
  const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : statusCode === 429 ? 'Too Many Requests' : 'Bad Request';
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`
    );
  } catch {
    // Ignore write failure
  }
  socket.destroy();
}

export function attachWebSocketRelay(server: http.Server, ctx: WsRelayContext): () => void {
  const screenerClients = new Map<string, { client: WsClient; query: ScreenerQueryOptions }>();
  const telemetryClients = new Map<string, WsClient>();

  let upstreamTelemetryWs: WebSocket | null = null;
  let upstreamReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTelemetryPayload = '';

  const broadcastTelemetry = (payload: string) => {
    lastTelemetryPayload = payload;
    for (const client of telemetryClients.values()) {
      sendWsText(client, payload);
    }
  };

  const stopUpstreamTelemetry = () => {
    lastTelemetryPayload = '';
    if (upstreamReconnectTimer) {
      clearTimeout(upstreamReconnectTimer);
      upstreamReconnectTimer = null;
    }
    if (upstreamTelemetryWs) {
      try {
        upstreamTelemetryWs.close(1000, 'No subscribers');
      } catch {
        // Ignore close error
      }
      upstreamTelemetryWs = null;
    }
  };

  const ensureUpstreamTelemetry = () => {
    if (telemetryClients.size === 0 || upstreamTelemetryWs || typeof globalThis.WebSocket !== 'function') {
      return;
    }
    const baseHttp = ctx.getEngineBaseUrl();
    const wsBase = baseHttp.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const tok = ctx.getEngineAuthToken();
    const targetUrl = tok
      ? `${wsBase}/ws/telemetry?token=${encodeURIComponent(tok)}`
      : `${wsBase}/ws/telemetry`;

    try {
      const ws = new globalThis.WebSocket(targetUrl);
      upstreamTelemetryWs = ws;
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string' && ev.data.length > 0) {
          broadcastTelemetry(ev.data);
        }
      });
      ws.addEventListener('error', () => {
        // Handled on close
      });
      ws.addEventListener('close', () => {
        upstreamTelemetryWs = null;
        if (telemetryClients.size > 0 && !upstreamReconnectTimer) {
          upstreamReconnectTimer = setTimeout(() => {
            upstreamReconnectTimer = null;
            ensureUpstreamTelemetry();
          }, 2500);
          if (typeof upstreamReconnectTimer.unref === 'function') {
            upstreamReconnectTimer.unref();
          }
        }
      });
    } catch {
      upstreamTelemetryWs = null;
    }
  };

  const unsubscribeScreener = ctx.screenerHub.onUpdate((env, venue) => {
    for (const entry of screenerClients.values()) {
      if (entry.client.closed) continue;
      const effEnv = entry.query.environment;
      const effVenue = entry.query.venue;
      const match =
        effVenue === venue &&
        (entry.query.rankingSource === 'environment' ? effEnv === env : env === 'Production' || effEnv === env);
      if (!match) continue;
      ctx.screenerHub
        .getScreenerSnapshot(entry.query)
        .then((snap) => {
          sendWsText(entry.client, JSON.stringify({ type: 'screener_snapshot', data: snap }));
        })
        .catch(() => {});
    }
  });

  const keepaliveTimer = setInterval(() => {
    for (const entry of screenerClients.values()) {
      sendWsPing(entry.client);
    }
    for (const client of telemetryClients.values()) {
      sendWsPing(client);
    }
  }, 25_000);
  if (typeof keepaliveTimer.unref === 'function') {
    keepaliveTimer.unref();
  }

  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if (pathname !== '/ws/screener' && pathname !== '/ws/telemetry') {
      socket.destroy();
      return;
    }

    const tokenFromQuery = (parsedUrl.searchParams.get('token') ?? '').trim();
    const ticketFromQuery = (parsedUrl.searchParams.get('ticket') ?? '').trim();
    const auth = ctx.authorizeUpgrade(req, tokenFromQuery, ticketFromQuery);
    if (!auth.ok) {
      rejectHttpUpgrade(socket, auth.status ?? 401, auth.reason ?? 'Unauthorized');
      return;
    }

    const wsKey = String(req.headers['sec-websocket-key'] ?? '').trim();
    if (!wsKey) {
      rejectHttpUpgrade(socket, 400, 'Missing Sec-WebSocket-Key');
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + WS_MAGIC_GUID)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        '',
      ].join('\r\n')
    );

    const clientId = `${pathname}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const client: WsClient = {
      id: clientId,
      socket,
      buffer: Buffer.alloc(0),
      fragmentedChunks: [],
      fragmentOpcode: 0,
      closed: false,
    };

    const appendAndProcess = (chunk: Buffer, onText: (text: string) => void) => {
      if (client.closed) return;
      if (client.buffer.length + chunk.length > MAX_CLIENT_FRAME_BYTES * 2) {
        closeWsClient(client);
        return;
      }
      client.buffer = client.buffer.length > 0 ? Buffer.concat([client.buffer, chunk]) : chunk;
      processClientBuffer(client, onText);
    };

    if (pathname === '/ws/screener') {
      const sp = parsedUrl.searchParams;
      const venueParam: ExchangeVenue = sp.get('venue') === 'Futures' ? 'Futures' : sp.get('venue') === 'Spot' ? 'Spot' : ctx.getDefaultVenue();
      const envParam: BinanceEnv = sp.get('environment') === 'Production' ? 'Production' : sp.get('environment') === 'Testnet' ? 'Testnet' : ctx.getDefaultEnv();
      const catRaw = sp.get('category') ?? 'hot_volume';
      const category: TrendingCategory =
        catRaw === 'top_gainers' ||
        catRaw === 'top_losers' ||
        catRaw === 'volatility_leaders' ||
        catRaw === 'cts_momentum'
          ? catRaw
          : 'hot_volume';
      const rsRaw = sp.get('rankingSource') ?? 'auto';
      const rankingSource: TrendingRankingSource =
        rsRaw === 'production' || rsRaw === 'environment' ? rsRaw : 'auto';

      const query: ScreenerQueryOptions = {
        venue: venueParam,
        environment: envParam,
        rankingSource,
        category,
        quoteAsset: (sp.get('quoteAsset') ?? 'USDT').toUpperCase(),
        minQuoteVolumeUsdt: Math.max(0, Number(sp.get('minQuoteVolumeUsdt') ?? 0) || 0),
        onlyTradable: sp.get('onlyTradable') !== 'false',
        limit: Math.min(200, Math.max(1, Number(sp.get('limit') ?? 50) || 50)),
        searchQuery: sp.get('searchQuery') ?? undefined,
      };
      const entry = { client, query };
      screenerClients.set(clientId, entry);

      // Push initial snapshot right away
      ctx.screenerHub
        .getScreenerSnapshot(entry.query)
        .then((snap) => sendWsText(client, JSON.stringify({ type: 'screener_snapshot', data: snap })))
        .catch(() => {});

      const handleScreenerText = (text: string) => {
        try {
          const msg = JSON.parse(text) as Partial<ScreenerQueryOptions>;
          if (msg.venue === 'Spot' || msg.venue === 'Futures') entry.query.venue = msg.venue;
          if (msg.environment === 'Testnet' || msg.environment === 'Production') entry.query.environment = msg.environment;
          if (
            msg.category === 'hot_volume' ||
            msg.category === 'top_gainers' ||
            msg.category === 'top_losers' ||
            msg.category === 'volatility_leaders' ||
            msg.category === 'cts_momentum'
          ) {
            entry.query.category = msg.category;
          }
          if (msg.rankingSource === 'auto' || msg.rankingSource === 'production' || msg.rankingSource === 'environment') {
            entry.query.rankingSource = msg.rankingSource;
          }
          if (typeof msg.quoteAsset === 'string' && msg.quoteAsset.trim()) {
            entry.query.quoteAsset = msg.quoteAsset.trim().toUpperCase();
          }
          if (typeof msg.minQuoteVolumeUsdt === 'number' && Number.isFinite(msg.minQuoteVolumeUsdt)) {
            entry.query.minQuoteVolumeUsdt = Math.max(0, msg.minQuoteVolumeUsdt);
          }
          if (typeof msg.onlyTradable === 'boolean') entry.query.onlyTradable = msg.onlyTradable;
          if (typeof msg.limit === 'number' && Number.isFinite(msg.limit)) {
            entry.query.limit = Math.min(200, Math.max(1, msg.limit));
          }
          if (typeof msg.searchQuery === 'string') entry.query.searchQuery = msg.searchQuery;
          if (Array.isArray(msg.activeWatchlist)) entry.query.activeWatchlist = msg.activeWatchlist;
          ctx.screenerHub
            .getScreenerSnapshot(entry.query)
            .then((snap) => sendWsText(client, JSON.stringify({ type: 'screener_snapshot', data: snap })))
            .catch(() => {});
        } catch {
          // Ignore malformed subscription payload
        }
      };

      socket.on('data', (chunk) => appendAndProcess(chunk, handleScreenerText));
      if (head && head.length > 0) {
        appendAndProcess(head, handleScreenerText);
      }

      const cleanup = () => {
        closeWsClient(client);
        screenerClients.delete(clientId);
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    } else {
      telemetryClients.set(clientId, client);
      if (lastTelemetryPayload) {
        sendWsText(client, lastTelemetryPayload);
      }
      ensureUpstreamTelemetry();

      socket.on('data', (chunk) => appendAndProcess(chunk, () => {}));
      if (head && head.length > 0) {
        appendAndProcess(head, () => {});
      }

      const cleanup = () => {
        closeWsClient(client);
        telemetryClients.delete(clientId);
        if (telemetryClients.size === 0) {
          stopUpstreamTelemetry();
        }
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    }
  });

  return () => {
    clearInterval(keepaliveTimer);
    unsubscribeScreener();
    stopUpstreamTelemetry();
    for (const entry of screenerClients.values()) closeWsClient(entry.client);
    for (const client of telemetryClients.values()) closeWsClient(client);
    screenerClients.clear();
    telemetryClients.clear();
  };
}
