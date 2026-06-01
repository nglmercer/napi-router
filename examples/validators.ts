/**
 * examples/validators.ts
 *
 * Simple validate() usage — like Zod.
 *
 * Run:
 *   bun examples/validators.ts
 */

import { serve } from "../adapter/serve.js";
import { Router } from "../adapter/router/router.js";
import { Validator } from "../index.js";
import { validate, s } from "../adapter/router/router/validator.js";

const validator = new Validator();
const router = new Router();

const registerFields = {
  name: s.string().required().min(2).max(100),
  email: s.string().required().pattern("email"),
  password: s.string().required().min(6).max(100),
};

const loginFields = {
  email: s.string().required().pattern("email"),
  password: s.string().required().min(1),
};

// ─── Register ────────────────────────────────────────────────────────
router.post("/register", async (ctx) => {
  const body = await ctx.req.json();
  const result = validate(body, registerFields, validator);

  if (!result.success) {
    ctx.status(400).json({ errors: result.errors });
    return;
  }

  const { name, email } = result.data;
  ctx.status(201).json({ message: "User registered", user: { name, email } });
});

// ─── Login ───────────────────────────────────────────────────────────
router.post("/login", async (ctx) => {
  const body = await ctx.req.json();
  const result = validate(body, loginFields, validator);

  if (!result.success) {
    ctx.status(400).json({ errors: result.errors });
    return;
  }

  const { email, password } = result.data;
  if (email === "john@example.com" && password === "secret123") {
    ctx.json({ token: "fake-token" });
  } else {
    ctx.status(401).json({ error: "Invalid credentials" });
  }
});

// ─── Start ───────────────────────────────────────────────────────────
console.log("Validator examples running at http://localhost:3000");

const server = await serve({ port: 3000, fetch: router.handle });
process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
