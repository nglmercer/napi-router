import { expect, test, describe } from "bun:test";
import { HttpServer } from "../index";

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ===========================================================================
// HTTP SERVER TESTS
// ===========================================================================

describe("HTTP: Basic Request/Response", () => {

  test("echo 200", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 200, headers: {}, body: Array.from(encoder.encode("hello")) });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    await srv.close();
  });

  test("custom status 201", async () => {
    const p = await findFreePort(19150);
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 201, headers: {}, body: Array.from(encoder.encode("created")) });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("created");
    await srv.close();
  });

  test("response headers forwarded", async () => {
    const p = await findFreePort(19170);
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 200, headers: { "x-powered-by": "napi-router" }, body: [] });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    expect(res.headers.get("x-powered-by")).toBe("napi-router");
    await srv.close();
  });

  test("requestId non-empty string", async () => {
    const p = await findFreePort(19190);
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 200, headers: {}, body: Array.from(encoder.encode(r.requestId)) });
    });
    await srv.listen(p);
    const res = await get(p, "/");
    const id = await res.text();
    expect(id.length).toBeGreaterThan(0);
    await srv.close();
  });

  test("parallel requests get distinct ids", async () => {
    const p = await findFreePort(19200);
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 200, headers: {}, body: Array.from(encoder.encode(r.requestId)) });
    });
    await srv.listen(p);
    const [ra, rb] = await Promise.all([
      get(p, "/a").then(r => r.text()),
      get(p, "/b").then(r => r.text()),
    ]);
    expect(ra).not.toBe(rb);
    await srv.close();
  });

  test("request exposes method/path/url/query/body/headers/remoteAddr", async () => {
    const p = await findFreePort(19300);
    let captured: any = null;
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      captured = r.request;
      srv.sendResponse(r.requestId, { status: 200, headers: {}, body: Array.from(encoder.encode("ok")) });
    });
    await srv.listen(p);
    await post(p, "/search?q=rust&page=1", JSON.stringify({ key: "val" }), {
      "content-type": "application/json",
      "x-trace": "xyz",
    });

    let attempts = 0;
    while (!captured && attempts < 20) {
      await new Promise(r => setTimeout(r, 50));
      attempts++;
    }

    expect(captured).not.toBeNull();
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe("/search");
    expect(captured.url).toContain("http://localhost");
    expect(captured.url).toContain("q=rust");
    expect(captured.query.q).toBe("rust");
    expect(captured.query.page).toBe("1");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["x-trace"]).toBe("xyz");
    expect(JSON.parse(decoder.decode(new Uint8Array(captured.body)))).toEqual({ key: "val" });
    expect(captured.remoteAddr).toBeTruthy();
    await srv.close();
  });

  test("close() stops the listener", async () => {
    const p = await findFreePort(19400);
    const srv = new HttpServer();
    srv.onRequest((reqs: any) => {
      const r = reqs[0];
      srv.sendResponse(r.requestId, { status: 200, headers: {}, body: [] });
    });
    await srv.listen(p);
    expect((await get(p, "/")).status).toBe(200);
    await srv.close();
    const { createServer } = await import("node:net");
    const s = createServer();
    await new Promise<void>((res) => { s.listen(p, () => { s.close(); res(); }); });
  });
});
