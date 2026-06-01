/**
 * test/validator.test.ts
 *
 * Tests for:
 *   - Validator class (addSchema, validateBody, validateQuery, validateParams)
 *   - Schema builder (s.string().min().max(), etc.)
 *   - Standalone validate() function
 *   - Rust Builder API
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
  validate,
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
      JSON.stringify({ name: "John", email: "john@example.com", age: -1 }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("fails when number exceeds max", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "john@example.com", age: 201 }),
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("max");
  });

  it("fails when enum value is invalid", () => {
    const result = validator.validateBody(
      "POST:/users",
      JSON.stringify({ name: "John", email: "john@example.com", role: "superadmin" }),
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
          sort: { type: "string", required: false, enum: ["asc", "desc"] },
        },
      }),
    );
  });

  it("passes valid query params", () => {
    const result = validator.validateQuery("GET:/search", { q: "hello", page: "1", limit: "20" });
    expect(result.success).toBe(true);
  });

  it("fails when required query param is missing", () => {
    const result = validator.validateQuery("GET:/search", { page: "1" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("required");
  });

  it("fails when query param exceeds min", () => {
    const result = validator.validateQuery("GET:/search", { q: "hello", page: "0" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("fails when query param exceeds max", () => {
    const result = validator.validateQuery("GET:/search", { q: "hello", limit: "101" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("max");
  });

  it("fails when query param is not a valid integer", () => {
    const result = validator.validateQuery("GET:/search", { q: "hello", page: "abc" });
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("type");
  });

  it("fails when enum value is invalid", () => {
    const result = validator.validateQuery("GET:/search", { q: "hello", sort: "random" });
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
        shipping: { address: "123 Main St", city: "Springfield", zip: "12345" },
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
      JSON.stringify({ body: { phone: { type: "string", required: true, pattern: "phone" } } }),
    );

    const r1 = validator.validateBody("POST:/contact", JSON.stringify({ phone: "+1234567890" }));
    expect(r1.success).toBe(true);

    const r2 = validator.validateBody("POST:/contact", JSON.stringify({ phone: "not-a-phone" }));
    expect(r2.success).toBe(false);
    expect(r2.errors![0].code).toBe("pattern");
  });

  it("validates custom pattern (slug)", () => {
    const validator = new Validator();
    validator.addPattern("slug", "^[a-z0-9]+(?:-[a-z0-9]+)*$");
    validator.addSchema(
      "POST:/posts",
      JSON.stringify({ body: { slug: { type: "string", required: true, pattern: "slug" } } }),
    );

    expect(validator.validateBody("POST:/posts", JSON.stringify({ slug: "my-blog-post" })).success).toBe(true);
    expect(validator.validateBody("POST:/posts", JSON.stringify({ slug: "My-Blog-Post" })).success).toBe(false);
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
    expect(() => validator.addPattern("bad", "[invalid")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema builder — fluent API
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
    expect(schema.int).toBe(true);
  });

  it("s.boolean() creates correct schema", () => {
    const schema = s.boolean().required().build();
    expect(schema.type).toBe("boolean");
    expect(schema.required).toBe(true);
  });

  it("s.object() creates correct schema", () => {
    const schema = s.object({ name: s.string().required(), age: s.integer().min(0) }).build();
    expect(schema.type).toBe("object");
    expect(schema.properties!.name.type).toBe("string");
    expect(schema.properties!.age.min).toBe(0);
  });

  it("s.array() creates correct schema", () => {
    const schema = s.array(s.string()).min(1).max(10).build();
    expect(schema.type).toBe("array");
    expect(schema.items!.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Rust Builder API
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

    expect(validator.validateBody("POST:/users", JSON.stringify({ name: "John", email: "john@example.com" })).success).toBe(true);
    expect(validator.validateBody("POST:/users", JSON.stringify({ name: "J", email: "john@example.com" })).success).toBe(false);
    expect(validator.validateBody("POST:/users", JSON.stringify({ name: "John", email: "bad" })).success).toBe(false);
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

    expect(validator.validateBody("POST:/users", JSON.stringify({ age: 30 })).success).toBe(true);
    expect(validator.validateBody("POST:/users", JSON.stringify({ age: 30.5 })).success).toBe(false);
    expect(validator.validateBody("POST:/users", JSON.stringify({ age: -1 })).success).toBe(false);
  });

  it("SchemaBuilder with BooleanField validates correctly", () => {
    const validator = new Validator();
    const schema = new SchemaBuilder();
    const activeField = new BooleanField();
    activeField.required();
    schema.addBodyBoolean("active", activeField);
    validator.addSchemaFromBuilder("POST:/users", schema);

    expect(validator.validateBody("POST:/users", JSON.stringify({ active: true })).success).toBe(true);
    expect(validator.validateBody("POST:/users", JSON.stringify({ active: "yes" })).success).toBe(false);
  });

  it("SchemaBuilder with ObjectField validates nested objects", () => {
    const validator = new Validator();
    const schema = new SchemaBuilder();
    const addressField = new ObjectField();
    addressField.required();
    const streetField = new StringField();
    streetField.required();
    addressField.addString("street", streetField);
    const cityField = new StringField();
    cityField.required();
    addressField.addString("city", cityField);
    schema.addBodyObject("address", addressField);
    validator.addSchemaFromBuilder("POST:/users", schema);

    expect(validator.validateBody("POST:/users", JSON.stringify({ address: { street: "123 Main", city: "NYC" } })).success).toBe(true);
    expect(validator.validateBody("POST:/users", JSON.stringify({ address: { street: "123 Main" } })).success).toBe(false);
  });

  it("SchemaBuilder with ArrayField validates arrays", () => {
    const validator = new Validator();
    const schema = new SchemaBuilder();
    const tagsField = new ArrayField();
    tagsField.required();
    tagsField.setMin(1);
    tagsField.setMax(5);
    const itemField = new StringField();
    tagsField.ofString(itemField);
    schema.addBodyArray("tags", tagsField);
    validator.addSchemaFromBuilder("POST:/users", schema);

    expect(validator.validateBody("POST:/users", JSON.stringify({ tags: ["a", "b"] })).success).toBe(true);
    expect(validator.validateBody("POST:/users", JSON.stringify({ tags: [] })).success).toBe(false);
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

    expect(validator.validateBody("POST:/contact", JSON.stringify({ phone: "+1234567890" })).success).toBe(true);
    expect(validator.validateBody("POST:/contact", JSON.stringify({ phone: "not-a-phone" })).success).toBe(false);
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

    router.post("/api/test", (ctx) => {
      ctx.json({ received: ctx.req.parsedBody });
    });

    await withServer(port, { fetch: router.handle }, async (server) => {
      const testData = { name: "test", value: 42 };
      const res = await post(server, "/api/test", JSON.stringify(testData), {
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received).toEqual(testData);
    });
  });

  it("query params are available from Rust parsing", async () => {
    const port = nextPort("HTTP");
    const router = new Router();

    router.get("/api/test", (ctx) => {
      ctx.json({ query: ctx.req.queryParams });
    });

    await withServer(port, { fetch: router.handle }, async (server) => {
      const res = await get(server, "/api/test?foo=bar&baz=123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query.foo).toBe("bar");
      expect(body.query.baz).toBe("123");
    });
  });
});

// ---------------------------------------------------------------------------
// Standalone validate() — like Zod
// ---------------------------------------------------------------------------

describe("Standalone validate()", () => {
  it("validates a plain object", () => {
    const validator = new Validator();
    const result = validate(
      { name: "John", email: "john@example.com" },
      { name: s.string().required(), email: s.string().required().pattern("email") },
      validator,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "John", email: "john@example.com" });
  });

  it("returns errors on invalid data", () => {
    const validator = new Validator();
    const result = validate(
      { email: "bad" },
      { name: s.string().required(), email: s.string().required().pattern("email") },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("validates a JSON string", () => {
    const validator = new Validator();
    const result = validate(
      '{"name":"John","email":"john@example.com"}',
      { name: s.string().required(), email: s.string().required() },
      validator,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "John", email: "john@example.com" });
  });

  it("validates nested objects", () => {
    const validator = new Validator();
    const result = validate(
      { items: [{ id: "a", qty: 2 }], shipping: { address: "123 Main", city: "NYC" } },
      {
        items: s.array(s.object({ id: s.string().required(), qty: s.integer().required().min(1) })).required(),
        shipping: s.object({ address: s.string().required(), city: s.string().required() }).required(),
      },
      validator,
    );
    expect(result.success).toBe(true);
  });

  it("validates string constraints", () => {
    const validator = new Validator();
    const result = validate(
      { name: "J" },
      { name: s.string().required().min(2).max(10) },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min_length");
  });

  it("validates integer constraints", () => {
    const validator = new Validator();
    const result = validate(
      { age: -1 },
      { age: s.integer().required().min(0) },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("min");
  });

  it("validates enum", () => {
    const validator = new Validator();
    const result = validate(
      { role: "superadmin" },
      { role: s.string().required().enum("admin", "user") },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("enum");
  });

  it("validates boolean", () => {
    const validator = new Validator();
    const result = validate(
      { active: "yes" },
      { active: s.boolean().required() },
      validator,
    );
    expect(result.success).toBe(false);
    expect(result.errors![0].code).toBe("type");
  });

  it("works with router.request()", async () => {
    const validator = new Validator();
    const router = new Router();

    router.post("/users", async (ctx) => {
      const body = await ctx.req.json();
      const result = validate(body, {
        name: s.string().required().min(2),
        email: s.string().required().pattern("email"),
      }, validator);
      if (!result.success) {
        ctx.status(400).json({ errors: result.errors });
        return;
      }
      ctx.json({ ok: true });
    });

    const res1 = await router.request(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "John", email: "john@example.com" }),
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await router.request(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bad" }),
      }),
    );
    expect(res2.status).toBe(400);
  });
});
