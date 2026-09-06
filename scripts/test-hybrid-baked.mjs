import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir,platform} from 'node:os';
const out=`${homedir()}/Downloads/Strata-Benchmark-Results/${new Date().toISOString().replaceAll(':','-')}-hybrid-baked`;
await mkdir(out,{recursive:true});
await build({entryPoints:['tests/browser/hybrid-baked-validation.ts'],outfile:'benchmarks/browser/hybrid-baked-validation.js',bundle:true,format:'esm',platform:'browser',target:'es2022'});
const server=await createBenchmarkServer({assetRoot:''});let browser;
const args=['--enable-unsafe-webgpu'];
if(process.env.STRATA_TEST_SOFTWARE_GPU==='1')args.push(...(platform()==='linux'?['--enable-features=Vulkan','--use-angle=vulkan','--use-vulkan=swiftshader','--use-webgpu-adapter=swiftshader','--disable-vulkan-surface']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']));
try{browser=await chromium.launch({channel:process.env.STRATA_TEST_BROWSER_CHANNEL??'chromium',headless:process.env.STRATA_TEST_HEADED!=='1',args});const page=await browser.newPage();await page.goto(`${server.url}/benchmarks/browser/index.html`);const report=await page.evaluate(async()=>{const mod=await import('/benchmarks/browser/hybrid-baked-validation.js');return mod.validateHybridBaked();});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('Hybrid baked validation',report.status,out);}finally{await browser?.close();await server.close();}
