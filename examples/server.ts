import { HttpServer } from "../index.js";
import type { RequestCall, ResponseData } from "../index.js";

const server = new HttpServer();

// We use a Map to store ResponseData promises keyed by requestId
const pendingResponses = new Map<string, (data: ResponseData) => void>();

server.onRequest(({ request, requestId }: RequestCall) => {
  const baseUrl = `http://localhost:8080`;
  const url = request.url.startsWith("/") ? `${baseUrl}${request.url}` : request.url;
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  // Handle the request in the microtask queue
  Promise.resolve()
    .then(() => fetch(new Request(url, init)))
    .then(async (res) => {
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      server.sendResponse(requestId, {
        status: res.status,
        headers,
        body,
      });
    })
    .catch((err: Error) => {
      server.sendResponse(requestId, {
        status: 500,
        headers: { "content-type": "text/plain" },
        body: err.message,
      });
    });
});

const info = await server.listen(8080, "0.0.0.0");
console.log(`Raw HttpServer listening on http://${info.address}:${info.port}`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close();
  process.exit(0);
});
