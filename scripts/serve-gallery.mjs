import { createBenchmarkServer } from './benchmark-server.mjs';

try {
  const server = await createBenchmarkServer({ port: Number(process.env.PORT ?? 4175) });
  console.log(`Strata local gallery: ${server.url}/gallery/`);
  console.log('Assets are read from STRATA_BENCHMARK_ASSET_DIR and remain outside the repository.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
