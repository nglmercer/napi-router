import { describe, expect, it } from "bun:test";
import { bodyParser } from "../router/bodyParser";
import { parseHttpMethods } from "../method";
import type { EndpointRoute } from "../types";
import { createMockReq, createMockRes } from "./utils";
import { Context } from "../context";

describe("bodyParser middleware", () => {
  it("adds a body parser route", () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");
    expect(routes.length).toBe(1);
    expect(routes[0].splitPath).toEqual(["api"]);
  });

  it("parses JSON body", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");
    const body = JSON.stringify({ name: "test", value: 42 });
    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toEqual({ name: "test", value: 42 });
  });

  it("parses form-urlencoded body", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");

    const body = "name=test&value=42";
    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
      body,
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toEqual({ name: "test", value: "42" });
  });

  it("parses text body", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");

    const body = "plain text content";
    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "text/plain" }),
      body,
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBe("plain text content");
  });

  it("handles invalid JSON gracefully", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "not json {{{",
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBeUndefined();
  });

  it("does not parse when json option is false", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api", { json: false, text: false, form: false });

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: '{"key":"value"}',
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBeUndefined();
  });

  it("does not parse when text option is false", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api", { text: false, json: false, form: false });

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "text/plain" }),
      body: "some text",
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBeUndefined();
  });

  it("does not parse when form option is false", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api", { form: false, json: false, text: false });

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
      body: "key=value",
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBeUndefined();
  });

  it("respects limit option for JSON", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api", { limit: 5 });

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: '{"name":"long value that exceeds limit"}',
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    // Truncated JSON should fail to parse
    expect(req.parsedBody).toBeUndefined();
  });

  it("respects limit option for text", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api", { limit: 5 });

    const req = createMockReq({
      method: "POST",
      headers: new Headers({ "content-type": "text/plain" }),
      body: "hello world",
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBe("hello");
  });

  it("works with all methods", () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "*", "/api");
    expect(routes.length).toBe(1);
    expect(routes[0].method).toBe(parseHttpMethods("*"));
  });

  it("handles missing content-type as text", async () => {
    const routes: EndpointRoute[] = [];
    bodyParser(routes, "POST", "/api");

    const req = createMockReq({
      method: "POST",
      headers: new Headers(),
      body: "fallback text",
    });
    const ctx = new Context(req, createMockRes());
    await routes[0].handler(ctx);
    expect(req.parsedBody).toBe("fallback text");
  });
});
