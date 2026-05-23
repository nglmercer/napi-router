import { expect, test, describe, afterEach } from "bun:test";
import { HttpServer, Router, RequestCall, ResponseData, WsEvent } from "../index";

// ============================================================
// Router Unit Tests
// ============================================================

describe("Router Tests", () => {
  test("constructor creates empty router", () => {
    const r = new Router();
    expect(r.routeCount()).toBe(0);
  });

  test("addRoute + matchRoute — static route exact match", () => {
    const r = new Router();
    r.addRoute("GET", "/users", "listUsers");
    const m = r.matchRoute("GET", "/users")!;
    expect(m.handlerId).toBe("listUsers");
    expect(Object.keys(m.params)).toHaveLength(0);
  });

  test("matchRoute returns null on no match", () => {
    const r = new Router();
    r.addRoute("GET", "/users", "listUsers");
    expect(r.matchRoute("GET", "/posts")).toBeNull();
  });

  test("method filtering — GET vs POST", () => {
    const r = new Router();
    r.addRoute("GET", "/items", "getItems");
    r.addRoute("POST", "/items", "createItem");
    expect(r.matchRoute("GET", "/items")!.handlerId).toBe("getItems");
    expect(r.matchRoute("POST", "/items")!.handlerId).toBe("createItem");
    expect(r.matchRoute("PUT", "/items")).toBeNull();
  });

  test("path parameter extraction — :id", () => {
    const r = new Router();
    r.addRoute("GET", "/users/:id", "getUser");
    const m = r.matchRoute("GET", "/users/42")!;
    expect(m.handlerId).toBe("getUser");
    expect(m.params.id).toBe("42");
  });

  test("multiple path parameters", () => {
    const r = new Router();
    r.addRoute("GET", "/orgs/:orgId/repos/:repoId", "getRepo");
    const m = r.matchRoute("GET", "/orgs/acme/repos/myapp")!;
    expect(m.handlerId).toBe("getRepo");
    expect(m.params.orgId).toBe("acme");
    expect(m.params.repoId).toBe("myapp");
  });

  test("wildcard *path capture", () => {
    const r = new Router();
    r.addRoute("GET", "/files/*path", "serveFile");
    const m = r.matchRoute("GET", "/files/a/b/c.txt")!;
    expect(m.handlerId).toBe("serveFile");
    expect(m.params.path).toBe("a/b/c.txt");
  });

  test("wildcard matches non-empty path", () => {
    const r = new Router();
    r.addRoute("GET", "/files/*path", "serveFile");
    // /files/ → no segment after /files/ so wildcard not triggered
    expect(r.matchRoute("GET", "/files/hello")).not.toBeNull();
    expect(r.matchRoute("GET", "/files/deep/nested/path")!.params.path).toBe("deep/nested/path");
  });

  test("trailing slash normalisation", () => {
    const r = new Router();
    r.addRoute("GET", "/users", "listUsers");
    expect(r.matchRoute("GET", "/users/")).toBeNull();
  });

  test("query string ignored in path matching", () => {
    const r = new Router();
    r.addRoute("GET", "/search", "search");
    expect(r.matchRoute("GET", "/search?q=hello")).not.toBeNull();
    expect(r.matchRoute("GET", "/search")).not.toBeNull();
  });

  test("convenience methods — get/post/put/delete/patch/options/head/any", () => {
    const r = new Router();
    r.get("/g", "getHandler");
    r.post("/p", "postHandler");
    r.put("/pu", "putHandler");
    r.delete("/d", "deleteHandler");
    r.patch("/pa", "patchHandler");
    r.options("/o", "optionsHandler");
    r.head("/h", "headHandler");
    r.any("/a", "anyHandler");

    expect(r.matchRoute("GET", "/g")!.handlerId).toBe("getHandler");
    expect(r.matchRoute("POST", "/p")!.handlerId).toBe("postHandler");
    expect(r.matchRoute("PUT", "/pu")!.handlerId).toBe("putHandler");
    expect(r.matchRoute("DELETE", "/d")!.handlerId).toBe("deleteHandler");
    expect(r.matchRoute("PATCH", "/pa")!.handlerId).toBe("patchHandler");
    expect(r.matchRoute("OPTIONS", "/o")!.handlerId).toBe("optionsHandler");
    expect(r.matchRoute("HEAD", "/h")!.handlerId).toBe("headHandler");
    expect(r.matchRoute("GET", "/a")!.handlerId).toBe("anyHandler");
    expect(r.matchRoute("DELETE", "/a")!.handlerId).toBe("anyHandler");
    expect(r.matchRoute("POST", "/a")!.handlerId).toBe("anyHandler");
  });

  test("matchAll returns all matching routes in order", () => {
    const r = new Router();
    r.any("/health", "healthCheck");
    r.addRoute("GET", "/items/:id", "getItem");
    r.addRoute("POST", "/items/:id", "updateItem");

    const all = r.matchAll("GET", "/items/5");
    expect(all).toHaveLength(1);
    expect(all[0].handlerId).toBe("getItem");

    expect(r.matchAll("*", "/health")).toHaveLength(1);
  });

  test("clear removes all routes", () => {
    const r = new Router();
    r.get("/a", "h");
    r.post("/b", "h");
    expect(r.routeCount()).toBe(2);
    r.clear();
    expect(r.routeCount()).toBe(0);
    expect(r.matchRoute("GET", "/a")).toBeNull();
  });

  test("removeRoute deletes only the specified route", () => {
    const r = new Router();
    r.addRoute("GET", "/items", "getItems");
    r.addRoute("POST", "/items", "createItem");
    expect(r.routeCount()).toBe(2);

    expect(r.removeRoute("GET", "/items")).toBe(true);
    expect(r.routeCount()).toBe(1);
    expect(r.matchRoute("GET", "/items")).toBeNull();
    expect(r.matchRoute("POST", "/items")).not.toBeNull();
  });

  test("removeRoute returns false when route does not exist", () => {
    const r = new Router();
    r.get("/users", "listUsers");
    expect(r.removeRoute("DELETE", "/users")).toBe(false);
    expect(r.routeCount()).toBe(1);
  });

  test("any() matches all HTTP methods", () => {
    const r = new Router();
    r.any("/all", "anyHandler");
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] as const;
    for (const m of methods) {
      expect(r.matchRoute(m, "/all")!.handlerId).toBe("anyHandler");
    }
  });
});

