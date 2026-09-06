import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';

const output = `${homedir()}/Downloads/Strata-Benchmark-Results/${new Date().toISOString().replaceAll(':','-')}-hybrid-baked`;
const source = () => ({ commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  status: execFileSync('git', ['status', '--porcelain'], {encoding:'utf8'}) });
const before = source();
const bundle = await build({entryPoints:['tests/browser/hybrid-baked-validation.ts'], write:false,
  bundle:true,format:'esm',platform:'browser',target:'es2022'});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packageHash = hash(await readFile('packages/core/dist/index.js'));
await mkdir(output,{recursive:true});
await writeFile(`${output}/bundle.js`,bundle.outputFiles[0].contents);
const server = await createBenchmarkServer({assetRoot:''});
const args = ['--enable-unsafe-webgpu'];
if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') args.push(...(platform() === 'linux'
  ? ['--enable-features=Vulkan','--use-angle=vulkan','--use-vulkan=swiftshader','--use-webgpu-adapter=swiftshader','--disable-vulkan-surface']
  : ['--use-angle=swiftshader','--enable-unsafe-swiftshader']));
let browser;
try {
  browser = await chromium.launch({channel:process.env.STRATA_TEST_BROWSER_CHANNEL??'chromium',headless:process.env.STRATA_TEST_HEADED!=='1',args});
  const page = await browser.newPage();
  await page.route(`${server.url}/hybrid-baked.js`, route => route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
  await page.goto(`${server.url}/benchmarks/browser/index.html`);
  const report = await page.evaluate(async()=>{const mod=await import('/hybrid-baked.js');return mod.validateHybridBaked();});
  assert.deepEqual(source(),before,'Source changed during hybrid validation');
  assert.equal(hash(await readFile('packages/core/dist/index.js')),packageHash,'Package changed during hybrid validation');
  await writeFile(`${output}/report.json`,JSON.stringify({...report,source:before,packageHash,browser:browser.version(),softwareGpu:process.env.STRATA_TEST_SOFTWARE_GPU==='1'},null,2));
  console.log('Hybrid baked validation',report.status,output);
} finally { await browser?.close(); await server.close(); }
