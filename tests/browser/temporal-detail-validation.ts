import { TemporalResolve } from '../../packages/core/src/rendering/temporal-resolve.js';
import { cameraJitter } from '../../packages/core/src/rendering/raster-math.js';
import type { TemporalInputs } from '../../packages/core/src/rendering/raster-types.js';

type Vec2 = readonly [number, number];
type Target = 'current-jittered-point' | 'pixel-box-integral';
type Scenario = 'static-sinusoids' | 'slanted-edge' | 'moving-sinusoids' | 'zooming-sinusoids';
const size = 128;
const inset = 8;
const depth = 4;
const checkpoints = [1, 8, 32, 128] as const;
const frequencies: readonly Vec2[] = [[1 / 16, 0], [3 / 16, 0], [5 / 16, 1 / 8]];
const phases = [.23, -.41, .67];
const halfTolerance = .002;
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const sinc = (x: number): number => x === 0 ? 1 : Math.sin(x) / x;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function roundEven(value: number): number { const floor = Math.floor(value), remainder = value - floor; return floor + Number(remainder > .5 || (remainder === .5 && floor % 2 !== 0)); }
/** Test-only IEEE half packing; readback itself uses float32 storage, not this conversion. */
function half(value: number): number {
  f32[0] = value; const word = u32[0]!, sign = (word >>> 16) & 0x8000, exponent = ((word >>> 23) & 255) - 127 + 15;
  const mantissa = word & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const magnitude = (mantissa | 0x800000) / 2 ** (14 - exponent);
    const rounded = roundEven(magnitude); return sign | rounded;
  }
  const fraction = mantissa / 8192;
  const rounded = roundEven(fraction);
  return sign | ((exponent << 10) + rounded);
}

function transform(scenario: Scenario, frame: number): { scale: number; offset: Vec2 } {
  return { scale: scenario === 'zooming-sinusoids' ? 1 + frame / 512 : 1,
    offset: scenario === 'moving-sinusoids' ? [frame / 4, 0] : [0, 0] };
}
function worldAt(pixel: Vec2, jitter: Vec2, scenario: Scenario, frame: number): Vec2 {
  const current = transform(scenario, frame);
  return [(pixel[0] - size / 2 - jitter[0] - current.offset[0]) / current.scale + size / 2,
    (pixel[1] - size / 2 - jitter[1] - current.offset[1]) / current.scale + size / 2];
}
function previousPixel(world: Vec2, jitter: Vec2, scenario: Scenario, frame: number): Vec2 {
  const previous = transform(scenario, Math.max(0, frame - 1));
  return [(world[0] - size / 2) * previous.scale + size / 2 + previous.offset[0] + jitter[0],
    (world[1] - size / 2) * previous.scale + size / 2 + previous.offset[1] + jitter[1]];
}
const edgeDistance = (x: number, y: number): number => x - 3 / 7 * y - 34.37;
function pointSignal(scenario: Scenario, point: Vec2): readonly [number, number, number] {
  if (scenario === 'slanted-edge') { const side = Number(edgeDistance(point[0], point[1]) >= 0); return [.25 + side, .5 + .5 * side, .125 + 2 * side]; }
  return frequencies.map(([x, y], channel) => 1 + .5 * Math.sin(2 * Math.PI * (x * point[0] + y * point[1]) + phases[channel]!)) as unknown as readonly [number, number, number];
}
/** Exact geometric area of the bright half-plane clipped against the unit pixel square. */
function edgeCoverage(x: number, y: number): number {
  const square: Vec2[] = [[x - .5, y - .5], [x + .5, y - .5], [x + .5, y + .5], [x - .5, y + .5]];
  const polygon: Vec2[] = [];
  for (let edge = 0; edge < square.length; edge++) {
    const a = square[edge]!, b = square[(edge + 1) % square.length]!;
    const da = edgeDistance(...a), db = edgeDistance(...b);
    if (da >= 0) polygon.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); polygon.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
  }
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) { const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!; twiceArea += a[0] * b[1] - a[1] * b[0]; }
  return Math.min(1, Math.max(0, Math.abs(twiceArea) / 2));
}
function reference(scenario: Scenario, frame: number, x: number, y: number, target: Target): readonly number[] {
  if (target === 'current-jittered-point') return pointSignal(scenario, worldAt([x, y], cameraJitter(frame), scenario, frame));
  if (scenario === 'slanted-edge') { const coverage = edgeCoverage(x, y); return [.25 + coverage, .5 + .5 * coverage, .125 + 2 * coverage]; }
  const world = worldAt([x, y], [0, 0], scenario, frame), scale = transform(scenario, frame).scale;
  return frequencies.map(([fx, fy], channel) => 1 + .5 * sinc(Math.PI * fx / scale) * sinc(Math.PI * fy / scale)
    * Math.sin(2 * Math.PI * (fx * world[0] + fy * world[1]) + phases[channel]!));
}
function fixture(scenario: Scenario, frame: number) {
  const jitter = cameraJitter(frame), previousJitter = cameraJitter(Math.max(0, frame - 1));
  const hdr = new Uint16Array(size * size * 4), motion = new Uint16Array(hdr.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const pixel: Vec2 = [x + .5, y + .5], world = worldAt(pixel, jitter, scenario, frame), previous = previousPixel(world, previousJitter, scenario, frame);
    const at = (y * size + x) * 4, color = pointSignal(scenario, world);
    hdr.set([half(color[0]), half(color[1]), half(color[2]), half(1)], at);
    motion.set([half((previous[0] - pixel[0]) / size), half((previous[1] - pixel[1]) / size), half(depth), half(depth)], at);
  }
  return { hdr, motion, jitter, previousJitter };
}

const readShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(source);
  if (any(id.xy >= size)) { return; }
  result[id.y * size.x + id.x] = textureLoad(source, vec2i(id.xy), 0);
}`;
class Reader {
  private readonly storage: GPUBuffer;
  private readonly readback: GPUBuffer;
  private constructor(private readonly device: GPUDevice, private readonly pipeline: GPUComputePipeline) {
    this.storage = device.createBuffer({ label: 'Temporal detail float32 extraction', size: size * size * 16, usage: 0x80 | 0x4 });
    try { this.readback = device.createBuffer({ label: 'Temporal detail readback', size: size * size * 16, usage: 0x8 | 0x1 }); }
    catch (error) { this.storage.destroy(); throw error; }
  }
  static async create(device: GPUDevice): Promise<Reader> {
    const module = device.createShaderModule({ label: 'Temporal detail readback shader', code: readShader });
    return new Reader(device, await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } }));
  }
  encode(encoder: GPUCommandEncoder, view: GPUTextureView): void {
    const group = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: this.storage } }] });
    const pass = encoder.beginComputePass({ label: 'Temporal detail exact float32 extraction' }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(size / 8, size / 8); pass.end();
    encoder.copyBufferToBuffer(this.storage, 0, this.readback, 0, size * size * 16);
  }
  async read(): Promise<Float32Array<ArrayBuffer>> {
    await this.readback.mapAsync(0x1);
    try { return new Float32Array(this.readback.getMappedRange().slice(0)); }
    finally { this.readback.unmap(); }
  }
  dispose(): void { if (this.readback.mapState === 'mapped') this.readback.unmap(); this.storage.destroy(); this.readback.destroy(); }
}
/** Independent least-squares fit of DC, sine and cosine, including non-integer zoomed ROI periods. */
function solve3(matrix: number[][], vector: number[]): number[] {
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < 3; column++) {
    let pivot = column; for (let row = column + 1; row < 3; row++) if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    [augmented[pivot], augmented[column]] = [augmented[column]!, augmented[pivot]!];
    const scale = augmented[column]![column]!; require(Math.abs(scale) > 1e-12, 'Singular analytic contrast fit.');
    for (let i = column; i < 4; i++) augmented[column]![i]! /= scale;
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = augmented[row]![column]!;
      for (let i = column; i < 4; i++) augmented[row]![i]! -= factor * augmented[column]![i]!;
    }
  }
  return augmented.map(row => row[3]!);
}
function metrics(output: Float32Array, scenario: Scenario, frame: number, target: Target) {
  require(output.every(Number.isFinite), `${scenario}: output contains a non-finite value.`);
  let depthError = 0; for (let at = 3; at < output.length; at += 4) depthError = Math.max(depthError, Math.abs(output[at]! - depth));
  require(depthError <= halfTolerance, `${scenario}: positive view depth was not preserved.`);
  const channels = frequencies.map(([fx, fy], channel) => {
    let samples = 0, sum = 0, squared = 0, maximum = 0, bandError = 0, bandSamples = 0;
    const matrix = [[0,0,0], [0,0,0], [0,0,0]], vector = [0,0,0];
    for (let y = inset; y < size - inset; y++) for (let x = inset; x < size - inset; x++) {
      const value = output[(y * size + x) * 4 + channel]!, desired = reference(scenario, frame, x + .5, y + .5, target)[channel]!;
      const error = Math.abs(value - desired); samples++; sum += error; squared += error * error; maximum = Math.max(maximum, error);
      if (scenario === 'slanted-edge') { if (Math.abs(edgeDistance(x + .5, y + .5)) <= 2) { bandError += error; bandSamples++; } }
      else {
        const world = worldAt([x + .5, y + .5], target === 'current-jittered-point' ? cameraJitter(frame) : [0,0], scenario, frame);
        const angle = 2 * Math.PI * (fx * world[0] + fy * world[1]) + phases[channel]!;
        const basis = [1, Math.sin(angle), Math.cos(angle)];
        for (let row = 0; row < 3; row++) { vector[row]! += basis[row]! * value; for (let column = 0; column < 3; column++) matrix[row]![column]! += basis[row]! * basis[column]!; }
      }
    }
    if (scenario === 'slanted-edge') return { channel, samples, mae: sum / samples, rmse: Math.sqrt(squared / samples), maximumError: maximum,
      edgeBandSamples: bandSamples, edgeBandMae: bandError / Math.max(1,bandSamples), dc: null, fittedAmplitude: null, referenceAmplitude: null, amplitudeRatio: null, phaseRadians: null };
    const fit = solve3(matrix, vector), scale = transform(scenario, frame).scale;
    const expected = target === 'current-jittered-point' ? .5 : .5 * sinc(Math.PI * fx / scale) * sinc(Math.PI * fy / scale), amplitude = Math.hypot(fit[1]!, fit[2]!);
    return { channel, samples, mae: sum / samples, rmse: Math.sqrt(squared / samples), maximumError: maximum, edgeBandSamples: 0, edgeBandMae: null,
      dc: fit[0]!, fittedAmplitude: amplitude, referenceAmplitude: expected, amplitudeRatio: amplitude / expected, phaseRadians: Math.atan2(fit[2]!, fit[1]!) };
  });
  return { target, depthError, channels };
}

function measureTargets(output: Float32Array, scenario: Scenario, frame: number) {
  return { targets: { currentJitteredPoint: metrics(output,scenario,frame,'current-jittered-point'),
    pixelBoxIntegral: metrics(output,scenario,frame,'pixel-box-integral') } };
}

async function runScenario(device: GPUDevice, reader: Reader, scenario: Scenario) {
  const temporal = await TemporalResolve.create(device); const textures: GPUTexture[] = [];
  const make = (label: string) => { const texture = device.createTexture({ label, size: [size,size], format: 'rgba16float', usage: 0x2 | 0x4 }); textures.push(texture); return texture; };
  try {
    const hdr = make('Temporal detail synthetic unlit HDR'), motion = make('Temporal detail analytic motion'); const hdrView = hdr.createView(), motionView = motion.createView();
    const observations = [];
    for (let frame = 0; frame < checkpoints.at(-1)!; frame++) {
      const current = fixture(scenario, frame);
      device.queue.writeTexture({texture:hdr},current.hdr,{bytesPerRow:size*8},[size,size]);
      device.queue.writeTexture({texture:motion},current.motion,{bytesPerRow:size*8},[size,size]);
      const inputs: TemporalInputs = { hdr: hdrView, motion: motionView };
      const encoder = device.createCommandEncoder({ label: `Temporal detail ${scenario}/${frame+1}` });
      const resolved = temporal.encode(encoder, inputs, size, size, frame > 0);
      const observe = checkpoints.some(value => value === frame+1);
      if (observe) reader.encode(encoder,resolved.view); device.queue.submit([encoder.finish()]);
      if (observe) observations.push({frame:frame+1, jitter:current.jitter, previousJitter:current.previousJitter,
        scale:transform(scenario,frame).scale, offset:transform(scenario,frame).offset,
        historyValid:resolved.historyValid, temporalUniformUploadBytes:resolved.uploadBytes,
        ...measureTargets(await reader.read(),scenario,frame)});
      // Queueing is bounded even between observation frames; this is correctness, never a timing run.
      else if ((frame+1)%8===0) await device.queue.onSubmittedWorkDone();
    }
    return {scenario,observations};
  } finally { temporal.dispose(); for (const texture of textures) texture.destroy(); }
}

async function depthGuard(device: GPUDevice, reader: Reader) {
  const temporal = await TemporalResolve.create(device); const textures: GPUTexture[] = [];
  const make = () => { const texture = device.createTexture({size:[size,size],format:'rgba16float',usage:0x2|0x4});textures.push(texture);return texture; };
  try {
    const hdr=make(),motion=make(),hdrView=hdr.createView(),motionView=motion.createView(); const outputs=[];
    // Seed a bright foreign surface, then reveal a patterned depth-four surface.
    for (let frame=0;frame<2;frame++) {
      const data=fixture('static-sinusoids',frame);
      if(frame===0) for(let at=0;at<data.hdr.length;at+=4){data.hdr.set([half(16),half(8),half(4),half(1)],at);data.motion[at+2]=half(12);data.motion[at+3]=half(12);}
      device.queue.writeTexture({texture:hdr},data.hdr,{bytesPerRow:size*8},[size,size]);device.queue.writeTexture({texture:motion},data.motion,{bytesPerRow:size*8},[size,size]);
      const inputs:TemporalInputs={hdr:hdrView,motion:motionView};
      const encoder=device.createCommandEncoder();const result=temporal.encode(encoder,inputs,size,size,frame>0);reader.encode(encoder,result.view);device.queue.submit([encoder.finish()]);outputs.push(await reader.read());
    }
    const current=fixture('static-sinusoids',1); let maxError=0;
    for(let y=inset;y<size-inset;y++)for(let x=inset;x<size-inset;x++){
      const color=pointSignal('static-sinusoids',worldAt([x+.5,y+.5],current.jitter,'static-sinusoids',1));
      for(let channel=0;channel<3;channel++)maxError=Math.max(maxError,Math.abs(outputs[1]![(y*size+x)*4+channel]!-color[channel]!));
    }
    require(outputs.every(values=>values.every(Number.isFinite)),'Foreign-depth output is not finite.');
    require(maxError<=halfTolerance,`Foreign depth leaked into a disoccluded surface (${maxError}).`);
    return {scenario:'foreign-depth-disocclusion',maxError,tolerance:halfTolerance,oldDepth:12,currentDepth:depth,expectedPriorDepth:depth};
  }finally{temporal.dispose();for(const texture of textures)texture.destroy();}
}

/** Real production resolve, generated inputs and analytic image oracle. No assets or performance claims. */
export async function validateTemporalDetail() {
  require(navigator.gpu,'WebGPU is required for temporal detail validation.');
  const adapter=await navigator.gpu.requestAdapter();require(adapter,'No WebGPU adapter.');const device=await adapter!.requestDevice();
  const errors:string[]=[];let destroying=false,scopes=0;let reader:Reader|undefined;
  const onError=(event:GPUUncapturedErrorEvent)=>errors.push(event.error.message);device.addEventListener('uncapturederror',onError);
  void device.lost.then(info=>{if(!destroying)errors.push(`Device lost: ${info.reason}: ${info.message}`);});
  try {
    for(const filter of ['validation','internal','out-of-memory'] as const){device.pushErrorScope(filter);scopes++;}
    reader=await Reader.create(device);const results=[];
    for(const scenario of ['static-sinusoids','slanted-edge','moving-sinusoids','zooming-sinusoids'] as const)results.push(await runScenario(device,reader,scenario));
    const depthRejection=[await depthGuard(device,reader)];
    await device.queue.onSubmittedWorkDone();while(scopes>0){scopes--;const error=await device.popErrorScope();if(error)errors.push(error.message);}
    require(errors.length===0,`Temporal GPU validation errors: ${errors.join('; ')}`);
    return {status:'passed-basic-correctness',qualityAccepted:false,performanceEvidence:false,
      protocol:{size,inset,frames:[...checkpoints],jitter:'production cameraJitter: repeating eight Halton(2,3) offsets in pixels',
        sampling:'HDR point samples at inverse-projected jittered pixel centers, uploaded as rgba16float; motion is exact previous projection including jitter, quantized to rgba16float',
        production:'One unmodified production TemporalResolve per invocation; compare this same harness bundled separately against baseline and candidate source identities. No motion-coordinate compensation.',
        oracles:{currentJitteredPoint:'Independent double-precision signal at the current inverse-projected jittered pixel center: point phase and amplitude, not anti-aliased integration.',
          pixelBoxIntegral:'Independent double-precision integral over the unjittered current pixel square: analytic sinc products for sinusoids, exact clipped-polygon area for slanted edge. A distinct target, not equivalent to the current jittered point.'},
        sine:{frequencies,phases,mean:1,amplitude:.5},edge:'x - (3/7)*y - 34.37 >= 0',movingPixelsPerFrame:.25,zoomScale:'1 + zeroBasedFrame/512',
        depth,depthGuardTolerance:halfTolerance,qualityGates:'none; record all before/after errors, contrast and phase without result-derived thresholds',
        limitations:'Generated planar constant-depth inputs isolate temporal filtering; not a textured 3D raster, visibility, animation image or GPU-performance proof. Eight Halton points plus exponential history are not exact box integration.'},
      adapter:{vendor:adapter!.info.vendor,architecture:adapter!.info.architecture,device:adapter!.info.device,description:adapter!.info.description,isFallbackAdapter:adapter!.info.isFallbackAdapter??null},
      results,depthRejection,gpuErrors:errors};
  }finally{reader?.dispose();while(scopes>0){scopes--;await device.popErrorScope().catch(()=>undefined);}destroying=true;device.removeEventListener('uncapturederror',onError);device.destroy();}
}
