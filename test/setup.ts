/**
 * test/setup.ts
 *
 * Shared test utilities and helpers for the napi-router test suite.
 * All test files import from here — keeps tests DRY and avoids port conflicts.
 *
 * Compatible with: bun test
 */

import { serve, tryServe } from '../adapter/serve.ts';
import type { Server, ServeOptions, WebSocketHandlers, ServerWebSocket } from '../adapter/serve.ts';

export { serve, tryServe };
export type { Server, ServeOptions, WebSocketHandlers, ServerWebSocket };

// ---------------------------------------------------------------------------
// Port registry — each suite owns a non-overlapping range
// Tests within a suite call nextPort(SUITE) to get a unique port.
// ---------------------------------------------------------------------------

export const PORT_RANGES = {
  REQUEST_IP:  { base: 9690, size: 10 },
  HTTP:        { base: 9700, size: 30 },
  SERVER_INFO: { base: 9730, size: 10 },
  ERRORS:      { base: 9740, size: 20 },
  LIFECYCLE:   { base: 9760, size: 20 },
  WEBSOCKET:   { base: 9780, size: 20 },
  CONCURRENT:  { base: 9800, size: 10 },
} as const;

type Suite = keyof typeof PORT_RANGES;

const _counters: Partial<Record<Suite, number>> = {};

/**
 * Allocate the next unique port for a given test suite.
 * Throws if the pool is exhausted (increase `size` if needed).
 */
export function nextPort(suite: Suite): number {
  const { base, size } = PORT_RANGES[suite];
  const idx = (_counters[suite] ??= 0);
  if (idx >= size) throw new Error(`Port pool exhausted for suite "${suite}"`);
  _counters[suite] = idx + 1;
  return base + idx;
}

// ---------------------------------------------------------------------------
// Server factory helpers
// ---------------------------------------------------------------------------

/**
 * Start a server, run `fn`, then stop the server — even if `fn` throws.
 * Useful for self-contained one-off tests.
 *
 * @example
 * it("example", () => withServer(9700, { fetch: handler }, async (s) => {
 *   const res = await get(s, "/");
 *   expect(res.status).toBe(200);
 * }));
 */
export async function withServer(
  port: number,
  options: Omit<ServeOptions, 'port'>,
  fn: (server: Server) => Promise<void>,
): Promise<void> {
  const server = await serve({ port, ...options });
  try {
    await fn(server);
  } finally {
    server.stop();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Make a fetch request to a path on the given server. */
export function get(server: Server, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://${server.hostname}:${server.port}${path}`, init);
}

/** POST to a path on the given server with a text body. */
export function post(server: Server, path: string, body: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://${server.hostname}:${server.port}${path}`, {
    method: 'POST',
    body,
    ...init,
  });
}

/** Send any method to a path on the given server. */
export function request(
  server: Server,
  method: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://${server.hostname}:${server.port}${path}`, { method, ...init });
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/** Connect a WebSocket and wait for it to open. */
export function wsConnect(server: Server, path = '/ws'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${server.hostname}:${server.port}${path}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`WebSocket failed to connect to port ${server.port}${path}`));
  });
}

/** Return a Promise that resolves with the next message received on `ws`. */
export function nextMessage(ws: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('error', onErr);
      resolve(e.data);
    };
    const onErr = () => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('error', onErr);
      reject(new Error('WebSocket error while waiting for message'));
    };
    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', onErr);
  });
}

/** Close a WebSocket and wait for its close event. */
export function closeWs(ws: WebSocket, code = 1000, reason = ''): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1000, reason: '' });
      return;
    }
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true });
    ws.close(code, reason);
  });
}

/** Collect `n` messages from a WebSocket, then resolve. */
export function collectMessages(ws: WebSocket, n: number): Promise<(string | ArrayBuffer)[]> {
  return new Promise((resolve, reject) => {
    const messages: (string | ArrayBuffer)[] = [];
    const onMsg = (e: MessageEvent) => {
      messages.push(e.data);
      if (messages.length >= n) {
        ws.removeEventListener('message', onMsg);
        resolve(messages);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Standard multi-route fetch handler used across several test suites.
 * Routes:
 *   GET  /           → 200 "Hello World"
 *   GET  /json       → 200 { ok: true }
 *   GET  /headers    → echos "authorization" header
 *   GET  /query      → echos "?name" query param
 *   GET  /method     → echos request method
 *   GET  /server-url → echos server.url (requires server arg)
 *   POST /echo       → echos request body
 *   *                → 404 "Not Found"
 */
export async function standardHandler(req: Request, server: Server): Promise<Response> {
  const url = new URL(req.url);

  switch (url.pathname) {
    case '/':
      return new Response('Hello World', { headers: { 'content-type': 'text/plain' } });

    case '/json':
      return Response.json({ ok: true });

    case '/headers':
      return new Response(req.headers.get('authorization') ?? 'none', {
        headers: { 'content-type': 'text/plain' },
      });

    case '/query':
      return new Response(url.searchParams.get('name') ?? 'none', {
        headers: { 'content-type': 'text/plain' },
      });

    case '/method':
      return new Response(req.method, { headers: { 'content-type': 'text/plain' } });

    case '/server-url':
      return new Response(server.url, { headers: { 'content-type': 'text/plain' } });

    case '/echo':
      if (req.method === 'POST') {
        const body = await req.text();
        return new Response(body, { headers: { 'content-type': 'text/plain' } });
      }
      return new Response('Method Not Allowed', { status: 405 });

    default:
      return new Response('Not Found', { status: 404 });
  }
}
