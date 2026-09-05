/** CPU-only original-workload preparation. This file has no browser launch path. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGINAL_TERRAIN_SOURCE = '4599d0475e7c46e79f698c60a951f34da3961c84';
export const ORIGINAL_TERRAIN_MANIFEST = '12e3946f079ae252d79509710631ea70b5abe14ce8f0119a04b4eb544eab0adf';
export const ORIGINAL_TERRAIN_NAME = 'terrain-v1-s1337-t8-c128';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = object => { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } return object; };
export const TERRAIN_ALLOCATIONS = freeze({
  A: { name:'timing', runOrder:[['greedy',1280,720],['retain-fallback',1280,720],['retain-fallback',1920,1080],['greedy',1920,1080]],
    warmupSeconds:30, durationSeconds:60, outerDeadlineMs:720000, cleanupDeadlineMs:10000, maxArtifactBytes:512*1024**2,
    diagnosticObservation:false },
  B: { name:'moving-reference', runOrder:[['greedy',1280,720,'streamed'],['retain-fallback',1280,720,'streamed'],['greedy',1280,720,'resident-full'],
    ['retain-fallback',1920,1080,'streamed'],['greedy',1920,1080,'streamed'],['greedy',1920,1080,'resident-full']],
    framesPerRun:3600, framesPerSecondSimulation:60, imageEveryFrame:false, imageStride:6, transitionBrackets:[-1,0,1], maxImagesPerRun:3600, maxRetainedCanvases:2, imageCapPolicy:'incomplete if any required image exceeds caps; never trim frame receipts', resetBetweenImages:false,
    maxImages:21600, maxImageBytes:16*1024**2, maxCaseBytes:4*1024**3, maxArtifactBytes:16*1024**3,
    outerDeadlineMs:1800000, cleanupDeadlineMs:20000, onePendingReadbackPerCase:true,
    qualification:'Cold root-ready, all3600 submission receipts; 10Hz images plus deduplicated previous/current/next actual selected-LOD transition brackets.21600 is a worst-case allocation cap, not the capture schedule. Not wall-clock timing or network-performance evidence.' },
  C: { name:'delayed-coverage', runOrder:[['greedy',1280,720],['retain-fallback',1280,720],['retain-fallback',1920,1080],['greedy',1920,1080]],
    pageLoadDelayMs:250, poses:[0,9.6,19.2,28.8,38.4,48,57.6], initialHolds:120, movementSubmissionsPerLeg:60, destinationHolds:120, framesPerRun:1201, cameraCutIndices:[0,180,360,540,720,900,1080],
    maxImages:4804, maxImageBytes:16*1024**2, maxCaseBytes:4*1024**3, maxArtifactBytes:4*1024**3,
    outerDeadlineMs:480000, cleanupDeadlineMs:20000, qualification:'Initial pose plus120 holds, then six continuous60-submission movements each followed by120 destination holds. Arrival history resets are not teleports; not a timed tour.' },
});
export function originalTerrainOptions(input={}) {
  assert(input && typeof input==='object' && !Array.isArray(input));
  assert(Object.keys(input).every(k=>['allocation','policy','width','height','geometryMode'].includes(k)),'No other workload override is supported');
  const {allocation='A',policy='greedy',width=1280,height=720,geometryMode='streamed'}=input;
  assert(['A','B','C'].includes(allocation)); assert(['greedy','retain-fallback'].includes(policy));
  assert((width===1280&&height===720)||(width===1920&&height===1080));
  assert(geometryMode==='streamed'||(allocation==='B'&&geometryMode==='resident-full'&&policy==='greedy'));
  return freeze({renderer:'virtual',manifestUrl:`/external-assets/${ORIGINAL_TERRAIN_NAME}/manifest.json`, geometryMode,
    residencyPolicy:policy,poolBytes:8388608,pixelError:2,pageLoadDelayMs:allocation==='C'?250:0,cameraMode:'tour',seed:1337,
    temporal:true,debugView:'final',exposureEV:0,width,height,cssWidth:1280,cssHeight:720,viewport:{width:1920,height:1160},devicePixelRatio:1,
    ...(allocation==='A'?{mode:'performance',warmupSeconds:30,durationSeconds:60}:{mode:'diagnostic',referenceExceedsStreamedPool:geometryMode==='resident-full'})});
}
export function assertOriginalManifest(bytes) {
  assert.equal(sha256(bytes),ORIGINAL_TERRAIN_MANIFEST,'Original manifest bytes required; certified/smaller source is not interchangeable');
  const m=JSON.parse(bytes);assert.deepEqual(m.source,{kind:'analytic-heightfield-v1',seed:1337,tilesPerSide:8,cellsPerTile:128,cellSize:1,triangleCount:2097152});
  assert.equal(m.pageBytes,65536);assert.equal(m.pages.length,1199);assert.equal(m.tiles.length,64);assert.equal(m.rootPageIds.length,24);
  return m;
}
export function terrainAssetRoute(asset,url) {
  if(typeof url!=='string'||!url.startsWith(`/external-assets/${ORIGINAL_TERRAIN_NAME}/`)||/[\\?#%]/.test(url)||url.split('/').some(x=>x==='.'||x==='..'))return null;
  return asset.files.find(f=>f.url===url)??null;
}
/** Required B images, including transition brackets clipped only at path endpoints. */
export function terrainRequiredImageIndices(transitions) {
  assert(Array.isArray(transitions)); const required=new Set(Array.from({length:600},(_,i)=>i*6));
  let last=0;for(const index of transitions){assert(Number.isInteger(index)&&index>last&&index<3600,'Invalid transition index');last=index;
    for(const i of [index-1,index,index+1])if(i<3600)required.add(i);}
  return [...required].sort((a,b)=>a-b);
}
export function assertAllocationComplete(allocation,record) {
  const plan=TERRAIN_ALLOCATIONS[allocation];assert(plan,'Unknown allocation');
  assert.equal(record.status,'complete');assert.equal(record.runs.length,plan.runOrder.length);
  assert(Number.isFinite(record.elapsedMs)&&record.elapsedMs>=0&&record.elapsedMs<=plan.outerDeadlineMs);
  assert(Number.isSafeInteger(record.artifactBytes)&&record.artifactBytes>=0&&record.artifactBytes<=plan.maxArtifactBytes);
  assert.equal(record.deadlineExpired,false);assert.deepEqual(record.errors,[]);
  let fullBracketCoverage=true;
  for(const [i,r] of record.runs.entries()){
    const [policy,width,height,mode='streamed']=plan.runOrder[i];
    assert.equal(r.policy,policy);assert.equal(r.width,width);assert.equal(r.height,height);assert.equal(r.geometryMode,mode);
    if(allocation!=='A'){
      assert.equal(r.frames,plan.framesPerRun);assert.equal(r.missingFrameIds,0);
      const required=allocation==='B'?terrainRequiredImageIndices(r.selectedLodTransitionIndices):Array.from({length:plan.framesPerRun},(_,i)=>i);
      assert.deepEqual(r.imageIndices,required,'Missing, extra or repeated required images');assert.equal(r.images,required.length);
      assert.equal(r.imageCapExceeded,false,'Required image cap makes the allocation incomplete');
      const censored=allocation==='B'&&r.selectedLodTransitionIndices.includes(3599)?[{transitionIndex:3599,missingIndex:3600}]:[];
      assert.deepEqual(r.boundaryCensoredBrackets,censored,'Outside-span brackets must remain explicit');
      assert.equal(r.fullBracketCoverage,censored.length===0);fullBracketCoverage &&=r.fullBracketCoverage;
    }
    else {assert.equal(r.warmupSeconds,30);assert.equal(r.durationSeconds,60);assert.equal(r.diagnosticObservation,false);}
  }
  assert.deepEqual(record.cleanup,{disposed:true,buffers:0,textures:0,wasm:0,pendingRequests:0,pendingReadbacks:0,errors:[]});
  assert(record.cleanupElapsedMs>=0&&record.cleanupElapsedMs<=plan.cleanupDeadlineMs);
  return {collected:true,fullBracketCoverage,qualityAccepted:false};
}
/** Practical gates only, evaluated independently at each resolution; never visual acceptance. */
export function terrainPracticalComparison(candidate, control) {
  const integerKeys=['fetchedBytes','evictions','missingDetailTileFrames','maxStableDemandNoProgressFrames','frameCount','callbacksAbove20Ms'];
  for(const sample of [candidate,control]) {
    for(const key of integerKeys)assert(Number.isSafeInteger(sample[key])&&sample[key]>=0,`Missing/invalid ${key}`);
    for(const key of ['cpuP95Ms','gpuSpanP95Ms','missingDetailTileMs'])assert(Number.isFinite(sample[key])&&sample[key]>=0,`Missing/invalid ${key}`);
    assert(sample.frameCount>0&&sample.callbacksAbove20Ms<=sample.frameCount);
    assert.equal(sample.gpuSpanCoverage,1,'Unqualified missing GPU coverage');
  }
  const checks={
    fetchedReductionAtLeast10Percent:control.fetchedBytes>0&&BigInt(candidate.fetchedBytes)*10n<=BigInt(control.fetchedBytes)*9n,
    evictionReductionAtLeast10Percent:control.evictions>0&&BigInt(candidate.evictions)*10n<=BigInt(control.evictions)*9n,
    timeWeightedDebtNonworse:candidate.missingDetailTileMs<=control.missingDetailTileMs,
    diagnosticFrameDebtNonworse:candidate.missingDetailTileFrames<=control.missingDetailTileFrames,
    stableDemandProgressNonworse:candidate.maxStableDemandNoProgressFrames<=control.maxStableDemandNoProgressFrames+1,
    cpuTailBound:candidate.cpuP95Ms-control.cpuP95Ms<=Math.max(.25,.1*control.cpuP95Ms),
    gpuTailBound:candidate.gpuSpanP95Ms-control.gpuSpanP95Ms<=Math.max(.3,.05*control.gpuSpanP95Ms),
    cadenceBound:(BigInt(candidate.callbacksAbove20Ms)*BigInt(control.frameCount)-BigInt(control.callbacksAbove20Ms)*BigInt(candidate.frameCount))*100n<=BigInt(candidate.frameCount)*BigInt(control.frameCount),
  };
  return {checks,numericalThresholdsMet:Object.values(checks).every(Boolean),qualityAccepted:false,
    debtScope:'Timing debt is the required integral of missing-detail tiles over measured milliseconds. Equal-cadence diagnostic tile-frame debt is an additional gate; moving visibility/censored episodes remain separate.'};
}
function within(root,p){const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`));}
export async function terrainExternalOutput(destination) {
  const absent=[];let p=resolve(destination);
  for(;;){try{const s=await lstat(p);assert(!s.isSymbolicLink(),'Output ancestor is a symlink');break;}catch(e){if(e.code!=='ENOENT')throw e;absent.unshift(p.split(sep).at(-1));const up=dirname(p);assert.notEqual(up,p);p=up;}}
  const parent=await realpath(p);for(let q=parent;;q=dirname(q)){try{await lstat(resolve(q,'.git'));throw Error('Output cannot be inside Git');}catch(e){if(e.code!=='ENOENT')throw e;}if(dirname(q)===q)break;}
  assert(absent.length,'Output already exists');const result=resolve(parent,...absent);assert(!within(await realpath(repository),result));
  await mkdir(result,{recursive:true});return result;
}
export function terrainPrepareArguments(args){
  const result={};for(let i=0;i<args.length;i++){const k=args[i];assert(!Object.hasOwn(result,k),'Duplicate option');
    if(k==='--prepare-only'||k==='--allow-dirty-draft')result[k]=true;
    else {assert(['--commit','--asset-root','--output'].includes(k),'Only CPU prepare is supported; no launch path');assert(args[i+1]&&!args[i+1].startsWith('--'));result[k]=args[++i];}}
  assert(result['--prepare-only']&&['--commit','--asset-root','--output'].every(k=>typeof result[k]==='string'));
  assert(/^[a-f0-9]{40}$/.test(result['--commit']));return result;
}
export async function prepareOriginalTerrain(args){
  const git=async(...a)=>(await exec('git',a,{cwd:repository})).stdout.trim();
  const commit=await git('rev-parse','HEAD');assert.equal(commit,args['--commit']);
  await git('merge-base','--is-ancestor',ORIGINAL_TERRAIN_SOURCE,commit);
  assert.equal(await git('rev-parse',`${commit}:packages/core`),await git('rev-parse',`${ORIGINAL_TERRAIN_SOURCE}:packages/core`),'CPU preparation must not alter runtime');
  assert.equal(await git('diff','HEAD','--','packages/core'),'','Uncommitted runtime edits are outside this slice');
  assert.equal(await git('ls-files','--others','--exclude-standard','packages/core'),'','Untracked runtime files are outside this slice');
  const status=await git('status','--porcelain');assert(!status||args['--allow-dirty-draft'],'Clean source required unless explicitly preparing a non-runnable draft');
  const assetRoot=await realpath(args['--asset-root']);assert(!within(repository,assetRoot)&&!within(assetRoot,repository),'Assets must remain external');
  const manifestPath=resolve(assetRoot,ORIGINAL_TERRAIN_NAME,'manifest.json');const bytes=await readFile(manifestPath);const source=assertOriginalManifest(bytes);
  const files=[];for(const entry of [{url:'manifest.json',byteLength:bytes.length,sha256:ORIGINAL_TERRAIN_MANIFEST},...source.pages]){
    const p=await realpath(resolve(dirname(manifestPath),entry.url));assert(within(assetRoot,p));const b=await readFile(p);assert.equal(b.length,entry.byteLength);assert.equal(sha256(b),entry.sha256);
    files.push({url:`/external-assets/${ORIGINAL_TERRAIN_NAME}/${entry.url}`,path:p,bytes:b.length,sha256:entry.sha256});
  }
  const names=new Set((await git('ls-files')).split('\n'));
  for(const p of ['scripts/original-terrain-acceptance.mjs','scripts/original-terrain-acceptance.test.mjs','tests/helpers/original-terrain-recording.ts','tests/unit/original-terrain-recording.test.ts'])names.add(p);
  const inputs=[];for(const name of [...names].sort()){const b=await readFile(resolve(repository,name));inputs.push({name,bytes:b.length,sha256:sha256(b)});}
  assert.equal(await git('status','--porcelain'),status);assert.equal(await git('rev-parse','HEAD'),commit);
  const result={kind:'original-terrain-acceptance-cpu-preparation-v1',runnable:false,source:{root:await realpath(repository),commit,status},
    asset:{manifestSha256:ORIGINAL_TERRAIN_MANIFEST,files},inputs,allocations:TERRAIN_ALLOCATIONS,
    practicalGates:{fetchedBytesReduction:.10,evictionReduction:.10,missingDetailDebt:'time-weighted tile×ms AND equal-cadence diagnostic tile-frames nonworse',stableDemandProgress:'nonworse within one diagnostic submission',cpuP95Increase:{fraction:.10,absoluteMs:.25},gpuP95Increase:{fraction:.05,absoluteMs:.3},callbackAbove20msShareIncrease:.01},
    remaining:['Native feedback interception has only CPU forwarding tests','Per-tile CPU cache plans/event capture is not wired; interception observes actual GPU selections only','Browser image/decode/persistence and reference oracle integration absent','C top-down waypoint coverage witnesses remain separate and are not wired','No frozen runtime build/server/browser launcher','No GPU grant or executed acceptance evidence'],defaultPolicy:'greedy',qualityAccepted:false};
  const directory=await terrainExternalOutput(args['--output']);const b=JSON.stringify(result,null,2)+'\n';await writeFile(resolve(directory,'manifest.json'),b,{flag:'wx'});
  return {directory,sha256:sha256(b),runnable:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareOriginalTerrain(terrainPrepareArguments(process.argv.slice(2))).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.stack);process.exitCode=1;});
