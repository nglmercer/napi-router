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
- **Rust-side validation** — schema validation in native code, 2.26x faster than manual JS validation
- **Zero-copy parsing** — JSON body and query params parsed in Rust, reused in JS without re-parsing
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

## Validator (Rust-side Schema Validation)

The Validator provides **high-performance request validation** that runs entirely in Rust. It validates body, query parameters, and path parameters against defined schemas before the handler executes.

### Why Rust-side validation?

```
Auto-validate (Rust internal)     5.63K req/sec  ← 2.26x faster
Manual JS validation middleware   2.49K req/sec
```

When using **auto-validate mode**, validation happens inside Rust before calling JS — zero NAPI boundary overhead.

### Quick Start

```ts
import { Validator } from "napi-router";
import { Router } from "napi-router/adapter/router";
import { s } from "napi-router/adapter/router/router/validator";

const validator = new Validator();
const router = new Router();
router.setValidator(validator);
router.body("*", "/api/*");

router.post("/users",
  router.validate({
    body: {
      name: s.string().required().min(2).max(100),
      email: s.string().required().pattern("email"),
      age: s.integer().min(0).max(200),
      role: s.string().enum("admin", "user", "guest"),
    },
    query: {
      format: s.string().enum("short", "full"),
    },
  }),
  async (ctx) => {
    // Body is validated — safe to use
    const user = ctx.req.parsedBody;
    ctx.json({ created: true, user });
  }
);

const server = await serve({ port: 3000, fetch: router.handle });
```

### Auto-Validate Mode (Fastest)

For maximum performance, enable auto-validate on the server. Validation runs inside Rust before calling JS — no NAPI overhead:

```ts
import { Validator } from "napi-router";
import { Router } from "napi-router/adapter/router";
import { s } from "napi-router/adapter/router/router/validator";

const validator = new Validator();
const router = new Router();
router.setValidator(validator);
router.body("*", "/api/*");

router.post("/api/users",
  router.validate({
    body: {
      name: s.string({ required: true, min: 2 }),
      email: s.string({ required: true, pattern: "email" }),
    },
  }),
  (ctx) => {
    ctx.json({ ok: true });
  }
);

const server = await serve({ port: 3000, fetch: router.handle });
router.enableAutoValidate(server);  // ← Validation in Rust, 2.16x faster
```

When validation fails, the server returns `400 Bad Request` with structured errors **without calling JS**:

```json
{
  "errors": [
    { "field": "body.name", "message": "String length must be >= 2, got 1", "code": "min_length" },
    { "field": "body.email", "message": "Value does not match pattern", "code": "pattern" }
  ]
}
```

### Schema Builder (`s.*`)

Fluent API for defining field schemas with method chaining:

```ts
import { s } from "napi-router/adapter/router/router/validator";

// String
s.string().required().min(2).max(100)
s.string().required().pattern("email")
s.string().required().enum("admin", "user", "guest")

// Number (float)
s.number().min(0).max(100)

// Integer
s.integer().required().min(1).max(1000)

// Number constrained to integer
s.number().integer().min(0)

// Boolean
s.boolean().required()

// Object with nested properties
s.object({
  street: s.string().required(),
  city: s.string().required(),
  zip: s.string().pattern("numeric"),
})

// Array with item schema
s.array(s.string()).min(1).max(10)

// Array of objects
s.array(
  s.object({
    product_id: s.string().required(),
    quantity: s.integer().required().min(1),
  })
).min(1)
```

### Schema Types

| Type | Methods | Description |
|------|---------|-------------|
| `s.string()` | `.required()`, `.min(n)`, `.max(n)`, `.pattern(name)`, `.enum(...values)`, `.default(v)` | String value with length/pattern constraints |
| `s.number()` | `.required()`, `.min(n)`, `.max(n)`, `.integer()`, `.default(v)` | Float number, optionally integer-only |
| `s.integer()` | `.required()`, `.min(n)`, `.max(n)`, `.default(v)` | Integer number (enforced) |
| `s.boolean()` | `.required()`, `.default(v)` | Boolean value |
| `s.object(props)` | `.required()`, `.default(v)` | Nested object with field schemas |
| `s.array(items)` | `.required()`, `.min(n)`, `.max(n)`, `.default(v)` | Array with item schema and length constraints |

### Built-in Patterns

| Pattern | Validates |
|---------|-----------|
| `"email"` | Contains `@` and `.` |
| `"url"` | Starts with `http://` or `https://` |
| `"uuid"` | 36-char UUID format |
| `"alpha"` | ASCII letters only |
| `"alphanumeric"` | ASCII letters and digits |
| `"numeric"` | ASCII digits only |

### Custom Patterns

Register custom regex patterns on the validator:

```ts
const validator = new Validator();

// Register custom patterns
validator.addPattern("phone", "^\\+?[1-9]\\d{1,14}$");
validator.addPattern("slug", "^[a-z0-9]+(?:-[a-z0-9]+)*$");
validator.addPattern("hex_color", "^#[0-9a-fA-F]{6}$");
validator.addPattern("credit_card", "^\\d{4}-?\\d{4}-?\\d{4}-?\\d{4}$");

// Use in schemas
router.post("/contact",
  router.validate({
    body: {
      phone: s.string().required().pattern("phone"),
      slug: s.string().required().pattern("slug"),
      color: s.string().pattern("hex_color"),
    },
  }),
  handler
);
```

