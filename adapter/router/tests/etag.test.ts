import { describe, expect, it, mock } from "bun:test";
import { staticFiles } from "../router/builtin";
import type { EndpointRoute } from "../types";
import { createMockReq, createMockRes, calls } from "./utils";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { Context } from "../context";

const TEST_DIR = "/tmp/router-bun-etag-test";

function setupTestDir() {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  writeFileSync(join(TEST_DIR, "test.txt"), "hello world");
  writeFileSync(join(TEST_DIR, "test.json"), '{"key":"value"}');
}

function cleanupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

describe("staticFiles with ETag", () => {
  it("sets ETag header when serving a file", async () => {
    setupTestDir();
    const routes: EndpointRoute[] = [];
    staticFiles(routes, "/static", TEST_DIR);
    const req = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
    });
    const res = createMockRes();
    const ctx = new Context(req, res);
    await routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "ETag",
      expect.stringMatching(/^".*"$/),
    );
    cleanupTestDir();
  });

  it("sets Cache-Control header", async () => {
    setupTestDir();
    const routes: EndpointRoute[] = [];
    staticFiles(routes, "/static", TEST_DIR);
    const req = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
    });
    const res = createMockRes();
    const ctx = new Context(req, res);
    await routes[0].handler(ctx);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=0",
    );
    cleanupTestDir();
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    setupTestDir();
    const routes: EndpointRoute[] = [];
    staticFiles(routes, "/static", TEST_DIR);

    // First request to get the ETag
    const req1 = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
    });
    const res1 = createMockRes();
    const ctx1 = new Context(req1, res1);
    await routes[0].handler(ctx1);

    // Get the ETag from the setHeader calls
    const etagCall = calls(res1.setHeader).find((c) => c[0] === "ETag");
    const etag = etagCall ? etagCall[1] : null;

    // Second request with If-None-Match
    if (etag) {
      const req2 = createMockReq({
        path: "/static/test.txt",
        splitPath: ["static", "test.txt"],
        pathParams: ["test.txt"],
        headers: new Headers({ "if-none-match": etag }),
      });
      const res2 = createMockRes();
      res2.status = mock(function () {
        return res2;
      });
      res2.send = mock(function () {
        res2.submit = true;
      });
      const ctx2 = new Context(req2, res2);
      await routes[0].handler(ctx2);
      expect(res2.status).toHaveBeenCalledWith(304);
    }

    cleanupTestDir();
  });

  it("returns full response when If-None-Match does not match", async () => {
    setupTestDir();
    const routes: EndpointRoute[] = [];
    staticFiles(routes, "/static", TEST_DIR);
    const req = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
      headers: new Headers({ "if-none-match": '"wrong-etag"' }),
    });
    const res = createMockRes();
    const ctx = new Context(req, res);
    await routes[0].handler(ctx);
    // Should still send the file (not 304)
    expect(res.status).not.toHaveBeenCalledWith(304);
    cleanupTestDir();
  });

  it("generates consistent ETag for same file content", async () => {
    setupTestDir();
    const routes: EndpointRoute[] = [];
    staticFiles(routes, "/static", TEST_DIR);

    const req1 = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
    });
    const res1 = createMockRes();
    const ctx1 = new Context(req1, res1);
    await routes[0].handler(ctx1);

    const req2 = createMockReq({
      path: "/static/test.txt",
      splitPath: ["static", "test.txt"],
      pathParams: ["test.txt"],
    });
    const res2 = createMockRes();
    const ctx2 = new Context(req2, res2);
    await routes[0].handler(ctx2);

    const etag1 = calls(res1.setHeader).find((c) => c[0] === "ETag")?.[1];
    const etag2 = calls(res2.setHeader).find((c) => c[0] === "ETag")?.[1];

    expect(etag1).toBe(etag2);
    cleanupTestDir();
  });
});
