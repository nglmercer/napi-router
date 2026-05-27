/**
 * bench/server.ts
 *
 * Multi-endpoint benchmark for napi-router using a custom fetch-based harness.
 * Tests GET, POST, and JSON endpoints.
 *
 * Run:  bun bench/server.ts
 */

import { serve } from "../adapter/serve.js";
import { NativeResponse } from "../index.js";
import type { Server } from "../adapter/serve.js";

interface BenchResult {
  totalRequests: number;
  rps: number;
  latency: {
    min: number;
    p50: number;
    p75: number;
    p90: number;
    p99: number;
    max: number;
    avg: number;
  };
  throughputMBs: number;
  errors: number;
  durationMs: number;
}

function knownBodyBytes(res: Response): number {
  const ct = res.headers.get("content-type") || "";
  const body = res.body;
  // Fall back to 0 if we can't determine
  return body ? 0 : 0;
}

async function bench(
  fn: () => Promise<Response>,
  connections: number,
  duration: number,
  warmupSec = 0,
): Promise<BenchResult> {
  if (warmupSec > 0) {
    const warmupEnd = performance.now() + warmupSec * 1000;
    await Promise.all(
      Array.from({ length: connections }, () =>
        (async () => {
          while (performance.now() < warmupEnd) {
            try {
              await fn();
            } catch {
              /* ok */
            }
          }
        })(),
      ),
    );
  }

  const latencies: number[] = [];
  let totalBytes = 0;
  let errors = 0;
  const stopAt = performance.now() + duration * 1000;

  const worker = async () => {
    while (performance.now() < stopAt) {
      const t0 = performance.now();
      try {
        const res = await fn();
        latencies.push(performance.now() - t0);
        // Estimate body size from content-length or response
        const cl = res.headers.get("content-length");
        totalBytes += cl ? parseInt(cl, 10) : 0;
      } catch {
        errors++;
      }
    }
  };

  const start = performance.now();
  await Promise.all(Array.from({ length: connections }, () => worker()));
  const elapsed = performance.now() - start;

  if (latencies.length === 0) {
    return {
      totalRequests: 0,
      rps: 0,
      durationMs: elapsed,
      latency: { min: 0, p50: 0, p75: 0, p90: 0, p99: 0, max: 0, avg: 0 },
      throughputMBs: 0,
      errors,
    };
  }

  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const idx = (p: number) =>
    Math.max(0, Math.min(n - 1, Math.floor((n * p) / 100)));
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    totalRequests: n + errors,
    rps: (n / elapsed) * 1000,
    durationMs: elapsed,
    latency: {
      min: latencies[0],
      p50: latencies[idx(50)],
      p75: latencies[idx(75)],
      p90: latencies[idx(90)],
      p99: latencies[idx(99)],
      max: latencies[n - 1],
      avg: sum / n,
    },
    throughputMBs: ((totalBytes / elapsed) * 1000) / 1024 / 1024,
    errors,
  };
}

function printResult(name: string, r: BenchResult): void {
  const gap = "  ";
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
  console.log(gap + "\u2500".repeat(46));
  console.log(
    `${gap}Requests:  ${fmt(r.totalRequests)} total  \u2192  ${r.rps.toFixed(0)} req/s`,
  );
  console.log(
    `${gap}Latency:   avg ${r.latency.avg.toFixed(2)} ms  p50 ${r.latency.p50.toFixed(2)} ms  p99 ${r.latency.p99.toFixed(2)} ms  max ${r.latency.max.toFixed(2)} ms`, // eslint-disable-line
  );
  console.log(`${gap}Throughput: ${r.throughputMBs.toFixed(2)} MB/s`);
  console.log(
    `${gap}Errors:    ${r.errors}  Duration: ${(r.durationMs / 1000).toFixed(1)}s`,
  );
}

async function main(): Promise<void> {
  const connections = 100;
  const duration = 15;

  const server: Server = await serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/raw") {
        return new NativeResponse().text("Hello World");
      }

      if (url.pathname === "/native") {
        return new NativeResponse().text("Hello World");
      }

      if (url.pathname === "/json") {
        return Response.json({ message: "hello", timestamp: Date.now() });
      }

      if (url.pathname === "/echo" && req.method === "POST") {
        const body = await req.text();
        return new Response(`echo: ${body}`, {
          headers: { "content-type": "text/plain" },
        });
      }

      return new Response("Hello World", {
        headers: { "content-type": "text/plain" },
      });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  console.log(`\nnapi-router listening on ${base}`);
  console.log(
    `  ${connections} concurrent connections  \u2022  ${duration}s per endpoint\n`,
  );

  const endpoints: { name: string; fn: () => Promise<Response> }[] = [
    { name: "GET  /", fn: () => fetch(`${base}/`) },
    { name: "GET  /raw", fn: () => fetch(`${base}/raw`) },
    { name: "GET  /native", fn: () => fetch(`${base}/native`) },
    {
      name: "POST /echo",
      fn: () =>
        fetch(`${base}/echo`, { method: "POST", body: "benchmark-payload" }),
    },
    { name: "GET  /json", fn: () => fetch(`${base}/json`) },
  ];

  console.log("\u2550".repeat(55));
  console.log("  napi-router Benchmark Results");
  console.log("\u2550".repeat(55));

  for (const ep of endpoints) {
    console.log(`\n${ep.name}`);
    const result = await bench(ep.fn, connections, duration, 3);
    printResult(ep.name, result);
  }

  console.log("\n" + "\u2550".repeat(55));
  await server.stop(true);
  console.log("  Done!");
  console.log("\u2550".repeat(55));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
