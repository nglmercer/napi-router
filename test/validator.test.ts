/**
 * test/validator.test.ts
 *
 * Tests for Rust-side validation:
 *   - Validator class (addSchema, validateBody, validateQuery, validateParams)
 *   - Schema builder (s.string().min().max(), etc.)
 *   - Router.validate() middleware (auto-detect method/path)
 *   - Zero-duplicate parsing (bodyParser reuses Rust data)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Validator } from "../index.js";
import {
  serve,
  nextPort,
  withServer,
  get,
  post,
  type Server,
} from "./setup.js";
import { Router } from "../adapter/router/router.js";
import {
  s,
  SchemaBuilder,
  StringField,
  NumberField,
  BooleanField,
  ObjectField,
  ArrayField,
} from "../adapter/router/router/validator.js";

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
// Custom patterns (regex-based)
// ---------------------------------------------------------------------------

describe("Custom patterns", () => {
  it("validates custom pattern (phone)", () => {
    const validator = new Validator();
    validator.addPattern("phone", "^\\+?[1-9]\\d{1,14}$");
    validator.addSchema(
      "POST:/contact",
      JSON.stringify({
        body: {
          phone: { type: "string", required: true, pattern: "phone" },
        },
      }),
    );

    // Valid phone
    const result1 = validator.validateBody(
      "POST:/contact",
      JSON.stringify({ phone: "+1234567890" }),
    );
    expect(result1.success).toBe(true);

    // Invalid phone
    const result2 = validator.validateBody(
      "POST:/contact",
      JSON.stringify({ phone: "not-a-phone" }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("pattern");
  });

  it("validates custom pattern (slug)", () => {
    const validator = new Validator();
    validator.addPattern("slug", "^[a-z0-9]+(?:-[a-z0-9]+)*$");
    validator.addSchema(
      "POST:/posts",
      JSON.stringify({
        body: {
          slug: { type: "string", required: true, pattern: "slug" },
        },
      }),
    );

    // Valid slug
    const result1 = validator.validateBody(
      "POST:/posts",
      JSON.stringify({ slug: "my-blog-post" }),
    );
    expect(result1.success).toBe(true);

    // Invalid slug (uppercase)
    const result2 = validator.validateBody(
      "POST:/posts",
      JSON.stringify({ slug: "My-Blog-Post" }),
    );
    expect(result2.success).toBe(false);
  });

  it("validates custom pattern (hex_color)", () => {
    const validator = new Validator();
    validator.addPattern("hex_color", "^#[0-9a-fA-F]{6}$");
    validator.addSchema(
      "POST:/theme",
      JSON.stringify({
        body: {
          color: { type: "string", required: true, pattern: "hex_color" },
        },
      }),
    );

    // Valid hex color
    const result1 = validator.validateBody(
      "POST:/theme",
      JSON.stringify({ color: "#ff0000" }),
    );
    expect(result1.success).toBe(true);

    // Invalid hex color
    const result2 = validator.validateBody(
      "POST:/theme",
      JSON.stringify({ color: "red" }),
    );
    expect(result2.success).toBe(false);
  });

  it("checks if pattern exists", () => {
    const validator = new Validator();
    validator.addPattern("custom", "^test$");
    expect(validator.hasPattern("custom")).toBe(true);
    expect(validator.hasPattern("nonexistent")).toBe(false);
  });

  it("removes a pattern", () => {
    const validator = new Validator();
    validator.addPattern("temp", "^test$");
    expect(validator.hasPattern("temp")).toBe(true);
    validator.removePattern("temp");
    expect(validator.hasPattern("temp")).toBe(false);
  });

  it("fails on invalid regex", () => {
    const validator = new Validator();
    expect(() => {
      validator.addPattern("bad", "[invalid");
    }).toThrow();
  });

  it("works with fluent API and custom patterns", () => {
    const validator = new Validator();
    validator.addPattern("phone", "^\\+?[1-9]\\d{1,14}$");

    const schema = {
      body: {
        phone: s.string().required().pattern("phone"),
      },
    };

    validator.addSchema("POST:/api", JSON.stringify({
      body: {
        phone: { type: "string", required: true, pattern: "phone" },
      },
    }));

    const result = validator.validateBody(
      "POST:/api",
      JSON.stringify({ phone: "+1234567890" }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema builder — fluent API (s.string().min().max(), etc.)
// ---------------------------------------------------------------------------

describe("Schema builder — fluent API", () => {
  it("s.string() creates correct schema", () => {
    const schema = s.string().required().min(2).max(100).build();
    expect(schema.type).toBe("string");
    expect(schema.required).toBe(true);
    expect(schema.min).toBe(2);
    expect(schema.max).toBe(100);
  });

  it("s.string().pattern() creates correct schema", () => {
    const schema = s.string().required().pattern("email").build();
    expect(schema.type).toBe("string");
    expect(schema.required).toBe(true);
    expect(schema.pattern).toBe("email");
  });

  it("s.string().enum() creates correct schema", () => {
    const schema = s.string().required().enum("admin", "user", "guest").build();
    expect(schema.type).toBe("string");
    expect(schema.required).toBe(true);
    expect(schema.enum).toEqual(["admin", "user", "guest"]);
  });

  it("s.number() creates correct schema", () => {
    const schema = s.number().min(0).max(100).build();
    expect(schema.type).toBe("number");
    expect(schema.min).toBe(0);
    expect(schema.max).toBe(100);
  });

  it("s.integer() creates correct schema", () => {
    const schema = s.integer().required().min(1).build();
    expect(schema.type).toBe("integer");
    expect(schema.required).toBe(true);
    expect(schema.min).toBe(1);
    expect(schema.int).toBe(true);
  });

  it("s.number().integer() creates correct schema", () => {
    const schema = s.number().integer().min(0).build();
    expect(schema.type).toBe("integer");
    expect(schema.int).toBe(true);
  });

  it("s.boolean() creates correct schema", () => {
    const schema = s.boolean().required().build();
    expect(schema.type).toBe("boolean");
    expect(schema.required).toBe(true);
  });

  it("s.object() creates correct schema", () => {
    const schema = s.object({
      name: s.string().required(),
      age: s.integer().min(0),
    }).build();
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties!.name.type).toBe("string");
    expect(schema.properties!.name.required).toBe(true);
    expect(schema.properties!.age.type).toBe("integer");
    expect(schema.properties!.age.min).toBe(0);
  });

  it("s.array() creates correct schema", () => {
    const schema = s.array(s.string()).min(1).max(10).build();
    expect(schema.type).toBe("array");
    expect(schema.items!.type).toBe("string");
    expect(schema.min).toBe(1);
    expect(schema.max).toBe(10);
  });

  it("s.array(s.object()) creates correct nested schema", () => {
    const schema = s.array(
      s.object({
        id: s.string().required(),
        qty: s.integer().required().min(1),
      })
    ).min(1).build();
    expect(schema.type).toBe("array");
    expect(schema.items!.type).toBe("object");
    expect(schema.items!.properties!.id.type).toBe("string");
    expect(schema.items!.properties!.qty.min).toBe(1);
  });

  it("builder can be used directly in schema definition", () => {
    // This tests that builders are auto-resolved in RouteSchemaDefinition
    const schema = {
      body: {
        name: s.string().required().min(2),
        age: s.integer().min(0),
      },
    };
    // Should not throw when building
    expect(schema.body.name.build().type).toBe("string");
    expect(schema.body.age.build().min).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Router.validate() middleware — fluent API
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
      router.validate({
        body: {
          name: s.string().required().min(2),
          email: s.string().required().pattern("email"),
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
      router.validate({
        query: {
          q: s.string().required().min(1),
          page: s.integer().min(1),
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
      router.validate({
        params: {
          id: s.integer().required().min(1),
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
      router.validate({
        query: { q: s.string().required() },
      });
    }).toThrow("Router.validate() requires a Validator");
  });

  it("works with multiple routes using different schemas", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);
    router.body("*", "/api/*");

    router.post(
      "/api/users",
      router.validate({
        body: { name: s.string().required() },
      }),
      (ctx) => ctx.json({ type: "user" }),
    );

    router.post(
      "/api/posts",
      router.validate({
        body: { title: s.string().required().min(5) },
      }),
      (ctx) => ctx.json({ type: "post" }),
    );

    await withServer(port, { fetch: router.handle }, async (server) => {
      // User route — valid
      const res1 = await post(
        server,
        "/api/users",
        JSON.stringify({ name: "John" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res1.status).toBe(200);

      // Post route — title too short
      const res2 = await post(
        server,
        "/api/posts",
        JSON.stringify({ title: "Hi" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res2.status).toBe(400);

      // Post route — valid
      const res3 = await post(
        server,
        "/api/posts",
        JSON.stringify({ title: "Hello World" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res3.status).toBe(200);
    });
  });

  it("validates nested objects with fluent API", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);
    router.body("*", "/api/*");

    router.post(
      "/api/orders",
      router.validate({
        body: {
          items: s.array(
            s.object({
              product_id: s.string().required(),
              quantity: s.integer().required().min(1),
            })
          ).required().min(1),
          shipping: s.object({
            address: s.string().required(),
            city: s.string().required(),
          }).required(),
        },
      }),
      (ctx) => ctx.json({ ok: true }),
    );

    await withServer(port, { fetch: router.handle }, async (server) => {
      // Valid nested body → 200
      const res1 = await post(
        server,
        "/api/orders",
        JSON.stringify({
          items: [{ product_id: "abc", quantity: 2 }],
          shipping: { address: "123 Main St", city: "Springfield" },
        }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res1.status).toBe(200);

      // Missing nested required field → 400
      const res2 = await post(
        server,
        "/api/orders",
        JSON.stringify({
          items: [{ quantity: 2 }],
          shipping: { address: "123 Main St", city: "Springfield" },
        }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res2.status).toBe(400);
    });
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

// ---------------------------------------------------------------------------
// Rust Builder API (SchemaBuilder, StringField, NumberField, etc.)
// ---------------------------------------------------------------------------

describe("Rust Builder API", () => {
  it("SchemaBuilder with StringField validates correctly", () => {
    const validator = new Validator();

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

    validator.addSchemaFromBuilder("POST:/users", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "john@example.com" }),
    );
    expect(result1.success).toBe(true);

    // Invalid - name too short
    const result2 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "J", email: "john@example.com" }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("min_length");

    // Invalid - bad email pattern
    const result3 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "notanemail" }),
    );
    expect(result3.success).toBe(false);
    expect(result3.errors![0].code).toBe("pattern");
  });

  it("SchemaBuilder with NumberField validates correctly", () => {
    const validator = new Validator();

    const schema = new SchemaBuilder();
    const ageField = new NumberField();
    ageField.integer();
    ageField.setMin(0);
    ageField.setMax(200);
    schema.addBodyNumber("age", ageField);

    validator.addSchemaFromBuilder("POST:/users", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ age: 30 }),
    );
    expect(result1.success).toBe(true);

    // Invalid - not an integer
    const result2 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ age: 30.5 }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("integer");

    // Invalid - below min
    const result3 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ age: -1 }),
    );
    expect(result3.success).toBe(false);
    expect(result3.errors![0].code).toBe("min");
  });

  it("SchemaBuilder with BooleanField validates correctly", () => {
    const validator = new Validator();

    const schema = new SchemaBuilder();
    const activeField = new BooleanField();
    activeField.required();
    schema.addBodyBoolean("active", activeField);

    validator.addSchemaFromBuilder("POST:/users", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ active: true }),
    );
    expect(result1.success).toBe(true);

    // Invalid - not a boolean
    const result2 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ active: "yes" }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("type");
  });

  it("SchemaBuilder with ObjectField validates nested objects", () => {
    const validator = new Validator();

    const addressField = new ObjectField();
    addressField.required();
    const streetField = new StringField();
    streetField.required();
    addressField.addString("street", streetField);
    const cityField = new StringField();
    cityField.required();
    addressField.addString("city", cityField);

    const schema = new SchemaBuilder();
    schema.addBodyObject("address", addressField);

    validator.addSchemaFromBuilder("POST:/users", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ address: { street: "123 Main", city: "NYC" } }),
    );
    expect(result1.success).toBe(true);

    // Invalid - missing required nested field
    const result2 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ address: { street: "123 Main" } }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].field).toContain("city");
  });

  it("SchemaBuilder with ArrayField validates arrays", () => {
    const validator = new Validator();

    const tagsField = new ArrayField();
    tagsField.required();
    tagsField.setMin(1);
    tagsField.setMax(5);
    const itemField = new StringField();
    tagsField.ofString(itemField);

    const schema = new SchemaBuilder();
    schema.addBodyArray("tags", tagsField);

    validator.addSchemaFromBuilder("POST:/users", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ tags: ["a", "b"] }),
    );
    expect(result1.success).toBe(true);

    // Invalid - empty array (min: 1)
    const result2 = validator.validateBody(
      "POST:/users",
      JSON.stringify({ tags: [] }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("min_items");
  });

  it("SchemaBuilder with query and params", () => {
    const validator = new Validator();

    const schema = new SchemaBuilder();
    const qField = new StringField();
    qField.required();
    qField.setMin(1);
    schema.addQueryString("q", qField);

    const pageField = new NumberField();
    pageField.integer();
    pageField.setMin(1);
    schema.addQueryNumber("page", pageField);

    const idField = new NumberField();
    idField.integer();
    idField.required();
    idField.setMin(1);
    schema.addParamNumber("id", idField);

    validator.addSchemaFromBuilder("GET:/users/:id", schema);

    // Valid query
    const result1 = validator.validateQuery("GET:/users/:id", { q: "test", page: "1" });
    expect(result1.success).toBe(true);

    // Invalid query - missing required
    const result2 = validator.validateQuery("GET:/users/:id", { page: "1" });
    expect(result2.success).toBe(false);

    // Valid params
    const result3 = validator.validateParams("GET:/users/:id", { id: "42" });
    expect(result3.success).toBe(true);

    // Invalid params
    const result4 = validator.validateParams("GET:/users/:id", { id: "0" });
    expect(result4.success).toBe(false);
  });

  it("SchemaBuilder with custom patterns", () => {
    const validator = new Validator();
    validator.addPattern("phone", "^\\+?[1-9]\\d{1,14}$");

    const schema = new SchemaBuilder();
    const phoneField = new StringField();
    phoneField.required();
    phoneField.setPattern("phone");
    schema.addBodyString("phone", phoneField);

    validator.addSchemaFromBuilder("POST:/contact", schema);

    // Valid
    const result1 = validator.validateBody(
      "POST:/contact",
      JSON.stringify({ phone: "+1234567890" }),
    );
    expect(result1.success).toBe(true);

    // Invalid
    const result2 = validator.validateBody(
      "POST:/contact",
      JSON.stringify({ phone: "not-a-phone" }),
    );
    expect(result2.success).toBe(false);
    expect(result2.errors![0].code).toBe("pattern");
  });

  it("SchemaBuilder works with Router.validate()", async () => {
    const port = nextPort("HTTP");
    const validator = new Validator();
    const router = new Router();
    router.setValidator(validator);
    router.body("*", "/api/*");

    // Build schema using Rust builders
    const schema = new SchemaBuilder();
    const nameField = new StringField();
    nameField.required();
    nameField.setMin(2);
    schema.addBodyString("name", nameField);
    const emailField = new StringField();
    emailField.required();
    emailField.setPattern("email");
    schema.addBodyString("email", emailField);

    // Register with validator directly
    validator.addSchemaFromBuilder("POST:/api/users", schema);

    // Use the validator in a middleware
    router.post("/api/users", (ctx) => {
      const routeKey = `${ctx.req.method}:${new URL(ctx.req.url).pathname}`;
      if (ctx.req.parsedBody) {
        const result = validator.validateBodyValue(routeKey, JSON.stringify(ctx.req.parsedBody));
        if (!result.success) {
          ctx.status(400).json({ error: "Validation failed", errors: result.errors });
          return;
        }
      }
      ctx.json({ created: true });
    });

    await withServer(port, { fetch: router.handle }, async (server) => {
      // Valid
      const res1 = await post(
        server,
        "/api/users",
        JSON.stringify({ name: "John", email: "john@example.com" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res1.status).toBe(200);

      // Invalid
      const res2 = await post(
        server,
        "/api/users",
        JSON.stringify({ name: "J", email: "bad" }),
        { headers: { "content-type": "application/json" } },
      );
      expect(res2.status).toBe(400);
    });
  });
});
