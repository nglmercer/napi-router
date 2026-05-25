import { describe, expect, it } from "bun:test";
import { Router } from "../router";

describe("router.request", () => {
    it("should handle request with string url", async () => {
        const router = new Router();
        router.get("/hello", ({ req, res }) => {
            res.send("world");
        });

        const response = await router.request("http://localhost/hello");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("world");
    });

    it("should handle request with string url and options", async () => {
        const router = new Router();
        router.post("/data", async ({ req, res }) => {
            const body = await req.json();
            res.setHeader("Content-Type", "application/json").send(JSON.stringify({ received: body.value }));
        });

        const response = await router.request("http://localhost/data", {
            method: "POST",
            body: JSON.stringify({ value: 42 }),
            headers: {
                "Content-Type": "application/json"
            }
        });
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.received).toBe(42);
    });

    it("should handle request with Request object", async () => {
        const router = new Router();
        router.get("/direct", ({ req, res }) => {
            res.send("direct object");
        });

        const req = new Request("http://localhost/direct");
        const response = await router.request(req);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("direct object");
    });

    it("should return 404 for unknown routes", async () => {
        const router = new Router();
        const response = await router.request("http://localhost/unknown");
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not found");
    });
});
