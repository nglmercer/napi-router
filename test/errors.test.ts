/**
 * test/errors.test.ts
 *
 * Error-handling coverage:
 *   - fetch handler throws synchronously
 *   - fetch handler throws asynchronously
 *   - options.error handler called instead of default 500
 *   - options.error handler itself throws → still 500
 *   - fetch handler returns non-Response → 500
 *   - serve() with missing fetch option → TypeError
 *   - Port already in use → serve() rejects
 *   - tryServe() on conflict → { server: null, error }
 *   - tryServe() on success → { server, error: null }
 */

import { describe, it, expect } from 'bun:test';
import { serve, tryServe, nextPort, withServer, get } from './setup.js';

// ---------------------------------------------------------------------------
// fetch handler throws synchronously
// ---------------------------------------------------------------------------

describe('fetch handler throws synchronously', () => {
  it('returns 500 when fetch throws', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      fetch() {
        throw new Error('sync crash');
      },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// fetch handler throws asynchronously
// ---------------------------------------------------------------------------

describe('fetch handler throws asynchronously', () => {
  it('returns 500 on async rejection', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      async fetch() {
        await Promise.reject(new Error('async crash'));
        return new Response('never');
      },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// options.error handler
// ---------------------------------------------------------------------------

describe('options.error handler', () => {
  it('is called when fetch throws', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      fetch() { throw new Error('crash'); },
      error(err) {
        return new Response(`caught: ${err.message}`, { status: 503 });
      },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('caught: crash');
    });
  });

  it('falls back to 500 if error handler itself throws', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      fetch() { throw new Error('primary'); },
      error() { throw new Error('secondary'); },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(500);
    });
  });

  it('receives the original error object', async () => {
    const port = nextPort('ERRORS');
    let captured: Error | null = null;

    await withServer(port, {
      fetch() { throw new TypeError('type-check failed'); },
      error(err) {
        captured = err;
        return new Response('handled', { status: 422 });
      },
    }, async (s) => {
      await get(s, '/');
      expect(captured).toBeInstanceOf(Error);
      expect(captured!.message).toBe('type-check failed');
    });
  });
});

// ---------------------------------------------------------------------------
// fetch handler returns non-Response value
// ---------------------------------------------------------------------------

describe('fetch handler returns non-Response', () => {
  it('returns 500 when handler returns undefined', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      // @ts-expect-error intentional wrong return type
      fetch() { return undefined; },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(500);
    });
  });

  it('returns 500 when handler returns a plain object', async () => {
    const port = nextPort('ERRORS');
    await withServer(port, {
      // @ts-expect-error intentional wrong return type
      fetch() { return { status: 200 }; },
    }, async (s) => {
      const res = await get(s, '/');
      expect(res.status).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// serve() validation — missing fetch
// ---------------------------------------------------------------------------

describe('serve() input validation', () => {
  it('throws TypeError when fetch option is missing', async () => {
    expect(
      // @ts-expect-error intentional missing fetch
      serve({ port: nextPort('ERRORS') })
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when fetch is not a function', async () => {
    expect(
      // @ts-expect-error intentional wrong type
      serve({ port: nextPort('ERRORS'), fetch: 'not a function' })
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Port conflicts — serve()
// ---------------------------------------------------------------------------

describe('Port conflict — serve()', () => {
  it('rejects when port is already in use', async () => {
    const port = nextPort('ERRORS');
    const first = await serve({ port, fetch: () => new Response('first') });
    try {
      await expect(
        serve({ port, fetch: () => new Response('second') })
      ).rejects.toThrow(/Failed to bind|address already in use/i);
    } finally {
      first.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// tryServe()
// ---------------------------------------------------------------------------

describe('tryServe()', () => {
  it('returns { server, error: null } on success', async () => {
    const port = nextPort('ERRORS');
    const { server, error } = await tryServe({
      port,
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
    });

    expect(error).toBeNull();
    expect(server).not.toBeNull();

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');

    server!.stop();
  });

  it('returns { server: null, error } on port conflict', async () => {
    const port = nextPort('ERRORS');
    const first = await serve({ port, fetch: () => new Response('first') });
    try {
      const { server, error } = await tryServe({
        port,
        fetch: () => new Response('second'),
      });
      expect(server).toBeNull();
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(/Failed to bind|address already in use/i);
    } finally {
      first.stop();
    }
  });

  it('error field is null (not undefined) on success', async () => {
    const port = nextPort('ERRORS');
    const { server, error } = await tryServe({
      port,
      fetch: () => new Response('ok'),
    });
    expect(error).toBeNull();        // strict null, not undefined
    server!.stop();
  });

  it('server field is null (not undefined) on failure', async () => {
    const port = nextPort('ERRORS');
    const first = await serve({ port, fetch: () => new Response('ok') });
    try {
      const { server } = await tryServe({ port, fetch: () => new Response('ok') });
      expect(server).toBeNull();
    } finally {
      first.stop();
    }
  });
});
