import { expect, test, describe } from "bun:test";
import { HttpServer, WsEvent } from "../index";

// --------------- helpers ---------------

async function findFreePort(start = 19200): Promise<number> {
  const { createServer } = await import("node:net");
  for (let p = start; p < start + 200; p++) {
    try {
      const srv = createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(p, () => { srv.close(); resolve(); });
      });
      return p;
    } catch { continue; }
  }
  throw new Error("no free ws port");
}

function bootWs(
  port: number,
  onWSEvent: (e: WsEvent) => void,
): Promise<HttpServer> {
  const srv = new HttpServer();
  srv.onWsEvent(onWSEvent);
  return srv.listen(port).then(() => srv);
}

function waitForEvent(
  onWSEvent: (e: WsEvent) => void,
  filter: (e: WsEvent) => boolean,
  timeout = 4_000,
): Promise<WsEvent> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ eventType: "timeout" } as any), timeout);
    const handler = (e: WsEvent) => {
      clearTimeout(timer);
      if (filter(e)) resolve(e);
    };
    // @ts-ignore — we only need a single-use handler per test call
    onWSEvent.__handler = handler;
    onWSEvent(handler);
  });
}

// --------------- tests ---------------

describe("WebSocket Server", () => {
  test("connection triggers open event", async () => {
    const p = await findFreePort();
    const openPromise = new Promise<WsEvent>((resolve) => {
      const srv = new HttpServer();
      srv.onWsEvent((e) => { if (e.eventType === "open") resolve(e); });
      srv.listen(p);
    });
    const ws = new WebSocket(`ws://localhost:${p}/`);
    const event = await Promise.race([openPromise, Bun.sleep(3_000).then(() => ({ eventType: "timeout" } as any))]);
    expect(event.eventType).toBe("open");
    expect(event.connectionId).toBeTruthy();
    ws.close();
  });

  test("echo messages", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => {
      if (e.eventType === "message" && e.text) srv.wsSend(e.connectionId, `echo:${e.text}`);
    });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    await new Promise((r) => { ws.onopen = r; });

    const reply = new Promise<string>((res) => { ws.onmessage = (e: MessageEvent) => res(e.data as string); });
    ws.send("hello");
    const result = await Promise.race([reply, Bun.sleep(3_000).then(() => "TIMEOUT")]);
    expect(result).toBe("echo:hello");

    ws.close();
  });

  test("sequential messages on same connection", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => {
      if (e.eventType === "message" && e.text) srv.wsSend(e.connectionId, `pong:${e.text}`);
    });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    await new Promise((r) => { ws.onopen = r; });

    const results: string[] = [];
    for (const m of ["a", "b", "c"]) {
      const p = new Promise<string>((res) => { ws.onmessage = (e: MessageEvent) => res(e.data as string); });
      ws.send(m);
      results.push(await Promise.race([p, Bun.sleep(2_000).then(() => "T")]));
    }
    expect(results).toEqual(["pong:a", "pong:b", "pong:c"]);
    ws.close();
  });

  test("wsClose terminates the connection", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => { if (e.eventType === "open") srv.wsClose(e.connectionId); });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    const closed = new Promise<string>((res) => { ws.onclose = () => res("CLOSED"); });
    const result = await Promise.race([closed, Bun.sleep(3_000).then(() => "T")]);
    expect(result).toBe("CLOSED");
  });

  test("ws_connection_count reflects active connections", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => {
      if (e.eventType === "open") srv.wsSend(e.connectionId, `welcome:${e.connectionId}`);
    });
    await srv.listen(p);

    const [c1, c2]: string[] = await Promise.all([
      new Promise<string>((res) => {
        const ws = new WebSocket(`ws://localhost:${p}/`);
        ws.onmessage = (e: MessageEvent) => res(e.data as string);
      }),
      new Promise<string>((res) => {
        const ws = new WebSocket(`ws://localhost:${p}/`);
        ws.onmessage = (e: MessageEvent) => res(e.data as string);
      }),
    ]);

    await new Promise((r) => setTimeout(r, 300));
    expect(srv.wsConnectionCount()).toBeGreaterThanOrEqual(1);

    expect(c1).toContain("welcome:");
    expect(c2).toContain("welcome:");
  });

  test("ws_send_binary sends binary message", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => {
      if (e.eventType === "message" && e.binary) srv.wsSendBinary(e.connectionId, Buffer.from(`reply:${e.binary.length}`));
    });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    await new Promise((r) => { ws.onopen = r; });

    const reply = new Promise<string>((res) => { ws.onmessage = (e: MessageEvent) => res(e.data as string); });
    ws.send(Buffer.from([0xAB, 0xCD]));
    const r = await Promise.race([reply, Bun.sleep(3_000).then(() => "T")]);
    expect(r).toBe("reply:2");
    ws.close();
  });

  test("close event fires when client disconnects", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    let closeFired = false;
    srv.onWsEvent((e) => {
      if (e.eventType === "close") closeFired = true;
    });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    await new Promise((r) => { ws.onopen = r; });
    ws.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(closeFired).toBe(true);
  });

  test("wsConnectionIds lists active connections", async () => {
    const p = await findFreePort();
    const srv = new HttpServer();
    srv.onWsEvent((e) => { if (e.eventType === "open") srv.wsSend(e.connectionId, "hi"); });
    await srv.listen(p);

    const ws = new WebSocket(`ws://localhost:${p}/`);
    await new Promise((r) => { ws.onopen = r; });

    await new Promise((r) => setTimeout(r, 300));
    expect(srv.wsConnectionIds().length).toBeGreaterThanOrEqual(1);
    expect(srv.wsConnectionIds()[0]).toBeTruthy();

    ws.close();
  });
});
