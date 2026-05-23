import { expect, test, describe } from "bun:test";
import { HttpServer, Router, Context, RequestCall } from "../index";

// --------------- shared helpers ---------------

async function findFreePort(start = 19100): Promise<number> {
  const { createServer } = await import("node:net");
  for (let p = start; p < start + 200; p++) {
    try {
      const srv = createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(p, () => { srv.close(); resolve(); });
      });
      return p;
    } catch { /* in use */ }
  }
  throw new Error("no free port");
}

function get(port: number, path: string) {
  return fetch(`http://localhost:${port}${path}`);
}

function post(port: number, path: string, body: string, headers: Record<string,string> = { "content-type": "application/json" }) {
  return fetch(`http://localhost:${port}${path}`, { method: "POST", headers, body });
}

// ===========================================================================
// RAW MODE  (backwards‑compatible  onRequest / sendResponse  path)
// ===========================================================================

describe("HTTP: Raw mode (onRequest)", () => {

  test("echo 200", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req: RequestCall) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "hello" });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    srv.close();
  });

  test("custom status 201", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req) => {
      srv.sendResponse(req.requestId, { status: 201, headers: {}, body: "created" });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(201);
    srv.close();
  });

  test("response headers forwarded", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: { "x-powered-by": "napi-router" }, body: "" });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.headers.get("x-powered-by")).toBe("napi-router");
    srv.close();
  });

  test("requestId non-empty string", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: req.requestId });
    });
    await srv.listen(p);
    const id = await (await get(p, "/")).text();
    expect(id.length).toBeGreaterThan(0);
    srv.close();
  });

  test("parallel requests get distinct ids", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: req.requestId });
    });
    await srv.listen(p);
    const [ra, rb] = await Promise.all([
      get(p, "/a").then(r => r.text()),
      get(p, "/b").then(r => r.text()),
    ]);
    expect(ra).not.toBe(rb);
    srv.close();
  });

  test("request exposes method/path/url/query/body/headers/remoteAddr", async () => {
    const p = await findFreePort();
    let captured: any = null;
    const srv = new HttpServer();
    srv.onRequest((req) => {
      captured = req.request;
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "ok" });
    });
    await srv.listen(p);
    await post(p, "/search?q=rust&page=1", JSON.stringify({ key: "val" }), {
      "content-type": "application/json",
      "x-trace": "xyz",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe("/search");
    expect(captured.url).toContain("q=rust");
    expect(captured.query.q).toBe("rust");
    expect(captured.query.page).toBe("1");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["x-trace"]).toBe("xyz");
    expect(JSON.parse(captured.body)).toEqual({ key: "val" });
    expect(captured.remoteAddr).toBeTruthy();
    srv.close();
  });

  test("close() stops the listener", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "" });
    });
    await srv.listen(p);
    expect((await get(p, "/")).status).toBe(200);
    srv.close();
    const { createServer } = await import("node:net");
    const s = createServer();
    await new Promise<void>((res) => { s.listen(p, () => { s.close(); res(); }); });
  });

  test("pendingCount tracks outstanding requests", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest(() => { /* do nothing */ });
    await srv.listen(p);
    await fetch(`http://localhost:${p}/hang`, { signal: AbortSignal.timeout(250) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    expect(srv.pendingCount()).toBeLessThanOrEqual(1);
    srv.close();
  });
});

// ===========================================================================
// CONTEXT MODE  (server.use / Context API)
// ===========================================================================

