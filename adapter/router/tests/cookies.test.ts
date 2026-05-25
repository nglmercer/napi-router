import { describe, expect, it } from "bun:test";
import { parseCookies, storeCookies } from "../router/cookies";
import { createMockReq, createMockRes } from "./utils";

describe("parseCookies", () => {
  it("sets empty cookies when no cookie header", () => {
    const req = createMockReq({
      headers: new Headers(),
      cookies: undefined,
      originCookies: undefined
    });

    parseCookies(req);
    expect(req.cookies).toEqual({});
    expect(req.originCookies).toEqual({});
  });

  it("parses single cookie", () => {
    const req = createMockReq({
      headers: new Headers({ cookie: "session=abc123" }),
      cookies: undefined,
      originCookies: undefined
    });

    parseCookies(req);
    expect(req.cookies).toEqual({ session: "abc123" });
    expect(req.originCookies).toEqual({ session: "abc123" });
  });

  it("parses multiple cookies", () => {
    const req = createMockReq({
      headers: new Headers({ cookie: "a=1; b=2; c=3" }),
      cookies: undefined,
      originCookies: undefined
    });

    parseCookies(req);
    expect(req.cookies).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("trims cookie name spaces", () => {
    const req = createMockReq({
      headers: new Headers({ cookie: "  name = value  " }),
      cookies: undefined,
      originCookies: undefined
    });

    parseCookies(req);
    expect(req.cookies).toEqual({ name: "value" });
  });

  it("forceReload resets to origin cookies", () => {
    const req = createMockReq({
      headers: new Headers({ cookie: "a=1" }),
      cookies: { a: "1", b: "2" },
      originCookies: { a: "1" }
    });

    parseCookies(req, true);
    expect(req.cookies).toEqual({ a: "1" });
  });

  it("does not reparse when originCookies exists and no forceReload", () => {
    const req = createMockReq({
      headers: new Headers({ cookie: "new=val" }),
      cookies: { old: "val" },
      originCookies: { old: "val" }
    });

    parseCookies(req);
    expect(req.cookies).toEqual({ old: "val" });
  });
});

describe("storeCookies", () => {
  it("sends 500 when no request cookies", () => {
    const res = createMockRes();
    const req = createMockReq({ cookies: undefined });
    storeCookies(req, res);
    expect(res.reset).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Request cookies store error");
  });

  it("sets new cookies", () => {
    const res = createMockRes();
    const req = createMockReq({
      cookies: { a: "1" },
      originCookies: {}
    });

    storeCookies(req, res);
    expect(res.setCookie).toHaveBeenCalledWith("a", "1");
  });

  it("updates changed cookies", () => {
    const res = createMockRes();
    const req = createMockReq({
      cookies: { a: "2" },
      originCookies: { a: "1" }
    });

    storeCookies(req, res);
    expect(res.setCookie).toHaveBeenCalledWith("a", "2");
  });

  it("unsets deleted cookies", () => {
    const res = createMockRes();
    const req = createMockReq({
      cookies: {},
      originCookies: { a: "1" }
    });

    storeCookies(req, res);
    expect(res.unsetCookie).toHaveBeenCalledWith("a");
  });

  it("does nothing when no changes", () => {
    const res = createMockRes();
    const req = createMockReq({
      cookies: { a: "1" },
      originCookies: { a: "1" }
    });

    storeCookies(req, res);
    expect(res.setCookie).not.toHaveBeenCalled();
    expect(res.unsetCookie).not.toHaveBeenCalled();
  });
});
