/**
 * examples/validators.test.ts
 *
 * Tests for the simplified validate() function.
 *
 * Run:
 *   bun examples/validators.test.ts
 */

import { describe, it, expect } from "bun:test";
import { Router } from "../adapter/router/router.js";
import { Validator } from "../index.js";
import { validate, s } from "../adapter/router/router/validator.js";

const validator = new Validator();
const router = new Router();

const registerFields = {
  name: s.string().required().min(2),
  email: s.string().required().pattern("email"),
  password: s.string().required().min(6),
};

const loginFields = {
  email: s.string().required().pattern("email"),
  password: s.string().required(),
};

router.post("/register", async (ctx) => {
  const body = await ctx.req.json();
  const result = validate(body, registerFields, validator);
  if (!result.success) {
    ctx.status(400).json({ errors: result.errors });
    return;
  }
  ctx.json({ message: "Registered", user: (result.data as any).name });
});

router.post("/login", async (ctx) => {
  const body = await ctx.req.json();
  const result = validate(body, loginFields, validator);
  if (!result.success) {
    ctx.status(400).json({ errors: result.errors });
    return;
  }
  ctx.json({ token: "ok" });
});

// ─── router.request() tests ──────────────────────────────────────────
describe("validate() with router.request()", () => {
  it("validates register body", async () => {
    const res1 = await router.request(
      new Request("http://localhost/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "John",
          email: "john@example.com",
          password: "secret123",
        }),
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await router.request(
      new Request("http://localhost/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );
    expect(res2.status).toBe(400);
  });

  it("validates login body", async () => {
    const res = await router.request(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "x" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ─── standalone validate() tests ─────────────────────────────────────
describe("standalone validate()", () => {
  it("validates a plain object", () => {
    const result = validate(
      { name: "John", email: "john@example.com" },
      { name: s.string().required(), email: s.string().required() },
      validator,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "John", email: "john@example.com" });
  });

  it("returns errors on invalid data", () => {
    const result = validate(
      { email: "bad" },
      {
        name: s.string().required(),
        email: s.string().required().pattern("email"),
      },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("validates a JSON string", () => {
    const result = validate(
      '{"name":"John","email":"john@example.com"}',
      { name: s.string().required(), email: s.string().required() },
      validator,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "John", email: "john@example.com" });
  });

  it("validates nested objects", () => {
    const result = validate(
      {
        items: [{ id: "a", qty: 2 }],
        shipping: { address: "123 Main", city: "NYC" },
      },
      {
        items: s
          .array(
            s.object({
              id: s.string().required(),
              qty: s.integer().required().min(1),
            }),
          )
          .required(),
        shipping: s
          .object({
            address: s.string().required(),
            city: s.string().required(),
          })
          .required(),
      },
      validator,
    );
    expect(result.success).toBe(true);
  });

  it("validates string constraints", () => {
    const result = validate(
      { name: "J" },
      { name: s.string().required().min(2).max(10) },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min_length");
  });

  it("validates integer constraints", () => {
    const result = validate(
      { age: -1 },
      { age: s.integer().required().min(0) },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("validates enum", () => {
    const result = validate(
      { role: "superadmin" },
      { role: s.string().required().enum("admin", "user") },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("enum");
  });

  it("validates boolean", () => {
    const result = validate(
      { active: "yes" },
      { active: s.boolean().required() },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("type");
  });
});
