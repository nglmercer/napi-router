import { Context } from "./context";
import { ResponseBuilder } from "./responseBuilder";
import { Param } from "./router/param";
import { parseHttpMethods } from "./method";
import { splitPath } from "./path";
import type { Request as EnhancedRequest } from "./types";

export interface TestContextOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  cookies?: Record<string, string>;
  ip?: string;
}

/**
 * Creates a Context with a mock request and fresh ResponseBuilder for unit testing
 * individual route handlers or middleware functions.
 *
 * The returned Context has all EnhancedRequest properties (`queryParam`, `pathParam`,
 * `ip`, `cookies`, etc.) populated to match what the router would normally set at runtime.
 *
 * @example
 * ```ts
 * import { createTestContext } from "router-bun"
 *
 * const ctx = createTestContext({
 *   method: "GET",
 *   url: "/users/42?filter=active",
 *   pathParams: { id: "42" },
 * })
 *
 * myHandler(ctx)
 *
 * expect(ctx.res.statusCode).toBe(200)
 * expect(ctx.res.bodyInit).toBe("hello")
 * ```
 */
export function createTestContext(opts: TestContextOptions = {}): Context {
  const {
    method = "GET",
    url = "http://localhost/",
    headers: headerMap = {},
    body = "",
    pathParams,
    queryParams: providedQuery = {},
    cookies: providedCookies = {},
    ip = "127.0.0.1",
  } = opts;

  const fullUrl = url.startsWith("http") ? url : `http://localhost${url}`;
  const parsedUrl = new URL(fullUrl);
  const req = new Request(fullUrl, {
    method,
    headers: headerMap,
    body,
  }) as unknown as EnhancedRequest;

  // Merge URL query params with provided query params
  const mergedQuery: Record<string, string> = { ...providedQuery };
  for (const [key, value] of parsedUrl.searchParams) {
    mergedQuery[key] = value;
  }

  req.httpMethod = parseHttpMethods(method);
  req.path = parsedUrl.pathname;
  req.splitPath = splitPath(req.path);
  req.queryParams = mergedQuery;
  req.ip = ip;
  req.ips = [ip];
  req.cookies = { ...providedCookies };
  req.pathParams = pathParams;

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(mergedQuery)) {
    searchParams.set(k, v);
  }

  req.query = (key?: string) => {
    if (key === undefined) return { ...mergedQuery };
    const values = searchParams.getAll(key);
    if (values.length > 1) return values;
    return searchParams.get(key) ?? undefined;
  };

  req.queries = (key: string) => searchParams.getAll(key);

  req.queryParam = ((key?: string) => {
    if (key === undefined) {
      const all: Record<string, Param> = {};
      for (const k of searchParams.keys()) {
        const values = searchParams.getAll(k);
        all[k] = new Param(values.length > 1 ? values : values[0]);
      }
      return all;
    }
    const values = searchParams.getAll(key);
    if (values.length === 0) return new Param(undefined);
    if (values.length > 1) return new Param(values);
    return new Param(values[0]);
  }) as {
    (key: string): Param;
    (): Record<string, Param>;
  };

  req.pathParam = ((key?: string) => {
    const pp = req.pathParams;
    if (key === undefined) {
      const all: Record<string, Param> = {};
      if (pp && typeof pp === "object" && !Array.isArray(pp)) {
        for (const k of Object.keys(pp)) {
          all[k] = new Param(pp[k]);
        }
      }
      return all;
    }
    if (pp && typeof pp === "object" && !Array.isArray(pp)) {
      return new Param(pp[key]);
    }
    if (Array.isArray(pp)) {
      const index = parseInt(key);
      if (!isNaN(index) && index >= 0 && index < pp.length) {
        return new Param(pp[index]);
      }
    }
    return new Param(undefined);
  }) as {
    (key: string): Param;
    (): Record<string, Param>;
  };

  const res = new ResponseBuilder();
  return new Context(req, res);
}
