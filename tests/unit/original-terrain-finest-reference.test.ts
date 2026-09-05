import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeFinestReferencePage, decodeOriginalTerrainFinest, ORIGINAL_FINEST_REFERENCE } from '../helpers/original-terrain-finest-reference.js';
import type { ReferenceCluster, ReferencePage } from '../helpers/original-terrain-finest-reference.js';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const backing = new Uint8Array(65536 + 20), bytes = backing.subarray(12, 12 + 65536), d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const clusters: ReferenceCluster[] = [0, 1].map(id => ({ id, pageId: 7, vertexOffset: 16 + id * 512, vertexCount: 4,
    indexOffset: 160 + id * 512, indexCount: 6, triangleCount: 2, bounds: { min: [id * 10, 0, 0], max: [id * 10 + 1, 0, 1] } }));
  for (const c of clusters) {
    [[0,0,0],[0,0,1],[1,0,0],[1,0,1]].forEach((p,i) => [p[0]!+c.id*10,p[1]!,p[2]!,0,1,0,p[0]!,p[2]!]
      .forEach((x,j)=>d.setFloat32(c.vertexOffset+i*32+j*4,x,true)));
    [0,1,2,2,1,3].forEach((x,i)=>d.setUint32(c.indexOffset+i*4,x,true));
  }
  const page: ReferencePage = { id:7,url:'pages/000007.bin',byteLength:65536,sha256:sha(bytes) };
  return {bytes,d,clusters,page};
}
function rehash(f: ReturnType<typeof fixture>) { return {...f.page,sha256:sha(f.bytes)}; }
describe('independent finest page decoding',()=>{
  it('decodes little-endian nonzero offsets and rebases cluster-local indices without changing source order',async()=>{
    const f=fixture();const saved=await decodeFinestReferencePage(f.page,f.clusters,f.bytes);
    expect([...saved.positions]).toEqual([0,0,0,0,0,1,1,0,0,1,0,1,10,0,0,10,0,1,11,0,0,11,0,1]);
    expect([...saved.indices]).toEqual([0,1,2,2,1,3,4,5,6,6,5,7]);
    expect(saved.ranges).toEqual([{clusterId:0,vertexStart:0,vertexCount:4,indexStart:0,indexCount:6},{clusterId:1,vertexStart:4,vertexCount:4,indexStart:6,indexCount:6}]);
    expect(saved.typedBytes).toBe(8*12+12*4);expect(saved.minProjectedCrossY).toBe(1);
  });
  it('hashes padding and exact visible bytes, rejecting truncation or source mutation',async()=>{
    const f=fixture();f.bytes[65000]=9;await expect(decodeFinestReferencePage(f.page,f.clusters,f.bytes)).rejects.toThrow(/hash mismatch/);
    await expect(decodeFinestReferencePage(f.page,f.clusters,f.bytes.subarray(1))).rejects.toThrow(/byte length/);
    await expect(decodeFinestReferencePage({...f.page,sha256:'X'.repeat(64)},f.clusters,f.bytes)).rejects.toThrow(/SHA/);
  });
  it('snapshots metadata and bytes before hashing instead of decoding mutable caller state',async()=>{
    const f=fixture(),p=decodeFinestReferencePage(f.page,f.clusters,f.bytes);f.bytes.fill(255);
    (f.clusters[0]!.bounds.min as number[])[0]=999;f.clusters[0]={...f.clusters[0]!,indexOffset:40000};
    const result=await p;expect(result.positions[0]).toBe(0);expect([...result.indices.slice(0,3)]).toEqual([0,1,2]);expect(result.sha256).toBe(f.page.sha256);
  });
  it.each(['vertex-range','index-range','unaligned','overlap','duplicate','page-owner','counts','bounds','url'] as const)('rejects %s metadata without treating it as a decode hint',async(kind)=>{
    const f=fixture();let c=f.clusters[0]!;
    if(kind==='vertex-range')c={...c,vertexOffset:65532};if(kind==='index-range')c={...c,indexOffset:65520};
    if(kind==='unaligned')c={...c,vertexOffset:17};if(kind==='overlap')c={...c,indexOffset:20};
    if(kind==='duplicate')f.clusters[1]={...f.clusters[1]!,id:0};if(kind==='page-owner')c={...c,pageId:8};
    if(kind==='counts')c={...c,indexCount:5};if(kind==='bounds')c={...c,bounds:{min:[0,0],max:[1,0,1]}};
    f.clusters[0]=c;const page=kind==='url'?{...f.page,url:'../000007.bin'}:f.page;
    await expect(decodeFinestReferencePage(page,f.clusters,f.bytes)).rejects.toThrow();
  });
  it.each(['local-index','nonfinite-position','nonfinite-uv','out-of-bounds','normal','reversed','degenerate'] as const)('rejects authenticated %s corruption rather than repairing it',async(kind)=>{
    const f=fixture(),c=f.clusters[0]!;
    if(kind==='local-index')f.d.setUint32(c.indexOffset,4,true);
    if(kind==='nonfinite-position')f.d.setFloat32(c.vertexOffset,NaN,true);
    if(kind==='nonfinite-uv')f.d.setFloat32(c.vertexOffset+28,Infinity,true);
    if(kind==='out-of-bounds')f.d.setFloat32(c.vertexOffset,2,true);
    if(kind==='normal')f.d.setFloat32(c.vertexOffset+16,2,true);
    if(kind==='reversed'){f.d.setUint32(c.indexOffset+4,2,true);f.d.setUint32(c.indexOffset+8,1,true);}
    if(kind==='degenerate')f.d.setUint32(c.indexOffset+4,0,true);
    await expect(decodeFinestReferencePage(rehash(f),f.clusters,f.bytes)).rejects.toThrow();
  });
  it('honors cancellation before work and after the asynchronous hash',async()=>{
    const f=fixture(),before=new AbortController();before.abort(new Error('before'));
    await expect(decodeFinestReferencePage(f.page,f.clusters,f.bytes,before.signal)).rejects.toThrow('before');
    const during=new AbortController(),pending=decodeFinestReferencePage(f.page,f.clusters,f.bytes,during.signal);during.abort(new Error('during'));
    await expect(pending).rejects.toThrow('during');
  });
});
describe('original-asset admission',()=>{
  it('rejects a generated or mutated manifest before any page reads; original admission cannot be overridden',async()=>{
    let reads=0;const reader=async()=>{reads++;return new Uint8Array(65536);};
    await expect(decodeOriginalTerrainFinest(new TextEncoder().encode('{"format":"strata-geometry"}'),reader)).rejects.toThrow(/original manifest hash/);
    await expect(decodeOriginalTerrainFinest(new Uint8Array(),reader)).rejects.toThrow(/manifest byte length/);
    expect(reads).toBe(0);expect(ORIGINAL_FINEST_REFERENCE.positionBytes+ORIGINAL_FINEST_REFERENCE.indexBytes).toBe(41091072);
    const controller=new AbortController();controller.abort(new Error('cancelled'));
    await expect(decodeOriginalTerrainFinest(new Uint8Array([0]),reader,{signal:controller.signal})).rejects.toThrow('cancelled');expect(reads).toBe(0);
  });
});
