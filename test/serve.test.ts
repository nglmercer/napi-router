import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { serve, trySterve } from "../index.js";

let server: ReturnType<typeof serve>;
const port = 9876;

describe("napi-router serve()", () => {
  before(async () => {
    server = await serve({
      port,
      hostname: "0.0.0.0",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/hello") {
          return new Response("Hello World", {
            headers: { "content-type": "text/plain" },
          });
        }
        if (url.pathname === "/json") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/echo" && req.method === "POST") {
          const body = await req.text();
          return new Response(body, {
            headers: { "content-type": "text/plain" },
          });
        }
        if (url.pathname === "/headers") {
          const auth = req.headers.get("authorization");
          return new Response(auth || "none", {
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  after(() => {
    server.stop();
  });

  it("should respond to GET /hello", async () => {
    const res = await fetch(`http://localhost:${port}/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Hello World");
  });

  it("should respond with JSON", async () => {
    const res = await fetch(`http://localhost:${port}/json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it("should echo POST body", async () => {
    const res = await fetch(`http://localhost:${port}/echo`, {
      method: "POST",
      body: "test body",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "test body");
  });

  it("should forward headers", async () => {
    const res = await fetch(`http://localhost:${port}/headers`, {
      headers: { authorization: "Bearer token123" },
    });
    assert.equal(await res.text(), "Bearer token123");
  });

  it("should return 404 for unknown routes", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    assert.equal(res.status, 404);
  });

  it("should support server.pendingRequests", () => {
    assert.equal(typeof server.pendingRequests, "number");
  });

  it("should support server.stop()", async () => {
    const s = await serve({
      port: 9877,
      fetch() {
        return new Response("ok");
      },
    });
    s.stop();
    // After stop, new connections should fail
    await assert.rejects(() => fetch(`http://localhost:9877/`));
  });
});

describe("WebSocket", () => {
  let wsServer;
  const wsPort = 9878;

  before(async () => {
    wsServer = await serve({
      port: wsPort,
      hostname: "0.0.0.0",
      websocket: {
        message(ws, message) {
          ws.send(`echo: ${message}`);
        },
      },
      fetch(req) {
        return new Response("WS server", { status: 200 });
      },
    });
  });

  after(() => {
    wsServer.stop();
  });

  it("should upgrade and echo text messages", async () => {
    const ws = new WebSocket(`ws://localhost:${wsPort}/ws`);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.send("hello");
    const data = await new Promise((resolve) => {
      ws.onmessage = (event) => resolve(event.data);
    });

    assert.strictEqual(data, "echo: hello");
    ws.close();
  });

  it("should handle concurrent connections", async () => {
    const ws1 = new WebSocket(`ws://localhost:${wsPort}/ws`);
    const ws2 = new WebSocket(`ws://localhost:${wsPort}/ws`);

    await Promise.all([
      new Promise((r) => (ws1.onopen = r)),
      new Promise((r) => (ws2.onopen = r)),
    ]);

    ws1.send("ping1");
    ws2.send("ping2");

    const [r1, r2] = await Promise.all([
      new Promise((r) => (ws1.onmessage = (e) => r(e.data))),
      new Promise((r) => (ws2.onmessage = (e) => r(e.data))),
    ]);

    assert.strictEqual(r1, "echo: ping1");
    assert.strictEqual(r2, "echo: ping2");

    ws1.close();
    ws2.close();
  });

  it("should handle connection close", async () => {
    const ws = new WebSocket(`ws://localhost:${wsPort}/ws`);
    await new Promise((r) => (ws.onopen = r));

    const closePromise = new Promise((resolve) => {
      ws.onclose = (event) =>
        resolve({ code: event.code, reason: event.reason });
    });

    ws.close(1000, "bye");
    const result = await closePromise;

    assert.ok(result);
    ws.close();
  });
});

describe("Error handling", () => {
  it("should reject when port is already in use", async () => {
    const s = await serve({
      port: 9880,
      fetch() {
        return new Response("first");
      },
    });
    try {
      await assert.rejects(
        () =>
          serve({
            port: 9880,
            fetch() {
              return new Response("second");
            },
          }),
        /Failed to bind|address already in use/i,
      );
    } finally {
      s.stop();
    }
  });

  it("tryServe returns error object instead of throwing", async () => {
    const s = await serve({
      port: 9881,
      fetch() {
        return new Response("ok");
      },
    });
    try {
      const { server, error } = await tryServe({
        port: 9881,
        fetch() {
          return new Response("conflict");
        },
      });
      assert.equal(server, null);
      assert.ok(error);
      assert.ok(error.message.match(/Failed to bind|address already in use/i));
    } finally {
      s.stop();
    }
  });

  it("tryServe returns server on success", async () => {
    const { server, error } = await tryServe({
      port: 9882,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      },
    });
    assert.ok(server);
    assert.equal(error, null);
    const res = await fetch(`http://127.0.0.1:9882/`);
    assert.equal(await res.text(), "ok");
    server.stop();
  });

  it("should handle errors thrown in fetch handler", async () => {
    const s = await serve({
      port: 9883,
      fetch() {
        throw new Error("handler crash");
      },
    });
    try {
      const res = await fetch(`http://localhost:9883/`);
      assert.equal(res.status, 500);
    } finally {
      s.stop();
    }
  });
});

describe("Lifecycle", () => {
  it("should allow stop to be called multiple times", async () => {
    const s = await serve({
      port: 9884,
      fetch() {
        return new Response("ok");
      },
    });
    s.stop();
    s.stop();
    s.stop();
  });

  it("should serve requests via PUT, DELETE, PATCH", async () => {
    const s = await serve({
      port: 9885,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method === "PUT") return new Response("put ok");
        if (req.method === "DELETE") return new Response("delete ok");
        if (req.method === "PATCH") return new Response("patch ok");
        return new Response("unknown", { status: 400 });
      },
    });
    try {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const res = await fetch(`http://127.0.0.1:9885/`, { method });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), `${method.toLowerCase()} ok`);
      }
    } finally {
      s.stop();
    }
  });

  it("should handle large request bodies", async () => {
    const s = await serve({
      port: 9886,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        return new Response(body.length.toString());
      },
    });
    try {
      const largeBody = "x".repeat(100_000);
      const res = await fetch(`http://127.0.0.1:9886/`, {
        method: "POST",
        body: largeBody,
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "100000");
    } finally {
      s.stop();
    }
  });

  it("should send custom response headers", async () => {
    const s = await serve({
      port: 9887,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok", {
          headers: { "x-custom": "value1", "x-another": "value2" },
        });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:9887/`);
      assert.equal(res.headers.get("x-custom"), "value1");
      assert.equal(res.headers.get("x-another"), "value2");
    } finally {
      s.stop();
    }
  });
});
