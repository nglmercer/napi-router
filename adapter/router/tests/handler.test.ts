import { describe, test, expect } from "bun:test";
import {
  createHandler,
  innerHandle,
  route,
  routeAsync,
} from "../router/handler";
import { Context } from "../context";
import { ResponseBuilder } from "../responseBuilder";
import type { EndpointRoute, WebSocketData } from "../types";
import type { Server } from "../../serve";
import { HttpMethod } from "../method";

describe("innerHandle", () => {
  test("returns 500 when requestIP returns null", async () => {
    const routes: EndpointRoute[] = [];
    const req = new Request("http://localhost/test") as Request;
    const server = { requestIP: () => null } as unknown as Server;
    const res = await innerHandle(routes, req, server);
    expect(res.status).toBe(500);
  });

  test("handles upgraded request in sync path", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.req.upgraded = true;
        },
      },
    ];
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await innerHandle(routes, req, server);
    expect(res).toBeUndefined();
  });

  test("handles upgraded request in async path", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          return new Promise((r) => {
            ctx.req.upgraded = true;
            r();
          });
        },
      },
    ];
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await innerHandle(routes, req, server);
    expect(res).toBeUndefined();
  });

  test("handles beforeSent hook in sync path", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          const res = ctx.res;
          res.beforeSent(() => {
            res.body("from hook");
          });
          res.send("matched");
        },
      },
    ];
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await innerHandle(routes, req, server);
    expect(await res.text()).toBe("from hook");
  });

  test("handles async beforeSent hook in async path", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          const res = ctx.res;
          return new Promise((r) => {
            res.beforeSent(async () => {
              await new Promise((r2) => setTimeout(r2, 10));
              res.body("async hook");
            });
            res.send("matched");
            r();
          });
        },
      },
    ];
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await innerHandle(routes, req, server);
    expect(await res.text()).toBe("async hook");
  });

  test("handles sync route with async beforeSent hook", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          const res = ctx.res;
          res.beforeSent(async () => {
            await new Promise((r) => setTimeout(r, 10));
            res.body("async hook from sync");
          });
          res.send("matched");
        },
      },
    ];
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await innerHandle(routes, req, server);
    expect(await res.text()).toBe("async hook from sync");
  });
});

describe("route", () => {
  test("returns 404 when no routes match", () => {
    const routes: EndpointRoute[] = [];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.statusCode).toBe(404);
    expect(res.bodyInit).toBe("Not found");
  });

  test("matches route with correct method and path", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("matched");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.bodyInit).toBe("matched");
  });

  test("skips routes with wrong method", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.POST,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("matched");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.statusCode).toBe(404);
  });

  test("stops when res.submit is true", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("first");
        },
      },
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.bodyInit).toBe("first");
  });

  test("stops when req.upgraded is true", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.req.upgraded = true;
        },
      },
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.bodyInit).toBe(null);
  });

  test("handles async handler with routeAsync", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          return new Promise((r) => {
            ctx.res.send("async");
            r();
          });
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await route(routes, ctx);
    expect(res.bodyInit).toBe("async");
  });

  test("handles path params with wildcard", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["*"],
        handler: (ctx) => {
          const req = ctx.req;
          const res = ctx.res;
          res.send((req.pathParams as string[])?.[0] || "none");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["123"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.bodyInit).toBe("123");
  });

  test("handles ALL method", () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.ALL,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("matched all");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.POST,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    route(routes, ctx);
    expect(res.bodyInit).toBe("matched all");
  });
});

describe("routeAsync", () => {
  test("skips routes with wrong method", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.POST,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.statusCode).toBe(404);
  });

  test("continues to next route on false path match", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["other"],
        handler: (ctx) => {
          ctx.res.send("first");
        },
      },
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.bodyInit).toBe("second");
  });

  test("handles path params in async route", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["*"],
        handler: async (ctx) => {
          const req = ctx.req;
          const res = ctx.res;
          res.send((req.pathParams as string[])?.[0] || "none");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["456"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.bodyInit).toBe("456");
  });

  test("stops when res.submit becomes true in async", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: async (ctx) => {
          ctx.res.send("first");
        },
      },
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.bodyInit).toBe("first");
  });

  test("stops when req.upgraded becomes true in async", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: async (ctx) => {
          ctx.req.upgraded = true;
        },
      },
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("second");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.bodyInit).toBe(null);
  });

  test("handles async handler in routeAsync", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: async (ctx) => {
          const res = ctx.res;
          await new Promise((r) => setTimeout(r, 10));
          res.send("async done");
        },
      },
    ];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.bodyInit).toBe("async done");
  });

  test("returns 404 when no async routes match", async () => {
    const routes: EndpointRoute[] = [];
    const req = {
      httpMethod: HttpMethod.GET,
      splitPath: ["test"],
      upgraded: false,
    } as unknown as Request;
    const res = new ResponseBuilder();
    const ctx = new Context(req, res);
    await routeAsync(routes, -1, Promise.resolve(), ctx);
    expect(res.statusCode).toBe(404);
    expect(res.bodyInit).toBe("Not found");
  });
});

describe("createHandler", () => {
  test("creates handler function", () => {
    const routes: EndpointRoute[] = [];
    const handler = createHandler(routes);
    expect(typeof handler).toBe("function");
  });

  test("created handler processes request", async () => {
    const routes: EndpointRoute[] = [
      {
        method: HttpMethod.GET,
        splitPath: ["test"],
        handler: (ctx) => {
          ctx.res.send("handled");
        },
      },
    ];
    const handler = createHandler(routes);
    const req = new Request("http://localhost/test") as Request;
    const server = {
      requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 0 }),
    } as unknown as Server<WebSocketData>;
    const res = await handler(req, server);
    expect(res).toBeInstanceOf(Response);
  });
});