// ============================================================
// HTTP Integration Tests
// ============================================================

async function findFreePort(start = 19000): Promise<number> {
  for (let p = start; p < start + 100; p++) {
    try {
      const { createServer } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(p, () => { srv.close(); resolve(); });
      });
      return p;
    } catch {
      continue;
    }
  }
  throw new Error("No free port");
}

async function serverWithHandler(
  port: number,
  onRequest: (reqCall: RequestCall) => void,
  onWsEvent?: (event: WsEvent) => void,
): Promise<HttpServer> {
  const srv = new HttpServer();
  srv.onRequest(onRequest);
  if (onWsEvent) srv.onWsEvent(onWsEvent);
  await srv.listen(port);
  return srv;
}

function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe("HTTP Server — basic transport", () => {
  afterEach(async () => {
    // nothing global to close since each test owns its server
  });

  test("handleRequest roundtrip — simple 200", async () => {
    const port = await findFreePort();
    const srv = await serverWithHandler(port, () => {
      server.close();
    });

    srv.onRequest(() => {
      srv.sendResponse("req-1", { status: 200, headers: {}, body: "hi" });
    });

    // Can't call onRequest via variable, since `server` isn't our local ref
    // We use `this` — so use the srv reference directly via onRequest call
    const srv2 = new HttpServer();
    srv2.onRequest((req) => {
      srv2.sendResponse(req.requestId, { status: 200, headers: {}, body: "hi" });
    });
    await srv2.listen(port);
    srv.close();

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe("hi");
    srv2.close();
  });

  test("status code honours 201", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest(() => {
      srv.sendResponse("x", { status: 201, headers: {}, body: "created" });
    });
    await srv.listen(port);

    expect((await fetch(`http://localhost:${port}/`)).status).toBe(201);
    srv.close();
  });

  test("response headers are forwarded", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest(() => {
      srv.sendResponse("x", {
        status: 200,
        headers: { "x-powered-by": "napi-router" },
        body: "",
      });
    });
    await srv.listen(port);

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.headers.get("x-powered-by")).toBe("napi-router");
    srv.close();
  });

  test("request exposes method, path, url, query, body, headers, remoteAddr", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    let captured: any = null;
    srv.onRequest((req) => {
      captured = req.request;
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "ok" });
    });
    await srv.listen(port);

    await fetch(`http://localhost:${port}/search?q=rust&page=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "abc123" },
      body: JSON.stringify({ key: "value" }),
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(captured.method).toBe("POST");
    expect(captured.path).toBe("/search");
    expect(captured.url).toContain("q=rust");
    expect(captured.query.q).toBe("rust");
    expect(captured.query.page).toBe("1");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["x-request-id"]).toBe("abc123");
    expect(JSON.parse(captured.body)).toEqual({ key: "value" });
    expect(captured.remoteAddr).toBeTruthy();
    srv.close();
  });

  test("requestId is a stable opaque string per request", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    let ids: string[] = [];
    srv.onRequest((req) => {
      ids.push(req.requestId);
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: req.requestId });
    });
    await srv.listen(port);

    const [r1, r2] = await Promise.all([
      fetch(`http://localhost:${port}/a`).then((r) => r.text()),
      fetch(`http://localhost:${port}/b`).then((r) => r.text()),
    ]);
    await new Promise((r) => setTimeout(r, 100));

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(r1).toBe(ids[0]);
    expect(r2).toBe(ids[1]);
    srv.close();
  });

  test("request without body has body undefined", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    let body: any = "NOT_SET";
    srv.onRequest((req) => {
      body = req.request.body;
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "" });
    });
    await srv.listen(port);

    await fetch(`http://localhost:${port}/no-body`, { method: "PUT" });
    await new Promise((r) => setTimeout(r, 100));
    expect(body).toBeUndefined();
    srv.close();
  });

  test("close unblocks listen", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();

    // listen should succeed
    await expect(srv.listen(port)).resolves.toBeUndefined();
    expect(srv.close()).toBeUndefined();
  });
});

