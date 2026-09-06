import { StrataError } from '../errors.js';
import { multiplyMatrices } from '../rendering/raster-math.js';
import type { RasterPointShadowPlan } from '../rendering/geometry-provider.js';
import type { ImportedVec3 } from './imported-types.js';

/** One bounded local light; intensity uses scene-linear radiance times scene-unit distance squared. */
export interface ImportedPointLight {
  readonly id: string;
  readonly position: ImportedVec3;
  readonly color: ImportedVec3;
  readonly intensity: number;
  readonly range: number;
  readonly shadowMapSize?: 512 | 1024;
}
export type ImportedPointLightControl = Omit<ImportedPointLight, 'shadowMapSize'>;
export const pointLightUniformBytes = 432;
export function snapshotPointLight(value: ImportedPointLight): ImportedPointLight {
  const fail=():never=>{throw new StrataError('INVALID_OPTIONS','Point light needs an ID, finite position/color, intensity 0–64, range .001–1024 and shadow edge 512/1024.');};
  if(!value||typeof value.id!=='string'||!value.id.length||value.id.length>128)fail();
  if(!Array.isArray(value.position)||value.position.length!==3||value.position.some(v=>!Number.isFinite(v)||Math.abs(v)>1024))fail();
  if(!Array.isArray(value.color)||value.color.length!==3||value.color.some(v=>!Number.isFinite(v)||v<0||v>1))fail();
  if(!Number.isFinite(value.intensity)||value.intensity<0||value.intensity>64||!Number.isFinite(value.range)||value.range<.001||value.range>1024)fail();
  if(value.shadowMapSize!==undefined&&value.shadowMapSize!==512&&value.shadowMapSize!==1024)fail();
  return {id:value.id,position:[...value.position],color:[...value.color],intensity:value.intensity,range:value.range,shadowMapSize:value.shadowMapSize??512};
}
/** Matches the signed cube-face UV convention, including the two vertical faces. */
export function pointLightMatrices(position: ImportedVec3, range: number): Float32Array<ArrayBuffer>[] {
  const near=range*.001,depth=range/(near-range);
  const projection=new Float32Array([1,0,0,0,0,1,0,0,0,0,depth,-1,0,0,near*depth,0]);
  const bases=[[[0,0,-1],[0,1,0],[-1,0,0]],[[0,0,1],[0,1,0],[1,0,0]],
    [[1,0,0],[0,0,-1],[0,-1,0]],[[1,0,0],[0,0,1],[0,1,0]],
    [[1,0,0],[0,1,0],[0,0,-1]],[[-1,0,0],[0,1,0],[0,0,1]]];
  return bases.map(([right,up,back])=>{
    const dot=(v:number[])=>v.reduce((sum,x,i)=>sum+x*position[i]!,0);
    const view=new Float32Array([right![0]!,up![0]!,back![0]!,0,right![1]!,up![1]!,back![1]!,0,right![2]!,up![2]!,back![2]!,0,-dot(right!),-dot(up!),-dot(back!),1]);
    return multiplyMatrices(projection,view);
  });
}
export class ImportedPointLightResources {
  readonly texture: GPUTexture;
  readonly cache: GPUTexture | undefined;
  readonly uniform: GPUBuffer;
  readonly textureBytes: number;
  readonly data=new Float32Array(pointLightUniformBytes/4);
  readonly views: GPUTextureView[];
  readonly cacheViews: GPUTextureView[];
  private dirty=true;
  private bakedShadows=true;
  private revision=0;
  private state: ImportedPointLight | undefined;
  private matrices: Float32Array<ArrayBuffer>[]=[];
  constructor(private readonly device: GPUDevice, initial?: ImportedPointLight) {
    this.state=initial===undefined?undefined:snapshotPointLight(initial);
    const size=this.state?.shadowMapSize??1;
    if(size>device.limits.maxTextureDimension2D)throw new StrataError('UNSUPPORTED_LIMIT','Point shadow edge exceeds device limits.');
    let texture:GPUTexture|undefined,cache:GPUTexture|undefined,uniform:GPUBuffer|undefined;
    try {
      texture=device.createTexture({label:'Strata point shadow depth',size:[size,size,6],format:'depth32float',usage:0x4|0x10|0x2});
      if(this.state)cache=device.createTexture({label:'Strata immutable point shadow depth',size:[size,size,6],format:'depth32float',usage:0x10|0x4});
      uniform=device.createBuffer({label:'Strata local point light',size:pointLightUniformBytes,usage:0x40|0x8});
      this.texture=texture;this.cache=cache;this.uniform=uniform;
      this.views=Array.from({length:6},(_,baseArrayLayer)=>texture!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1}));
      this.cacheViews=cache?Array.from({length:6},(_,baseArrayLayer)=>cache!.createView({dimension:'2d',baseArrayLayer,arrayLayerCount:1})):[];
      this.textureBytes=size*size*6*4*(cache?2:1);
      this.pack();this.prepare();
    } catch(error){texture?.destroy();cache?.destroy();uniform?.destroy();throw error;}
  }
  candidate(value?: ImportedPointLightControl): ImportedPointLight | undefined {
    if(value===undefined)return this.state;
    if(!this.state||!value||value.id!==this.state.id)throw new StrataError('INVALID_OPTIONS','Point light control ID must match the scene light.');
    return snapshotPointLight({...value,shadowMapSize:this.state.shadowMapSize!});
  }
  commit(next: ImportedPointLight | undefined): boolean {
    if(JSON.stringify(next)===JSON.stringify(this.state))return false;
    if(next?.range!==this.state?.range||JSON.stringify(next?.position)!==JSON.stringify(this.state?.position))this.revision++;
    this.state=next;this.pack();this.dirty=true;return true;
  }
  setBakedShadows(enabled: boolean): boolean {
    if(enabled===this.bakedShadows)return false;
    this.bakedShadows=enabled;this.pack();this.dirty=true;return true;
  }
  invalidate():void {this.revision++;}
  private pack():void {
    const light=this.state;if(!light)return;
    this.matrices=pointLightMatrices(light.position,light.range);
    this.matrices.forEach((m,i)=>this.data.set(m,i*16));
    this.data.set([...light.position,light.range],96);this.data.set([...light.color,light.intensity],100);
    this.data.set([Number(light.intensity>0),light.range*.001,light.shadowMapSize!,Number(this.bakedShadows)],104);
  }
  prepare():number {if(!this.dirty)return 0;this.device.queue.writeBuffer(this.uniform,0,this.data);this.dirty=false;return pointLightUniformBytes;}
  plan(counts: Pick<RasterPointShadowPlan,'staticDrawCalls'|'staticTriangles'|'dynamicDrawCalls'|'dynamicTriangles'>): RasterPointShadowPlan | undefined {
    if(!this.state)return undefined;
    return {texture:this.texture,cache:this.cache!,views:this.views,cacheViews:this.cacheViews,matrices:this.matrices,
      size:this.state.shadowMapSize!,revision:this.revision,enabled:this.state.intensity>0,...counts};
  }
  get telemetry(): ImportedPointLight | null {return this.state?snapshotPointLight(this.state):null;}
}
