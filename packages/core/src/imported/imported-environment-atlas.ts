/** Seven independently filtered levels packed vertically, with a one-texel apron. */
export const environmentAtlasWidth = 66;
export const environmentAtlasHeight = 141;
export const environmentLevelOffset = (level: number): number => 128 - (128 >> level) + 2 * level;
type V3 = readonly [number, number, number];
function direction(face: number, x: number, y: number): V3 {
  return [[1,-y,-x],[-1,-y,x],[x,1,y],[x,-1,-y],[x,-y,1],[-x,-y,-1]][face]! as unknown as V3;
}
function uv(d: V3, face: number): [number, number] {
  const [x,y,z] = d;
  const p = [[-z/Math.abs(x),-y/Math.abs(x)],[z/Math.abs(x),-y/Math.abs(x)],
    [x/Math.abs(y),z/Math.abs(y)],[x/Math.abs(y),-z/Math.abs(y)],
    [x/Math.abs(z),-y/Math.abs(z)],[-x/Math.abs(z),-y/Math.abs(z)]][face]!;
  return [p[0]!*.5+.5,p[1]!*.5+.5];
}
function faceOf(d: V3): number {
  const a=d.map(Math.abs);
  return a[0]!>=a[1]!&&a[0]!>=a[2]!?(d[0]<0?1:0):a[1]!>=a[2]!?(d[1]<0?3:2):(d[2]<0?5:4);
}
function fromHalf(bits: number): number {
  const e=(bits>>10)&31, f=bits&1023;
  return (bits&32768?-1:1)*(e===0?f*2**-24:(1+f/1024)*2**(e-15));
}
function toHalf(value: number): number {
  if(value===0)return 0;
  const exponent=Math.max(-14,Math.floor(Math.log2(value))), scaled=value/2**(exponent-10);
  const integer=Math.floor(scaled), fraction=scaled-integer;
  const rounded=integer+Number(fraction>.5||(fraction===.5&&(integer&1)!==0));
  return exponent===-14&&rounded<1024?rounded:((exponent+14)<<10)+rounded;
}
/** Copy source texels exactly; only missing cube-corner means require binary16 rounding. */
export function environmentLevelApron(source: Uint16Array, edge: number): Uint16Array<ArrayBuffer> {
  if(!Number.isInteger(edge)||edge<1||edge>64||(edge&(edge-1))!==0||source.length!==edge*edge*12*4)throw new RangeError('Expected two complete RGBA16F cube levels');
  const size=edge+2, output=new Uint16Array(size*size*12*4);
  const texel=(preset:number,face:number,d:V3,channel:number)=>{
    const q=uv(d,face),x=Math.max(0,Math.min(edge-1,Math.floor(q[0]*edge))),y=Math.max(0,Math.min(edge-1,Math.floor(q[1]*edge)));
    return source[(((preset*6+face)*edge+y)*edge+x)*4+channel]!;
  };
  for(let layer=0;layer<12;layer++)for(let y=-1;y<=edge;y++)for(let x=-1;x<=edge;x++) {
    const dst=((layer*size+y+1)*size+x+1)*4,face=layer%6,preset=Math.floor(layer/6);
    if(x>=0&&x<edge&&y>=0&&y<edge){output.set(source.subarray(((layer*edge+y)*edge+x)*4,((layer*edge+y)*edge+x)*4+4),dst);continue;}
    const px=(x+.5)*2/edge-1,py=(y+.5)*2/edge-1;
    const corner=(x<0||x>=edge)&&(y<0||y>=edge);
    const d=direction(face,corner?Math.sign(px):px,corner?Math.sign(py):py);
    const faces=corner?[d[0]<0?1:0,d[1]<0?3:2,d[2]<0?5:4]:[faceOf(d)];
    for(let c=0;c<4;c++)output[dst+c]=corner?toHalf(faces.reduce((sum,f)=>sum+fromHalf(texel(preset,f,d,c)),0)/3):texel(preset,faces[0]!,d,c);
  }
  return output;
}
export function uploadEnvironmentLevel(device: GPUDevice, texture: GPUTexture, level: number, source: Uint16Array): void {
  if(!Number.isInteger(level)||level<0||level>6)throw new RangeError('Invalid environment level');
  const edge=64>>level,size=edge+2, data=environmentLevelApron(source,edge);
  device.queue.writeTexture({texture,origin:[0,environmentLevelOffset(level),0]},data,
    {bytesPerRow:size*8,rowsPerImage:size},[size,size,12]);
}
