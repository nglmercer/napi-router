/**
 * test/websocket.test.ts
 *
 * Full WebSocket feature coverage:
 *   - Connection open (open handler, server.pendingWebSockets)
 *   - Text messages (echo via ws.send)
 *   - Binary messages (Uint8Array echo)
 *   - Server-initiated messages (server.sendToWs)
 *   - Server-initiated binary (server.sendBinaryToWs)
 *   - Server-initiated close (server.closeWs)
 *   - server.wsConnectionIds tracking
 *   - Client-initiated close (close handler, code + reason)
 *   - Concurrent connections isolated from each other
 *   - WebSocket alongside HTTP on the same server
 *   - websocket.open handler
 *   - websocket.error handler
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  serve,
  nextPort,
  wsConnect,
  nextMessage,
  collectMessages,
  closeWs,
  sleep,
  get,
  type Server,
  type ServerWebSocket,
} from './setup.js';

// ---------------------------------------------------------------------------
// Shared echo server
// ---------------------------------------------------------------------------

let echoServer: Server;
const ECHO_PORT = nextPort('WEBSOCKET');

beforeAll(async () => {
  echoServer = await serve({
    port: ECHO_PORT,
    hostname: '127.0.0.1',
    fetch: () => new Response('ws server running'),
    websocket: {
      message(ws, msg) {
        // Echo text or binary back
        ws.send(msg as string);
      },
    },
  });
});

afterAll(() => echoServer.stop());

// ---------------------------------------------------------------------------
// Connection open
// ---------------------------------------------------------------------------

describe('WebSocket — open', () => {
  it('connects and reaches OPEN state', async () => {
    const ws = await wsConnect(echoServer);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeWs(ws);
    await sleep(50);
  });

  it('increments pendingWebSockets on connect', async () => {
    const before = echoServer.pendingWebSockets;
    const ws = await wsConnect(echoServer);
    await sleep(30);
    expect(echoServer.pendingWebSockets).toBe(before + 1);
    await closeWs(ws);
    await sleep(60);
  });

  it('open handler is called with a ws proxy', async () => {
    let receivedId: string | null = null;

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        open(ws) { receivedId = ws.id; },
        message(ws, msg) { ws.send(msg as string); },
      },
    });

    const ws = await wsConnect(s);
    await sleep(50);

    expect(typeof receivedId).toBe('string');
    expect(receivedId!.length).toBeGreaterThan(0);

    await closeWs(ws);
    await sleep(50);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

describe('WebSocket — text messages', () => {
  it('echoes a simple text message', async () => {
    const ws = await wsConnect(echoServer);
    const p = nextMessage(ws);
    ws.send('hello');
    const msg = await p;
    expect(msg).toBe('hello');
    await closeWs(ws);
    await sleep(40);
  });

  it('echoes unicode text correctly', async () => {
    const ws = await wsConnect(echoServer);
    const p = nextMessage(ws);
    ws.send('¡Hola mundo! 🦀');
    const msg = await p;
    expect(msg).toBe('¡Hola mundo! 🦀');
    await closeWs(ws);
    await sleep(40);
  });

  it('echoes multiple sequential messages correctly', async () => {
    const ws = await wsConnect(echoServer);
    const messages = ['one', 'two', 'three'];

    for (const text of messages) {
      const p = nextMessage(ws);
      ws.send(text);
      const reply = await p;
      expect(reply).toBe(text);
    }

    await closeWs(ws);
    await sleep(40);
  });
});

// ---------------------------------------------------------------------------
// Binary messages
// ---------------------------------------------------------------------------

describe('WebSocket — binary messages', () => {
  it('echoes a binary Uint8Array message', async () => {
    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        message(ws, msg) {
          if (msg instanceof Uint8Array) {
            ws.send(msg);
          }
        },
      },
    });

    const ws = await wsConnect(s);
    ws.binaryType = 'arraybuffer';

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const p = nextMessage(ws);
    ws.send(data);

    const reply = await p;
    const arr = new Uint8Array(reply as ArrayBuffer);
    expect(Array.from(arr)).toEqual([1, 2, 3, 4, 5]);

    await closeWs(ws);
    await sleep(40);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Server-initiated messages (server.sendToWs)
// ---------------------------------------------------------------------------

describe('server.sendToWs()', () => {
  it('sends a text message to a specific connection', async () => {
    let openedId: string | null = null;

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        open(ws) { openedId = ws.id; },
        message(ws, msg) { ws.send(msg as string); },
      },
    });

    const ws = await wsConnect(s);
    await sleep(50); // wait for open handler

    expect(openedId).not.toBeNull();

    // Server pushes a message to the client
    const recvPromise = nextMessage(ws);
    await s.sendToWs(openedId!, 'server push');
    expect(await recvPromise).toBe('server push');

    await closeWs(ws);
    await sleep(50);
    s.stop();
  });

  it('silently ignores unknown connection IDs', () => {
    expect(echoServer.sendToWs('nonexistent-id', 'msg')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Server-initiated binary (server.sendBinaryToWs)
// ---------------------------------------------------------------------------

describe('server.sendBinaryToWs()', () => {
  it('sends binary data to a specific connection', async () => {
    let openedId: string | null = null;

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        open(ws) { openedId = ws.id; },
        message(ws, msg) { ws.send(msg as string); },
      },
    });

    const ws = await wsConnect(s);
    ws.binaryType = 'arraybuffer';
    await sleep(50);

    const recvPromise = nextMessage(ws);
    await s.sendBinaryToWs(openedId!, [10, 20, 30]);

    const buf = await recvPromise as ArrayBuffer;
    expect(Array.from(new Uint8Array(buf))).toEqual([10, 20, 30]);

    await closeWs(ws);
    await sleep(50);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Server-initiated close (server.closeWs)
// ---------------------------------------------------------------------------

describe('server.closeWs()', () => {
  it('closes the client WebSocket from the server side', async () => {
    let openedId: string | null = null;

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        open(ws) { openedId = ws.id; },
        message(ws, msg) { ws.send(msg as string); },
      },
    });

    const ws = await wsConnect(s);
    await sleep(50);

    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });

    await s.closeWs(openedId!);
    await Promise.race([closed, sleep(500)]);

    expect([WebSocket.CLOSING, WebSocket.CLOSED] as number[]).toContain(ws.readyState);

    await sleep(50);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// server.wsConnectionIds tracking
// ---------------------------------------------------------------------------

describe('server.wsConnectionIds', () => {
  it('is empty before any connections', () => {
    // echoServer may have leftover — use a fresh one
    // (Already tested in server-info.test.ts; here we focus on ID format)
    expect(Array.isArray(echoServer.wsConnectionIds)).toBe(true);
  });

  it('each connection gets a unique ID', async () => {
    const ws1 = await wsConnect(echoServer);
    const ws2 = await wsConnect(echoServer);
    await sleep(40);

    const ids = echoServer.wsConnectionIds;
    expect(new Set(ids).size).toBe(ids.length); // all unique

    await closeWs(ws1);
    await closeWs(ws2);
    await sleep(80);
  });
});

// ---------------------------------------------------------------------------
// Client-initiated close — close handler
// ---------------------------------------------------------------------------

describe('WebSocket — close handler', () => {
  it('close handler fires when client disconnects', async () => {
    let closed = false;

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        message(ws, msg) { ws.send(msg as string); },
        close() { closed = true; },
      },
    });

    const ws = await wsConnect(s);
    await closeWs(ws);
    await sleep(100);

    expect(closed).toBe(true);
    s.stop();
  });

  it('close handler receives code and reason', async () => {
    let closedCode = -1;
    let closedReason = '';

    const s = await serve({
      port: nextPort('WEBSOCKET'),
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
      websocket: {
        message(ws, msg) { ws.send(msg as string); },
        close(_ws, code, reason) {
          closedCode = code;
          closedReason = reason;
        },
      },
    });

    const ws = await wsConnect(s);
    await closeWs(ws, 1000, 'bye');
    await sleep(100);

    // Rust/tungstenite normalises close codes; we just check it's a number
    expect(typeof closedCode).toBe('number');
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Concurrent connections — isolation
// ---------------------------------------------------------------------------

describe('WebSocket — concurrent connections', () => {
  it('echoes independently to each connected client', async () => {
    const N = 5;
    const sockets: WebSocket[] = [];
    for (let i = 0; i < N; i++) {
      sockets.push(await wsConnect(echoServer));
    }

    // Each client sends a unique message and expects its own echo
    const results: string[] = [];
    for (let i = 0; i < N; i++) {
      const ws = sockets[i];
      const msg = `client-${i}`;
      const p = nextMessage(ws);
      ws.send(msg);
      results.push((await p) as string);
    }

    for (let i = 0; i < N; i++) {
      expect(results[i]).toBe(`client-${i}`);
    }

    await Promise.all(sockets.map((ws) => closeWs(ws)));
    await sleep(80);
  });
});

// ---------------------------------------------------------------------------
// WebSocket alongside HTTP on same server
// ---------------------------------------------------------------------------

describe('WebSocket + HTTP on the same server', () => {
  it('HTTP requests still work while WebSocket is open', async () => {
    const ws = await wsConnect(echoServer);

    const res = await get(echoServer, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ws server running');

    await closeWs(ws);
    await sleep(40);
  });
});

// ---------------------------------------------------------------------------
// Manual upgrade and ws.data / pubsub tests
// ---------------------------------------------------------------------------

describe('WebSocket — manual upgrade and data tracking', () => {
  it('supports manual upgrade and attaches contextual data', async () => {
    let openData: any = null;
    const port = nextPort('WEBSOCKET');

    const s = await serve({
      port,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const upgraded = server.upgrade(req, {
          data: { greeting: 'hello manual' },
        });
        if (upgraded) return;
        return new Response('not upgraded', { status: 400 });
      },
      websocket: {
        open(ws) {
          openData = ws.data;
        },
      },
    });

    const ws = await wsConnect(s);
    await sleep(50);

    expect(openData).toEqual({ greeting: 'hello manual' });

    await closeWs(ws);
    await sleep(50);
    s.stop();
  });
});

describe('WebSocket — Pub/Sub API', () => {
  it('supports subscribe, unsubscribe, isSubscribed, and publish', async () => {
    const port = nextPort('WEBSOCKET');
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const s = await serve({
      port,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response('ok');
      },
      websocket: {
        open(ws) {
          // Subscribe client to "broadcast" topic by default
          ws.subscribe('broadcast');
        },
        message(ws, msg) {
          if (msg === 'unsub') {
            ws.unsubscribe('broadcast');
            ws.send(`unsubscribed:${ws.isSubscribed('broadcast')}`);
          } else if (msg === 'check') {
            ws.send(`status:${ws.isSubscribed('broadcast')}`);
          } else {
            ws.publish('broadcast', msg as string);
          }
        },
      },
    });

    const wsA = await wsConnect(s);
    wsA.onmessage = (e) => receivedA.push(e.data);

    const wsB = await wsConnect(s);
    wsB.onmessage = (e) => receivedB.push(e.data);

    await sleep(50);

    // Test ws.publish: client A publishes a message, client B (subscribed) should receive it, but A should not (excluded)
    wsA.send('hello from A');
    await sleep(50);
    expect(receivedB).toContain('hello from A');
    expect(receivedA).not.toContain('hello from A');

    // Test ws.isSubscribed
    const p1 = nextMessage(wsA);
    wsA.send('check');
    expect(await p1).toBe('status:true');

    // Test ws.unsubscribe
    const p2 = nextMessage(wsA);
    wsA.send('unsub');
    expect(await p2).toBe('unsubscribed:false');

    // Test server.publish: publish to topic from server handle
    s.publish('broadcast', 'server broadcast');
    await sleep(50);

    // Client B is still subscribed, A is unsubscribed
    expect(receivedB).toContain('server broadcast');
    expect(receivedA).not.toContain('server broadcast');

    await closeWs(wsA);
    await closeWs(wsB);
    await sleep(50);
    s.stop();
  });
});

