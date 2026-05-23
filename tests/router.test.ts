import { expect, test, describe } from "bun:test";
import { Router } from "../index";

describe("Router — basic operations", () => {
  test("constructor creates empty router", () => {
    const r = new Router();
    expect(r.routeCount()).toBe(0);
  });

  test("addRoute + matchRoute — exact static match", () => {
    const r = new Router();
    r.addRoute("GET", "/users", "listUsers");
    const m = r.matchRoute("GET", "/users")!;
    expect(m.handlerId).toBe("listUsers");
    expect(Object.keys(m.params)).toHaveLength(0);
  });

  test("matchRoute returns null on no match", () => {
    const r = new Router();
    r.addRoute("GET", "/users", "listUsers");
    expect(r.matchRoute("GET", "/posts")).toBeNull();
  });

  test("method filtering — GET vs POST vs PUT", () => {
    const r = new Router();
    r.addRoute("GET", "/items", "getItems");
    r.addRoute("POST", "/items", "createItem");
    expect(r.matchRoute("GET", "/items")!.handlerId).toBe("getItems");
    expect(r.matchRoute("POST", "/items")!.handlerId).toBe("createItem");
    expect(r.matchRoute("PUT", "/items")).toBeNull();
  });
});

describe("Router — parameters and wildcards", () => {
  test("single path parameter :id", () => {
    const r = new Router();
    r.addRoute("GET", "/users/:id", "getUser");
    const m = r.matchRoute("GET", "/users/42")!;
    expect(m.handlerId).toBe("getUser");
    expect(m.params.id).toBe("42");
  });

  test("multiple path parameters", () => {
    const r = new Router();
    r.addRoute("GET", "/orgs/:orgId/repos/:repoId", "getRepo");
    const m = r.matchRoute("GET", "/orgs/acme/repos/myapp")!;
    expect(m.handlerId).toBe("getRepo");
    expect(m.params.orgId).toBe("acme");
    expect(m.params.repoId).toBe("myapp");
  });

  test("wildcard *path — multi-segment", () => {
    const r = new Router();
    r.addRoute("GET", "/files/*path", "serveFile");
    const m = r.matchRoute("GET", "/files/a/b/c.txt")!;
    expect(m.handlerId).toBe("serveFile");
    expect(m.params.path).toBe("a/b/c.txt");
  });

  test("wildcard — deep nested path", () => {
    const r = new Router();
    r.addRoute("GET", "/static/*path", "servePath");
    const m = r.matchRoute("GET", "/static/deep/nested/file.txt")!;
    expect(m.params.path).toBe("deep/nested/file.txt");
  });

  test("query string stripped before path matching", () => {
    const r = new Router();
    r.addRoute("GET", "/search", "search");
    expect(r.matchRoute("GET", "/search?q=hello&page=1")).not.toBeNull();
    expect(r.matchRoute("GET", "/search")).not.toBeNull();
  });
});

describe("Router — convenience methods", () => {
  test("all HTTP verb shortcuts", () => {
    const router = new Router();
    router.get("/g", "getHandler");
    router.post("/p", "postHandler");
    router.put("/pu", "putHandler");
    router.delete("/d", "deleteHandler");
    router.patch("/pa", "patchHandler");
    router.options("/o", "optionsHandler");
    router.head("/h", "headHandler");
    router.any("/a", "anyHandler");

    expect(router.matchRoute("GET", "/g")!.handlerId).toBe("getHandler");
    expect(router.matchRoute("POST", "/p")!.handlerId).toBe("postHandler");
    expect(router.matchRoute("PUT", "/pu")!.handlerId).toBe("putHandler");
    expect(router.matchRoute("DELETE", "/d")!.handlerId).toBe("deleteHandler");
    expect(router.matchRoute("PATCH", "/pa")!.handlerId).toBe("patchHandler");
    expect(router.matchRoute("OPTIONS", "/o")!.handlerId).toBe("optionsHandler");
    expect(router.matchRoute("HEAD", "/h")!.handlerId).toBe("headHandler");
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const) {
      expect(router.matchRoute(m, "/a")!.handlerId).toBe("anyHandler");
    }
  });

  test("any() matches all HTTP methods", () => {
    const r = new Router();
    r.any("/health", "healthCheck");
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      expect(r.matchRoute(m, "/health")!.handlerId).toBe("healthCheck");
    }
  });
});

describe("Router — matchAll", () => {
  test("matchAll returns one result for single match", () => {
    const r = new Router();
    r.addRoute("GET", "/items/:id", "getItem");
    r.addRoute("POST", "/items/:id", "updateItem");
    const all = r.matchAll("GET", "/items/5");
    expect(all).toHaveLength(1);
    expect(all[0].handlerId).toBe("getItem");
  });

  test("matchAll returns multiple when any + exact coexist", () => {
    const r = new Router();
    r.any("/items/:id", "anyHandler");
    r.addRoute("GET", "/items/:id", "getItem");
    const all = r.matchAll("GET", "/items/5");
    expect(all).toHaveLength(2);
    expect(all.map((x) => x.handlerId)).toEqual(["anyHandler", "getItem"]);
  });
});

describe("Router — mutation", () => {
  test("clear removes all routes", () => {
    const r = new Router();
    r.get("/a", "h");
    r.post("/b", "h");
    expect(r.routeCount()).toBe(2);
    r.clear();
    expect(r.routeCount()).toBe(0);
    expect(r.matchRoute("GET", "/a")).toBeNull();
  });

  test("removeRoute — returns true and removes route", () => {
    const r = new Router();
    r.addRoute("GET", "/items", "getItems");
    r.addRoute("POST", "/items", "createItem");
    expect(r.removeRoute("GET", "/items")).toBe(true);
    expect(r.routeCount()).toBe(1);
    expect(r.matchRoute("GET", "/items")).toBeNull();
    expect(r.matchRoute("POST", "/items")).not.toBeNull();
  });

  test("removeRoute — returns false when route does not exist", () => {
    const r = new Router();
    r.get("/users", "listUsers");
    expect(r.removeRoute("DELETE", "/users")).toBe(false);
    expect(r.routeCount()).toBe(1);
  });
});
