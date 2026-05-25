import { describe, expect, it } from "bun:test";
import { requestPathMatchesRouteDefinition, splitRoutePath } from "..";

describe("named path params (:param syntax)", () => {
  describe("requestPathMatchesRouteDefinition with named params", () => {
    it("single named param matches and returns object", () => {
      expect(requestPathMatchesRouteDefinition(
        ["users", "123"],
        ["users", ":id"]
      )).toEqual({ id: "123" })
    })

    it("multiple named params matches and returns object", () => {
      expect(requestPathMatchesRouteDefinition(
        ["users", "123", "edit"],
        ["users", ":id", ":action"]
      )).toEqual({ id: "123", action: "edit" })
    })

    it("named param with literal segments before and after", () => {
      expect(requestPathMatchesRouteDefinition(
        ["api", "users", "42", "profile"],
        ["api", "users", ":id", "profile"]
      )).toEqual({ id: "42" })
    })

    it("named param fails when segment is missing", () => {
      expect(requestPathMatchesRouteDefinition(
        ["users"],
        ["users", ":id"]
      )).toBe(false)
    })

    it("named param fails on mismatched literal", () => {
      expect(requestPathMatchesRouteDefinition(
        ["posts", "123"],
        ["users", ":id"]
      )).toBe(false)
    })

    it("named param with double wildcard", () => {
      expect(requestPathMatchesRouteDefinition(
        ["files", "a", "b", "c"],
        ["files", "**"]
      )).toEqual(["a", "b", "c"])
    })

    it("named param with single wildcard", () => {
      expect(requestPathMatchesRouteDefinition(
        ["users", "123", "posts"],
        ["users", ":id", "*"]
      )).toEqual({ id: "123", })
    })

    it("mixed named params and wildcards", () => {
      expect(requestPathMatchesRouteDefinition(
        ["org", "acme", "users", "42"],
        ["org", ":orgId", "users", ":userId"]
      )).toEqual({ orgId: "acme", userId: "42" })
    })

    it("empty requestPath with named param route fails", () => {
      expect(requestPathMatchesRouteDefinition(
        undefined,
        ["users", ":id"]
      )).toBe(false)
    })

    it("named param with undefined paths returns empty object", () => {
      expect(requestPathMatchesRouteDefinition(
        undefined,
        undefined
      )).toEqual({})
    })

    it("single named param on single segment matches", () => {
      expect(requestPathMatchesRouteDefinition(
        ["hello"],
        [":name"]
      )).toEqual({ name: "hello" })
    })

    it("named param does not match empty string segment", () => {
      expect(requestPathMatchesRouteDefinition(
        [""],
        [":name"]
      )).toEqual({ name: "" })
    })
  })

  describe("splitRoutePath with named params", () => {
    it("preserves :param in split path", () => {
      const result = splitRoutePath("/users/:id")
      expect(result).toEqual(["users", ":id"])
    })

    it("preserves multiple :params", () => {
      const result = splitRoutePath("/users/:id/posts/:postId")
      expect(result).toEqual(["users", ":id", "posts", ":postId"])
    })

    it("preserves :param with literal segments", () => {
      const result = splitRoutePath("/api/v1/users/:id")
      expect(result).toEqual(["api", "v1", "users", ":id"])
    })
  })
})
