import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm,symlink,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {TERRAIN_ALLOCATIONS,originalTerrainOptions,assertOriginalManifest,terrainAssetRoute,assertAllocationComplete,terrainExternalOutput,terrainPrepareArguments,terrainPracticalComparison,terrainRequiredImageIndices} from './original-terrain-acceptance.mjs';
test('original8MiB default and policy arms cannot alter source, resolution, shading or geometry reference semantics',()=>{
 const d=originalTerrainOptions();assert.equal(d.residencyPolicy,'greedy');assert.equal(d.poolBytes,8388608);assert.equal(d.cssWidth,1280);
 assert.equal(originalTerrainOptions({policy:'retain-fallback',height:1080,width:1920}).residencyPolicy,'retain-fallback');
 assert.throws(()=>originalTerrainOptions({poolBytes:1048576}));assert.throws(()=>originalTerrainOptions({allocation:'A',geometryMode:'resident-full'}));
 assert.equal(originalTerrainOptions({allocation:'B',geometryMode:'resident-full'}).referenceExceedsStreamedPool,true);
 assert.throws(()=>originalTerrainOptions({width:640,height:360}));assert.throws(()=>{d.poolBytes=1;});
});
test('separate allocations have frozen order, all3600 moving frames, image caps, cut schedule and cleanup deadlines',()=>{
 assert.deepEqual(TERRAIN_ALLOCATIONS.A.runOrder.map(x=>[x[0],x[2]]),[['greedy',720],['retain-fallback',720],['retain-fallback',1080],['greedy',1080]]);
 assert.equal(TERRAIN_ALLOCATIONS.B.framesPerRun,3600);assert.equal(TERRAIN_ALLOCATIONS.B.maxImages,21600);assert.equal(TERRAIN_ALLOCATIONS.C.framesPerRun,1201);assert.equal(TERRAIN_ALLOCATIONS.B.imageEveryFrame,false);assert.equal(TERRAIN_ALLOCATIONS.B.imageStride,6);
 assert.deepEqual(TERRAIN_ALLOCATIONS.C.cameraCutIndices,[0,180,360,540,720,900,1080]);
 for(const p of Object.values(TERRAIN_ALLOCATIONS)){assert(p.outerDeadlineMs>p.cleanupDeadlineMs&&p.cleanupDeadlineMs>0);assert(p.maxArtifactBytes>0);}
});
test('asset route accepts only frozen original files, no queries, traversal, encoded aliases or other collections',()=>{
 const url='/external-assets/terrain-v1-s1337-t8-c128/manifest.json';const assets={files:[{url,sha256:'a'.repeat(64)}]};assert.equal(terrainAssetRoute(assets,url),assets.files[0]);
 for(const bad of [url+'?x',url+'#x',url.replace('manifest','../manifest'),url.replace('manifest','%6danifest'),url.replace('t8-c128','t4-c64'),'https://example.org'+url])assert.equal(terrainAssetRoute(assets,bad),null);
 assert.throws(()=>assertOriginalManifest(Buffer.from('{}')),/Original/);
});
function complete(phase){const p=TERRAIN_ALLOCATIONS[phase];return {status:'complete',runs:p.runOrder.map(([policy,width,height,geometryMode='streamed'])=>({policy,width,height,geometryMode,frames:p.framesPerRun,images:phase==='B'?600:p.framesPerRun,imageIndices:phase==='B'?terrainRequiredImageIndices([]):Array.from({length:p.framesPerRun??0},(_,i)=>i),selectedLodTransitionIndices:[],boundaryCensoredBrackets:[],fullBracketCoverage:true,imageCapExceeded:false,missingFrameIds:0,warmupSeconds:30,durationSeconds:60,diagnosticObservation:false})),elapsedMs:100,artifactBytes:100,deadlineExpired:false,errors:[],cleanupElapsedMs:1,cleanup:{disposed:true,buffers:0,textures:0,wasm:0,pendingRequests:0,pendingReadbacks:0,errors:[]}};}
test('no aggregate pass can hide incomplete images, wrong arm, exceeded caps/deadline or incomplete cleanup',()=>{
 for(const p of ['A','B','C'])assert.deepEqual(assertAllocationComplete(p,complete(p)),{collected:true,fullBracketCoverage:true,qualityAccepted:false});
 for(const mutate of [r=>r.runs[0].frames--,r=>r.runs[0].images--,r=>r.runs[0].imageIndices.pop(),r=>r.runs[0].imageCapExceeded=true,r=>r.runs[0].selectedLodTransitionIndices=[2],r=>r.runs[0].policy='retain-fallback',r=>r.deadlineExpired=true,r=>r.artifactBytes=Number.MAX_SAFE_INTEGER,r=>r.cleanup.buffers=1,r=>r.cleanup.pendingReadbacks=1,r=>r.cleanupElapsedMs=21000]){
  const r=complete('B');mutate(r);assert.throws(()=>assertAllocationComplete('B',r));
 }
});
test('CPU preparation rejects launch switches, missing SHA, duplicates, unknown workload overrides',()=>{
 const args=['--prepare-only','--commit','a'.repeat(40),'--asset-root','/external','--output','/out'];assert(terrainPrepareArguments(args)['--prepare-only']);
 for(const v of [args.slice(1),[...args,'--run'],[...args,'--commit','a'.repeat(40)],[...args,'--pool-mib','1']])assert.throws(()=>terrainPrepareArguments(v));
});
test('external output cannot reuse evidence or enter git/symlinked ancestors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'terrain-output-test-'));try{
  await mkdir(join(root,'repo','.git'),{recursive:true});await assert.rejects(terrainExternalOutput(join(root,'repo','result')),/Git/);
  await symlink(join(root,'repo'),join(root,'alias'));await assert.rejects(terrainExternalOutput(join(root,'alias','result')),/symlink/);
  const p=await terrainExternalOutput(join(root,'external','result'));assert.equal(p,join(await realpath(root),'external','result'));await assert.rejects(terrainExternalOutput(p),/exists/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('traffic savings cannot hide worse detail debt, blocked progress, timing tails or incomplete GPU coverage',()=>{
 const b={fetchedBytes:1000,evictions:100,missingDetailTileFrames:100,missingDetailTileMs:1000,maxStableDemandNoProgressFrames:5,frameCount:3600,callbacksAbove20Ms:0,cpuP95Ms:1,gpuSpanP95Ms:10,gpuSpanCoverage:1};
 const c={...b,fetchedBytes:900,evictions:90};assert.equal(terrainPracticalComparison(c,b).numericalThresholdsMet,true);assert.equal(terrainPracticalComparison(c,b).qualityAccepted,false);
 for(const [key,value] of [['fetchedBytes',901],['evictions',91],['missingDetailTileFrames',101],['missingDetailTileMs',1001],['maxStableDemandNoProgressFrames',7],['cpuP95Ms',1.251],['gpuSpanP95Ms',10.501],['callbacksAbove20Ms',37]])assert.equal(terrainPracticalComparison({...c,[key]:value},b).numericalThresholdsMet,false,key);
 assert.throws(()=>terrainPracticalComparison({...c,gpuSpanCoverage:.99},b));assert.throws(()=>terrainPracticalComparison({...c,missingDetailTileFrames:null},b));
 for(const invalid of [undefined,null,NaN,Infinity,-1])assert.throws(()=>terrainPracticalComparison({...c,missingDetailTileMs:invalid},b));
});

test('10Hz plus exact selected-LOD transition brackets are deduplicated and clipped only at path endpoints',()=>{
 const required=terrainRequiredImageIndices([1,2,3599]);
 assert.deepEqual(required.filter(x=>x<6),[0,1,2,3]);assert.deepEqual(required.slice(-3),[3594,3598,3599]);
 for(const invalid of [[0],[2,1],[1,1],[3600],[1.5]])assert.throws(()=>terrainRequiredImageIndices(invalid));
 const r=complete('B');r.runs[0].selectedLodTransitionIndices=[1,2,3599];r.runs[0].imageIndices=required;r.runs[0].images=required.length;
 assert.throws(()=>assertAllocationComplete('B',r),/Outside-span/);
 r.runs[0].boundaryCensoredBrackets=[{transitionIndex:3599,missingIndex:3600}];r.runs[0].fullBracketCoverage=false;
 assert.deepEqual(assertAllocationComplete('B',r),{collected:true,fullBracketCoverage:false,qualityAccepted:false});
 r.runs[0].fullBracketCoverage=true;assert.throws(()=>assertAllocationComplete('B',r));
});
