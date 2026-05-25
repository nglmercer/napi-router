import { describe, test, expect } from "bun:test"
import { mergeRequestMiddlewares, unmergeRequestMiddleware, isMergedRequestMiddleware, isMergeableEndpointRoute } from "../middleware"
import type { Context } from "../types"
import type { Request, EndpointRoute } from "../types"
import { ResponseBuilder } from "../responseBuilder"
import { HttpMethod } from "../method"
import { createMockReq, createMockRes } from "./utils"
describe("mergeRequestMiddlewares", () => {
  test("throws when no middlewares", () => {
    expect(() => mergeRequestMiddlewares()).toThrow("no middlewares specified")
  })

  test("returns single middleware when only one", () => {
    const mw = (ctx: Context) => { }
    const result = mergeRequestMiddlewares(mw)
    expect(result).toBe(mw)
  })

  test("merges multiple sync middlewares", () => {
    const order: number[] = []
    const mw1 = (ctx: Context) => { order.push(1) }
    const mw2 = (ctx: Context) => { order.push(2) }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    merged({ req: {} as Request, res: {} as ResponseBuilder } as unknown as Context)
    expect(order).toEqual([1, 2])
  })

  test("stops sync middlewares when res.submit is true", () => {
    const order: number[] = []
    const mw1 = (ctx: Context) => { order.push(1); ctx.res.submit = true }
    const mw2 = (ctx: Context) => { order.push(2) }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    const res = createMockRes()
    merged({ req: {} as Request, res } as unknown as Context)
    expect(order).toEqual([1])
  })

  test("stops sync middlewares when req.upgraded is true", () => {
    const order: number[] = []
    const req = createMockReq()
    req.upgraded = true
    const mw1 = (ctx: Context) => { order.push(1); ctx.req.upgraded = true }
    const mw2 = (ctx: Context) => { order.push(2) }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    merged({ req, res: createMockRes() } as unknown as Context)
    expect(order).toEqual([1])
  })

  test("handles async middleware", async () => {
    const order: number[] = []
    const mw1 = (ctx: Context) => {
      order.push(1)
      return new Promise<void>(resolve => setTimeout(() => { order.push(2); resolve() }, 10))
    }
    const mw2 = (ctx: Context) => { order.push(3) }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    await merged({ req: {} as Request, res: {} as ResponseBuilder } as unknown as Context)
    expect(order).toEqual([1, 2, 3])
  })

  test("stops async middlewares when res.submit is true after await", async () => {
    const order: number[] = []
    const mw1 = (ctx: Context) => {
      order.push(1)
      const res2 = createMockRes()
      res2.submit = true
      return new Promise<void>(resolve => setTimeout(() => { ctx.res.submit = true; order.push(2); resolve() }, 10))
    }
    const mw2 = (ctx: Context) => { order.push(3) }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    const res = createMockRes()
    await merged({ req: {} as Request, res } as unknown as Context)
    expect(order).toEqual([1, 2])
  })
})

describe("unmergeRequestMiddleware", () => {
  test("unmerges merged middleware", () => {
    const mw1 = (ctx: Context) => { }
    const mw2 = (ctx: Context) => { }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    const unmerged = unmergeRequestMiddleware(merged)
    expect(unmerged).toEqual([mw1, mw2])
  })
})

describe("isMergedRequestMiddleware", () => {
  test("returns true for merged middleware", () => {
    const mw1 = (ctx: Context) => { }
    const mw2 = (ctx: Context) => { }
    const merged = mergeRequestMiddlewares(mw1, mw2)
    expect(isMergedRequestMiddleware(merged)).toBe(true)
  })

  test("returns false for normal middleware", () => {
    const mw = (ctx: Context) => { }
    expect(isMergedRequestMiddleware(mw)).toBe(false)
  })
})

describe("isMergeableEndpointRoute", () => {
  const emptyHandler = () => { }
  test("returns false for different methods", () => {
    const route1 = { method: HttpMethod.GET, splitPath: undefined, handler: emptyHandler } as EndpointRoute
    const route2 = { method: HttpMethod.POST, splitPath: undefined, handler: emptyHandler } as EndpointRoute
    expect(isMergeableEndpointRoute(route1, route2)).toBe(false)
  })

  test("returns true when both splitPath are undefined", () => {
    const route1 = { method: HttpMethod.GET, splitPath: undefined, handler: emptyHandler } as EndpointRoute
    const route2 = { method: HttpMethod.GET, splitPath: undefined, handler: emptyHandler } as EndpointRoute
    expect(isMergeableEndpointRoute(route1, route2)).toBe(true)
  })

  test("returns false when one splitPath is undefined and the other is defined", () => {
    const route1 = { method: HttpMethod.GET, splitPath: undefined, handler: emptyHandler } as EndpointRoute
    const route2 = { method: HttpMethod.GET, splitPath: ["test"], handler: emptyHandler } as EndpointRoute
    expect(isMergeableEndpointRoute(route1, route2)).toBe(false)
  })

  test("returns true when splitPath join matches", () => {
    const route1 = { method: HttpMethod.GET, splitPath: ["a", "b"], handler: emptyHandler } as EndpointRoute
    const route2 = { method: HttpMethod.GET, splitPath: ["a", "b"], handler: emptyHandler } as EndpointRoute
    expect(isMergeableEndpointRoute(route1, route2)).toBe(true)
  })

  test("returns false when splitPath join does not match", () => {
    const route1 = { method: HttpMethod.GET, splitPath: ["a", "b"], handler: emptyHandler } as EndpointRoute
    const route2 = { method: HttpMethod.GET, splitPath: ["a", "c"], handler: emptyHandler } as EndpointRoute
    expect(isMergeableEndpointRoute(route1, route2)).toBe(false)
  })
})
