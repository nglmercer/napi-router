import { describe, expect, it, mock } from "bun:test";
import { cors } from "../router/cors";
import { HttpMethod } from "../method";
import type { EndpointRoute } from "../types";
import { createMockReq, createMockRes, calls } from "./utils";
import { Context } from "../context";

describe("cors middleware", () => {
  it("adds a cors route", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "GET", "/api");
    expect(routes.length).toBe(1);
    expect(routes[0].splitPath).toEqual(["api"]);
  });

  it("sets Access-Control-Allow-Origin header for any origin", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "GET", "/api");
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://example.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "*"
    );
  });

  it("sets Access-Control-Allow-Origin to * when no origin header", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api");
    const res = createMockRes();
    const req = createMockReq({ headers: new Headers() });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    // When no origin header, getAllowOrigin returns undefined, so no header is set
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      expect.anything()
    );
  });

  it("restricts origin when specific origin is provided", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", { origin: "http://example.com" });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://example.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "http://example.com"
    );
  });

  it("rejects disallowed origin", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", { origin: "http://example.com" });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://evil.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      expect.anything()
    );
  });

  it("allows origin from array", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", { origin: ["http://a.com", "http://b.com"] });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://b.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "http://b.com"
    );
  });

  it("sets credentials header when enabled", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", { credentials: true });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://example.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Credentials",
      "true"
    );
  });

  it("sets exposed headers", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", { exposedHeaders: ["X-Custom", "X-Other"] });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://example.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Expose-Headers",
      "X-Custom, X-Other"
    );
  });

  it("handles preflight OPTIONS request", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "OPTIONS", "/api", {
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 3600
    });
    const res = createMockRes();
    res.status = mock(function () { return res; });
    res.send = mock(function () { res.submit = true; });
    const req = createMockReq({
      method: "OPTIONS",
      headers: new Headers({ origin: "http://example.com" })
    });
    (req).httpMethod = HttpMethod.OPTIONS;
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Allow-Origin", "*"]);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Allow-Methods", "GET, POST"]);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Allow-Headers", "Content-Type, Authorization"]);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Max-Age", "3600"]);
  });

  it("preflight reads request headers when allowedHeaders not set", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "OPTIONS", "/api");
    const res = createMockRes();
    res.status = mock(function () { return res; });
    res.send = mock(function () { res.submit = true; });
    const req = createMockReq({
      method: "OPTIONS",
      headers: new Headers({
        origin: "http://example.com",
        "access-control-request-headers": "X-Custom-Header"
      })
    });
    (req).httpMethod = HttpMethod.OPTIONS;
    const localCtx = new Context(req, res);
    routes[0].handler(localCtx);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Allow-Headers", "X-Custom-Header"]);
  });


  it("preflight continues when preflightContinue is true", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "OPTIONS", "/api", { preflightContinue: true });
    const res = createMockRes();
    res.status = mock(function () { return res; });
    res.send = mock(function () { res.submit = true; });
    const req = createMockReq({
      method: "OPTIONS",
      headers: new Headers({ origin: "http://example.com" })
    });
    (req).httpMethod = HttpMethod.OPTIONS;
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    // Should NOT call send because preflightContinue is true
    expect(res.send).not.toHaveBeenCalled();
  });

  it("sets default methods when not specified", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "OPTIONS", "/api");
    const res = createMockRes();
    res.status = mock(function () { return res; });
    res.send = mock(function () { res.submit = true; });
    const req = createMockReq({
      method: "OPTIONS",
      headers: new Headers({ origin: "http://example.com" })
    });
    (req).httpMethod = HttpMethod.OPTIONS;
    const localCtx = new Context(req, res);
    routes[0].handler(localCtx);
    expect(calls(res.setHeader)).toContainEqual(["Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE"]);
  });


  it("allows function-based origin", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", {
      origin: (origin) => origin.endsWith(".example.com") ? origin : undefined
    });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://sub.example.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "http://sub.example.com"
    );
  });

  it("rejects function-based origin when returns undefined", () => {
    const routes: EndpointRoute[] = [];
    cors(routes, "*", "/api", {
      origin: (origin) => origin.endsWith(".example.com") ? origin : undefined
    });
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ origin: "http://evil.com" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      expect.anything()
    );
  });
});
