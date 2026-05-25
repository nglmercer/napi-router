import { describe, expect, it } from "bun:test"
import { Router } from "../router"
import { extractPathParams, getRouteDefinitions, resolveHandlerName } from "../router/dump"
import { splitRoutePath } from "../path"
import { parseHttpMethods } from "../method"
import type { EndpointRoute } from "../types"

describe("extractPathParams", () => {
  it("returns empty array for undefined splitPath", () => {
    expect(extractPathParams(undefined)).toEqual([])
  })

  it("returns empty array for static path with no params", () => {
    expect(extractPathParams(["users", "list"])).toEqual([])
  })

  it("extracts named params", () => {
    const result = extractPathParams(["users", ":id", "posts", ":postId"])
    expect(result).toEqual([
      { name: "id", type: "named", position: 1 },
      { name: "postId", type: "named", position: 3 },
    ])
  })

  it("extracts single wildcard", () => {
    const result = extractPathParams(["files", "*"])
    expect(result).toEqual([
      { name: "_0", type: "wildcard", position: 1 },
    ])
  })

  it("extracts double wildcard", () => {
    const result = extractPathParams(["static", "**"])
    expect(result).toEqual([
      { name: "wild", type: "double-wildcard", position: 1 },
    ])
  })

  it("extracts mixed params with auto-named wildcards", () => {
    const result = extractPathParams(["api", ":version", "*", "*", "**"])
    expect(result).toEqual([
      { name: "version", type: "named", position: 1 },
      { name: "_0", type: "wildcard", position: 2 },
      { name: "_1", type: "wildcard", position: 3 },
      { name: "wild", type: "double-wildcard", position: 4 },
    ])
  })
})

describe("resolveHandlerName", () => {
  it("returns function name for named functions", () => {
    function myHandler() {}
    expect(resolveHandlerName(myHandler)).toBe("myHandler")
  })

  it("returns [anonym] for anonymous functions", () => {
    const fn = () => {}
    Object.defineProperty(fn, "name", { value: "" })
    expect(resolveHandlerName(fn)).toBe("[anonym]")
  })

  it("returns [merged] for merged middlewares", () => {
    const { mergeRequestMiddlewares } = require("../middleware")
    const merged = mergeRequestMiddlewares(() => {}, () => {})
    expect(resolveHandlerName(merged)).toBe("[merged]")
  })
})

