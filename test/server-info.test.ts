/**
 * test/server-info.test.ts
 *
 * Validates all properties and metadata exposed on the Server handle:
 *   server.port, server.hostname, server.url,
 *   server.pendingRequests, server.pendingWebSockets,
 *   server.wsConnectionIds, [Symbol.toStringTag]
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { serve, nextPort, wsConnect, sleep, type Server } from './setup.js';

let server: Server;
const PORT = nextPort('SERVER_INFO');

beforeAll(async () => {
  server = await serve({
    port: PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      // Slow route — lets us observe pendingRequests > 0 in tests
      const url = new URL(req.url);
      if (url.pathname === '/slow') {
        await sleep(200);
        return new Response('slow');
      }
      return new Response('ok');
    },
    websocket: {
      message(ws, msg) {
        ws.send(`echo:${msg}`);
      },
    },
  });
});

afterAll(() => server.stop());

// ---------------------------------------------------------------------------
// server.port
// ---------------------------------------------------------------------------

describe('server.port', () => {
  it('matches the requested port', () => {
    expect(server.port).toBe(PORT);
  });

  it('is a number', () => {
    expect(typeof server.port).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// server.hostname
// ---------------------------------------------------------------------------

describe('server.hostname', () => {
  it('is the bound address string', () => {
    expect(typeof server.hostname).toBe('string');
    expect(server.hostname.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// server.url
// ---------------------------------------------------------------------------

describe('server.url', () => {
  it('starts with http://', () => {
    expect(server.url).toMatch(/^http:\/\//);
  });

  it('ends with /', () => {
    expect(server.url).toMatch(/\/$/);
  });

  it('contains the port', () => {
    expect(server.url).toContain(String(PORT));
  });

  it('is a valid URL', () => {
    expect(() => new URL(server.url)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// server.pendingRequests
// ---------------------------------------------------------------------------

describe('server.pendingRequests', () => {
  it('is 0 when idle', () => {
    expect(server.pendingRequests).toBe(0);
  });

  it('is a number', () => {
    expect(typeof server.pendingRequests).toBe('number');
  });

  it('rises while requests are in-flight, then falls back to 0', async () => {
    // Fire several slow requests without awaiting them
    const promises = Array.from({ length: 5 }, () =>
      fetch(`http://127.0.0.1:${PORT}/slow`),
    );

    // Give them time to reach the handler
    await sleep(50);
    expect(server.pendingRequests).toBeGreaterThan(0);

    // Wait for them to finish
    await Promise.all(promises);
    await sleep(20);
    expect(server.pendingRequests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// server.pendingWebSockets
// ---------------------------------------------------------------------------

describe('server.pendingWebSockets', () => {
  it('is 0 before any WebSocket connects', () => {
    expect(server.pendingWebSockets).toBe(0);
  });

  it('increments when a WebSocket connects', async () => {
    const ws = await wsConnect(server);
    await sleep(30);
    expect(server.pendingWebSockets).toBeGreaterThan(0);
    ws.close();
    await sleep(50);
  });

  it('decrements after the WebSocket closes', async () => {
    const ws = await wsConnect(server);
    await sleep(30);
    ws.close();
    await sleep(80);
    expect(server.pendingWebSockets).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// server.wsConnectionIds
// ---------------------------------------------------------------------------

describe('server.wsConnectionIds', () => {
  it('is an empty array when no connections', async () => {
    await sleep(20);
    expect(server.wsConnectionIds).toEqual([]);
  });

  it('contains a string ID while a connection is open', async () => {
    const ws = await wsConnect(server);
    await sleep(30);
    const ids = server.wsConnectionIds;
    expect(ids.length).toBeGreaterThan(0);
    expect(typeof ids[0]).toBe('string');
    ws.close();
    await sleep(60);
  });

  it('tracks multiple simultaneous connections', async () => {
    const ws1 = await wsConnect(server);
    const ws2 = await wsConnect(server);
    await sleep(40);
    expect(server.wsConnectionIds.length).toBe(2);
    ws1.close();
    ws2.close();
    await sleep(80);
  });
});

// ---------------------------------------------------------------------------
// OS-assigned port (port = 0)
// ---------------------------------------------------------------------------

describe('OS-assigned port (port 0)', () => {
  it('binds to a real port when 0 is requested', async () => {
    const s = await serve({
      port: 0,
      fetch: () => new Response('dynamic port'),
    });

    expect(s.port).toBeGreaterThan(0);
    expect(s.port).toBeLessThanOrEqual(65535);

    const res = await fetch(s.url);
    expect(await res.text()).toBe('dynamic port');

    s.stop();
  });
});
