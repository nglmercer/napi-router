/**
 * test/validator.test.ts
 *
 * Tests for Rust-side validation:
 *   - Validator class (addSchema, validateBody, validateQuery, validateParams)
 *   - Schema builder (s.string, s.number, s.integer, s.boolean, s.object, s.array)
 *   - Auto-validate mode in server
 *   - Zero-duplicate parsing (bodyParser reuses Rust data)
 *   - Router.validate() middleware integration
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Validator } from "../index.js";
import {
  serve,
  nextPort,
  withServer,
  get,
  post,
  request,
  sleep,
  type Server,
} from "./setup.js";
import { Router } from "../adapter/router/router.js";
import { s } from "../adapter/router/router/validator.js";

// ---------------------------------------------------------------------------
// Validator class — direct Rust API tests
// ---------------------------------------------------------------------------

describe("Validator class", () => {
  let validator: Validator;

  beforeAll(() => {
    validator = new Validator();
  });

  it("creates a new Validator instance", () => {
    expect(validator).toBeDefined();
    expect(validator.schemaCount()).toBe(0);
  });

  it("adds a schema from JSON string", () => {
    const schema = JSON.stringify({
      body: {
        name: { type: "string", required: true, min: 2, max: 100 },
        age: { type: "integer", required: false, min: 0, max: 200 },
      },
    });
    validator.addSchema("POST:/users", schema);
    expect(validator.hasSchema("POST:/users")).toBe(true);
    expect(validator.schemaCount()).toBe(1);
  });

  it("removes a schema", () => {
    validator.addSchema("DELETE:/temp", JSON.stringify({ body: {} }));
    expect(validator.hasSchema("DELETE:/temp")).toBe(true);
    validator.removeSchema("DELETE:/temp");
    expect(validator.hasSchema("DELETE:/temp")).toBe(false);
  });

  it("clears all schemas", () => {
    const v = new Validator();
    v.addSchema("GET:/a", JSON.stringify({}));
    v.addSchema("POST:/b", JSON.stringify({}));
    expect(v.schemaCount()).toBe(2);
    v.clear();
    expect(v.schemaCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("Validator.validateBody", () => {
  let validator: Validator;

  beforeAll(() => {
    validator = new Validator();
    validator.addSchema(
      "POST:/users",
      JSON.stringify({
        body: {
          name: { type: "string", required: true, min: 2, max: 100 },
          email: { type: "string", required: true, pattern: "email" },
          age: { type: "integer", required: false, min: 0, max: 200 },
          role: {
            type: "string",
            required: false,
            enum: ["admin", "user", "guest"],
          },
        },
      }),
    );
  });

  it("passes valid body", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "john@example.com", age: 30 }),
    );
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
  });

  it("fails when required field is missing", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ email: "john@example.com" }),
    );
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0].field).toContain("name");
    expect(result.errors![0].code).toBe("required");
  });

  it("fails when string is too short", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "J", email: "john@example.com" }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min_length");
  });

  it("fails when string is too long", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({
        name: "A".repeat(101),
        email: "john@example.com",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("max_length");
  });

  it("fails when number exceeds min", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({
        name: "John",
        email: "john@example.com",
        age: -1,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("fails when number exceeds max", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({
        name: "John",
        email: "john@example.com",
        age: 201,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("max");
  });

  it("fails when enum value is invalid", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({
        name: "John",
        email: "john@example.com",
        role: "superadmin",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("enum");
  });

  it("passes when optional field is absent", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "john@example.com" }),
    );
    expect(result.success).toBe(true);
  });

  it("fails on invalid JSON", () => {
    const result = validator.validateBody("POST:/users", "not json{{{");
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("invalid_json");
  });

  it("returns no schema match → passes", () => {
    const result = validator.validateBody(
      "GET:/unknown",
      JSON.stringify({ anything: true }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

describe("Validator.validateQuery", () => {
  let validator: Validator;

  beforeAll(() => {
    validator = new Validator();
    validator.addSchema(
      "GET:/search",
      JSON.stringify({
        query: {
          q: { type: "string", required: true, min: 1, max: 200 },
          page: { type: "integer", required: false, min: 1 },
          limit: { type: "integer", required: false, min: 1, max: 100 },
          sort: {
            type: "string",
            required: false,
            enum: ["asc", "desc"],
          },
        },
      }),
    );
  });

  it("passes valid query params", () => {
    const result = validator.validateQuery("GET:/search", {
      q: "hello",
      page: "1",
      limit: "20",
    });
    expect(result.success).toBe(true);
  });

  it("fails when required query param is missing", () => {
    const result = validator.validateQuery("GET:/search", { page: "1" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("required");
  });

  it("fails when query param exceeds min", () => {
    const result = validator.validateQuery("GET:/search", {
      q: "hello",
      page: "0",
    });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("fails when query param exceeds max", () => {
    const result = validator.validateQuery("GET:/search", {
      q: "hello",
      limit: "101",
    });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("max");
  });

  it("fails when query param is not a valid integer", () => {
    const result = validator.validateQuery("GET:/search", {
      q: "hello",
      page: "abc",
    });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("type");
  });

  it("fails when enum value is invalid", () => {
    const result = validator.validateQuery("GET:/search", {
      q: "hello",
      sort: "random",
    });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("enum");
  });

  it("passes when optional params are absent", () => {
    const result = validator.validateQuery("GET:/search", { q: "test" });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path params validation
// ---------------------------------------------------------------------------

describe("Validator.validateParams", () => {
  let validator: Validator;

  beforeAll(() => {
    validator = new Validator();
    validator.addSchema(
      "GET:/users/:id",
      JSON.stringify({
        params: {
          id: { type: "integer", required: true, min: 1 },
        },
      }),
    );
  });

  it("passes valid path params", () => {
    const result = validator.validateParams("GET:/users/:id", { id: "42" });
    expect(result.success).toBe(true);
  });

  it("fails when path param is not a valid number", () => {
    const result = validator.validateParams("GET:/users/:id", { id: "abc" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("type");
  });

  it("fails when path param below min", () => {
    const result = validator.validateParams("GET:/users/:id", { id: "0" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });
});

// ---------------------------------------------------------------------------
// Nested object validation
// ---------------------------------------------------------------------------

describe("Validator — nested objects", () => {
  let validator: Validator;

  beforeAll(() => {
    validator = new Validator();
    validator.addSchema(
      "POST:/orders",
      JSON.stringify({
        body: {
          items: {
            type: "array",
            required: true,
            min: 1,
            items: {
              type: "object",
              properties: {
                product_id: { type: "string", required: true },
                quantity: { type: "integer", required: true, min: 1 },
              },
            },
          },
          shipping: {
            type: "object",
            required: true,
            properties: {
              address: { type: "string", required: true },
              city: { type: "string", required: true },
              zip: { type: "string", required: false, pattern: "numeric" },
            },
          },
        },
      }),
    );
  });

  it("passes valid nested body", () => {
    const result = validator.validateBody(
      "POST:/orders",
      JSON.stringify({
        items: [
          { product_id: "abc", quantity: 2 },
          { product_id: "def", quantity: 1 },
        ],
        shipping: {
          address: "123 Main St",
          city: "Springfield",
          zip: "12345",
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("fails on nested required field", () => {
    const result = validator.validateBody(
      "POST:/orders",
      JSON.stringify({
        items: [{ quantity: 2 }],
        shipping: { address: "123 Main St", city: "Springfield" },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].field).toContain("product_id");
  });

  it("fails on nested type error", () => {
    const result = validator.validateBody(
      "POST:/orders",
      JSON.stringify({
        items: [{ product_id: "abc", quantity: 0 }],
        shipping: { address: "123 Main St", city: "Springfield" },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("fails when array is empty (min: 1)", () => {
    const result = validator.validateBody(
      "POST:/orders",
      JSON.stringify({
        items: [],
        shipping: { address: "123 Main St", city: "Springfield" },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min_items");
  });
});

// ---------------------------------------------------------------------------
// Schema builder (s.*) helpers
// ---------------------------------------------------------------------------

describe("Schema builder s.*", () => {
  it("s.string() creates correct schema", () => {
    const schema = s.string({ required: true, min: 2, max: 100 });
    expect(schema.type).toBe("string");
    expect(schema.required).toBe(true);
    expect(schema.min).toBe(2);
    expect(schema.max).toBe(100);
  });

  it("s.number() creates correct schema", () => {
    const schema = s.number({ min: 0, max: 100, int: true });
    expect(schema.type).toBe("number");
    expect(schema.int).toBe(true);
  });

  it("s.integer() creates correct schema", () => {
    const schema = s.integer({ min: 1 });
    expect(schema.type).toBe("integer");
    expect(schema.min).toBe(1);
  });

  it("s.boolean() creates correct schema", () => {
    const schema = s.boolean({ required: true });
    expect(schema.type).toBe("boolean");
    expect(schema.required).toBe(true);
  });

  it("s.object() creates correct schema", () => {
    const schema = s.object({
      name: s.string({ required: true }),
      age: s.integer({ min: 0 }),
    });
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.name.type).toBe("string");
    expect(schema.properties!.age.type).toBe("integer");
  });

  it("s.array() creates correct schema", () => {
    const schema = s.array(s.string(), { min: 1, max: 10 });
    expect(schema.type).toBe("array");
    expect(schema.items!.type).toBe("string");
    expect(schema.min).toBe(1);
    expect(schema.max).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Router.validate() middleware integration
// ---------------------------------------------------------------------------

describe("Router.validate() middleware", () => {
  it("validates body and returns 400 on failure", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);
    router.body("*", "/api/*");

    router.post(
      "/api/users",
      router.validate("POST", "/api/users", {
        body: {
          name: s.string({ required: true, min: 2 }),
          email: s.string({ required: true, pattern: "email" }),
        },
      }),
      (ctx) => {
        ctx.json({ created: true });
      },
    );

    await withServer(port, { fetch: router.handle }, async (server) => {
      // Valid body → 200
      const res1 = await post(
        server,
        "/api/users",
        JSON.stringify({ name: "John", email: "john@example.com" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res1.status).toBe(200);

      // Missing required field → 400
      const res2 = await post(
        server,
        "/api/users",
        JSON.stringify({ email: "john@example.com" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res2.status).toBe(400);
      const body2 = await res2.json();
      expect(body2.error).toBe("Validation failed");
      expect(body2.errors).toBeDefined();
      expect(body2.errors.length).toBeGreaterThan(0);

      // Invalid email pattern → 400
      const res3 = await post(
        server,
        "/api/users",
        JSON.stringify({ name: "John", email: "notanemail" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res3.status).toBe(400);
    });
  });

  it("validates query params and returns 400 on failure", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);

    router.get(
      "/api/search",
      router.validate("GET", "/api/search", {
        query: {
          q: s.string({ required: true, min: 1 }),
          page: s.integer({ min: 1 }),
        },
      }),
      (ctx) => {
        ctx.json({ results: [] });
      },
    );

    await withServer(port, { fetch: router.handle }, async (server) => {
      // Valid query → 200
      const res1 = await get(server, "/api/search?q=test&page=1");
      expect(res1.status).toBe(200);

      // Missing required query → 400
      const res2 = await get(server, "/api/search?page=1");
      expect(res2.status).toBe(400);

      // Invalid page (below min) → 400
      const res3 = await get(server, "/api/search?q=test&page=0");
      expect(res3.status).toBe(400);
    });
  });

  it("validates path params and returns 400 on failure", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);

    router.get(
      "/api/users/:id",
      router.validate("GET", "/api/users/:id", {
        params: {
          id: s.integer({ required: true, min: 1 }),
        },
      }),
      (ctx) => {
        ctx.json({ id: ctx.req.pathParams });
      },
    );

    await withServer(port, { fetch: router.handle }, async (server) => {
      // Valid param → 200
      const res1 = await get(server, "/api/users/42");
      expect(res1.status).toBe(200);

      // Invalid param (not a number) → 400
      const res2 = await get(server, "/api/users/abc");
      expect(res2.status).toBe(400);
    });
  });

  it("throws if setValidator() was not called", () => {
    const router = new Router();
    expect(() => {
      router.validate("GET", "/test", {
        query: { q: s.string({ required: true }) },
      });
    }).toThrow("Router.validate() requires a Validator");
  });
});

// ---------------------------------------------------------------------------
// Auto-validate mode (server-level)
// ---------------------------------------------------------------------------

describe("Server auto-validate mode", () => {
  it("returns 400 automatically when auto-validate is enabled", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    validator.addSchema(
      "POST:/api/items",
      JSON.stringify({
        body: {
          title: { type: "string", required: true, min: 3 },
        },
      }),
    );

    await withServer(
      port,
      {
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/items" && req.method === "POST") {
            const body = await req.json();
            return Response.json({ received: body });
          }
          return new Response("Not Found", { status: 404 });
        },
      },
      async (server) => {
        // Set validator and enable auto-validate on the raw HttpServer
        (server as any).setValidator(validator);
        (server as any).setAutoValidate(true);

        // Valid body → 200
        const res1 = await post(
          server,
          "/api/items",
          JSON.stringify({ title: "Hello" }),
          { headers: { "content-type": "application/json" } },
        );
        expect(res1.status).toBe(200);

        // Invalid body (too short) → 400 from Rust, no JS handler called
        const res2 = await post(
          server,
          "/api/items",
          JSON.stringify({ title: "Hi" }),
          { headers: { "content-type": "application/json" } },
        );
        expect(res2.status).toBe(400);
        const body2 = await res2.json();
        expect(body2.errors).toBeDefined();

        // Missing required field → 400
        const res3 = await post(
          server,
          "/api/items",
          JSON.stringify({}),
          { headers: { "content-type": "application/json" } },
        );
        expect(res3.status).toBe(400);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Zero-duplicate parsing (bodyParser reuses Rust data)
// ---------------------------------------------------------------------------

describe("Zero-duplicate parsing", () => {
  it("bodyParser reuses Rust-parsed JSON body", async () => {
    const port = nextPort("HTTP");
    const router = new Router();
    router.body("*", "/api/*");

    let parsedBodyReceived: unknown;

    router.post("/api/test", (ctx) => {
      parsedBodyReceived = ctx.req.parsedBody;
      ctx.json({ received: ctx.req.parsedBody });
    });

    await withServer(port, { fetch: router.handle }, async (server) => {
      const testData = { name: "test", value: 42 };
      const res = await post(
        server,
        "/api/test",
        JSON.stringify(testData),
        { headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toEqual(testData);
      expect(parsedBodyReceived).toEqual(testData);
    });
  });

  it("query params are available from Rust parsing", async () => {
    const port = nextPort("HTTP");
    const router = new Router();

    let receivedQuery: Record<string, string> | undefined;

    router.get("/api/test", (ctx) => {
      receivedQuery = ctx.req.queryParams;
      ctx.json({ query: ctx.req.queryParams });
    });

    await withServer(port, { fetch: router.handle }, async (server) => {
      const res = await get(server, "/api/test?foo=bar&baz=123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query.foo).toBe("bar");
      expect(body.query.baz).toBe("123");
      expect(receivedQuery).toBeDefined();
      expect(receivedQuery!.foo).toBe("bar");
    });
  });
});