Pattern management:

```ts
validator.addPattern(name, regex);     // Register a pattern
validator.hasPattern(name);            // Check if pattern exists
validator.removePattern(name);         // Remove a pattern
```

### Validator API

```ts
const validator = new Validator();

// Register custom pattern (regex)
validator.addPattern("phone", "^\\+?[1-9]\\d{1,14}$");
validator.hasPattern("phone");        // boolean
validator.removePattern("phone");     // boolean

// Register schema (JSON string)
validator.addSchema("POST:/users", JSON.stringify({ body: { ... } }));

// Validate body (from JSON string)
const result = validator.validateBody("POST:/users", jsonString);
// { success: true, data?: string } | { success: false, errors: [...] }

// Validate body (from raw bytes — fastest)
const result = validator.validateBodyBytes("POST:/users", uint8array);

// Validate query parameters
const result = validator.validateQuery("GET:/search", { q: "test", page: "1" });

// Validate path parameters
const result = validator.validateParams("GET:/users/:id", { id: "42" });

// Management
validator.hasSchema("POST:/users");     // boolean
validator.removeSchema("POST:/users"); // boolean
validator.clear();                      // remove all
validator.schemaCount();                // number
```

### Server API

```ts
const server = await serve({ port: 3000, fetch: router.handle });

// Set validator for auto-validate mode
server.setValidator(validator);

// Enable/disable auto-validation
server.setAutoValidate(true);
```

### Router API

```ts
const router = new Router();

// Set validator (required before using router.validate())
router.setValidator(validator);

// Register validation middleware for a route
// Method and path are auto-detected from the route registration
router.post("/users",
  router.validate({
    body: { name: s.string().required() },
    query: { format: s.string().enum("short", "full") },
    params: { id: s.integer().required().min(1) },
  }),
  handler
);

// Enable auto-validate mode (validation in Rust, 2.16x faster)
router.enableAutoValidate(server);

// Get the validator instance
const v = router.getValidator();
```

### Validation Errors

Errors are returned in a structured format:

```ts
interface ValidationErr {
  field: string;    // e.g. "body.name", "query.page", "params.id"
  message: string;  // Human-readable description
  code: string;     // Machine-readable code
}
```

Error codes:

| Code | Meaning |
|------|---------|
| `required` | Field is missing |
| `type` | Wrong type (expected string, got number, etc.) |
| `min_length` | String too short |
| `max_length` | String too long |
| `min` | Number below minimum |
| `max` | Number above maximum |
| `integer` | Expected integer |
| `pattern` | Doesn't match pattern |
| `enum` | Not in allowed values |
| `min_items` | Array too short |
| `max_items` | Array too long |
| `invalid_json` | Body is not valid JSON |

### Zero-Duplicate Parsing

When using `router.body()` with the validator, the body is parsed once in Rust and reused:

```
Request → Rust: body bytes → serde_json::from_slice (zero-copy)
                              ↓
                    parsedBody string → JS
                              ↓
                    bodyParser reuses it (no re-parse)
                              ↓
                    validator reuses it (no re-parse)
```

### Benchmark

```bash
bun bench/validator.bench.ts
```

Results (AMD Ryzen 7, Linux):

```
HTTP REQUEST FLOW (10,000 requests)
───────────────────────────────────────────────────────────
No validation                                           2.64K req/sec
Auto-validate (Rust internal)                           5.63K req/sec  ← 2.26x faster
Rust Validator middleware (NAPI calls)                  2.51K req/sec
Manual JS validation middleware                         2.49K req/sec
```

**Auto-validate** is recommended for production workloads. The middleware path is for cases where you need custom JS logic after validation.

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
├── schema.rs     Schema types, compiled patterns, validation logic
├── validator.rs  Validator class (N-API exported)
├── lib.rs        Module entry point
adapter/          TypeScript adapter (Bun-compatible serve() API)
├── serve.ts
├── router/       Express-like router
│   ├── router.ts           Router class
│   ├── router/validator.ts Validation middleware + schema builder (s.*)
│   ├── router/handler.ts   Request routing engine
│   ├── router/bodyParser.ts Body parsing (reuses Rust-parsed data)
│   └── ...
bench/            Benchmark scripts
├── compare.ts    napi-router vs Bun native
├── server.ts     Multi-endpoint napi-router benchmark
├── validator.bench.ts  Validator vs manual JS benchmark
examples/         Example usage
├── dev.ts        Basic HTTP server
├── upload-download.ts  File upload/download demo
test/             Test suite
├── validator.test.ts  Validator + schema tests
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
| `bun bench/validator.bench.ts` | Run validator benchmark (Rust vs JS) |
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
- **Zero-copy JSON parsing** — body parsed from `&[u8]` via `serde_json::from_slice`, reused in JS
- **Pre-compiled schema patterns** — email/url/uuid patterns compiled once at registration, not per-validation
- **Sorted property lookup** — object properties sorted for fast binary search during validation
- **`ErrorBuffer`** — reusable error buffer avoids `Vec` allocations per validation call
- **Fast float parser** — custom integer/float parser for query params (avoids `str::parse` overhead)

## License

MIT
