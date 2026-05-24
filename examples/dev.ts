import { serve } from "../index.js";

/**
 * Development server that hot-reloads on file changes.
 *
 * Usage:
 *   bun run examples/dev.ts
 *
 * The server starts on port 3000 and auto-restarts when any
 * watched file changes (requires bun --watch).
 *
 * Run with:
 *   bun --watch run examples/dev.ts
 *
 * Or use nodemon:
 *   npx nodemon --exec "bun run examples/dev.ts"
 */

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOST || "0.0.0.0";

const requestHandler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response(
      `napi-router dev server\nport: ${port}\ntime: ${new Date().toISOString()}\n`,
      { headers: { "content-type": "text/plain" } }
    );
  }

  if (url.pathname === "/api/health") {
    return Response.json({
      status: "ok",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  }

  if (url.pathname === "/api/echo" && req.method === "POST") {
    const body = await req.json();
    return Response.json({ echoed: body, timestamp: Date.now() });
  }

  return new Response("Not Found", { status: 404 });
};

const server = await serve({ port, hostname, fetch: requestHandler });
console.log(`Dev server running on http://${hostname}:${server.port}`);
console.log(`PID: ${process.pid}`);

process.on("SIGINT", () => {
  server.stop();
  process.exit(0);
});