describe("getRouteDefinitions", () => {
  it("returns definitions for all routes", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/users/:id"),
        method: parseHttpMethods("GET"),
        handler: function getUser() {},
      },
      {
        splitPath: splitRoutePath("/users"),
        method: parseHttpMethods("POST"),
        handler: function createUser() {},
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs).toHaveLength(2)
    expect(defs[0].method).toBe("GET")
    expect(defs[0].path).toBe("/users/:id")
    expect(defs[0].handlerName).toBe("getUser")
    expect(defs[1].method).toBe("POST")
    expect(defs[1].path).toBe("/users")
  })

  it("deduplicates identical method+path combinations", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/test"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
      {
        splitPath: splitRoutePath("/test"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs).toHaveLength(1)
  })

  it("extracts path params in definitions", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/users/:userId/posts/:postId"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs[0].pathParams).toEqual([
      { name: "userId", type: "named", position: 1 },
      { name: "postId", type: "named", position: 3 },
    ])
  })

  it("includes middleware chain info", () => {
    const { mergeRequestMiddlewares } = require("../middleware")
    const authMiddleware = function auth() {}
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/admin"),
        method: parseHttpMethods("GET"),
        handler: mergeRequestMiddlewares(authMiddleware, function adminHandler() {}),
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs[0].isMerged).toBe(true)
    expect(defs[0].middlewareChain).toHaveLength(2)
    expect(defs[0].middlewareChain[0].name).toBe("auth")
    expect(defs[0].middlewareChain[0].mergedToTop).toBe(true)
    expect(defs[0].middlewareChain[1].name).toBe("adminHandler")
    expect(defs[0].middlewareChain[1].mergedToTop).toBe(false)
  })

  it("includes middlewareName from route", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/api/**"),
        method: parseHttpMethods("*"),
        handler: function corsMiddleware() {},
        middlewareName: "cors",
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs[0].middlewareName).toBe("cors")
  })

  it("handles wildcard and double-wildcard paths", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/files/*"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
      {
        splitPath: splitRoutePath("/static/**"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs[0].path).toBe("/files/*")
    expect(defs[0].pathParams).toEqual([
      { name: "_0", type: "wildcard", position: 1 },
    ])
    expect(defs[1].path).toBe("/static/**")
    expect(defs[1].pathParams).toEqual([
      { name: "wild", type: "double-wildcard", position: 1 },
    ])
  })

  it("handles root path", () => {
    const routes: EndpointRoute[] = [
      {
        splitPath: undefined,
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
    ]
    const defs = getRouteDefinitions(routes)
    expect(defs[0].path).toBe("/")
  })
})

describe("getRouteDefinitions with routeMeta (query params)", () => {
  it("includes queryParams from routeMeta map", () => {
    const routeMeta = new Map<string, { queryParams?: import("../router/dump").QueryParamInfo[] }>()
    routeMeta.set("/search", {
      queryParams: [
        { name: "q", type: "string", required: true, description: "Search query" },
        { name: "limit", type: "integer", required: false, default: 10 },
      ],
    })
    routeMeta.set("/users/:id", {
      queryParams: [{ name: "filter", type: "string", required: false }],
    })

    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/search"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
      {
        splitPath: splitRoutePath("/users/:id"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
      {
        splitPath: splitRoutePath("/static"),
        method: parseHttpMethods("GET"),
        handler: () => {},
      },
    ]

    const defs = getRouteDefinitions(routes, routeMeta)
    const searchDef = defs.find(d => d.path === "/search")
    expect(searchDef?.queryParams).toHaveLength(2)
    expect(searchDef?.queryParams?.[0].name).toBe("q")
    expect(searchDef?.queryParams?.[0].required).toBe(true)
    expect(searchDef?.queryParams?.[1].default).toBe(10)

    const userDef = defs.find(d => d.path === "/users/:id")
    expect(userDef?.queryParams).toHaveLength(1)
    expect(userDef?.queryParams?.[0].name).toBe("filter")

    const staticDef = defs.find(d => d.path === "/static")
    expect(staticDef?.queryParams).toBeUndefined()
  })
})

describe("Router.getRouteDefinitions", () => {
  it("works as router instance method", () => {
    const router = new Router()
    router.get("/users/:id", () => {})
    router.post("/users", () => {})

    const defs = router.getRouteDefinitions()
    expect(defs).toHaveLength(2)
    const getDef = defs.find(d => d.method === "GET")
    expect(getDef).toBeDefined()
    expect(getDef!.path).toBe("/users/:id")
    expect(getDef!.pathParams).toEqual([
      { name: "id", type: "named", position: 1 },
    ])
  })

  it("works with route groups", () => {
    const router = new Router()
    router.group("/api", (r) => {
      r.get("/users", () => {})
      r.get("/users/:id", () => {})
    })

    const defs = router.getRouteDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs[0].path).toBe("/api/users")
    expect(defs[1].path).toBe("/api/users/:id")
  })

  it("includes queryParams from router.describe()", () => {
    const router = new Router()
    router.get("/search", () => {})
    router.get("/users/:id", () => {})
    router.describe("/search", {
      queryParams: [
        { name: "q", type: "string", required: true, description: "Search term" },
        { name: "limit", type: "integer", required: false, default: 20 },
      ],
    })

    const defs = router.getRouteDefinitions()
    const searchDef = defs.find(d => d.path === "/search")
    expect(searchDef?.queryParams).toHaveLength(2)
    expect(searchDef?.queryParams?.[0].name).toBe("q")
    expect(searchDef?.queryParams?.[0].required).toBe(true)
    expect(searchDef?.queryParams?.[1].default).toBe(20)

    const userDef = defs.find(d => d.path === "/users/:id")
    expect(userDef?.queryParams).toBeUndefined()
  })

  it("works with sub-router mounting", () => {
    const sub = new Router()
    sub.get("/items", () => {})
    sub.get("/items/:id", () => {})

    const router = new Router()
    router.mount("/api/v1", sub)

    const defs = router.getRouteDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs[0].path).toBe("/api/v1/items")
    expect(defs[1].path).toBe("/api/v1/items/:id")
  })
})
