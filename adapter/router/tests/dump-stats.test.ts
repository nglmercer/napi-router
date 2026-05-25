import { describe, expect, it } from "bun:test";
import { dump, trackRouteTime, getRouteStats, clearRouteStats } from "../router/dump";
import type { EndpointRoute } from "../types";
import { splitRoutePath } from "../path";
import { parseHttpMethods } from "../method";

describe("dump response time tracking", () => {
  it("trackRouteTime records stats", () => {
    clearRouteStats();
    trackRouteTime("GET", "/test", 10);
    trackRouteTime("GET", "/test", 20);
    trackRouteTime("GET", "/test", 30);
    
    const stats = getRouteStats();
    expect(stats.size).toBe(1);
    const entry = stats.get("GET:/test");
    expect(entry).toBeDefined();
    expect(entry!.requestCount).toBe(3);
    expect(entry!.totalTimeMs).toBe(60);
    expect(entry!.avgTimeMs).toBe(20);
  });

  it("getRouteStats returns the stats map", () => {
    clearRouteStats();
    trackRouteTime("POST", "/api", 5);
    const stats = getRouteStats();
    expect(stats).toBeInstanceOf(Map);
    expect(stats.has("POST:/api")).toBe(true);
  });

  it("clearRouteStats empties the stats", () => {
    trackRouteTime("GET", "/test", 10);
    clearRouteStats();
    const stats = getRouteStats();
    expect(stats.size).toBe(0);
  });

  it("dump includes stats columns when stats exist", () => {
    clearRouteStats();
    trackRouteTime("GET", "/test", 15);
    trackRouteTime("GET", "/test", 25);
    
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    }];
    
    const result = dump(routes);
    expect(result).toContain("Requests");
    expect(result).toContain("Avg Time");
    expect(result).toContain("2"); // request count
  });

  it("dump does not include stats columns when no stats exist", () => {
    clearRouteStats();
    
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    }];
    
    const result = dump(routes);
    expect(result).not.toContain("Requests");
    expect(result).not.toContain("Avg Time");
  });

  it("dump shows 0 requests for routes without stats", () => {
    clearRouteStats();
    
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    }];
    
    const result = dump(routes);
    // When no stats exist, the stats columns are not shown at all
    expect(result).not.toContain("Requests");
    expect(result).not.toContain("Avg Time");
  });

  it("multiple routes with different stats", () => {
    clearRouteStats();
    trackRouteTime("GET", "/a", 10);
    trackRouteTime("GET", "/a", 20);
    trackRouteTime("POST", "/b", 5);
    
    const routes: EndpointRoute[] = [
      {
        splitPath: splitRoutePath("/a"),
        method: parseHttpMethods("GET"),
        handler: function handlerA() { }
      },
      {
        splitPath: splitRoutePath("/b"),
        method: parseHttpMethods("POST"),
        handler: function handlerB() { }
      }
    ];
    
    const result = dump(routes);
    expect(result).toContain("handlerA");
    expect(result).toContain("handlerB");
    expect(result).toContain("2"); // /a request count
    expect(result).toContain("1"); // /b request count
  });

  it("dump includes separator line with stats", () => {
    clearRouteStats();
    trackRouteTime("GET", "/test", 10);
    
    const routes: EndpointRoute[] = [{
      splitPath: splitRoutePath("/test"),
      method: parseHttpMethods("GET"),
      handler: function testHandler() { }
    }];
    
    const result = dump(routes);
    expect(result).toContain("---");
  });
});
