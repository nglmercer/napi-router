# napi-router

**Bun-compatible HTTP server** powered by Rust via N-API — works in Node.js, Bun, and Deno.

```
napi-router  16890 req/s   p50 53 ms   p99 120 ms
Bun native   4891 req/s   p50 232 ms  p99 256 ms
```

> Benchmarked with 100 connections / 10 pipelining / 30s — see [`bench/`](./bench).

## Features

- **Rust-native HTTP** — Hyper + Tokio under the hood, no JS event-loop bottleneck for I/O
- **Bun-compatible `serve()` API** — drop-in replacement for `Bun.serve()`; runs unmodified on Node.js and Deno too
- **WebSocket** — full-duplex messaging, pub/sub topics, per-connection metadata
- **Binary protocol** — zero-copy response buffers via `sendResponseRaw` (used automatically by the adapter)
- **Cross-platform** — prebuilt binaries for Windows, macOS, and Linux (x86_64 & aarch64)

## Quick Start

```ts
import { serve } from "napi-router/adapter";

const server = await serve({
  port: 3000,
  hostname: "0.0.0.0",
  fetch(req) {
    return new Response("Hello from napi-router!");
  },
});

console.log(`Listening on ${server.url}`);
```

## Installation

```bash
bun add napi-router
```

> **Requirements**: Node.js ≥ 18, Bun ≥ 1.0, or Deno ≥ 1.35.  
> The package ships with prebuilt `.node` binaries. No Rust toolchain needed at install time.

### Build from source

```bash
git clone https://github.com/nglmercer/napi-router.git
cd napi-router
bun install
bun run build          # release build
# or
bun run build:debug    # debug build
```

## API

### Adapter (`napi-router/adapter`)

The adapter provides a **Bun-compatible** `serve()` function.

```ts
import { serve, type Server, type ServeOptions } from "napi-router/adapter";

const server: Server = await serve({
  port: 3000,                         // default 3000
  hostname: "0.0.0.0",                // default "0.0.0.0"
  async fetch(req, server) {          // required
    return new Response("ok");
  },
  websocket?: WebSocketHandlers,      // optional — enables WS
  error?(err): Response,              // optional error handler
});
```

#### `Server` methods

| Method | Description |
|--------|-------------|
| `server.stop(closeActive?)` | Stop the server. Pass `true` to abort active connections. |
| `server.publish(topic, data)` | Publish a message to all WebSocket subscribers of a topic. |
| `server.pendingRequests` | Number of in-flight requests awaiting a fetch-handler response. |
| `server.pendingWebSockets` | Number of open WebSocket connections. |
| `server.url` | Bound URL string e.g. `"http://0.0.0.0:3000/"`. |
| `server.port` | Bound port number. |
| `server.hostname` | Bound hostname. |

### WebSocket

```ts
const server = await serve({
  port: 3000,
  fetch(req, server) {
    if (server.upgrade(req)) return;   // upgrade to WebSocket
    return new Response("Not a WS request");
  },
  websocket: {
    open(ws)        { console.log("connected", ws.id); },
    message(ws, msg) { ws.send(`echo: ${msg}`); },
    close(ws, code, reason) { console.log("closed", code, reason); },
    error(ws, err)  { console.error(err); },
  },
});
```

#### `ServerWebSocket` methods

| Method | Description |
|--------|-------------|
| `ws.send(data)` | Send text or binary data. Returns bytes written. |
| `ws.close(code?, reason?)` | Close the connection. |
| `ws.subscribe(topic)` | Subscribe to a pub/sub topic. |
| `ws.unsubscribe(topic)` | Unsubscribe from a topic. |
| `ws.publish(topic, data)` | Publish to a topic (all subscribers receive it). |
| `ws.isSubscribed(topic)` | Check subscription status. |
| `ws.id` | Unique connection identifier. |
| `ws.data` | Custom data attached during `server.upgrade(req, { data })`. |
| `ws.remoteAddress` | Remote IP address. |

### Low-level API (`HttpServer`)

The raw N-API binding is available for advanced use:

```ts
import { HttpServer } from "napi-router";

const raw = new HttpServer();
raw.onRequest((data) => {
  // data: { method, url, path, headers, body, remoteAddr, requestId }
  raw.sendResponseText(data.requestId, 200, ["content-type", "text/plain"], "ok");
});
await raw.listen(3000);
```

> The adapter wraps this low-level API. Most users should use `serve()`.

## Benchmarks

See [`bench/`](./bench) for runnable benchmark scripts.

```bash
bun run bench          # compare vs Bun native (30s)
bun run bench:simple   # multi-endpoint napi-router test (15s per endpoint)
```

Results from a typical run (AMD Ryzen 7, Linux):

| Server | Req/s | p50 | p99 | Max |
|--------|-------|-----|-----|-----|
| napi-router | 16 890 | 53 ms | 120 ms | 227 ms |
| Bun native | 4 891 | 232 ms | 256 ms | 261 ms |

## Project Structure

```
src/              Rust source (Hyper + Tokio HTTP server)
├── server.rs     Connection handling, request dispatch, WebSocket lifecycle
├── websocket.rs  WebSocket upgrade and message handling
├── types.rs      N-API type definitions
├── lib.rs        Module entry point
adapter/          TypeScript adapter (Bun-compatible serve() API)
├── serve.ts
bench/            Benchmark scripts
├── compare.ts    napi-router vs Bun native
├── server.ts     Multi-endpoint napi-router benchmark
examples/         Example usage
├── dev.ts        Basic HTTP server
├── upload-download.ts  File upload/download demo
test/             Test suite
scripts/          Utility scripts
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Build Rust addon (release) |
| `bun run build:debug` | Build Rust addon (debug) |
| `bun test` | Run test suite |
| `bun run dev` | Start example dev server |
| `bun run bench` | Run comparison benchmark |
| `bun run bench:simple` | Run multi-endpoint benchmark |
| `bun run type-check` | TypeScript type checking |
| `bun run format` | Format TypeScript sources |
| `bun run lint` | Rust Clippy linting |

## Performance Optimizations

The server incorporates several optimizations:

- **`RwLock` over `Mutex`** for read-heavy callback access (multiple readers never block each other)
- **Batched DashMap lookups** in WebSocket publish (releases shard locks before iterating senders)
- **Self-cleaning connection tracking** via `DashMap<u64, AbortHandle>` (handles removed on connection close, no memory leak)
- **Body size limits** (10 MB default) with Content-Length pre-check
- **`AtomicU64` request ID counter** (wraps safely at u32::MAX for N-API boundary)
- **Lossy UTF-8 header decoding** (`from_utf8_lossy` instead of silent data loss on non-UTF8 bytes)

## License

MIT
