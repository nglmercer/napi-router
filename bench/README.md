# Benchmarks

## compare.ts — napi-router vs Bun native

Runs both servers side-by-side with identical load from the same process. Uses a
custom fetch-based harness (no external dependencies) with concurrent workers.

```bash
bun bench/compare.ts
```

Parameters (edit at top of file):
- `connections`: 100 concurrent fetch workers
- `duration`: 30 seconds per server

Output:
```
═══════════════════════════════════════════════════════
  napi-router vs Bun — HTTP Benchmark
  100 concurrent connections  •  30s duration
═══════════════════════════════════════════════════════

Bun listening on port 33097

Bun Native Server
  ────────────────────────────────────────────────
  Requests:  132k total  →  4891 req/s
  Latency:   avg 229.99 ms  p50 232.00 ms  p99 256.00 ms  max 261.00 ms
  Throughput: 0.59 MB/s
  Errors:    0  Duration: 30.7s

napi-router listening on port 34755

napi-router (adapter)
  ────────────────────────────────────────────────
  Requests:  506k total  →  16890 req/s
  Latency:   avg 59.72 ms  p50 53.00 ms  p99 120.00 ms  max 227.00 ms
  Throughput: 1.40 MB/s
  Errors:    0  Duration: 30.6s
═══════════════════════════════════════════════════════
  Done!
═══════════════════════════════════════════════════════
```

## server.ts — Multi-endpoint napi-router benchmark

Tests GET /, POST /echo, and GET /json endpoints separately on napi-router.

```bash
bun bench/server.ts
```

Each endpoint runs for 15 seconds with 100 concurrent connections.
