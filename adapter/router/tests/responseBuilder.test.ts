import { describe, test, expect } from "bun:test"
import { ResponseBuilder, HTTP_STATUS, HTTP_HEADERS } from "../responseBuilder"

describe("ResponseBuilder", () => {
  test("initial state is correct", () => {
    const res = new ResponseBuilder()
    expect(res.submit).toBe(false)
    expect(res.statusCode).toBe(HTTP_STATUS.OK)
    expect(res.statusText).toBeUndefined()
    expect(res.bodyInit).toBeNull()
    expect(res.headers).toEqual([])
  })

  test("reset returns to default state", () => {
    const res = new ResponseBuilder()
    res.status(404).body("test").setHeader("X-Test", "1")
    res.reset()
    expect(res.statusCode).toBe(HTTP_STATUS.OK)
    expect(res.bodyInit).toBeNull()
    expect(res.headers).toEqual([])
  })

  test("status sets code and text", () => {
    const res = new ResponseBuilder()
    res.status(404, "Not Found")
    expect(res.statusCode).toBe(404)
    expect(res.statusText).toBe("Not Found")
  })

  test("setHeader adds header with overwrite", () => {
    const res = new ResponseBuilder()
    res.setHeader("X-Test", "1")
    res.setHeader("X-Test", "2")
    expect(res.headers).toEqual([["X-Test", "2"]])
  })

  test("setHeader adds header without overwrite", () => {
    const res = new ResponseBuilder()
    res.setHeader("X-Test", "1", false)
    res.setHeader("X-Test", "2", false)
    expect(res.headers).toEqual([["X-Test", "1"], ["X-Test", "2"]])
  })

  test("unsetHeader removes header", () => {
    const res = new ResponseBuilder()
    res.setHeader("X-Test", "1")
    res.unsetHeader("X-Test")
    expect(res.headers).toEqual([])
  })

  test("body sets bodyInit", () => {
    const res = new ResponseBuilder()
    res.body("hello")
    expect(res.bodyInit).toBe("hello")
  })

  test("send sets submit to true", () => {
    const res = new ResponseBuilder()
    res.send("hello")
    expect(res.submit).toBe(true)
    expect(res.bodyInit).toBe("hello")
  })

  test("sendRedirect sets 307 by default", () => {
    const res = new ResponseBuilder()
    res.sendRedirect("/test")
    expect(res.submit).toBe(true)
    expect(res.statusCode).toBe(HTTP_STATUS.TEMPORARY_REDIRECT)
    expect(res.headers).toContainEqual([HTTP_HEADERS.LOCATION, "/test"])
  })

  test("sendRedirect with perma sets 308", () => {
    const res = new ResponseBuilder()
    res.sendRedirect("/test", true)
    expect(res.statusCode).toBe(HTTP_STATUS.PERMANENT_REDIRECT)
  })

  test("sendRedirectCustom sets custom status", () => {
    const res = new ResponseBuilder()
    res.sendRedirectCustom("/test", 301)
    expect(res.submit).toBe(true)
    expect(res.statusCode).toBe(301)
    expect(res.headers).toContainEqual([HTTP_HEADERS.LOCATION, "/test"])
  })

  test("setCookie adds cookie header", () => {
    const res = new ResponseBuilder()
    res.setCookie("session", "abc", { HttpOnly: true, Path: "/" })
    expect(res.headers[0][0]).toBe(HTTP_HEADERS.SET_COOKIE)
    expect(res.headers[0][1]).toContain("session=abc")
    expect(res.headers[0][1]).toContain("HttpOnly")
    expect(res.headers[0][1]).toContain("Path=/")
  })

  test("unsetCookie sets expiry", () => {
    const res = new ResponseBuilder()
    res.unsetCookie("session")
    expect(res.headers[0][1]).toContain("session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
  })

  test("beforeSent adds hook", () => {
    const res = new ResponseBuilder()
    res.beforeSent(() => { })
    expect(res.beforeSentHooks?.length).toBe(1)
  })

  test("startBeforeSentHook runs hooks", async () => {
    const res = new ResponseBuilder()
    const order: number[] = []
    res.beforeSent(() => { order.push(1) })
    res.beforeSent(() => { order.push(2) })
    await res.startBeforeSentHook()
    expect(order).toEqual([2, 1])
  })

  test("startBeforeSentHook handles async hooks", async () => {
    const res = new ResponseBuilder()
    const order: number[] = []
    res.beforeSent(async () => { await new Promise(r => setTimeout(r, 10)); order.push(1) })
    res.beforeSent(() => { order.push(2) })
    await res.startBeforeSentHook()
    expect(order).toEqual([2, 1])
  })

  test("build creates Response", () => {
    const res = new ResponseBuilder()
    res.status(201).body("created")
    const response = res.build()
    expect(response.status).toBe(201)
    expect(response.statusText).toBe("")
  })
})
