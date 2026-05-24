import { serve } from "../index.js";

const server = await serve({
  port: 3000,
  hostname: "0.0.0.0",

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response("Hello from napi-router!", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/json") {
      return new Response(JSON.stringify({ ok: true, method: req.method }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/echo" && req.method === "POST") {
      const body = await req.text();
      return new Response(body, {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/headers") {
      const ua = req.headers.get("user-agent") || "unknown";
      return new Response(ua, {
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running on http://${server.hostname}:${server.port}`);
