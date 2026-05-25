import { describe, expect, it } from "bun:test";
import { Router } from "../router";

describe("Router.onError()", () => {
  it("returns router for chaining", () => {
    const router = new Router();
    const result = router.onError((err, { req, res }) => {
      res.status(500).send("error");
    });
    expect(result).toBe(router);
  });

  it("catches sync errors in handlers", async () => {
    const router = new Router();
    router.onError((err, { req, res }) => {
      res.status(500).send(`caught: ${err.message}`);
    });
    router.get("/test", () => {
      throw new Error("sync error");
    });
    const res = await router.request("http://localhost/test");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught: sync error");
  });

  it("catches async errors in handlers", async () => {
    const router = new Router();
    router.onError((err, { req, res }) => {
      res.status(500).send(`caught: ${err.message}`);
    });
    router.get("/test", async () => {
      throw new Error("async error");
    });
    const res = await router.request("http://localhost/test");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught: async error");
  });

  it("returns 500 when no error handler is set and sync error occurs", async () => {
    const router = new Router();
    router.get("/test", () => {
      throw new Error("unhandled");
    });
    const res = await router.request("http://localhost/test");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("returns 500 when no error handler is set and async error occurs", async () => {
    const router = new Router();
    router.get("/test", async () => {
      throw new Error("unhandled async");
    });
    const res = await router.request("http://localhost/test");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("error handler receives the request object", async () => {
    const router = new Router();
    let receivedPath = "";
    router.onError((err, { req, res }) => {
      receivedPath = req.path;
      res.status(500).send("ok");
    });
    router.get("/myroute", () => {
      throw new Error("test");
    });
    await router.request("http://localhost/myroute");
    expect(receivedPath).toBe("/myroute");
  });

  it("error handler can set custom headers", async () => {
    const router = new Router();
    router.onError((err, { req, res }) => {
      res.setHeader("X-Error", "true");
      res.status(500).send("error");
    });
    router.get("/test", () => { throw new Error("test"); });
    const res = await router.request("http://localhost/test");
    expect(res.headers.get("X-Error")).toBe("true");
  });

  it("multiple error handlers - last one wins", async () => {
    const router = new Router();
    router.onError((err, { req, res }) => {
      res.status(500).send("first");
    });
    router.onError((err, { req, res }) => {
      res.status(500).send("second");
    });
    router.get("/test", () => { throw new Error("test"); });
    const res = await router.request("http://localhost/test");
    expect(await res.text()).toBe("second");
  });
});
