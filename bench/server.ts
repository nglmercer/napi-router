/**
 * bench/server.ts
 *
 * Single-server detailed benchmark for napi-router.
 * Tests GET, POST, JSON endpoints with sequential and concurrent loads.
 *
 * Run:  bun bench/server.ts
 */

import { serve } from '../adapter/serve.js';
import type { Server } from '../adapter/serve.js';

const PORT       = 9999;
const WARMUP     = 500;
const GET_N      = 3_000;
const POST_N     = 1_500;
const JSON_N     = 1_500;
const CONCURRENT = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rps(n: number, ms: number): string {
  return ((n / ms) * 1_000).toFixed(0);
}

async function measure(label: string, n: number, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  let done = 0;
  while (done < n) {
    const batch = Math.min(CONCURRENT, n - done);
    await Promise.all(Array.from({ length: batch }, fn));
    done += batch;
  }
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(16)} ${n.toString().padStart(5)} req  →  ${rps(n, elapsed).padStart(7)} req/s  (${elapsed.toFixed(1)} ms)`);
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

async function benchmark(): Promise<void> {
  const server: Server = await serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(req, _server) {
      const url = new URL(req.url);

      if (url.pathname === '/json') {
        return Response.json({ message: 'hello', timestamp: Date.now() });
      }

      if (url.pathname === '/echo' && req.method === 'POST') {
        const body = await req.text();
        return new Response(`echo: ${body}`, { headers: { 'content-type': 'text/plain' } });
      }

      return new Response('Hello World', { headers: { 'content-type': 'text/plain' } });
    },
  });

  const base = `http://localhost:${PORT}`;
  console.log(`\nnapi-router listening on ${server.url}`);
  console.log(`concurrency: ${CONCURRENT}\n`);

  // Warmup
  await Promise.all(Array.from({ length: WARMUP }, () => fetch(`${base}/`).catch(() => {})));

  console.log('='.repeat(60));
  console.log('  napi-router Benchmark Results');
  console.log('='.repeat(60));

  await measure('GET  /', GET_N,  () => fetch(`${base}/`));
  await measure('POST /echo', POST_N, () =>
    fetch(`${base}/echo`, { method: 'POST', body: 'benchmark-payload' }),
  );
  await measure('GET  /json', JSON_N, () => fetch(`${base}/json`));

  console.log('='.repeat(60));

  server.stop();
}

benchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});