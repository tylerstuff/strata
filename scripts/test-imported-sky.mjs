import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
const out=`${homedir()}/Downloads/Strata-Benchmark-Results/${new Date().toISOString().replaceAll(':','-')}-imported-sky`;
await mkdir(out,{recursive:true});
await build({entryPoints:['tests/browser/imported-sky-validation.ts'],outfile:'benchmarks/browser/imported-sky-validation.js',bundle:true,format:'esm',platform:'browser',target:'es2022'});
const server=await createBenchmarkServer({assetRoot:''});let browser;
try{browser=await chromium.launch({channel:process.env.STRATA_TEST_BROWSER_CHANNEL??'chromium',headless:true,args:['--enable-unsafe-webgpu']});const page=await browser.newPage();await page.goto(`${server.url}/benchmarks/browser/index.html`);const report=await page.evaluate(async()=>{const mod=await import('/benchmarks/browser/imported-sky-validation.js');return mod.validateImportedSky();});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('Imported sky validation',report.status,out);}finally{await browser?.close();await server.close();}
