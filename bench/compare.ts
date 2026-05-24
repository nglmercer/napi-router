/**
 * bench/compare.ts
 *
 * Compares Bun's native server vs napi-router (via the adapter) side-by-side.
 * Imports: from '../adapter/serve.js' — NOT from '../index.js' (raw NAPI binding).
 *
 * Run:  bun bench/compare.ts
 */

import type { Server } from "../adapter/serve.js";

const WARMUP = 200; // requests discarded before measurement
const ITERATIONS = 3_000; // total measured requests
const CONCURRENCY = 50; // parallel requests per batch

// ---------------------------------------------------------------------------
// Benchmarking harness
// ---------------------------------------------------------------------------

async function runBenchmark(name: string, url: string): Promise<void> {
  console.log(`\n=== ${name} ===`);

  // Warmup
  await Promise.all(
    Array.from({ length: WARMUP }, () => fetch(url).catch(() => {})),
  );

  const start = performance.now();
  let done = 0;

  while (done < ITERATIONS) {
    const batchSize = Math.min(CONCURRENCY, ITERATIONS - done);
    await Promise.all(Array.from({ length: batchSize }, () => fetch(url)));
    done += batchSize;
  }

  const elapsed = performance.now() - start;
  const rps = (ITERATIONS / elapsed) * 1_000;
  console.log(
    `  ${ITERATIONS} requests in ${elapsed.toFixed(1)} ms  →  ${rps.toFixed(0)} req/s`,
  );
}

// ---------------------------------------------------------------------------
// Bun native server
// ---------------------------------------------------------------------------

async function runBunBenchmark(): Promise<void> {
  const port = 9998;

  // @ts-ignore — Bun-specific global
  if (typeof Bun === "undefined") {
    console.log("\n=== Bun Native Server ===");
    console.log("  [skipped — not running under Bun]");
    return;
  }

  // @ts-ignore
  const server = Bun.serve({ port, fetch: () => new Response("Hello World") });
  await runBenchmark("Bun Native Server", `http://localhost:${port}/`);
  server.stop(true);
}

// ---------------------------------------------------------------------------
// napi-router via adapter
// ---------------------------------------------------------------------------

async function runNapiRouterBenchmark(): Promise<void> {
  const { serve } = await import("../adapter/serve.js");
  const port = 9999;

  const server: Server = await serve({
    port,
    hostname: "0.0.0.0",
    fetch() {
      return new Response("Hello World");
    },
  });

  await runBenchmark("napi-router (adapter)", `http://localhost:${port}/`);
  server.stop();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  napi-router benchmark");
  console.log(`  ${ITERATIONS} requests  •  concurrency ${CONCURRENCY}`);
  console.log("=".repeat(50));

  await runBunBenchmark();
  await runNapiRouterBenchmark();

  console.log("=".repeat(50));
  console.log("  Done!");
  console.log("=".repeat(50));
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
