import { describe, expect, it } from "bun:test";
import { requestId } from "../router/requestId";
import { parseHttpMethods } from "../method";
import type { EndpointRoute } from "../types";
import { createMockReq, createMockRes } from "./utils";
import { Context } from "../context";

describe("requestId middleware", () => {
  it("adds a request ID route", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "GET", "/api");
    expect(routes.length).toBe(1);
    expect(routes[0].splitPath).toEqual(["api"]);
  });

  it("sets req.id with generated UUID", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api");
    const res = createMockRes();
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe("string");
    expect(req.id!.length).toBeGreaterThan(0);
  });

  it("sets X-Request-Id header on response", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api");
    const res = createMockRes();
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", req.id);
  });

  it("uses existing X-Request-Id from request", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api");
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ "x-request-id": "my-custom-id" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(req.id).toBe("my-custom-id");
  });

  it("uses custom header name", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api", { header: "X-Correlation-Id" });
    const res = createMockRes();
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith("X-Correlation-Id", req.id);
  });

  it("custom generator is used", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api", {
      generator: () => "fixed-id-123"
    });
    const res = createMockRes();
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(req.id).toBe("fixed-id-123");
  });

  it("reads existing header case-insensitively", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api");
    const res = createMockRes();
    const req = createMockReq({
      headers: new Headers({ "X-REQUEST-ID": "case-test" })
    });
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(req.id).toBe("case-test");
  });

  it("works with all methods", () => {
    const routes: EndpointRoute[] = [];
    requestId(routes, "*", "/api");
    expect(routes[0].method).toBe(parseHttpMethods("*"));
  });
});
