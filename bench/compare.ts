/**
 * bench/compare.ts
 *
 * Compares Bun's native server vs napi-router using a custom fetch-based
 * benchmark (no external binary dependencies).
 *
 * Run:  bun bench/compare.ts
 */

import type { Server } from "../adapter/serve.js";

interface BenchResult {
  totalRequests: number;
  rps: number;
  latency: { min: number; p50: number; p75: number; p90: number; p99: number; max: number; avg: number };
  throughputMBs: number;
  errors: number;
  durationMs: number;
}

const BODY_BYTES = 11; // "Hello World".length

async function bench(url: string, connections: number, duration: number, warmupSec = 0): Promise<BenchResult> {
  if (warmupSec > 0) {
    const warmupEnd = performance.now() + warmupSec * 1000;
    await Promise.all(
      Array.from({ length: connections }, () =>
        (async () => {
          while (performance.now() < warmupEnd) {
            try { await fetch(url); } catch { /* ok */ }
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
        const res = await fetch(url);
        latencies.push(performance.now() - t0);
        totalBytes += BODY_BYTES;
      } catch {
        errors++;
      }
    }
  };

  const start = performance.now();
  await Promise.all(Array.from({ length: connections }, () => worker()));
  const elapsed = performance.now() - start;

  if (latencies.length === 0) {
    return { totalRequests: 0, rps: 0, durationMs: elapsed, latency: { min: 0, p50: 0, p75: 0, p90: 0, p99: 0, max: 0, avg: 0 }, throughputMBs: 0, errors };
  }

  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const idx = (p: number) => Math.max(0, Math.min(n - 1, Math.floor(n * p / 100)));
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
    throughputMBs: (totalBytes / elapsed) * 1000 / 1024 / 1024,
    errors,
  };
}

function printResult(name: string, r: BenchResult): void {
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0);
  console.log(`\n${name}`);
  console.log("  " + "\u2500".repeat(48));
  console.log(`  Requests:  ${fmt(r.totalRequests)} total  \u2192  ${r.rps.toFixed(0)} req/s`);
  console.log(
    `  Latency:   avg ${r.latency.avg.toFixed(2)} ms  p50 ${r.latency.p50.toFixed(2)} ms  p99 ${r.latency.p99.toFixed(2)} ms  max ${r.latency.max.toFixed(2)} ms`,  // eslint-disable-line
  );
  console.log(`  Throughput: ${r.throughputMBs.toFixed(2)} MB/s`);
  console.log(`  Errors:    ${r.errors}  Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
}

async function runBunBenchmark(connections: number, duration: number): Promise<void> {
  if (typeof Bun === "undefined") {
    console.log("\n=== Bun Native Server === [skipped]");
    return;
  }

  const server = Bun.serve({ port: 0, fetch: () => new Response("Hello World") });
  const port = server.port;
  console.log(`\nBun listening on port ${port}`);

  const result = await bench(`http://127.0.0.1:${port}/`, connections, duration, 3);
  printResult("Bun Native Server", result);
  server.stop();
}

async function runNapiRouterBenchmark(connections: number, duration: number): Promise<void> {
  const { serve } = await import("../adapter/serve.js");

  const server: Server = await serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() { return new Response("Hello World"); },
  });

  console.log(`napi-router listening on port ${server.port}`);

  const result = await bench(`http://127.0.0.1:${server.port}/`, connections, duration, 3);
  printResult("napi-router (adapter)", result);
  await server.stop(true);
}

async function main(): Promise<void> {
  const connections = 100;
  const duration = 30;

  console.log("\u2550".repeat(55));
  console.log("  napi-router vs Bun \u2014 HTTP Benchmark");
  console.log(`  ${connections} concurrent connections  \u2022  ${duration}s duration`);
  console.log("\u2550".repeat(55));

  await runBunBenchmark(connections, duration);
  await runNapiRouterBenchmark(connections, duration);

  console.log("\n" + "\u2550".repeat(55));
  console.log("  Done!");
  console.log("\u2550".repeat(55));
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
