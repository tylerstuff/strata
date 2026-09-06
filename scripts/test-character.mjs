import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {serveConsumer} from '../tests/consumer-server.mjs';
const capsuleMode=process.argv.includes('--capsule')||process.env.STRATA_TEST_CAPSULE==='1';
const root=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(join(tmpdir(),'strata-character-'));
let browser,server;
try{
 const packResult=JSON.parse(execFileSync('npm',['pack','--workspace','@strata-engine/core','--pack-destination',temporary,'--json'],{cwd:root,encoding:'utf8'}));
 const packed=Array.isArray(packResult)?packResult.find(p=>p.name==='@strata-engine/core'):packResult['@strata-engine/core'];
 assert(packed?.filename);
 await writeFile(join(temporary,'package.json'),JSON.stringify({type:'module',dependencies:{'@strata-engine/core':`file:${join(temporary,packed.filename)}`}}));
 execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:temporary,stdio:'pipe'});
 // Resolve the public package export in a clean install, without DOM/GPU globals.
 await writeFile(join(temporary,'cpu.mjs'),`import {createCharacterController} from '@strata-engine/core/gameplay'; export default createCharacterController({boxes:[{min:[-5,-1,-5],max:[5,0,5]}],position:[0,0,0]}).advance(1/60,{x:1,z:0});`);
 const {default:state}=await import(pathToFileURL(join(temporary,'cpu.mjs')).href);assert.equal(state.tick,1);assert(state.grounded);
 await cp(join(root,'examples/character'),join(temporary,'course'),{recursive:true});
 const main=join(temporary,'course/main.js');await writeFile(main,(await readFile(main,'utf8')).replaceAll('/packages/core/dist/','/node_modules/@strata-engine/core/dist/'));
 server=await serveConsumer(temporary);
 browser=await chromium.launch({headless:true,...(process.env.STRATA_TEST_BROWSER_CHANNEL?{channel:process.env.STRATA_TEST_BROWSER_CHANNEL}:{}),args:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--disable-vulkan-surface']});
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(server.url+'/course/index.html'+(capsuleMode?'?capsule'+(process.argv.includes('--gzip')?'&gzip':''):''));await page.waitForFunction(()=>window.characterCourse?.ready,{},{timeout:60000});
 await page.waitForFunction(()=>window.characterCourse.metrics(),{},{timeout:60000});
 const initial=await page.evaluate(()=>({state:characterCourse.snapshot(),metrics:characterCourse.metrics(),telemetry:characterCourse.telemetry()}));
 await page.locator('canvas').focus();await page.keyboard.down('KeyW');
 await page.waitForFunction(t=>characterCourse.snapshot().tick>=t+20,initial.state.tick,{timeout:60000});await page.keyboard.up('KeyW');
 const moved=await page.evaluate(()=>({state:characterCourse.snapshot(),metrics:characterCourse.metrics()}));assert(moved.state.position[2]<initial.state.position[2]-.5);assert.equal(moved.metrics.scene.sceneGeneration,initial.metrics.scene.sceneGeneration);
 await page.keyboard.down('Space');await page.waitForFunction(()=>!characterCourse.snapshot().grounded,{},{timeout:60000});await page.keyboard.up('Space');
 await page.locator('#reset').click();await page.waitForFunction(()=>characterCourse.snapshot().position[2]===4);
 const before=await page.evaluate(()=>characterCourse.snapshot());assert.equal(before.grounded,true);
 await page.locator('#pause').click();const paused=await page.evaluate(()=>characterCourse.snapshot().tick);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>characterCourse.snapshot().tick),paused);
 const output=resolve(process.env.STRATA_CHARACTER_RESULTS??join(tmpdir(),'strata-character-results'));await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'course.png')});
 const telemetry=await page.evaluate(()=>{characterCourse.dispose();return characterCourse.telemetry();});assert.equal(telemetry.gpuErrorCount,0);assert.equal(telemetry.allocatedGpuBufferBytes,0);assert.equal(telemetry.allocatedGpuTextureBytes,0);assert.equal(telemetry.wasmMemoryBytes,0);assert.deepEqual(errors,[]);if(capsuleMode)assert.equal(await page.evaluate(()=>characterCourse.collisionDiagnostics().ownedWorlds),0);
 await writeFile(join(output,'report.json'),JSON.stringify({status:'passed',adapter:'software WebGPU correctness only',initial:initial.state,moved:moved.state,telemetry},null,2));console.log('Packed character course passed: '+output);
}finally{await browser?.close();await server?.close();await rm(temporary,{recursive:true,force:true});}
