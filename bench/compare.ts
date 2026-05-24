// Benchmark comparing Bun's native server vs napi-router
const iterations = 3000;

function runBenchmark(name: string, port: number, fetchUrl: string) {
  return new Promise<void>((resolve) => {
    console.log(`\n=== ${name} ===`);
    
    // Warmup
    Promise.all(Array.from({ length: 100 }, () => fetch(fetchUrl))).then(() => {
      const start = performance.now();
      let completed = 0;
      
      const batch = () => {
        const batchSize = 100;
        const promises = Array.from({ length: batchSize }, () => fetch(fetchUrl));
        
        Promise.all(promises).then(() => {
          completed += batchSize;
          if (completed < iterations) {
            batch();
          } else {
            const end = performance.now();
            const total = end - start;
            const rps = (iterations / total) * 1000;
            console.log(`${iterations} requests in ${total.toFixed(2)}ms = ${rps.toFixed(0)} rps`);
            resolve();
          }
        });
      };
      
      batch();
    });
  });
}

async function runBunNativeBenchmark() {
  const port = 9998;
  const ac = new AbortController();
  
  // @ts-ignore - Bun-specific
  const server = Bun.serve({
    port,
    fetch() {
      return new Response('Hello World');
    },
  });

  await runBenchmark('Bun Native Server', port, `http://localhost:${port}/`);
  server.stop();
}

async function runNapiRouterBenchmark() {
  const { serve } = await import('../index.js');
  const port = 9999;
  
  const server = await serve({
    port,
    hostname: '0.0.0.0',
    async fetch() {
      return new Response('Hello World');
    },
  });

  await runBenchmark('napi-router', port, `http://localhost:${port}/`);
  server.stop();
}

async function main() {
  console.log('Starting benchmarks...');
  
  await runBunNativeBenchmark();
  await runNapiRouterBenchmark();
  
  console.log('\nBenchmark complete!');
}

main().catch(console.error);