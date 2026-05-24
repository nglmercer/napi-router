/**
 * test/http.test.ts
 *
 * HTTP feature coverage:
 *   - All standard methods (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
 *   - Request: URL, path, query string, headers, body
 *   - Response: status codes, headers, body, JSON
 *   - Large bodies
 *   - fetch handler receives server handle as second argument
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  serve,
  nextPort,
  withServer,
  get,
  post,
  request,
  standardHandler,
  sleep,
  type Server,
} from './setup.js';

// ---------------------------------------------------------------------------
// Shared server for stateless HTTP tests
// ---------------------------------------------------------------------------

let server: Server;

beforeAll(async () => {
  server = await serve({
    port: nextPort('HTTP'),
    hostname: '127.0.0.1',
    fetch: standardHandler,
  });
});

afterAll(() => server.stop());

// ---------------------------------------------------------------------------
// Basic GET
// ---------------------------------------------------------------------------

describe('GET requests', () => {
  it('returns 200 and body for /', async () => {
    const res = await get(server, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello World');
  });

  it('returns correct content-type for /', async () => {
    const res = await get(server, '/');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('returns 404 for unknown route', async () => {
    const res = await get(server, '/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('JSON responses', () => {
  it('returns application/json content-type', async () => {
    const res = await get(server, '/json');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('body parses as JSON', async () => {
    const res = await get(server, '/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

describe('Query string', () => {
  it('parses ?name param from URL', async () => {
    const res = await get(server, '/query?name=bun');
    expect(await res.text()).toBe('bun');
  });

  it('returns "none" when query param missing', async () => {
    const res = await get(server, '/query');
    expect(await res.text()).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Request headers forwarding
// ---------------------------------------------------------------------------

describe('Request headers', () => {
  it('forwards authorization header to handler', async () => {
    const res = await get(server, '/headers', {
      headers: { authorization: 'Bearer abc123' },
    });
    expect(await res.text()).toBe('Bearer abc123');
  });

  it('returns "none" when authorization header is absent', async () => {
    const res = await get(server, '/headers');
    expect(await res.text()).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// fetch handler receives server as second argument
// ---------------------------------------------------------------------------

describe('fetch handler second argument (server)', () => {
  it('server.url is passed to fetch handler', async () => {
    const res = await get(server, '/server-url');
    const text = await res.text();
    expect(text).toMatch(/^http:\/\//);
    expect(text).toContain(String(server.port));
  });
});

// ---------------------------------------------------------------------------
// POST / body
// ---------------------------------------------------------------------------

describe('POST requests', () => {
  it('echoes text body', async () => {
    const res = await post(server, '/echo', 'hello body');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello body');
  });

  it('echoes empty body', async () => {
    const res = await post(server, '/echo', '');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('returns 405 for GET /echo', async () => {
    const res = await get(server, '/echo');
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// HTTP methods — PUT, PATCH, DELETE, OPTIONS
// ---------------------------------------------------------------------------

describe('HTTP methods', () => {
  let methodServer: Server;

  beforeAll(async () => {
    methodServer = await serve({
      port: nextPort('HTTP'),
      hostname: '127.0.0.1',
      async fetch(req) {
        return new Response(req.method);
      },
    });
  });

  afterAll(() => methodServer.stop());

  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    it(`handles ${method}`, async () => {
      const res = await request(methodServer, method, '/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(method);
    });
  }
});

// ---------------------------------------------------------------------------
// Response status codes
// ---------------------------------------------------------------------------

describe('Response status codes', () => {
  let statusServer: Server;

  beforeAll(async () => {
    statusServer = await serve({
      port: nextPort('HTTP'),
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const code = Number(url.searchParams.get('code') ?? '200');
        return new Response(`status ${code}`, { status: code });
      },
    });
  });

  afterAll(() => statusServer.stop());

  for (const code of [200, 201, 204, 400, 401, 403, 404, 422, 500, 503]) {
    it(`returns status ${code}`, async () => {
      const res = await get(statusServer, `/?code=${code}`);
      expect(res.status).toBe(code);
    });
  }
});

// ---------------------------------------------------------------------------
// Custom response headers
// ---------------------------------------------------------------------------

describe('Custom response headers', () => {
  it('sends custom headers', async () => {
    const port = nextPort('HTTP');
    await withServer(port, {
      hostname: '127.0.0.1',
      fetch() {
        return new Response('ok', {
          headers: {
            'x-powered-by': 'napi-router',
            'x-request-id': 'test-123',
            'cache-control': 'no-store',
          },
        });
      },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.headers.get('x-powered-by')).toBe('napi-router');
      expect(res.headers.get('x-request-id')).toBe('test-123');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});

// ---------------------------------------------------------------------------
// Large bodies
// ---------------------------------------------------------------------------

describe('Large bodies', () => {
  let largeServer: Server;

  beforeAll(async () => {
    largeServer = await serve({
      port: nextPort('HTTP'),
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.text();
        return new Response(String(body.length));
      },
    });
  });

  afterAll(() => largeServer.stop());

  it('handles 100 KB request body', async () => {
    const body = 'x'.repeat(100_000);
    const res = await post(largeServer, '/', body);
    expect(await res.text()).toBe('100000');
  });

  it('handles 500 KB request body', async () => {
    const body = 'y'.repeat(500_000);
    const res = await post(largeServer, '/', body);
    expect(await res.text()).toBe('500000');
  });

  it('handles 1 MB request body', async () => {
    const body = 'z'.repeat(1_000_000);
    const res = await post(largeServer, '/', body);
    expect(await res.text()).toBe('1000000');
  });
});

// ---------------------------------------------------------------------------
// Multiple concurrent requests
// ---------------------------------------------------------------------------

describe('Concurrent requests', () => {
  let concurrentServer: Server;

  beforeAll(async () => {
    concurrentServer = await serve({
      port: nextPort('HTTP'),
      hostname: '127.0.0.1',
      async fetch(req) {
        // Simulate async work
        await sleep(5);
        return new Response('ok');
      },
    });
  });

  afterAll(() => concurrentServer.stop());

  it('handles 20 concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => get(concurrentServer, '/'))
    );
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    }
  });
});
