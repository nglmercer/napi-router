/**
 * bench/validator.bench.ts
 *
 * Benchmark: Manual JS validation vs Rust-side validation
 *
 * Measures:
 *   1. Rust Validator.validateBody() — NAPI call overhead
 *   2. Manual JS validation — typical if/else checks
 *   3. Auto-validate mode — validation inside Rust (no JS roundtrip)
 *   4. Full request flow comparison
 */

import { Validator } from "../index.js";
import { serve, type Server } from "../adapter/serve.js";
import { Router } from "../adapter/router/router.js";
import { s } from "../adapter/router/router/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hrtime(): number {
  return performance.now();
}

function formatOps(opsPerSec: number): string {
  if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(2)}M`;
  if (opsPerSec >= 1_000) return `${(opsPerSec / 1_000).toFixed(2)}K`;
  return opsPerSec.toFixed(0);
}

function bench(name: string, fn: () => void, iterations = 100_000): number {
  // Warmup
  for (let i = 0; i < 1000; i++) fn();

  const start = hrtime();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = hrtime() - start;

  const opsPerSec = (iterations / elapsed) * 1000;
  console.log(
    `  ${name.padEnd(50)} ${formatOps(opsPerSec).padStart(10)} ops/sec  (${elapsed.toFixed(2)}ms)`,
  );
  return opsPerSec;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const validBody = JSON.stringify({
  name: "John Doe",
  email: "john@example.com",
  age: 30,
  role: "admin",
  tags: ["developer", "rust"],
  address: {
    street: "123 Main St",
    city: "Springfield",
    zip: "12345",
  },
});

const validBodyBytes = Buffer.from(validBody);

const invalidBody = JSON.stringify({
  name: "J", // too short
  email: "notanemail",
  age: -1,
  role: "superadmin",
  tags: [],
  address: {
    street: "",
    city: "",
    zip: "abc",
  },
});

// ---------------------------------------------------------------------------
// Rust Validator setup
// ---------------------------------------------------------------------------

const rustValidator = new Validator();
const schemaJson = JSON.stringify({
  body: {
    name: { type: "string", required: true, min: 2, max: 100 },
    email: { type: "string", required: true, pattern: "email" },
    age: { type: "integer", required: true, min: 0, max: 200 },
    role: { type: "string", required: true, enum: ["admin", "user", "guest"] },
    tags: {
      type: "array",
      required: false,
      min: 1,
      max: 10,
      items: { type: "string" },
    },
    address: {
      type: "object",
      required: false,
      properties: {
        street: { type: "string", required: true },
        city: { type: "string", required: true },
        zip: { type: "string", required: false, pattern: "numeric" },
      },
    },
  },
});
rustValidator.addSchema("POST:/api/users", schemaJson);

// ---------------------------------------------------------------------------
// Manual JS validation (typical approach)
// ---------------------------------------------------------------------------

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

function validateUserManual(body: unknown): { success: boolean; errors?: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== "object") {
    return { success: false, errors: [{ field: "body", message: "Expected object", code: "type" }] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string") {
    errors.push({ field: "body.name", message: "Expected string", code: "type" });
  } else {
    if (b.name.length < 2) errors.push({ field: "body.name", message: "Too short", code: "min_length" });
    if (b.name.length > 100) errors.push({ field: "body.name", message: "Too long", code: "max_length" });
  }

  if (typeof b.email !== "string") {
    errors.push({ field: "body.email", message: "Expected string", code: "type" });
  } else {
    if (!b.email.includes("@") || !b.email.includes(".") || b.email.length < 5) {
      errors.push({ field: "body.email", message: "Invalid email", code: "pattern" });
    }
  }

  if (typeof b.age !== "number" || !Number.isInteger(b.age)) {
    errors.push({ field: "body.age", message: "Expected integer", code: "type" });
  } else {
    if (b.age < 0) errors.push({ field: "body.age", message: "Too small", code: "min" });
    if (b.age > 200) errors.push({ field: "body.age", message: "Too large", code: "max" });
  }

  if (typeof b.role !== "string") {
    errors.push({ field: "body.role", message: "Expected string", code: "type" });
  } else {
    if (!["admin", "user", "guest"].includes(b.role)) {
      errors.push({ field: "body.role", message: "Invalid role", code: "enum" });
    }
  }

  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) {
      errors.push({ field: "body.tags", message: "Expected array", code: "type" });
    } else {
      if (b.tags.length < 1) errors.push({ field: "body.tags", message: "Too few items", code: "min_items" });
      if (b.tags.length > 10) errors.push({ field: "body.tags", message: "Too many items", code: "max_items" });
    }
  }

  if (b.address !== undefined) {
    if (typeof b.address !== "object" || b.address === null) {
      errors.push({ field: "body.address", message: "Expected object", code: "type" });
    } else {
      const addr = b.address as Record<string, unknown>;
      if (typeof addr.street !== "string" || addr.street.length === 0) {
        errors.push({ field: "body.address.street", message: "Required", code: "required" });
      }
      if (typeof addr.city !== "string" || addr.city.length === 0) {
        errors.push({ field: "body.address.city", message: "Required", code: "required" });
      }
    }
  }

  return errors.length > 0 ? { success: false, errors } : { success: true };
}

// ---------------------------------------------------------------------------
// Benchmark: Pure Validation (NAPI call overhead)
// ---------------------------------------------------------------------------

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  PURE VALIDATION BENCHMARK (NAPI call overhead)");
console.log("═══════════════════════════════════════════════════════════════════");
console.log("  Note: This measures the NAPI boundary crossing cost.");
console.log("  In real usage, validation happens inside Rust (auto-validate)");
console.log("  with zero NAPI overhead.\n");

const ITERATIONS = 100_000;

console.log("--- Valid body ---\n");

bench(
  "Rust validateBody(string)",
  () => { rustValidator.validateBody("POST:/api/users", validBody); },
  ITERATIONS,
);

bench(
  "Rust validateBodyBytes(buffer)",
  () => { rustValidator.validateBodyBytes("POST:/api/users", validBodyBytes); },
  ITERATIONS,
);

bench(
  "Manual JS: JSON.parse + validate",
  () => { validateUserManual(JSON.parse(validBody)); },
  ITERATIONS,
);

bench(
  "JSON.parse() baseline only",
  () => { JSON.parse(validBody); },
  ITERATIONS,
);

console.log("\n--- Invalid body ---\n");

bench(
  "Rust validateBody(string)",
  () => { rustValidator.validateBody("POST:/api/users", invalidBody); },
  ITERATIONS,
);

bench(
  "Rust validateBodyBytes(buffer)",
  () => { rustValidator.validateBodyBytes("POST:/api/users", Buffer.from(invalidBody)); },
  ITERATIONS,
);

bench(
  "Manual JS: JSON.parse + validate",
  () => { validateUserManual(JSON.parse(invalidBody)); },
  ITERATIONS,
);

// ---------------------------------------------------------------------------
// Benchmark: Full HTTP request flow
// ---------------------------------------------------------------------------

async function benchHttpFlow() {
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  HTTP REQUEST FLOW BENCHMARK");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const REQUESTS = 10_000;
  const body = JSON.stringify({ name: "John", email: "john@example.com", age: 30 });
  const headers = { "content-type": "application/json" };

  // --- 1. No validation ---
  const routerNoValidation = new Router();
  routerNoValidation.body("*", "/api/*");
  routerNoValidation.post("/api/users", (ctx) => {
    ctx.json({ ok: true });
  });

  // --- 2. Auto-validate (validation in Rust, no JS roundtrip) ---
  const autoValidator = new Validator();
  autoValidator.addSchema("POST:/api/users", schemaJson);

  const routerAutoValidate = new Router();
  routerAutoValidate.body("*", "/api/*");
  routerAutoValidate.post("/api/users", (ctx) => {
    ctx.json({ ok: true });
  });

  // --- 3. Rust Validator middleware (JS calls Rust) ---
  const validator = new Validator();
  const routerRustMiddleware = new Router();
  routerRustMiddleware.setValidator(validator);
  routerRustMiddleware.body("*", "/api/*");
  routerRustMiddleware.post(
    "/api/users",
    routerRustMiddleware.validate({
      body: {
        name: s.string({ required: true, min: 2 }),
        email: s.string({ required: true, pattern: "email" }),
        age: s.integer({ min: 0, max: 200 }),
      },
    }),
    (ctx) => {
      ctx.json({ ok: true });
    },
  );

  // --- 4. Manual JS validation middleware ---
  const routerManualValidation = new Router();
  routerManualValidation.body("*", "/api/*");
  routerManualValidation.post("/api/users", (ctx) => {
    const result = validateUserManual(ctx.req.parsedBody);
    if (!result.success) {
      ctx.status(400).json({ error: "Validation failed", errors: result.errors });
      return;
    }
    ctx.json({ ok: true });
  });

  const serverPort = 9900;

  async function runBench(name: string, router: Router, port: number, extraSetup?: (s: Server) => void): Promise<number> {
    const server = await serve({ port, fetch: router.handle, hostname: "127.0.0.1" });
    if (extraSetup) extraSetup(server);

    // Warmup
    for (let i = 0; i < 200; i++) {
      await fetch(`http://127.0.0.1:${port}/api/users`, { method: "POST", body, headers });
    }

    const start = hrtime();
    for (let i = 0; i < REQUESTS; i++) {
      await fetch(`http://127.0.0.1:${port}/api/users`, { method: "POST", body, headers });
    }
    const elapsed = hrtime() - start;

    await server.stop();

    const rps = (REQUESTS / elapsed) * 1000;
    console.log(
      `  ${name.padEnd(50)} ${formatOps(rps).padStart(10)} req/sec  (${elapsed.toFixed(0)}ms)`,
    );
    return rps;
  }

  const noValRps = await runBench("No validation", routerNoValidation, serverPort);

  const autoValRps = await runBench(
    "Auto-validate (Rust internal, no NAPI overhead)",
    routerAutoValidate,
    serverPort + 1,
    (s) => {
      s.setValidator(autoValidator);
      s.setAutoValidate(true);
    },
  );

  const rustMiddlewareRps = await runBench(
    "Rust Validator middleware (NAPI calls)",
    routerRustMiddleware,
    serverPort + 2,
  );

  const manualRps = await runBench(
    "Manual JS validation middleware",
    routerManualValidation,
    serverPort + 3,
  );

  console.log("\n  ┌─────────────────────────────────────────────────────────────┐");
  console.log("  │ Comparison vs No Validation baseline                        │");
  console.log("  ├─────────────────────────────────────────────────────────────┤");
  console.log(`  │ Auto-validate overhead:     ${((1 - autoValRps / noValRps) * 100).toFixed(1).padStart(5)}%  (best option)         │`);
  console.log(`  │ Rust middleware overhead:   ${((1 - rustMiddlewareRps / noValRps) * 100).toFixed(1).padStart(5)}%                        │`);
  console.log(`  │ Manual JS overhead:         ${((1 - manualRps / noValRps) * 100).toFixed(1).padStart(5)}%                        │`);
  console.log("  ├─────────────────────────────────────────────────────────────┤");
  console.log(`  │ Auto-validate vs Manual:    ${(autoValRps / manualRps).toFixed(2).padStart(5)}x faster                 │`);
  console.log(`  │ Rust middleware vs Manual:  ${(rustMiddlewareRps / manualRps).toFixed(2).padStart(5)}x                       │`);
  console.log("  └─────────────────────────────────────────────────────────────┘\n");
}

benchHttpFlow().catch(console.error);
