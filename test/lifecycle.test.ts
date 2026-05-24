/**
 * test/lifecycle.test.ts
 *
 * Server lifecycle coverage:
 *   - server.stop() is idempotent (multiple calls safe)
 *   - After stop(), connections are refused
 *   - Multiple independent servers can run simultaneously
 *   - Port reuse after stop
 *   - Default options (port, hostname)
 */

import { describe, it, expect } from 'bun:test';
import { serve, nextPort, withServer, get, sleep } from './setup.js';

// ---------------------------------------------------------------------------
// stop() idempotent
// ---------------------------------------------------------------------------

describe('server.stop() is idempotent', () => {
  it('can be called multiple times without throwing', async () => {
    const port = nextPort('LIFECYCLE');
    const s = await serve({ port, fetch: () => new Response('ok') });

    expect(() => {
      s.stop();
      s.stop();
      s.stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connections refused after stop
// ---------------------------------------------------------------------------

describe('After stop(), connections are refused', () => {
  it('fetch rejects after server is stopped', async () => {
    const port = nextPort('LIFECYCLE');
    const s = await serve({ port, fetch: () => new Response('ok') });

    // Verify it works first
    const before = await fetch(`http://127.0.0.1:${port}/`);
    expect(before.status).toBe(200);

    s.stop();
    await sleep(50); // give the OS time to release

    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Multiple servers simultaneously
// ---------------------------------------------------------------------------

describe('Multiple simultaneous servers', () => {
  it('serves requests independently on different ports', async () => {
    const portA = nextPort('LIFECYCLE');
    const portB = nextPort('LIFECYCLE');

    const sA = await serve({ port: portA, fetch: () => new Response('server-a') });
    const sB = await serve({ port: portB, fetch: () => new Response('server-b') });

    try {
      const [resA, resB] = await Promise.all([
        fetch(`http://127.0.0.1:${portA}/`),
        fetch(`http://127.0.0.1:${portB}/`),
      ]);
      expect(await resA.text()).toBe('server-a');
      expect(await resB.text()).toBe('server-b');
    } finally {
      sA.stop();
      sB.stop();
    }
  });

  it('stopping one server does not affect others', async () => {
    const portA = nextPort('LIFECYCLE');
    const portB = nextPort('LIFECYCLE');

    const sA = await serve({ port: portA, fetch: () => new Response('a') });
    const sB = await serve({ port: portB, fetch: () => new Response('b') });

    sA.stop();
    await sleep(50);

    const resB = await fetch(`http://127.0.0.1:${portB}/`);
    expect(await resB.text()).toBe('b');

    sB.stop();
  });
});

// ---------------------------------------------------------------------------
// Port reuse after stop
// ---------------------------------------------------------------------------

describe('Port reuse after stop', () => {
  it('can bind the same port after the previous server stops', async () => {
    const port = nextPort('LIFECYCLE');

    const s1 = await serve({ port, fetch: () => new Response('first') });
    s1.stop();
    await sleep(100);

    const s2 = await serve({ port, fetch: () => new Response('second') });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('second');
    } finally {
      s2.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Default option values
// ---------------------------------------------------------------------------

describe('Default option values', () => {
  it('defaults to port 3000 when not specified', async () => {
    // Only run if port 3000 is free
    try {
      const s = await serve({ fetch: () => new Response('default') });
      expect(s.port).toBe(3000);
      s.stop();
    } catch (e: any) {
      // Port 3000 might already be in use in CI — skip gracefully
      if (/Failed to bind|address already in use/i.test(e.message)) {
        console.warn('[skip] Port 3000 is already in use');
      } else {
        throw e;
      }
    }
  });

  it('defaults hostname to 0.0.0.0', async () => {
    const port = nextPort('LIFECYCLE');
    await withServer(port, {
      fetch: () => new Response('ok'),
    }, async (s) => {
      // binding to 0.0.0.0 should be reachable via localhost
      const res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// withServer() helper correctness
// ---------------------------------------------------------------------------

describe('withServer() helper', () => {
  it('stops the server even when the callback throws', async () => {
    const port = nextPort('LIFECYCLE');
    let stoppedPort = -1;

    try {
      await withServer(port, { fetch: () => new Response('ok') }, async (s) => {
        stoppedPort = s.port;
        throw new Error('test error inside withServer');
      });
    } catch {
      // expected
    }

    await sleep(60);

    // Port should be free now
    const s2 = await serve({ port: stoppedPort, fetch: () => new Response('reused') });
    const res = await fetch(`http://127.0.0.1:${stoppedPort}/`);
    expect(await res.text()).toBe('reused');
    s2.stop();
  });
});
