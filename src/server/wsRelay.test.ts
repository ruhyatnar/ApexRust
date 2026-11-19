import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import type { BinanceScreenerHub, ScreenerQueryOptions } from './binanceScreenerHub';
import { attachWebSocketRelay } from './wsRelay';

function encodeMaskedClientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = b0;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = b0;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeServerTextFrames(buf: Buffer): { texts: string[]; remainder: Buffer } {
  const texts: string[] = [];
  let cursor = 0;
  while (buf.length - cursor >= 2) {
    const opcode = buf[cursor] & 0x0f;
    let len = buf[cursor + 1] & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (buf.length - cursor < 4) break;
      len = buf.readUInt16BE(cursor + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (buf.length - cursor < 10) break;
      len = Number(buf.readBigUInt64BE(cursor + 2));
      headerLen = 10;
    }
    if (buf.length - cursor < headerLen + len) break;
    const payload = buf.subarray(cursor + headerLen, cursor + headerLen + len);
    if (opcode === 0x01) {
      texts.push(payload.toString('utf8'));
    }
    cursor += headerLen + len;
  }
  return { texts, remainder: buf.subarray(cursor) };
}

test('attachWebSocketRelay handles pipelined upgrade frames, fragmented binary->text transitions, and stray continuations', async () => {
  const observedCategories: string[] = [];
  const fakeHub = {
    onUpdate: () => () => {},
    getScreenerSnapshot: async (q: ScreenerQueryOptions) => {
      observedCategories.push(q.category ?? 'hot_volume');
      return {
        venue: q.venue,
        environment: q.environment,
        category: q.category ?? 'hot_volume',
        tickers: [],
      };
    },
  } as unknown as BinanceScreenerHub;

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const cleanupRelay = attachWebSocketRelay(server, {
    screenerHub: fakeHub,
    getDefaultVenue: () => 'Spot',
    getDefaultEnv: () => 'Testnet',
    getEngineBaseUrl: () => 'http://127.0.0.1:8787',
    getEngineAuthToken: () => '',
    authorizeUpgrade: (_req, token) =>
      token === 'secret-ws-tok' ? { ok: true } : { ok: false, status: 401, reason: 'Unauthorized' },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  try {
    // 1. Unauthorized upgrade must return HTTP 401
    const unauthStatus = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(
          [
            'GET /ws/screener?token=wrong HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });
      let data = '';
      sock.on('data', (c) => {
        data += c.toString('utf8');
      });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(unauthStatus, /^HTTP\/1\.1 401/);

    // 2. Authorized upgrade with pipelined frame in `head` + fragmented binary + stray continuation + fragmented text
    const receivedMessages: Array<{ type: string; data: { category: string } }> = [];
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        const upgradeHeaders = Buffer.from(
          [
            'GET /ws/screener?token=secret-ws-tok&category=hot_volume HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
          'utf8'
        );
        // Pipelined frame sent immediately in the same write as the HTTP Upgrade request
        const pipelinedFrame = encodeMaskedClientFrame(
          0x01,
          Buffer.from(JSON.stringify({ category: 'top_gainers' }), 'utf8'),
          true
        );
        sock.write(Buffer.concat([upgradeHeaders, pipelinedFrame]));
      });

      let upgraded = false;
      let frameBuf: Buffer = Buffer.alloc(0);
      let sentFragmentSequence = false;
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Timed out waiting for WS messages; got ${JSON.stringify(receivedMessages)}`));
      }, 4000);

      sock.on('data', (chunk) => {
        if (!upgraded) {
          const combined = Buffer.concat([frameBuf, chunk]);
          const sepIdx = combined.indexOf('\r\n\r\n');
          if (sepIdx === -1) {
            frameBuf = combined;
            return;
          }
          const headerText = combined.subarray(0, sepIdx).toString('utf8');
          assert.match(headerText, /^HTTP\/1\.1 101 Switching Protocols/);
          upgraded = true;
          frameBuf = combined.subarray(sepIdx + 4);
        } else {
          frameBuf = Buffer.concat([frameBuf, chunk]);
        }

        const decoded = decodeServerTextFrames(frameBuf);
        frameBuf = decoded.remainder;
        for (const text of decoded.texts) {
          receivedMessages.push(JSON.parse(text));
        }

        // Once initial + pipelined responses arrived, send:
        // (a) fragmented binary (0x02 fin=0 -> 0x00 fin=1)
        // (b) stray continuation (0x00 fin=1)
        // (c) fragmented text (0x01 fin=0 -> 0x00 fin=1) for volatility_leaders
        if (!sentFragmentSequence && receivedMessages.some((m) => m.data.category === 'top_gainers')) {
          sentFragmentSequence = true;
          const bin1 = encodeMaskedClientFrame(0x02, Buffer.from([1, 2, 3]), false);
          const bin2 = encodeMaskedClientFrame(0x00, Buffer.from([4, 5, 6]), true);
          const strayCont = encodeMaskedClientFrame(0x00, Buffer.from('ignored', 'utf8'), true);
          const txtPayload = JSON.stringify({ category: 'volatility_leaders' });
          const split = Math.floor(txtPayload.length / 2);
          const txt1 = encodeMaskedClientFrame(0x01, Buffer.from(txtPayload.slice(0, split), 'utf8'), false);
          const txt2 = encodeMaskedClientFrame(0x00, Buffer.from(txtPayload.slice(split), 'utf8'), true);
          sock.write(Buffer.concat([bin1, bin2, strayCont, txt1, txt2]));
        }

        if (receivedMessages.some((m) => m.data.category === 'volatility_leaders')) {
          clearTimeout(timer);
          sock.end();
          resolve();
        }
      });

      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(observedCategories.includes('hot_volume'), true);
    assert.equal(observedCategories.includes('top_gainers'), true);
    assert.equal(observedCategories.includes('volatility_leaders'), true);
  } finally {
    cleanupRelay();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
