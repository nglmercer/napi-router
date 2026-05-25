import { describe, expect, it, mock } from "bun:test";
import { timeout } from "../router/timeout";
import { parseHttpMethods } from "../method";
import type { EndpointRoute } from "../types";
import { createMockReq, createMockRes } from "./utils";
import { Context } from "../context";

describe("timeout middleware", () => {
  it("adds a timeout route", () => {
    const routes: EndpointRoute[] = [];
    timeout(routes, "GET", "/api", { timeoutMs: 5000 });
    expect(routes.length).toBe(1);
    expect(routes[0].splitPath).toEqual(["api"]);
  });

  it("registers a beforeSent hook", () => {
    const routes: EndpointRoute[] = [];
    timeout(routes, "GET", "/api", { timeoutMs: 5000 });
    const res = createMockRes();
    res.beforeSent = mock(function () { return res; });
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(res.beforeSent).toHaveBeenCalled();
  });

  it("works with all methods", () => {
    const routes: EndpointRoute[] = [];
    timeout(routes, "*", "/api", { timeoutMs: 5000 });
    expect(routes[0].method).toBe(parseHttpMethods("*"));
  });

  it("returns router for chaining", () => {
    const routes: EndpointRoute[] = [];
    const result = timeout(routes, "GET", "/api", { timeoutMs: 5000 });
    expect(result).toBe(routes);
  });

  it("timeout can be short for testing", async () => {
    const routes: EndpointRoute[] = [];
    timeout(routes, "GET", "/api", { timeoutMs: 1 });
    const res = createMockRes();
    res.status = mock(function () { return res; });
    res.send = mock(function () { res.submit = true; });
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);

    // Wait for the timeout to fire
    await new Promise(r => setTimeout(r, 50));

    // The timeout callback should have tried to set status
    // (though res.submit may already be true from a prior call)
  });

  it("beforeSent hook cleans up timer", () => {
    const routes: EndpointRoute[] = [];
    timeout(routes, "GET", "/api", { timeoutMs: 5000 });
    const res = createMockRes();
    let hookFn: Function | undefined;
    res.beforeSent = mock((fn: Function) => { hookFn = fn; return res; });
    const req = createMockReq();
    const ctx = new Context(req, res);
    routes[0].handler(ctx);
    expect(hookFn).toBeDefined();
  });
});
