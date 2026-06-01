/**
 * bench/validator.bench.ts
 *
 * Benchmark: Manual JS validation vs Rust-side validation
 *
 * Measures:
 *   1. Rust Validator.validateBody() — NAPI call overhead
 *   2. Manual JS validation — typical if/else checks
 *   3. Rust Builder schema registration vs JSON schema registration
 *   4. Full request flow comparison
 */

import { Validator, SchemaBuilder, StringField, NumberField, BooleanField } from "../index.js";
import { serve, type Server } from "../adapter/serve.js";
import { Router } from "../adapter/router/router.js";
import { validate, s } from "../adapter/router/router/validator.js";

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
    `  ${name.padEnd(55)} ${formatOps(opsPerSec).padStart(10)} ops/sec  (${elapsed.toFixed(2)}ms)`,
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
});

const invalidBody = JSON.stringify({
  name: "J", // too short
  email: "notanemail",
  age: -1,
  role: "superadmin",
});

const validBodyBytes = Buffer.from(validBody);

// ---------------------------------------------------------------------------
// Schema registration: JSON string approach
// ---------------------------------------------------------------------------

const jsonSchemaString = JSON.stringify({
  body: {
    name: { type: "string", required: true, min: 2, max: 100 },
    email: { type: "string", required: true, pattern: "email" },
    age: { type: "integer", required: true, min: 0, max: 200 },
    role: { type: "string", required: true, enum: ["admin", "user", "guest"] },
  },
});

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

  return errors.length > 0 ? { success: false, errors } : { success: true };
}

// ---------------------------------------------------------------------------
// Benchmark: Schema Registration (JSON vs Rust Builder)
// ---------------------------------------------------------------------------

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  SCHEMA REGISTRATION BENCHMARK");
console.log("═══════════════════════════════════════════════════════════════════\n");

const REG_ITERATIONS = 10_000;

bench(
  "JSON string: validator.addSchema()",
  () => {
    const v = new Validator();
    v.addSchema("POST:/users", jsonSchemaString);
  },
  REG_ITERATIONS,
);

bench(
  "Rust Builder: validator.addSchemaFromBuilder()",
  () => {
    const v = new Validator();
    const schema = new SchemaBuilder();
    const nameField = new StringField();
    nameField.required();
    nameField.setMin(2);
    nameField.setMax(100);
    schema.addBodyString("name", nameField);
    const emailField = new StringField();
    emailField.required();
    emailField.setPattern("email");
    schema.addBodyString("email", emailField);
    const ageField = new NumberField();
    ageField.integer();
    ageField.setMin(0);
    ageField.setMax(200);
    schema.addBodyNumber("age", ageField);
    const roleField = new StringField();
    roleField.required();
    roleField.setEnum(["admin", "user", "guest"]);
    schema.addBodyString("role", roleField);
    v.addSchemaFromBuilder("POST:/users", schema);
  },
  REG_ITERATIONS,
);

// ---------------------------------------------------------------------------
// Benchmark: Pure Validation (NAPI call overhead)
// ---------------------------------------------------------------------------

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  VALIDATION BENCHMARK (valid body)");
console.log("═══════════════════════════════════════════════════════════════════\n");

const VAL_ITERATIONS = 100_000;

// Setup validators
const jsonValidator = new Validator();
jsonValidator.addSchema("POST:/users", jsonSchemaString);

const builderValidator = new Validator();
const bSchema = new SchemaBuilder();
const bName = new StringField(); bName.required(); bName.setMin(2); bName.setMax(100);
bSchema.addBodyString("name", bName);
const bEmail = new StringField(); bEmail.required(); bEmail.setPattern("email");
bSchema.addBodyString("email", bEmail);
const bAge = new NumberField(); bAge.integer(); bAge.setMin(0); bAge.setMax(200);
bSchema.addBodyNumber("age", bAge);
const bRole = new StringField(); bRole.required(); bRole.setEnum(["admin", "user", "guest"]);
bSchema.addBodyString("role", bRole);
builderValidator.addSchemaFromBuilder("POST:/users", bSchema);

bench(
  "Rust validateBody(JSON schema, valid)",
  () => { jsonValidator.validateBody("POST:/users", validBody); },
  VAL_ITERATIONS,
);

bench(
  "Rust validateBody(Rust builder schema, valid)",
  () => { builderValidator.validateBody("POST:/users", validBody); },
  VAL_ITERATIONS,
);

bench(
  "Rust validateBodyBytes(valid)",
  () => { jsonValidator.validateBodyBytes("POST:/users", validBodyBytes); },
  VAL_ITERATIONS,
);

bench(
  "Manual JS: JSON.parse + validate (valid)",
  () => { validateUserManual(JSON.parse(validBody)); },
  VAL_ITERATIONS,
);

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  VALIDATION BENCHMARK (invalid body)");
console.log("═══════════════════════════════════════════════════════════════════\n");

