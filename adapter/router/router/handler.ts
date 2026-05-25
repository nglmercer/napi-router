import { ResponseBuilder, HTTP_STATUS } from "../responseBuilder";
import { parseHttpMethods } from "../method";
import { splitPath, requestPathMatchesRouteDefinition } from "../path";
import type {
  Awaitable,
  RequestHandler,
  EndpointRoute,
  Context,
} from "../types";
import { NRequest } from "../types";
import { HttpMethod } from "../method";
import { Param } from "./param";
import { Context as ContextImpl } from "../context";
import { Server } from "../../serve";
export function innerHandle(
  routes: EndpointRoute[],
  request: NRequest,
  server: Server,
): Awaitable<Response> {
  const res = new ResponseBuilder();
  const req = request;
  req.httpMethod = parseHttpMethods(req.method);
  req.server = server;
  req.cookies = {};
  const url = new URL(req.url);
  req.path = url.pathname;
  req.splitPath = splitPath(req.path);
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key) {
        req.cookies[key.trim()] = decodeURIComponent(rest.join("=").trim());
      }
    }
  }
  const searchParams = url.searchParams;
  const queryParams: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    queryParams[key] = value;
  }
  req.queryParams = queryParams;
  req.query = (key?: string) => {
    if (key === undefined) {
      return { ...queryParams };
    }
    const values = searchParams.getAll(key);
    if (values.length > 1) {
      return values;
    }
    return searchParams.get(key) ?? undefined;
  };
  req.queries = (key: string) => {
    return searchParams.getAll(key);
  };
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

  const sock = req.server.requestIP(req);
  if (!sock) {
    return new Response("Request closed early", {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    });
  }
  req.sock = sock;

  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    req.ips = forwardedFor.split(",").map((ip) => ip.trim());
    req.ip = req.ips[0];
  } else {
    req.ip = sock.address;
    req.ips = [req.ip];
  }

  const ctx = new ContextImpl(req, res);
  const p = route(routes, ctx);
  if (p instanceof Response) {
    return p;
  }
  if (p && p.then != undefined) {
    return p.then((response: Response | void) => {
      if (response instanceof Response) {
        return response;
      }
      if (req.upgraded) {
        return undefined as unknown as Response;
      }
      const p = res.startBeforeSentHook();
      if (p && p.then != undefined) {
        return p.then(() => res.build());
      }
      return res.build();
    });
  }

  if (req.upgraded) {
    return undefined as unknown as Response;
  }
  const p2 = res.startBeforeSentHook();
  if (p2 && p2.then != undefined) {
    return p2.then(() => res.build());
  }

  return res.build();
}

export function route(
  routes: EndpointRoute[],
  ctx: Context,
): void | Response | Promise<void | Response> {
  const req = ctx.req;
  const res = ctx.res;
  for (let i = 0; i < routes.length; i++) {
    if (
      routes[i].method != HttpMethod.ALL &&
      routes[i].method != req.httpMethod
    ) {
      continue;
    }

    const pathParams = requestPathMatchesRouteDefinition(
      req.splitPath,
      routes[i].splitPath,
    );

    if (pathParams === false) {
      continue;
    } else if (pathParams !== true) {
      req.pathParams = pathParams as string[] | Record<string, string>;
    }

    const p = routes[i].handler(ctx);
    if (p instanceof Response) {
      return p;
    }
    if (p != undefined && p.then != undefined) {
      return routeAsync(routes, i, p, ctx);
    }

    if (res.submit === true || req.upgraded === true) {
      return;
    }
  }

  if (req.upgraded) {
    return;
  }

  res.reset().status(HTTP_STATUS.NOT_FOUND).body("Not found");
}

export async function routeAsync(
  routes: EndpointRoute[],
  initialDefIndex: number,
  promise: Promise<void | Response> | Response,
  ctx: Context,
): Promise<void | Response> {
  const req = ctx.req;
  const res = ctx.res;
  if (promise instanceof Response) {
    return promise;
  }
  const result = await promise;
  if (result instanceof Response) {
    return result;
  }

  if (res.submit === true || req.upgraded === true) {
    return;
  }

  for (let i = initialDefIndex + 1; i < routes.length; i++) {
    if (
      routes[i].method != HttpMethod.ALL &&
      routes[i].method != req.httpMethod
    ) {
      continue;
    }

    const pathParams = requestPathMatchesRouteDefinition(
      req.splitPath,
      routes[i].splitPath,
    );

    if (pathParams === false) {
      continue;
    } else if (pathParams !== true) {
      req.pathParams = pathParams as string[] | Record<string, string>;
    }

    const p = routes[i].handler(ctx);
    if (p instanceof Response) {
      return p;
    }
    if (p && p.then != undefined) {
      await p;
    }

    if ((res.submit as boolean) === true || req.upgraded === true) {
      return;
    }
  }

  if (req.upgraded) {
    return;
  }

  res.reset().status(HTTP_STATUS.NOT_FOUND).body("Not found");
}

export function createHandler(routes: EndpointRoute[]): RequestHandler {
  return (request: Request, server: Server) =>
    innerHandle(routes, request as NRequest, server);
}
