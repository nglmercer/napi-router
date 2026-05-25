import { describe, expect, it } from "bun:test";
import { getDefinitionString, dump } from "../router/dump";
import type { EndpointRoute } from "../types";
import { splitRoutePath } from "../path";
import { parseHttpMethods } from "../method";
import { createMockServer } from "./utils";
describe("dump.getDefinitionString", () => {
  it("returns correct method, path and handler name", () => {
    const route: EndpointRoute = {
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    };
    const [method, path, name] = getDefinitionString(route, route.handler, false);
    expect(method).toBe("GET");
    expect(path).toBe("/test");
    expect(name).toBe("testHandler");
  });

  it("shows merged marker when mergedToTop is true", () => {
    const route: EndpointRoute = {
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: () => { }
    };
    const [method] = getDefinitionString(route, route.handler, true);
    expect(method).toBe("^ (M)");
  });

  it("shows [anonym] for anonymous handlers without prototype name", () => {
    const handler = () => { };
    Object.defineProperty(handler, "name", { value: "" });
    Object.defineProperty(handler, "prototype", { value: {} });
    const route: EndpointRoute = {
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler
    };
    const [, , name] = getDefinitionString(route, route.handler, false);
    expect(name).toBe("[anonym]");
  });

  it("shows / when splitPath is undefined", () => {
    const route: EndpointRoute = {
      splitPath: undefined,
      method: parseHttpMethods("GET"),
      handler: () => { }
    };
    const [, path] = getDefinitionString(route, route.handler, false);
    expect(path).toBe("/");
  });

  it("shows [merged] for merged middlewares", () => {
    const { mergeRequestMiddlewares } = require("../middleware");
    const route: EndpointRoute = {
      splitPath: undefined,
      method: parseHttpMethods("GET"),
      handler: mergeRequestMiddlewares(() => { }, () => { })
    };
    const [, , name] = getDefinitionString(route, route.handler, false);
    expect(name).toBe("[merged]");
  });

  it("shows prototype name if handler name is empty", () => {
    const handler = () => { };
    Object.defineProperty(handler, "name", { value: "" });
    Object.defineProperty(handler, "prototype", { value: { name: "ProtoName" } });
    const route: EndpointRoute = {
      splitPath: undefined,
      method: parseHttpMethods("GET"),
      handler
    };
    const [, , name] = getDefinitionString(route, route.handler, false);
    expect(name).toBe("ProtoName");
  });
});

describe("dump.dump", () => {
  it("throws error when no routes", () => {
    expect(() => dump([])).toThrow("No endpoint routes defined");
  });

  it("returns string with endpoint info", () => {
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    }];
    const result = dump(routes);
    expect(result).toContain("Defined endpoints:");
    expect(result).toContain("GET");
    expect(result).toContain("/test");
    expect(result).toContain("testHandler");
  });

  it("includes server url when provided", () => {
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: () => { }
    }];
    const mockServer = createMockServer();
    Object.defineProperty(mockServer, "url", {
      value: new URL("http://localhost:3000"),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const result = dump(routes, mockServer);
    expect(result).toContain("Server is listening on http://localhost:3000");
  });

  it("includes multiple server urls when provided", () => {
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: () => { }
    }];

    const mockServer1 = createMockServer();
    Object.defineProperty(mockServer1, "url", {
      value: new URL("http://localhost:3000"),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const mockServer2 = createMockServer();
    Object.defineProperty(mockServer2, "url", {
      value: new URL("http://localhost:3001"),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const result = dump(routes, mockServer1, mockServer2);
    expect(result).toContain("Server is listening on:");
    expect(result).toContain("- http://localhost:3000");
    expect(result).toContain("- http://localhost:3001");
  });

  it("prints Merged endpoints section for merged handlers", () => {
    const { mergeRequestMiddlewares } = require("../middleware");
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: mergeRequestMiddlewares(() => { }, () => { })
    }];
    const result = dump(routes);
    expect(result).toContain("Merged endpoints:");
  });
});