bench(
  "Rust validateBody(JSON schema, invalid)",
  () => { jsonValidator.validateBody("POST:/users", invalidBody); },
  VAL_ITERATIONS,
);

bench(
  "Rust validateBody(Rust builder schema, invalid)",
  () => { builderValidator.validateBody("POST:/users", invalidBody); },
  VAL_ITERATIONS,
);

bench(
  "Manual JS: JSON.parse + validate (invalid)",
  () => { validateUserManual(JSON.parse(invalidBody)); },
  VAL_ITERATIONS,
);

// ---------------------------------------------------------------------------
// Benchmark: Full HTTP request flow
// ---------------------------------------------------------------------------

async function benchHttpFlow() {
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  HTTP REQUEST FLOW BENCHMARK (10,000 requests)");
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

  // --- 2. Auto-validate with JSON schema ---
  const autoValidator = new Validator();
  autoValidator.addSchema("POST:/api/users", jsonSchemaString);

  const routerAutoValidate = new Router();
  routerAutoValidate.body("*", "/api/*");
  routerAutoValidate.post("/api/users", (ctx) => {
    ctx.json({ ok: true });
  });

  // --- 3. Auto-validate with Rust builder schema ---
  const autoBuilderValidator = new Validator();
  autoBuilderValidator.addSchemaFromBuilder("POST:/api/users", bSchema);

  const routerAutoBuilder = new Router();
  routerAutoBuilder.body("*", "/api/*");
  routerAutoBuilder.post("/api/users", (ctx) => {
    ctx.json({ ok: true });
  });

  // --- 4. Standalone validate() with s.* builders ---
  const validatorTs = new Validator();
  const routerTsMiddleware = new Router();
  routerTsMiddleware.body("*", "/api/*");
  routerTsMiddleware.post(
    "/api/users",
    async (ctx) => {
      const result = validate(ctx.req.parsedBody, {
        name: s.string().required().min(2),
        email: s.string().required().pattern("email"),
        age: s.integer().min(0).max(200),
      }, validatorTs);
      if (!result.success) {
        ctx.status(400).json({ error: "Validation failed", errors: result.errors });
        return;
      }
      ctx.json({ ok: true });
    },
  );

  // --- 5. Manual JS validation middleware ---
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
      `  ${name.padEnd(55)} ${formatOps(rps).padStart(10)} req/sec  (${elapsed.toFixed(0)}ms)`,
    );
    return rps;
  }

  const noValRps = await runBench("No validation", routerNoValidation, serverPort);

  const autoJsonRps = await runBench(
    "Auto-validate (JSON schema)",
    routerAutoValidate,
    serverPort + 1,
    (s) => {
      s.setValidator(autoValidator);
      s.setAutoValidate(true);
    },
  );

  const autoBuilderRps = await runBench(
    "Auto-validate (Rust builder schema)",
    routerAutoBuilder,
    serverPort + 2,
    (s) => {
      s.setValidator(autoBuilderValidator);
      s.setAutoValidate(true);
    },
  );

  const tsMiddlewareRps = await runBench(
    "Rust Validator middleware (TS s.* builder)",
    routerTsMiddleware,
    serverPort + 3,
  );

  const manualRps = await runBench(
    "Manual JS validation middleware",
    routerManualValidation,
    serverPort + 4,
  );

  console.log("\n  ┌───────────────────────────────────────────────────────────────────┐");
  console.log("  │ Comparison vs No Validation baseline                              │");
  console.log("  ├───────────────────────────────────────────────────────────────────┤");
  console.log(`  │ Auto-validate (JSON):       ${((1 - autoJsonRps / noValRps) * 100).toFixed(1).padStart(5)}% overhead                       │`);
  console.log(`  │ Auto-validate (Builder):    ${((1 - autoBuilderRps / noValRps) * 100).toFixed(1).padStart(5)}% overhead                       │`);
  console.log(`  │ TS middleware:               ${((1 - tsMiddlewareRps / noValRps) * 100).toFixed(1).padStart(5)}% overhead                       │`);
  console.log(`  │ Manual JS:                  ${((1 - manualRps / noValRps) * 100).toFixed(1).padStart(5)}% overhead                       │`);
  console.log("  ├───────────────────────────────────────────────────────────────────┤");
  console.log(`  │ Auto-validate (Builder) vs Manual JS:  ${(autoBuilderRps / manualRps).toFixed(2).padStart(5)}x faster               │`);
  console.log(`  │ Auto-validate (JSON) vs Manual JS:     ${(autoJsonRps / manualRps).toFixed(2).padStart(5)}x faster               │`);
  console.log(`  │ TS middleware vs Manual JS:             ${(tsMiddlewareRps / manualRps).toFixed(2).padStart(5)}x                     │`);
  console.log("  └───────────────────────────────────────────────────────────────────┘\n");
}

benchHttpFlow().catch(console.error);
