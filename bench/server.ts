import { serve } from '../index.js';

const port = 9999;
const iterations = 5000;

async function benchmark() {
  const server = await serve({
    port,
    hostname: '0.0.0.0',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/json') {
        return Response.json({ message: 'hello', timestamp: Date.now() });
      }
      if (url.pathname === '/echo' && req.method === 'POST') {
        return new Response('echo: ' + (await req.text()));
      }
      return new Response('Hello World');
    },
  });

  console.log(`Benchmark server running on port ${port}`);
  console.log(`Running ${iterations} requests...\n`);

  // Warmup
  for (let i = 0; i < 500; i++) {
    await fetch(`http://localhost:${port}/`);
  }

  // Benchmark GET
  const getStart = performance.now();
  for (let i = 0; i < 2500; i++) {
    await fetch(`http://localhost:${port}/`);
  }
  const getEnd = performance.now();

  // Benchmark POST
  const postStart = performance.now();
  for (let i = 0; i < 1250; i++) {
    await fetch(`http://localhost:${port}/echo`, { method: 'POST', body: 'test' });
  }
  const postEnd = performance.now();

  // Benchmark JSON
  const jsonStart = performance.now();
  for (let i = 0; i < 1250; i++) {
    await fetch(`http://localhost:${port}/json`);
  }
  const jsonEnd = performance.now();

  const getTotal = getEnd - getStart;
  const postTotal = postEnd - postStart;
  const jsonTotal = jsonEnd - jsonStart;

  console.log('=== napi-router Benchmark Results ===');
  console.log(`GET requests:    ${(2500 / getTotal * 1000).toFixed(2)} rps (${getTotal.toFixed(2)}ms total)`);
  console.log(`POST requests:   ${(1250 / postTotal * 1000).toFixed(2)} rps (${postTotal.toFixed(2)}ms total)`);
  console.log(`JSON requests:   ${(1250 / jsonTotal * 1000).toFixed(2)} rps (${jsonTotal.toFixed(2)}ms total)`);

  server.stop();
}

benchmark().catch(console.error);