import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const command = promisify(execFile);
const args = process.argv.slice(2); const sourceFlag = args.indexOf('--source-root');
const smoke = args.includes('--smoke');
const sourceRoot = sourceFlag < 0 ? process.cwd() : resolve(args[sourceFlag + 1] ?? '');
if (args.length !== (sourceFlag < 0 ? 0 : 2) + Number(smoke)) throw new Error('Usage: node scripts/test-gi-motion.mjs [--smoke] [--source-root clean-baseline-worktree]');
const sourceFiles = new Map();
const bundle = await build({ entryPoints: ['tests/browser/gi-motion-validation.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'explicit-runtime-source', setup(build) {
    build.onResolve({ filter: /packages\/core\/src\// }, ({ path }) => ({ path: resolve(sourceRoot, path.slice(path.indexOf('packages/core/src/'))).replace(/\.js$/, '.ts') }));
    build.onLoad({ filter: /packages\/core\/src\/.*\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path, 'utf8'); sourceFiles.set(path, createHash('sha256').update(contents).digest('hex'));
      return { contents, loader: 'ts' };
    });
  } }] });
const output = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-gi-motion-validation`);
await mkdir(output, { recursive: true });
const revision = (await command('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).stdout.trim();
const dirty = (await command('git', ['-C', sourceRoot, 'status', '--porcelain'])).stdout.trim().length > 0;
const report = { kind: 'strata-gi-motion-functional', totalFramePerformanceEvidence: false,
  source: { commit: revision, dirty, root: sourceRoot, moduleSha256: Object.fromEntries(sourceFiles) },
  harnessSha256: createHash('sha256').update(await readFile('tests/browser/gi-motion-validation.ts')).digest('hex'),
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browserErrors: [] };
let browser; let server;
try {
  server = await createBenchmarkServer({ assetRoot: '' });
  const flags = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) flags.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args: flags });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); else if (message.text().startsWith('GI motion diagnostic:')) console.log(message.text()); });
  await page.route(`${server.url}/motion.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata diffuse motion diagnostic</title><canvas></canvas>' }));
  await page.route(`${server.url}/motion.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.goto(`${server.url}/motion.html`);
  report.result = await page.evaluate(async smoke => (await import('/motion.js')).validateGiMotion({ smoke }), smoke);
  assert.deepEqual(report.browserErrors, []);
  console.log(`GI motion functional validation passed (${report.result.policy}). Saved local report: ${output}/report.json`);
} catch (error) { report.failure = error.stack ?? String(error); throw error; }
finally {
  await Promise.allSettled([browser?.close(), server?.close()]);
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
