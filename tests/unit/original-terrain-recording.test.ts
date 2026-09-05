import { describe, expect, it } from 'vitest';
import { ORIGINAL_TERRAIN, TerrainDiagnosticRecorder, observeTerrainFeedback, terrainDiagnosticStep, terrainTimingWindows, reserveTerrainEvidence } from '../helpers/original-terrain-recording.js';
import type { GeometrySnapshot, TerrainFrameEvidence, TerrainTopology } from '../helpers/original-terrain-recording.js';
function geometry(overrides: Partial<GeometrySnapshot> = {}): GeometrySnapshot {
  return { sourceFrameId: 0, requestsStarted: 24, requestsCompleted: 24, requestsFailed: 0, requestsCancelled: 0,
    evictions: 0, uploadedPages: 24, uploadedBytes: 24 * 65536, fetchedBytes: 24 * 65536, discardedCompletions: 0,
    poolBytes: 8388608, residentPages: 88, pendingRequests: 0, stagingReservedBytes: 0, coverageMissingTiles: 0, overflowCount: 0, ...overrides };
}
function topology(): TerrainTopology {
  // Synthetic dependencies for schema tests only; the preparation command hashes the actual manifest/pages.
  return { manifestSha256: ORIGINAL_TERRAIN.manifestSha256, rootPages: Array.from({length:24},(_,i)=>i),
    dependencies: Array.from({length:64},(_,i)=>[[24+i],[24+i],[24+i],[i%24]]) };
}
function frame(index = 0): TerrainFrameEvidence {
  const feedback = new Uint32Array(528), residency = new Uint32Array(1199).fill(0xffffffff);
  for(let i=0;i<88;i++)residency[i]=i;
  for(let i=0;i<64;i++)feedback[16+i*8+2]=1;
  // Deliberately only a structural PNG header: decoding/authentic raster evidence is a later browser gate.
  const png = new Uint8Array(33); png.set([137,80,78,71,13,10,26,10]);
  const view=new DataView(png.buffer);view.setUint32(8,13);png.set([73,72,68,82],12);view.setUint32(16,1280);view.setUint32(20,720);
  return {index,frameId:index+100,feedbackSourceFrameId:index+100,timeSeconds:index/60,cameraCut:false,
    viewProjection:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],feedback,residency,geometry:geometry(),pageUploadBytes:0,images:index%6===0?[{index,frameId:index+100,png}]:[]};
}
const make=()=>new TerrainDiagnosticRecorder('B','streamed','greedy',1280,720,topology());
const cleanup={disposed:true,buffers:0,textures:0,wasm:0,pendingRequests:0,pendingReadbacks:0,errors:[]};
describe('original terrain capture counter boundary',()=>{
  it('separates capture-start, last measured and later drained bytes without mutating the source',()=>{
    const start=geometry(), last=geometry({sourceFrameId:2,uploadedPages:26,uploadedBytes:26*65536}), drained=geometry({sourceFrameId:4,uploadedPages:29,uploadedBytes:29*65536});
    const value=terrainTimingWindows({frames:[{frameId:3,elapsedMs:0,geometry:last}],assetTraffic:{geometryAtCaptureStart:start,geometryAtCaptureEnd:drained}});
    expect(value.measuredDelta.uploadedBytes).toBe(2*65536);expect(value.postMeasurementDrainDelta.uploadedBytes).toBe(3*65536);
    last.uploadedBytes=0;expect(value.lastMeasured.uploadedBytes).toBe(26*65536);
  });
  it('rejects negative first elapsed time, including the formerly admitted fractional interval',()=>{
    const base={frames:[{frameId:1,elapsedMs:0,geometry:geometry()}],assetTraffic:{geometryAtCaptureStart:geometry(),geometryAtCaptureEnd:geometry()}};
    expect(()=>terrainTimingWindows(base)).not.toThrow();
    for(const elapsedMs of [-.5,-Number.MIN_VALUE,-1,-100]){
      expect(()=>terrainTimingWindows({...base,frames:[{...base.frames[0]!,elapsedMs}]})).toThrow(/Invalid measured time/);
    }
  });
  it('rejects counter reset, duplicate/unordered frames and future feedback',()=>{
    const run={frames:[{frameId:1,elapsedMs:0,geometry:geometry()}],assetTraffic:{geometryAtCaptureStart:geometry(),geometryAtCaptureEnd:geometry()}};
    expect(()=>terrainTimingWindows({...run,frames:[{...run.frames[0]!,geometry:geometry({uploadedBytes:0})}]})).toThrow(/decreased/);
    expect(()=>terrainTimingWindows({...run,frames:[run.frames[0]!,run.frames[0]!]})).toThrow(/advance/);
    expect(()=>terrainTimingWindows({...run,frames:[{...run.frames[0]!,geometry:geometry({sourceFrameId:2})}]})).toThrow(/future/);
  });
});
describe('original moving observation schema',()=>{
  it('bounds accumulated evidence without allocating a full corpus',()=>{
    expect(reserveTerrainEvidence(ORIGINAL_TERRAIN.maxCaseEvidenceBytes-10,10)).toBe(ORIGINAL_TERRAIN.maxCaseEvidenceBytes);
    expect(()=>reserveTerrainEvidence(ORIGINAL_TERRAIN.maxCaseEvidenceBytes-10,11)).toThrow(/cap/);
    expect(()=>reserveTerrainEvidence(0,ORIGINAL_TERRAIN.maxFrameEvidenceBytes+1)).toThrow(/cap/);
  });
  it('retains all3600 frame receipts with600 fixed 10Hz images; completion never claims visual acceptance',async()=>{
    const recorder=make();for(let i=0;i<3600;i++) await recorder.record(frame(i));
    const result=recorder.complete(cleanup);expect(result.frames).toBe(3600);expect(result.images).toBe(600);expect(result.boundaryCensoredBrackets).toEqual([]);expect(result.fullBracketCoverage).toBe(true);expect(result.qualityAccepted).toBe(false);
    await expect(recorder.record(frame(3600))).rejects.toThrow(/closed/);
  });
  it('exposes a deliberate all-root quality regression despite preserved physical coverage',async()=>{
    const f=frame();for(let i=0;i<64;i++)f.feedback[16+i*8+1]=3;f.feedback[11]=64;
    const value=await make().record(f);expect(value.missingDetailTiles).toBe(64);expect(value.finerFallbackTiles).toBe(0);
    expect(value.selections.every(x=>x.selected>x.desired)).toBe(true);
  });
  it('rejects missing, repeated and stale source/image frame IDs',async()=>{
    await expect(make().record(frame(1))).rejects.toThrow(/step/);
    const stale=frame();stale.feedbackSourceFrameId--;await expect(make().record(stale)).rejects.toThrow(/Stale/);
    stale.feedbackSourceFrameId=stale.frameId;stale.images[0]!.frameId--;await expect(make().record(stale)).rejects.toThrow(/Stale/);
    const r=make();await r.record(frame());await expect(r.record(frame())).rejects.toThrow(/step/);
    expect(()=>make().complete(cleanup)).toThrow(/Incomplete/);
  });
  it('copies mapped bytes before unmap/reuse and does not conflate finer fallback with missing detail',async()=>{
    const f=frame();f.feedback[16]=2;
    const pending=make().record(f);f.feedback.fill(0xffffffff);f.residency.fill(0xffffffff);f.images[0]!.png.fill(0);
    const saved=await pending;expect(saved.finerFallbackTiles).toBe(1);expect(saved.missingDetailTiles).toBe(0);expect(saved.feedback[16]).toBe(2);expect(saved.images[0]!.png[0]).toBe(137);
  });
  it.each(['root','dependency','alias','pool','staging','upload','flags','aggregate','negative'])('rejects %s corruption',async(kind)=>{
    const f=frame();
    if(kind==='root')f.residency[0]=0xffffffff;
    if(kind==='dependency')f.residency[24]=0xffffffff;
    if(kind==='alias')f.residency[24]=23;
    if(kind==='pool')f.geometry.poolBytes*=2;
    if(kind==='staging')f.geometry.stagingReservedBytes=327680;
    if(kind==='upload')f.pageUploadBytes=327680;
    if(kind==='flags')f.feedback[18]=2;
    if(kind==='aggregate')f.feedback[11]=1;
    if(kind==='negative')f.geometry.pendingRequests=-1;
    await expect(make().record(f)).rejects.toThrow();
  });
  it('rejects malformed image dimensions/size and blocks late or concurrent completions',async()=>{
    const f=frame();new DataView(f.images[0]!.png.buffer).setUint32(16,640);await expect(make().record(f)).rejects.toThrow(/resolution/);
    f.images[0]!.png=new Uint8Array(ORIGINAL_TERRAIN.maxImageBytes+1);await expect(make().record(f)).rejects.toThrow(/cap/);
    const r=make(),p=r.record(frame());r.cancel();await expect(p).rejects.toThrow(/Late/);expect(r.progress.frames).toBe(0);
    const c=make(),first=c.record(frame());await expect(c.record(frame())).rejects.toThrow(/busy/);await expect(first).rejects.toThrow(/failure/);
  });
  it('freezes original topology and rejects unsupported dimensions/reference policy',()=>{
    expect(()=>new TerrainDiagnosticRecorder('B','resident-full','retain-fallback',1280,720,topology())).toThrow();
    expect(()=>new TerrainDiagnosticRecorder('B','streamed','greedy',640,360,topology())).toThrow();
    const t=topology();t.rootPages=[0,...t.rootPages.slice(0,23)];expect(()=>new TerrainDiagnosticRecorder('B','streamed','greedy',1280,720,t)).toThrow();
  });
  it('preserves all1201 C submissions with continuous movement and explicit arrival resets',async()=>{
    const all=Array.from({length:1201},(_,i)=>terrainDiagnosticStep('C',i));
    expect(all.filter(s=>s.cameraCut).map(s=>s.index)).toEqual([0,180,360,540,720,900,1080]);
    expect(all[120]).toEqual({index:120,timeSeconds:0,cameraCut:false});
    expect(all[121]!.timeSeconds).toBeCloseTo(.16,12);
    const poses=[0,9.6,19.2,28.8,38.4,48,57.6];
    for(let leg=0;leg<6;leg++){
      const begin=121+180*leg,arrival=180+180*leg;
      for(let i=begin;i<=arrival;i++)expect(all[i]!.timeSeconds-all[i-1]!.timeSeconds).toBeCloseTo(.16,12);
      for(let i=arrival;i<=arrival+120;i++)expect(all[i]!.timeSeconds).toBe(poses[leg+1]);
    }
    expect(()=>terrainDiagnosticStep('C',1201)).toThrow();
    const r=new TerrainDiagnosticRecorder('C','streamed','greedy',1280,720,topology());
    for(const step of all){const f=frame(step.index);Object.assign(f,step);f.images=[{index:step.index,frameId:f.frameId,png:frame().images[0]!.png}];await r.record(f);}
    expect(r.complete(cleanup)).toMatchObject({frames:1201,images:1201});
  });
  it('commits the snapshotted native ID despite asynchronous caller mutation and rejects omitted submissions',async()=>{
    const r=make(),f=frame(),p=r.record(f);f.frameId=9999;
    expect((await p).frameId).toBe(100);await r.record(frame(1));
    const skipped=frame(2);skipped.frameId=103;skipped.feedbackSourceFrameId=103;
    await expect(r.record(skipped)).rejects.toThrow(/consecutive/);
    const duplicate=make();await duplicate.record(frame());const next=frame(1);next.frameId=100;next.feedbackSourceFrameId=100;
    await expect(duplicate.record(next)).rejects.toThrow(/consecutive/);
  });
  it('captures previous/current/next actual selected-LOD transitions with deduplication and endpoint clipping',async()=>{
    const r=make(),saved:number[]=[];let selected=0;
    for(let i=0;i<3600;i++){
      if([2,3,3599].includes(i))selected=1-selected;
      const f=frame(i);f.feedback[17]=selected;f.feedback[11]=selected;
      const required=r.imageRequirements(f.feedback);f.images=required.indices.map(index=>({index,frameId:index+100,png:frame().images[0]!.png}));
      const result=await r.record(f);saved.push(...result.images.map(image=>image.index));
    }
    const required=new Set([...Array.from({length:600},(_,i)=>i*6),1,2,3,4,3598,3599]);
    expect(saved).toEqual([...required].sort((a,b)=>a-b));expect(r.complete(cleanup)).toMatchObject({status:'complete',frames:3600,images:606,boundaryCensoredBrackets:[{transitionIndex:3599,missingIndex:3600}],fullBracketCoverage:false});
  });
  it('fails incomplete when a transition bracket image is omitted instead of trimming frame evidence',async()=>{
    const r=make();await r.record(frame());await r.record(frame(1));
    const f=frame(2);f.feedback[17]=1;f.feedback[11]=1;
    expect(r.imageRequirements(f.feedback).indices).toEqual([1,2]);
    f.images=[{index:2,frameId:102,png:frame().images[0]!.png}];
    await expect(r.record(f)).rejects.toThrow(/required images/);expect(()=>r.complete(cleanup)).toThrow(/Incomplete/);
  });
});
describe('native feedback interception without a new pass/buffer',()=>{
  it('preserves native receiver, exact map promise/range and capture-at-map ticket, restoring methods',async()=>{
    const bytes=new ArrayBuffer(2112), promise=Promise.resolve();let current={frameId:20,generation:2};const events:unknown[]=[];const calls:unknown[]=[];
    const buffer={label:'Strata geometry feedback 0',size:2112,mapAsync(...args:unknown[]){expect(this).toBe(buffer);calls.push(args);return promise;},getMappedRange(...args:unknown[]){expect(this).toBe(buffer);calls.push(args);return bytes;}};
    const originalMap=buffer.mapAsync,originalRead=buffer.getMappedRange;
    const hook=observeTerrainFeedback(buffer,()=>current,e=>events.push(e));expect(buffer.mapAsync(1,0,2112)).toBe(promise);
    current={frameId:21,generation:3};await promise;expect(buffer.getMappedRange()).toBe(bytes);new Uint32Array(bytes)[0]=7;
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({frameId:20,generation:2});expect(new Uint32Array((events[0] as {bytes:ArrayBuffer}).bytes)[0]).toBe(0);
    expect(calls).toEqual([[1,0,2112],[]]);hook.detach();expect(buffer.mapAsync).toBe(originalMap);expect(buffer.getMappedRange).toBe(originalRead);expect(hook.errors).toEqual([]);
  });
  it('latches missing-map observation failures and does not observe after detach',()=>{
    const buffer={label:'Strata geometry feedback 1',size:2112,mapAsync:()=>Promise.resolve(),getMappedRange:()=>new ArrayBuffer(2112)};
    let count=0;const hook=observeTerrainFeedback(buffer,()=>({frameId:1,generation:0}),()=>count++);
    expect(()=>buffer.getMappedRange()).toThrow(/map invocation/);expect(hook.errors).toHaveLength(1);hook.detach();buffer.getMappedRange();expect(count).toBe(0);
  });
});
