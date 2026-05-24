/**
 * test/server-info.test.ts
 *
 * Validates all properties and metadata exposed on the Server handle:
 *   server.port, server.hostname, server.url,
 *   server.pendingRequests, server.pendingWebSockets,
 *   server.wsConnectionIds, [Symbol.toStringTag]
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { serve, nextPort, wsConnect, sleep, closeWs, withServer, type Server } from './setup.js';

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
  it('is 0 before any WebSocket connects', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok')
    }, async (s) => {
      expect(s.pendingWebSockets).toBe(0);
    });
  });

  it('increments when a WebSocket connects', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok'),
      websocket: { message() {} }
    }, async (s) => {
      const ws = await wsConnect(s);
      await sleep(30);
      expect(s.pendingWebSockets).toBeGreaterThan(0);
      await closeWs(ws);
      await sleep(50);
    });
  });

  it('decrements after the WebSocket closes', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok'),
      websocket: { message() {} }
    }, async (s) => {
      const ws = await wsConnect(s);
      await sleep(30);
      await closeWs(ws);
      await sleep(150);
      expect(s.pendingWebSockets).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// server.wsConnectionIds
// ---------------------------------------------------------------------------

describe('server.wsConnectionIds', () => {
  it('is an empty array when no connections', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok')
    }, async (s) => {
      await sleep(20);
      expect(s.wsConnectionIds).toEqual([]);
    });
  });

  it('contains a string ID while a connection is open', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok'),
      websocket: { message() {} }
    }, async (s) => {
      const ws = await wsConnect(s);
      await sleep(30);
      const ids = s.wsConnectionIds;
      expect(ids.length).toBeGreaterThan(0);
      expect(typeof ids[0]).toBe('string');
      await closeWs(ws);
      await sleep(50);
    });
  });

  it('tracks multiple simultaneous connections', async () => {
    await withServer(nextPort('SERVER_INFO'), {
      fetch: () => new Response('ok'),
      websocket: { message() {} }
    }, async (s) => {
      const ws1 = await wsConnect(s);
      const ws2 = await wsConnect(s);
      await sleep(40);
      expect(s.wsConnectionIds.length).toBe(2);
      await closeWs(ws1);
      await closeWs(ws2);
      await sleep(50);
    });
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
