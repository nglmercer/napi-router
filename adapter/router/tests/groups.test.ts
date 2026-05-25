import { describe, expect, it } from "bun:test";
import { Router } from "../router";
import { HttpMethod } from "../method";

describe("Router.group()", () => {
  it("registers routes with prefix path", () => {
    const router = new Router();
    router.group("/api/v1", (r) => {
      r.get("/users", ({ req, res }) => { res.send("users") });
    });
    expect(router.routes.length).toBe(1);
    expect(router.routes[0].splitPath).toEqual(["api", "v1", "users"]);
    expect(router.routes[0].method).toBe(HttpMethod.GET);
  });

  it("registers multiple routes with prefix", () => {
    const router = new Router();
    router.group("/api", (r) => {
      r.get("/users", ({ req, res }) => { res.send("users") });
      r.post("/users", ({ req, res }) => { res.send("create") });
      r.get("/posts", ({ req, res }) => { res.send("posts") });
    });
    expect(router.routes.length).toBe(3);
  });

  it("supports nested groups", () => {
    const router = new Router();
    router.group("/api", (r) => {
      r.group("/v1", (r2) => {
        r2.get("/users", ({ req, res }) => { res.send("users") });
      });
    });
    expect(router.routes.length).toBe(1);
    expect(router.routes[0].splitPath).toEqual(["api", "v1", "users"]);
  });

  it("group routes work via router.request()", async () => {
    const router = new Router();
    router.group("/api", (r) => {
      r.get("/users", ({ req, res }) => { res.send("users list") });
    });
    const res = await router.request("http://localhost/api/users");
    expect(await res.text()).toBe("users list");
  });

  it("returns router for chaining", () => {
    const router = new Router();
    const result = router.group("/api", (r) => {
      r.get("/test", ({ req, res }) => { res.send("test") });
    });
    expect(result).toBe(router);
  });

  it("empty group does not add routes", () => {
    const router = new Router();
    router.group("/api", () => { });
    expect(router.routes.length).toBe(0);
  });
});

describe("Router.mount()", () => {
  it("mounts sub-router routes with prefix", () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/users", ({ req, res }) => { res.send("users") });
    sub.post("/users", ({ req, res }) => { res.send("create") });

    main.mount("/api", sub);
    expect(main.routes.length).toBe(2);
    expect(main.routes[0].splitPath).toEqual(["api", "users"]);
    expect(main.routes[0].method).toBe(HttpMethod.GET);
    expect(main.routes[1].splitPath).toEqual(["api", "users"]);
    expect(main.routes[1].method).toBe(HttpMethod.POST);
  });

  it("mounts sub-router with deep prefix", () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/", ({ req, res }) => { res.send("root") });

    main.mount("/api/v1", sub);
    expect(main.routes.length).toBe(1);
    expect(main.routes[0].splitPath).toEqual(["api", "v1"]);
  });

  it("mount works via router.request()", async () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/items", ({ req, res }) => { res.send("items list") });

    main.mount("/api", sub);
    const res = await main.request("http://localhost/api/items");
    expect(await res.text()).toBe("items list");
  });

  it("returns router for chaining", () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/test", ({ req, res }) => { res.send("test") });

    const result = main.mount("/api", sub);
    expect(result).toBe(main);
  });

  it("mount multiple sub-routers", () => {
    const main = new Router();
    const users = new Router();
    users.get("/", ({ req, res }) => { res.send("users") });
    const posts = new Router();
    posts.get("/", ({ req, res }) => { res.send("posts") });

    main.mount("/users", users);
    main.mount("/posts", posts);
    expect(main.routes.length).toBe(2);
  });

  it("mounted routes preserve middleware", async () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/test", ({ req, res }) => { res.send("from sub") });

    main.mount("/api", sub);
    const res = await main.request("http://localhost/api/test");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from sub");
  });

  it("mounted sub-router with named params", async () => {
    const main = new Router();
    const sub = new Router();
    sub.get("/users/:id", ({ req, res }) => {
      const params = req.pathParams as Record<string, string>;
      res.send(`user ${params.id}`);
    });

    main.mount("/api", sub);
    const res = await main.request("http://localhost/api/users/42");
    expect(await res.text()).toBe("user 42");
  });
});