// ============================================================
// Router + HTTP Server Integration
// ============================================================

describe("Router + HTTP Server integration", () => {
  test("full CRUD via Router dispatch to handler", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    const router = new Router();

    const db: Record<string, { name: string }> = {};

    router.get("/todos", "listTodos");
    router.get("/todos/:id", "getTodo");
    router.post("/todos", "createTodo");
    router.put("/todos/:id", "updateTodo");
    router.delete("/todos/:id", "deleteTodo");

    srv.onRequest((req) => {
      const m = router.matchRoute(req.request.method, req.request.path);
      if (!m) {
        srv.sendResponse(req.requestId, { status: 404, headers: {}, body: "not found" });
        return;
      }
      switch (m.handlerId) {
        case "listTodos": {
          const items = Object.entries(db).map(([id, v]) => ({ id, ...v }));
          srv.sendResponse(req.requestId, {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(items),
          });
          return;
        }
        case "getTodo": {
          const item = db[m.params.id];
          if (item) {
            srv.sendResponse(req.requestId, {
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: m.params.id, ...item }),
            });
          } else {
            srv.sendResponse(req.requestId, {
              status: 404,
              headers: {},
              body: "todo not found",
            });
          }
          return;
        }
        case "createTodo": {
          const body = JSON.parse(req.request.body || "{}");
          const id = crypto.randomUUID();
          db[id] = { name: body.name };
          srv.sendResponse(req.requestId, {
            status: 201,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, ...db[id] }),
          });
          return;
        }
        case "updateTodo": {
          if (!db[m.params.id]) {
            srv.sendResponse(req.requestId, { status: 404, headers: {}, body: "not found" });
            return;
          }
          const body = JSON.parse(req.request.body || "{}");
          db[m.params.id] = { name: body.name };
          srv.sendResponse(req.requestId, {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: m.params.id, ...db[m.params.id] }),
          });
          return;
        }
        case "deleteTodo": {
          if (db[m.params.id]) {
            delete db[m.params.id];
            srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "deleted" });
          } else {
            srv.sendResponse(req.requestId, { status: 404, headers: {}, body: "not found" });
          }
          return;
        }
      }
    });

    await srv.listen(port);

    // POST create
    let res = await fetch(`http://localhost:${port}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "write tests" }),
    });
    expect(res.status).toBe(201);
    const created: any = await res.json();
    const todoId = created.id;

    // GET all (should be 1)
    res = await fetch(`http://localhost:${port}/todos`);
    expect(res.status).toBe(200);
    const all: any[] = await res.json();
    expect(all).toHaveLength(1);

    // GET by id
    res = await fetch(`http://localhost:${port}/todos/${todoId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(todoId);

    // PUT update
    res = await fetch(`http://localhost:${port}/todos/${todoId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "write good tests" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("write good tests");

    // DELETE
    res = await fetch(`http://localhost:${port}/todos/${todoId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    // GET deleted — 404
    res = await fetch(`http://localhost:${port}/todos/${todoId}`);
    expect(res.status).toBe(404);

    srv.close();
  });

  test("static + param + wildcard routes coexist", async () => {
    const port = await findFreePort();
    const srv = new HttpServer();
    const router = new Router();
    router.get("/", "root");
    router.get("/users/:id", "getUser");
    router.get("/files/*path", "serveFile");

    srv.onRequest((req) => {
      const m = router.matchRoute(req.request.method, req.request.path);
      if (m) {
        srv.sendResponse(req.requestId, {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handler: m.handlerId, params: m.params }),
        });
      } else {
        srv.sendResponse(req.requestId, { status: 404, headers: {}, body: "N/A" });
      }
    });
    await srv.listen(port);

    // Static
    let r = await (await fetch(`http://localhost:${port}/`))!.json();
    expect(r.handler).toBe("root");

    // Param
    r = await (await fetch(`http://localhost:${port}/users/7`))!.json();
    expect(r.handler).toBe("getUser");
    expect(r.params.id).toBe("7");

    // Wildcard
    r = await (await fetch(`http://localhost:${port}/files/x/y/z.md`))!.json();
    expect(r.handler).toBe("serveFile");
    expect(r.params.path).toBe("x/y/z.md");

    // Unknown
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);

    srv.close();
  });
});
