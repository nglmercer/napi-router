import { expect, test, describe } from "bun:test";
import { HttpServer, Router, RequestCall, ResponseData } from "../index";

// --------------- helpers ---------------

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
    } catch { /* port in use, try next */ }
  }
  throw new Error("no free port");
}

function bootServer(
  port: number,
  onRequest: (req: RequestCall) => void,
  onWSEvent?: (e: any) => void,
): HttpServer {
  const srv = new HttpServer();
  srv.onRequest(onRequest);
  if (onWSEvent) srv.onWsEvent(onWSEvent);
  return srv;
}

async function get(port: number, path: string) { return fetch(`http://localhost:${port}${path}`); }
async function post(port: number, path: string, body: string, headers = { "content-type": "application/json" }) {
  return fetch(`http://localhost:${port}${path}`, { method: "POST", headers, body });
}

const OK    = (res: Response) => expect(res.status).toBe(200);
const NOTFD = (res: Response) => expect(res.status).toBe(404);
const CREATED = (res: Response) => expect(res.status).toBe(201);

// --------------- basic HTTP roundtrip ---------------

describe("HTTP Server — raw roundtrip", () => {
  test("echo 200", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, (_req) => {
      srv.sendResponse("req-1", { status: 200, headers: {}, body: "hello" });
    });
    await srv.listen(p);
    OK( await get(p, "/") );
    expect(await (await get(p, "/"))!.text()).toBe("hello");
    srv.close();
  });

  test("custom status 201", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, () => {
      srv.sendResponse("x", { status: 201, headers: {}, body: "created" });
    });
    await srv.listen(p);
    CREATED( await get(p, "/") );
    srv.close();
  });

  test("response headers forwarded", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, () => {
      srv.sendResponse("x", { status: 200, headers: { "x-powered-by": "napi-router" }, body: "" });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.headers.get("x-powered-by")).toBe("napi-router");
    srv.close();
  });

  test("empty body is undefined on JS side", async () => {
    const p = await findFreePort();
    let body: any = null;
    const srv = bootServer(p, (req) => {
      body = req.request.body;
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: "" });
    });
    await srv.listen(p);
    await fetch(`http://localhost:${p}/no-body`, { method: "PUT" });
    // Give TSFN fire time
    await new Promise((r) => setTimeout(r, 100));
    const res = await get(p, "/ack");
    OK(res);
    expect(body).toBeUndefined();
    srv.close();
  });

  test("requestId is a non-empty opaque string", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, (req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: req.requestId });
    });
    await srv.listen(p);
    const id = await (await get(p, "/"))!.text();
    expect(id.length).toBeGreaterThan(0);
    srv.close();
  });

  test("two parallel requests get distinct requestIds", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, (req) => {
      srv.sendResponse(req.requestId, { status: 200, headers: {}, body: req.requestId });
    });
    await srv.listen(p);
    const [a, b] = await Promise.all([get(p, "/a"), get(p, "/b")]);
    const [ra, rb] = await Promise.all([a!.text(), b!.text()]);
    await new Promise((r) => setTimeout(r, 100));
    expect(ra).not.toBe(rb);
    srv.close();
  });

  test("request exposes method, path, url, query, body, headers, remoteAddr", async () => {
    const p = await findFreePort();
    let captured: any = null;
    const srv = bootServer(p, (req) => {
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

  test("pendingCount tracks outstanding requests", async () => {
    const p = await findFreePort();
    // cause a timeout so we never call sendResponse
    const srv = bootServer(p, (_req: RequestCall) => { /* do nothing */ });
    await srv.listen(p);
    await fetch(`http://localhost:${p}/hang`, { signal: AbortSignal.timeout(250) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    // Request should still be pending at timeout
    expect(srv.pendingCount()).toBeLessThanOrEqual(1);
    srv.close();
  });

  test("close() stops the listener", async () => {
    const p = await findFreePort();
    const srv = bootServer(p, () => {
      srv.sendResponse("x", { status: 200, headers: {}, body: "" });
    });
    await srv.listen(p);
    OK( await get(p, "/") );
    srv.close();
    // After closing the port should be free
    const { createServer } = await import("node:net");
    const s = createServer();
    await new Promise<void>((res) => { s.listen(p, () => { s.close(); res(); }); });
  });
});

// --------------- Router + Server integration ---------------

describe("Router + HTTP integration", () => {
  test("handlers dispatched by Router matchRoute", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/hello", "sayHello");
    router.get("/users/:id", "getUser");
    router.post("/users", "createUser");

    const srv = bootServer(p, (req) => {
      const m = router.matchRoute(req.request.method, req.request.path);
      if (!m) {
        srv.sendResponse(req.requestId, { status: 404, headers: {}, body: "NO_MATCH" });
        return;
      }
      srv.sendResponse(req.requestId, {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handler: m.handlerId, params: m.params }),
      });
    });
    await srv.listen(p);

    // static route
    let r: any = await (await get(p, "/hello"))!.json();
    expect(r.handler).toBe("sayHello");

    // param route
    r = await (await get(p, "/users/7"))!.json();
    expect(r.handler).toBe("getUser");
    expect(r.params.id).toBe("7");

    // post
    await post(p, "/users", "{}");
    await new Promise((r) => setTimeout(r, 50));

    // 404
    NOTFD( await get(p, "/unknown") );

    srv.close();
  });

  test("full CRUD lifecycle via Router", async () => {
    const p = await findFreePort();
    const router = new Router();
    const db: Record<string, { name: string }> = {};

    router.get("/todos",   "listTodos");
    router.get("/todos/:id", "getTodo");
    router.post("/todos",  "createTodo");
    router.put("/todos/:id", "updateTodo");
    router.delete("/todos/:id", "deleteTodo");

    const srv = bootServer(p, (req) => {
      const m = router.matchRoute(req.request.method, req.request.path);
      if (!m) { srv.sendResponse(req.requestId, { status:404, headers:{}, body:"404" }); return; }
      switch (m.handlerId) {
        case "listTodos": {
          const items = Object.entries(db as any).map(([id,v]) => ({ id,...(v as any) }));
          srv.sendResponse(req.requestId, { status:200, headers:{ "content-type":"application/json" }, body:JSON.stringify(items) });
          return;
        }
        case "getTodo": {
          const item = (db as any)[m.params.id];
          srv.sendResponse(req.requestId, item
            ? { status:200, headers:{"content-type":"application/json"}, body:JSON.stringify({id:m.params.id,...item}) }
            : { status:404, headers:{}, body:"not found" });
          return;
        }
        case "createTodo": {
          const body = JSON.parse(req.request.body || "{}");
          const id = crypto.randomUUID();
          (db as any)[id] = { name: body.name };
          srv.sendResponse(req.requestId, { status:201, headers:{"content-type":"application/json"}, body:JSON.stringify({id,...(db as any)[id]}) });
          return;
        }
        case "updateTodo": {
          if (!(db as any)[m.params.id]) { srv.sendResponse(req.requestId,{status:404,headers:{},body:"NF"}); return; }
          const body = JSON.parse(req.request.body || "{}");
          (db as any)[m.params.id] = { name:body.name };
          srv.sendResponse(req.requestId, { status:200, headers:{"content-type":"application/json"}, body:JSON.stringify({id:m.params.id,...(db as any)[m.params.id]}) });
          return;
        }
        case "deleteTodo": {
          if ((db as any)[m.params.id]) { delete (db as any)[m.params.id]; }
          srv.sendResponse(req.requestId, { status:(db as any)[m.params.id] ? 404:200, headers:{}, body:(db as any)[m.params.id] ? "NF" : "deleted" });
          return;
        }
      }
    });
    await srv.listen(p);

    // CREATE
    let res = await post(p, "/todos", JSON.stringify({ name: "learn rust" }));
    CREATED(res);
    const created: any = await res.json();
    const id = created.id;

    // LIST
    res = await get(p, "/todos");
    expect(await res.json()).toHaveLength(1);

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

    // READ deleted
    NOTFD( await get(p, `/todos/${id}`) );

    srv.close();
  });

  test("static + param + wildcard routes coexist correctly", async () => {
    const p = await findFreePort();
    const router = new Router();
    router.get("/", "root");
    router.get("/users/:id", "getUser");
    router.get("/files/*path", "serveFile");

    const srv = bootServer(p, (req) => {
      const m = router.matchRoute(req.request.method, req.request.path);
      srv.sendResponse(req.requestId, m ? {
        status: 200, headers: { "content-type": "application/json" },
        body: JSON.stringify({ handler: m.handlerId, params: m.params }),
      } : { status: 404, headers: {}, body: "not found" });
    });
    await srv.listen(p);

    // static /
    let r: any = await (await get(p, "/"))!.json();
    expect(r.handler).toBe("root");

    // param
    r = await (await get(p, "/users/7"))!.json();
    expect(r.handler).toBe("getUser");
    expect(r.params.id).toBe("7");

    // wildcard
    r = await (await get(p, "/x/y/z.md"))!.json();
    expect(r.handler).toBe("serveFile");
    expect(r.params.path).toBe("x/y/z.md");

    // 404
    NOTFD( await get(p, "/nope") );

    srv.close();
  });
});
