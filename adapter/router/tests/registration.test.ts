import { describe, test, expect } from "bun:test"
import { use, get, post, put, deleteMethod, patch, trace, head, connect, options } from "../router/registration"
import type { RequestMiddleware, EndpointRoute } from "../types"
import { HttpMethod } from "../method"

describe("registration.use", () => {
  test("throws when no handler provided", () => {
    //@ts-expect-error
    expect(() => use([], true, "GET", "/test", undefined)).toThrow("no handler provided")
  })

  test("adds route with correct method and path", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    use(routes, true, "GET", "/test", handler)
    expect(routes.length).toBe(1)
    expect(routes[0].method).toBe(HttpMethod.GET)
    expect(routes[0].splitPath).toEqual(["test"])
  })

  test("merges handlers when mergeHandlers is true", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    use(routes, true, "GET", "/test", handler1)
    use(routes, true, "GET", "/test", handler2)
    expect(routes.length).toBe(1)
  })

  test("does not merge handlers when mergeHandlers is false", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    use(routes, false, "GET", "/test", handler1)
    use(routes, false, "GET", "/test", handler2)
    expect(routes.length).toBe(2)
  })

  test("handles * method as ALL", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    use(routes, true, "*", "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.ALL)
  })

  test("adds multiple handlers with use", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    use(routes, true, "GET", "/test", handler1, handler2)
    expect(routes.length).toBe(1)
  })
})

describe("registration.get", () => {
  test("adds GET route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    get(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.GET)
  })

  test("adds GET route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    get(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.GET)
    expect(routes.length).toBe(1)
  })
})

describe("registration.post", () => {
  test("adds POST route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    post(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.POST)
  })
})

describe("registration.put", () => {
  test("adds PUT route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    put(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.PUT)
  })

  test("adds PUT route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    put(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.PUT)
    expect(routes.length).toBe(1)
  })
})

describe("registration.deleteMethod", () => {
  test("adds DELETE route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    deleteMethod(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.DELETE)
  })

  test("adds DELETE route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    deleteMethod(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.DELETE)
    expect(routes.length).toBe(1)
  })
})

describe("registration.patch", () => {
  test("adds PATCH route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    patch(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.PATCH)
  })

  test("adds PATCH route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    patch(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.PATCH)
    expect(routes.length).toBe(1)
  })
})

describe("registration.trace", () => {
  test("adds TRACE route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    trace(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.TRACE)
  })

  test("adds TRACE route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    trace(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.TRACE)
    expect(routes.length).toBe(1)
  })
})

describe("registration.head", () => {
  test("adds HEAD route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    head(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.HEAD)
  })

  test("adds HEAD route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    head(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.HEAD)
    expect(routes.length).toBe(1)
  })
})

describe("registration.connect", () => {
  test("adds CONNECT route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    connect(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.CONNECT)
  })

  test("adds CONNECT route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    connect(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.CONNECT)
    expect(routes.length).toBe(1)
  })
})

describe("registration.options", () => {
  test("adds OPTIONS route", () => {
    const routes: EndpointRoute[] = []
    const handler: RequestMiddleware = () => { }
    options(routes, true, "/test", handler)
    expect(routes[0].method).toBe(HttpMethod.OPTIONS)
  })

  test("adds OPTIONS route with multiple handlers", () => {
    const routes: EndpointRoute[] = []
    const handler1: RequestMiddleware = () => { }
    const handler2: RequestMiddleware = () => { }
    options(routes, true, "/test", handler1, handler2)
    expect(routes[0].method).toBe(HttpMethod.OPTIONS)
    expect(routes.length).toBe(1)
  })
})
