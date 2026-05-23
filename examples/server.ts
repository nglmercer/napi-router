import { HttpServer, Router, RequestCall, ResponseData, WsEvent } from '../index.js';

const router = new Router();

router.get('/', 'home');
router.get('/users', 'listUsers');
router.get('/users/:id', 'getUser');
router.post('/users', 'createUser');
router.put('/users/:id', 'updateUser');
router.delete('/users/:id', 'deleteUser');
router.get('/files/*path', 'serveFile');
router.any('/health', 'healthCheck');

const users: Record<string, { name: string; email: string }> = {
  '1': { name: 'Alice', email: 'alice@example.com' },
  '2': { name: 'Bob', email: 'bob@example.com' },
};

function handleRequest(reqCall: RequestCall): void {
  const { request, requestId } = reqCall;
  const match = router.matchRoute(request.method, request.path);

  if (!match) {
    server.sendResponse(requestId, {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Not Found', path: request.path }),
    });
    return;
  }

  let response: ResponseData;

  switch (match.handlerId) {
    case 'home':
      response = {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<h1>NAPI Router</h1><p>HTTP + WebSocket server powered by Rust</p>',
      };
      break;

    case 'healthCheck':
      response = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          wsConnections: server.wsConnectionCount(),
          pendingRequests: server.pendingCount(),
          routes: router.routeCount(),
        }),
      };
      break;

    case 'listUsers':
      response = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.entries(users).map(([id, u]) => ({ id, ...u }))),
      };
      break;

    case 'getUser': {
      const user = users[match.params.id];
      if (user) {
        response = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: match.params.id, ...user }),
        };
      } else {
        response = {
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'User not found' }),
        };
      }
      break;
    }

    case 'createUser': {
      try {
        const body = JSON.parse(request.body || '{}');
        const id = String(Object.keys(users).length + 1);
        users[id] = { name: body.name || 'Unknown', email: body.email || '' };
        response = {
          status: 201,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, ...users[id] }),
        };
      } catch {
        response = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid JSON' }),
        };
      }
      break;
    }

    case 'updateUser': {
      const user = users[match.params.id];
      if (!user) {
        response = {
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'User not found' }),
        };
        break;
      }
      try {
        const body = JSON.parse(request.body || '{}');
        if (body.name) user.name = body.name;
        if (body.email) user.email = body.email;
        response = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: match.params.id, ...user }),
        };
      } catch {
        response = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid JSON' }),
        };
      }
      break;
    }

    case 'deleteUser':
      if (users[match.params.id]) {
        delete users[match.params.id];
        response = {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deleted: true }),
        };
      } else {
        response = {
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'User not found' }),
        };
      }
      break;

    case 'serveFile':
      response = {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: `Serving file: ${match.params.path}`,
      };
      break;

    default:
      response = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Unknown handler' }),
      };
  }

  server.sendResponse(requestId, response);
}

const server = new HttpServer();

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

const PORT = 3000;
server.listen(PORT, handleRequest);

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
