import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
const out=`${homedir()}/Downloads/Strata-Benchmark-Results/${new Date().toISOString().replaceAll(':','-')}-compressed-textures`;
await mkdir(out,{recursive:true});
await build({entryPoints:['tests/browser/compressed-texture-validation.ts'],outfile:'benchmarks/browser/compressed-texture-validation.js',bundle:true,format:'esm',platform:'browser',target:'es2022'});
const server=await createBenchmarkServer({assetRoot:''});let browser;
try{browser=await chromium.launch({channel:process.env.STRATA_TEST_BROWSER_CHANNEL??'chromium',headless:true,args:['--enable-unsafe-webgpu']});const page=await browser.newPage();await page.goto(`${server.url}/benchmarks/browser/index.html`);const report=await page.evaluate(async()=>{const mod=await import('/benchmarks/browser/compressed-texture-validation.js');return mod.validateCompressedTextures();});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('Compressed texture validation',report.status,report.compressedCases,out);}finally{await browser?.close();await server.close();}