describe("HTTP: Context mode (server.use)", () => {

  test("ctx.sendResponse returns plain text", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.sendResponse(200, "hello-ctx");
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-ctx");
    srv.close();
  });

  test("ctx.json sets Content-Type header", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.json(200, JSON.stringify({ ok: true }));
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
    srv.close();
  });

  test("ctx.sendResponseData with custom headers", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.sendResponseData({ status: 200, headers: { "x-custom": "yes" }, body: "ok" });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe("ok");
    srv.close();
  });

  test("ctx.set / ctx.get state persists within request", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.set("hello", "world");
      ctx.set("count", "42");
      expect(ctx.get("hello")).toBe("world");
      expect(ctx.get("count")).toBe("42");
      expect(ctx.get("missing")).toBeNull();
      ctx.sendResponse(200, `${ctx.get("hello")}-${ctx.get("count")}`);
    });
    await srv.listen(p);
    const text = await (await get(p, "/")).text();
    expect(text).toBe("world-42");
    srv.close();
  });

  test("ctx.next() + useRouter triggers route match", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/hello", "sayHello");
    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      ctx.next();
      const handlerId = ctx.matchedHandler();
      ctx.sendResponse(handlerId ? 200 : 404, handlerId || "no-match");
    });
    await srv.listen(p);
    expect(await (await get(p, "/hello")).text()).toBe("sayHello");
    expect((await get(p, "/nope")).status).toBe(404);
    expect(await (await get(p, "/nope")).text()).toBe("no-match");
    srv.close();
  });

  test("ctx.next() populates params for :param routes", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/users/:id", "getUser");
    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      ctx.next();
      ctx.json(ctx.matchedHandler() ? 200 : 404, JSON.stringify({
        handler: ctx.matchedHandler(),
        params: ctx.params(),
      }));
    });
    await srv.listen(p);
    const res = await get(p, "/users/42");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handler).toBe("getUser");
    expect(body.params.id).toBe("42");
    srv.close();
  });

  test("ctx.next() with wildcard *path routes", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/files/*path", "serveFile");
    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      ctx.next();
      ctx.sendResponse(200, ctx.params().path || "");
    });
    await srv.listen(p);
    expect(await (await get(p, "/files/a/b/c.txt")).text()).toBe("a/b/c.txt");
    srv.close();
  });

  test("ctx.isHandled reflects response sent", async () => {
    const p = await findFreePort();
    let before = false, after = false;
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      before = ctx.isHandled();
      ctx.sendResponse(200, "done");
      after = ctx.isHandled();
    });
    await srv.listen(p);
    expect((await get(p, "/")).status).toBe(200);
    expect(before).toBe(false);
    expect(after).toBe(true);
    srv.close();
  });

  test("getRequest returns correct request data", async () => {
    const p = await findFreePort();
    let method = "";
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      method = ctx.getRequest().method;
      ctx.sendResponse(200, "ok");
    });
    await srv.listen(p);
    await post(p, "/test", "{}");
    await new Promise((r) => setTimeout(r, 200));
    expect(method).toBe("POST");
    srv.close();
  });

  test("custom status 500", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.sendResponse(500, "internal error");
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
    srv.close();
  });

  test("status 204 with empty body", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.use((ctx: Context) => {
      ctx.sendResponse(204, "");
    });
    await srv.listen(p);
    expect((await get(p, "/")).status).toBe(204);
    srv.close();
  });
});

// ===========================================================================
// ROUTER + SERVER INTEGRATION (context mode)
// ===========================================================================

describe("HTTP: Router + Context mode integration", () => {

  test("full CRUD lifecycle", async () => {
    const p = await findFreePort();
    const router = new Router();
    const db: Record<string, { name: string }> = {};

    router.get("/todos",     "listTodos");
    router.get("/todos/:id", "getTodo");
    router.post("/todos",    "createTodo");
    router.put("/todos/:id", "updateTodo");
    router.delete("/todos/:id", "deleteTodo");

    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      const body = ctx.getRequest().body || "{}";
      ctx.next();
      const h = ctx.matchedHandler();
      const p = ctx.params();
      if (!h) { ctx.sendResponse(404, "not found"); return; }
      switch (h) {
        case "listTodos": {
          const items = Object.entries(db).map(([id, v]) => ({ id, ...v }));
          ctx.json(200, JSON.stringify(items));
          return;
        }
        case "getTodo": {
          const item = db[p.id];
          ctx.json(item ? 200 : 404, JSON.stringify(item ? { id: p.id, ...item } : { error: "not found" }));
          return;
        }
        case "createTodo": {
          const data = JSON.parse(body);
          const id = crypto.randomUUID();
          db[id] = { name: data.name };
          ctx.json(201, JSON.stringify({ id, ...db[id] }));
          return;
        }
        case "updateTodo": {
          if (!db[p.id]) { ctx.sendResponse(404, "NF"); return; }
          const data = JSON.parse(body);
          db[p.id] = { name: data.name };
          ctx.json(200, JSON.stringify({ id: p.id, ...db[p.id] }));
          return;
        }
        case "deleteTodo": {
          const existed = !!db[p.id];
          if (existed) delete db[p.id];
          ctx.sendResponse(existed ? 200 : 404, existed ? "deleted" : "NF");
          return;
        }
        default:
          ctx.sendResponse(500, "unknown");
      }
    });
    await srv.listen(p);

    // CREATE
    let res = await post(p, "/todos", JSON.stringify({ name: "learn rust" }));
    expect(res.status).toBe(201);
    const created: any = await res.json();
    const id = created.id;

    // LIST
    res = await get(p, "/todos");
    expect((await res.json())).toHaveLength(1);

    // READ
    res = await get(p, `/todos/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(id);

    // UPDATE
    res = await fetch(`http://localhost:${p}/todos/${id}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "master rust" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("master rust");

    // DELETE
    res = await fetch(`http://localhost:${p}/todos/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("deleted");

    // READ deleted
    res = await get(p, `/todos/${id}`);
    expect(res.status).toBe(404);

    srv.close();
  });

  test("static + param + wildcard routes coexist", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/", "root");
    router.get("/users/:id", "getUser");
    router.get("/files/*path", "serveFile");

    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      ctx.next();
      const h = ctx.matchedHandler();
      const params = ctx.params();
      ctx.json(h ? 200 : 404, JSON.stringify({ handler: h, params }));
    });
    await srv.listen(p);

    let body: any = await (await get(p, "/")).json();
    expect(body.handler).toBe("root");

    body = await (await get(p, "/users/7")).json();
    expect(body.handler).toBe("getUser");
    expect(body.params.id).toBe("7");

    body = await (await get(p, "/x/y/z.md")).json();
    expect(body.handler).toBe("serveFile");
    expect(body.params.path).toBe("x/y/z.md");

    expect((await get(p, "/nope")).status).toBe(404);
    srv.close();
  });

  test("multiple HTTP methods on same path", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/resource", "getResource");
    router.post("/resource", "createResource");
    router.delete("/resource", "deleteResource");

    const srv = new HttpServer();
    srv.useRouter(router);
    srv.use((ctx: Context) => {
      ctx.next();
      const h = ctx.matchedHandler();
      ctx.sendResponse(h ? 200 : 404, h || "missing");
    });
    await srv.listen(p);

    expect((await get(p, "/resource")).status).toBe(200);
    expect(await (await get(p, "/resource")).text()).toBe("getResource");
    expect((await post(p, "/resource", "{}")).status).toBe(200);
    expect(await (await post(p, "/resource", "{}")).text()).toBe("createResource");

    const del = await fetch(`http://localhost:${p}/resource`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.text()).toBe("deleteResource");

    const put = await fetch(`http://localhost:${p}/resource`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(404);
    srv.close();
  });
});

// ===========================================================================
// ERROR / EDGE CASES
// ===========================================================================

describe("HTTP: Error / edge cases", () => {

  test("listen() fails when no handler is registered", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    try {
      await srv.listen(p);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("No handler registered");
    }
  });

  test("server can restart on same port after close", async () => {
    const p = await findFreePort();

    const srv1 = new HttpServer();
    srv1.onRequest((req) => srv1.sendResponse(req.requestId, { status: 200, headers: {}, body: "first" }));
    await srv1.listen(p);
    expect(await (await get(p, "/")).text()).toBe("first");
    srv1.close();
    await new Promise((r) => setTimeout(r, 200));

    const srv2 = new HttpServer();
    srv2.onRequest((req) => srv2.sendResponse(req.requestId, { status: 200, headers: {}, body: "second" }));
    await srv2.listen(p);
    expect(await (await get(p, "/")).text()).toBe("second");
    srv2.close();
  });
});
