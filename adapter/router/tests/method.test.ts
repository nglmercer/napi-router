import { describe, test, expect } from "bun:test"
import { parseHttpMethods, stringifyHttpMethods, HttpMethod } from "../method"

describe("parseHttpMethods", () => {
  test("parses * as ALL", () => {
    expect(parseHttpMethods("*")).toBe(HttpMethod.ALL)
  })

  test("parses GET", () => {
    expect(parseHttpMethods("GET")).toBe(HttpMethod.GET)
  })

  test("parses PUT", () => {
    expect(parseHttpMethods("PUT")).toBe(HttpMethod.PUT)
  })

  test("parses POST", () => {
    expect(parseHttpMethods("POST")).toBe(HttpMethod.POST)
  })

  test("parses PATCH", () => {
    expect(parseHttpMethods("PATCH")).toBe(HttpMethod.PATCH)
  })

  test("parses DELETE", () => {
    expect(parseHttpMethods("DELETE")).toBe(HttpMethod.DELETE)
  })

  test("parses HEAD", () => {
    expect(parseHttpMethods("HEAD")).toBe(HttpMethod.HEAD)
  })

  test("parses OPTIONS", () => {
    expect(parseHttpMethods("OPTIONS")).toBe(HttpMethod.OPTIONS)
  })

  test("parses TRACE", () => {
    expect(parseHttpMethods("TRACE")).toBe(HttpMethod.TRACE)
  })

  test("parses CONNECT", () => {
    expect(parseHttpMethods("CONNECT")).toBe(HttpMethod.CONNECT)
  })

  test("unknown method returns UNKNOWN", () => {
    expect(parseHttpMethods("INVALID")).toBe(HttpMethod.UNKNOWN)
  })
})

describe("stringifyHttpMethods", () => {
  test("ALL returns ALL", () => {
    expect(stringifyHttpMethods(HttpMethod.ALL)).toBe("ALL")
  })

  test("GET returns GET", () => {
    expect(stringifyHttpMethods(HttpMethod.GET)).toBe("GET")
  })

  test("PUT returns PUT", () => {
    expect(stringifyHttpMethods(HttpMethod.PUT)).toBe("PUT")
  })

  test("POST returns POST", () => {
    expect(stringifyHttpMethods(HttpMethod.POST)).toBe("POST")
  })

  test("PATCH returns PATCH", () => {
    expect(stringifyHttpMethods(HttpMethod.PATCH)).toBe("PATCH")
  })

  test("DELETE returns DELETE", () => {
    expect(stringifyHttpMethods(HttpMethod.DELETE)).toBe("DELETE")
  })

  test("HEAD returns HEAD", () => {
    expect(stringifyHttpMethods(HttpMethod.HEAD)).toBe("HEAD")
  })

  test("OPTIONS returns OPTIONS", () => {
    expect(stringifyHttpMethods(HttpMethod.OPTIONS)).toBe("OPTIONS")
  })

  test("TRACE returns TRACE", () => {
    expect(stringifyHttpMethods(HttpMethod.TRACE)).toBe("TRACE")
  })

  test("CONNECT returns CONNECT", () => {
    expect(stringifyHttpMethods(HttpMethod.CONNECT)).toBe("CONNECT")
  })

  test("undefined returns ALL", () => {
    expect(stringifyHttpMethods(undefined)).toBe("ALL")
  })

  test("unknown method returns UNKNOWN", () => {
    // @ts-expect-error testing invalid input
    expect(stringifyHttpMethods(999)).toBe("UNKNOWN")
  })
})
