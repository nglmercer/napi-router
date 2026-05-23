import { HttpServer, Router, Context, WsEvent } from '../index.js';

// Router setup
const router = new Router();

router.get('/', 'home');
router.get('/users', 'listUsers');
router.get('/users/:id', 'getUser');
router.post('/users', 'createUser');
router.put('/users/:id', 'updateUser');
router.delete('/users/:id', 'deleteUser');
router.get('/files/*path', 'serveFile');
router.any('/health', 'healthCheck');

// In-memory data store
const users: Record<string, { name: string; email: string }> = {
  '1': { name: 'Alice', email: 'alice@example.com' },
  '2': { name: 'Bob', email: 'bob@example.com' },
};

// Server setup
const server = new HttpServer();

// Attach the router so ctx.next() performs route matching
server.useRouter(router);

// Register middleware / request handler via Context
server.use((ctx: Context): void => {
  const { method, path, body } = ctx.getRequest();

  // Example: request logging
  console.log(`[${method}] ${path}`);

  // Let Rust run route matching
  ctx.next();

  // Check which handler matched and respond
  const handlerId = ctx.matchedHandler();

  if (!handlerId) {
    // No route matched
    ctx.sendResponse(404, JSON.stringify({ error: 'Not Found', path }));
    return;
  }

  const params = ctx.params();

  switch (handlerId) {
    case 'home':
      ctx.sendResponse(200, '<h1>NAPI Router</h1><p>HTTP + WebSocket server powered by Rust</p>');
      break;

    case 'healthCheck':
      ctx.json(200, JSON.stringify({
        status: 'ok',
        wsConnections: server.wsConnectionCount(),
        pendingRequests: server.pendingCount(),
        routes: router.routeCount(),
      }));
      break;

    case 'listUsers':
      ctx.json(200, JSON.stringify(
        Object.entries(users).map(([id, u]) => ({ id, ...u }))
      ));
      break;

    case 'getUser': {
      const user = users[params.id];
      if (user) {
        ctx.json(200, JSON.stringify({ id: params.id, ...user }));
      } else {
        ctx.sendResponse(404, JSON.stringify({ error: 'User not found' }));
      }
      break;
    }

    case 'createUser': {
      try {
        const data = JSON.parse(body || '{}');
        const id = String(Object.keys(users).length + 1);
        users[id] = { name: data.name || 'Unknown', email: data.email || '' };
        ctx.json(201, JSON.stringify({ id, ...users[id] }));
      } catch {
        ctx.sendResponse(400, JSON.stringify({ error: 'Invalid JSON' }));
      }
      break;
    }

    case 'updateUser': {
      const user = users[params.id];
      if (!user) {
        ctx.sendResponse(404, JSON.stringify({ error: 'User not found' }));
        break;
      }
      try {
        const data = JSON.parse(body || '{}');
        if (data.name) user.name = data.name;
        if (data.email) user.email = data.email;
        ctx.json(200, JSON.stringify({ id: params.id, ...user }));
      } catch {
        ctx.sendResponse(400, JSON.stringify({ error: 'Invalid JSON' }));
      }
      break;
    }

    case 'deleteUser':
      if (users[params.id]) {
        delete users[params.id];
        ctx.json(200, JSON.stringify({ deleted: true }));
      } else {
        ctx.sendResponse(404, JSON.stringify({ error: 'User not found' }));
      }
      break;

    case 'serveFile':
      ctx.sendResponse(200, `Serving file: ${params.path}`);
      break;

    default:
      ctx.sendResponse(500, JSON.stringify({ error: 'Unknown handler' }));
  }
});



// WebSocket event handler
server.onWsEvent((event: WsEvent) => {
  switch (event.eventType) {
    case 'open':
      console.log(`[WS] Connected: ${event.connectionId}`);
      server.wsSend(event.connectionId, JSON.stringify({
        type: 'welcome',
        message: 'Connected to NAPI Router WebSocket',
        connectionId: event.connectionId,
      }));
      break;

    case 'message':
      console.log(`[WS] Message from ${event.connectionId}: ${event.text}`);
      server.wsSend(event.connectionId, JSON.stringify({
        type: 'echo',
        data: event.text,
      }));
      break;

    case 'close':
      console.log(`[WS] Client closed: ${event.connectionId} (code: ${event.code})`);
      break;

    case 'disconnect':
      console.log(`[WS] Disconnected: ${event.connectionId}`);
      break;

    case 'error':
      console.error(`[WS] Error on ${event.connectionId}: ${event.error}`);
      break;
  }
});

// Start server
const PORT = 3000;
await server.listen(PORT);

console.log(`HTTP + WS server listening on http://localhost:${PORT}`);
console.log(`WebSocket upgrade available at ws://localhost:${PORT}`);
console.log(`Routes: ${router.routeCount()}`);
console.log('');
console.log('Try:');
console.log(`  curl http://localhost:${PORT}/`);
console.log(`  curl http://localhost:${PORT}/users`);
console.log(`  curl http://localhost:${PORT}/users/1`);
console.log(`  curl -X POST http://localhost:${PORT}/users -d '{"name":"Charlie","email":"charlie@test.com"}'`);
console.log(`  curl http://localhost:${PORT}/health`);
console.log(`  curl -H "Upgrade: websocket" -H "Connection: Upgrade" http://localhost:${PORT}/ws`);
