import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { serve, nextPort, withServer, get, type Server } from './setup.js';

// ---------------------------------------------------------------------------
// server.requestIP() — returns SocketAddress for a given Request
// ---------------------------------------------------------------------------

describe('server.requestIP', () => {
  let server: Server;

  beforeAll(async () => {
    server = await serve({
      port: nextPort('REQUEST_IP'),
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const sock = srv.requestIP(req);
        if (!sock) return new Response('no sock', { status: 500 });
        return Response.json({
          address: sock.address,
          family: sock.family,
          port: sock.port,
        });
      },
    });
  });

  afterAll(() => server.stop());

  it('returns a non-null SocketAddress', async () => {
    const res = await get(server, '/');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBeTruthy();
  });

  it('has address 127.0.0.1 for localhost connections', async () => {
    const res = await get(server, '/');
    const data = await res.json();
    expect(data.address).toBe('127.0.0.1');
  });

  it('has family "IPv4" for IPv4 connections', async () => {
    const res = await get(server, '/');
    const data = await res.json();
    expect(data.family).toBe('IPv4');
  });

  it('has a positive integer port number', async () => {
    const res = await get(server, '/');
    const data = await res.json();
    expect(Number.isInteger(data.port)).toBe(true);
    expect(data.port).toBeGreaterThan(0);
  });

  it('returns SocketAddress for POST requests too', async () => {
    const res = await fetch(`http://${server.hostname}:${server.port}/`, {
      method: 'POST',
      body: 'hello',
    });
    const data = await res.json();
    expect(data.address).toBe('127.0.0.1');
    expect(data.family).toBe('IPv4');
    expect(data.port).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// server.requestIP() returns null for unknown requests
// ---------------------------------------------------------------------------

describe('server.requestIP edge cases', () => {
  it('returns null for a request that was not handled by this server', async () => {
    const port = nextPort('REQUEST_IP');
    let capturedSrv: Server | null = null;
    await withServer(port, {
      hostname: '127.0.0.1',
      fetch(req, srv) {
        capturedSrv = srv;
        return new Response('ok');
      },
    }, async (s) => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);

      const fakeReq = new Request('http://localhost:9999/');
      const result = capturedSrv!.requestIP(fakeReq);
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// req.sock is set on requests through the Router
// ---------------------------------------------------------------------------

describe('req.sock via Router', () => {
  it('sets req.sock with correct address, family, and port', async () => {
    const { Router } = await import('../adapter/router/router.ts');

    const router = new Router();
    router.get('/', (ctx) => {
      const sock = (ctx.req as Record<string, unknown>).sock as {
        address: string;
        family: string;
        port: number;
      };
      if (!sock) {
        return new Response('no sock', { status: 500 });
      }
      return Response.json({
        address: sock.address,
        family: sock.family,
        port: sock.port,
      });
    });

    const port = nextPort('REQUEST_IP');
    await withServer(
      port,
      {
        hostname: '127.0.0.1',
        fetch: router.handle,
      },
      async (s) => {
        const res = await get(s, '/');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.address).toBe('127.0.0.1');
        expect(data.family).toBe('IPv4');
        expect(Number.isInteger(data.port)).toBe(true);
        expect(data.port).toBeGreaterThan(0);
      },
    );
  });
});
