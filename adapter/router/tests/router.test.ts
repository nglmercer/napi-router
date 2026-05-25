import { describe, test, expect } from "bun:test"
import { Router } from "../router"
import type { RequestMiddleware } from "../types"
import { HttpMethod } from "../method"

describe("Router", () => {
  test("initializes with empty routes", () => {
    const router = new Router()
    expect(router.routes).toEqual([])
  })

  test("handle property is a function", () => {
    const router = new Router()
    expect(typeof router.handle).toBe("function")
  })

  test("request method sends request to router", async () => {
    const router = new Router()
    router.get("/test", (ctx) => { ctx.res.send("hello") })
    const res = await router.request("http://localhost/test")
    expect(await res.text()).toBe("hello")
  })

  test("use method adds middleware", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.use("GET", "/test", handler)
    expect(router.routes.length).toBe(1)
    expect(router.routes[0].method).toBe(HttpMethod.GET)
  })

  test("use with * method adds ALL route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.use("*", "/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.ALL)
  })

  test("get method adds GET route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.get("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.GET)
  })

  test("get with multiple handlers", () => {
    const router = new Router()
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    router.get("/test", handler1, handler2)
    expect(router.routes.length).toBe(1)
  })

  test("post method adds POST route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.post("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.POST)
  })

  test("put method adds PUT route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.put("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.PUT)
  })

  test("delete method adds DELETE route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.delete("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.DELETE)
  })

  test("patch method adds PATCH route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.patch("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.PATCH)
  })

  test("trace method adds TRACE route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.trace("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.TRACE)
  })

  test("head method adds HEAD route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.head("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.HEAD)
  })

  test("connect method adds CONNECT route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.connect("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.CONNECT)
  })

  test("options method adds OPTIONS route", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    router.options("/test", handler)
    expect(router.routes[0].method).toBe(HttpMethod.OPTIONS)
  })

  test("ws method adds websocket route", () => {
    const router = new Router()
    router.ws("/ws")
    expect(router.routes.length).toBe(1)
    expect(router.routes[0].method).toBe(HttpMethod.GET)
  })

  test("redirect method adds redirect route", () => {
    const router = new Router()
    router.redirect("GET", "/old", "/new")
    expect(router.routes.length).toBe(1)
  })

  test("redirect with permanent flag", () => {
    const router = new Router()
    router.redirect("GET", "/old", "/new", true)
    expect(router.routes.length).toBe(1)
  })

  test("static method adds static files route", () => {
    const router = new Router()
    const tmpDir = "/tmp/opencode-test-static"
    const fs = require("fs")
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir)
    router.static("/static", tmpDir)
    expect(router.routes.length).toBeGreaterThanOrEqual(1)
  })

  test("cookies method adds cookie parsing route", () => {
    const router = new Router()
    router.cookies("GET", "/", true)
    expect(router.routes.length).toBe(1)
  })

  test("cookies with autoResponseHeaders false", () => {
    const router = new Router()
    router.cookies("GET", "/", false)
    expect(router.routes.length).toBe(1)
  })

  test("dump method returns string", () => {
    const router = new Router()
    router.get("/test", ({ req, res }) => { res.send("test") })
    const dump = router.dump()
    expect(typeof dump).toBe("string")
  })

  test("mergeHandlers property is true by default", () => {
    const router = new Router()
    expect(router.mergeHandlers).toBe(true)
  })

  test("chaining methods return router instance", () => {
    const router = new Router()
    const handler: RequestMiddleware = () => { }
    expect(router.get("/1", handler)).toBe(router)
    expect(router.post("/2", handler)).toBe(router)
    expect(router.put("/3", handler)).toBe(router)
    expect(router.delete("/4", handler)).toBe(router)
    expect(router.patch("/5", handler)).toBe(router)
    expect(router.trace("/6", handler)).toBe(router)
    expect(router.head("/7", handler)).toBe(router)
    expect(router.connect("/8", handler)).toBe(router)
    expect(router.options("/9", handler)).toBe(router)
  })

  test("request with POST method", async () => {
    const router = new Router()
    router.post("/test", ({ req, res }) => { res.send("posted") })
    const res = await router.request("http://localhost/test", { method: "POST" })
    expect(await res.text()).toBe("posted")
  })

  test("request returns 404 for unmatched route", async () => {
    const router = new Router()
    const res = await router.request("http://localhost/nonexistent")
    expect(res.status).toBe(404)
  })

  test("static method throws on non-directory target", () => {
    expect(() => {
      const router = new Router()
      router.static("/static", "/nonexistent/path/12345")
    }).toThrow("static target is not a directory")
  })
})
