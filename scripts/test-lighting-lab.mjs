import {chromium} from 'playwright';
import {createBenchmarkServer} from './benchmark-server.mjs';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const {PNG}=createRequire(import.meta.url)(join(process.cwd(),'node_modules/playwright-core/lib/utilsBundle.js'));
const out=join(homedir(),'Downloads/Strata-Benchmark-Results',`${new Date().toISOString().replaceAll(':','-')}-colored-lighting`);await mkdir(out,{recursive:true});
const server=await createBenchmarkServer({assetRoot:''});let browser;
try{
 browser=await chromium.launch({channel:process.env.STRATA_TEST_BROWSER_CHANNEL??'chromium',headless:true,args:['--enable-unsafe-webgpu']});
 const page=await browser.newPage({viewport:{width:1000,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${server.url}/lighting-lab/index.html`);await page.waitForFunction(()=>window.lightingLab?.report.ready,null,{timeout:120000});
 const reports=[];
 for(const [mode,on] of [['red-blue',true],['red-blue',false],['blocked',true],['green-magenta',true]]){
  const report=await page.evaluate(async([mode,on])=>window.lightingLab.capture(mode,on),[mode,on]);
  const bytes=await page.locator('canvas').screenshot();await writeFile(join(out,`${mode}-${on}.png`),bytes);const png=PNG.sync.read(bytes);
  // Back-wall patch excludes the emitters, front opening and center pedestal.
  const sum=[0,0,0];let count=0;
  for(let y=Math.floor(png.height*.24);y<png.height*.45;y++)for(let x=Math.floor(png.width*.4);x<png.width*.6;x++){for(let c=0;c<3;c++)sum[c]+=png.data[(y*png.width+x)*4+c];count++;}
  const mean=sum.map(v=>v/count);if(report.telemetry.gpuErrorCount)throw Error('GPU validation failure');
  reports.push({mode,on,mean,...report});
 }
 const [lit,direct,blocked,green]=reports;
 if(lit.mean[0]<30||lit.mean[2]<30||Math.max(...direct.mean)>2||Math.max(...blocked.mean)>2||green.mean[1]<30)throw Error(`Color transport negative controls failed: ${JSON.stringify(reports.map(r=>({mode:r.mode,on:r.on,mean:r.mean})))}`);
 if(errors.length)throw Error(errors.join('\n'));
 await writeFile(join(out,'report.json'),JSON.stringify({status:'passed',scope:'Generated static progressive emission transport, no GI performance claim',reports},null,2));console.log('Colored GI, direct-only and blocked-path checks passed:',out);
}finally{await browser?.close();await server.close();}
