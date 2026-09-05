import { StrataError } from '../errors.js';
import type { TemporalInputs } from './raster-types.js';
import { temporalShader } from './temporal-shader.js';

const uniformBytes = 16;
const historyTexelBytes = 8;
const bufferUsage = { copyDestination: 0x8, uniform: 0x40 };
const textureUsage = { textureBinding: 0x4, renderAttachment: 0x10 };

interface HistoryTarget { readonly texture: GPUTexture; readonly view: GPUTextureView }

export interface TemporalFrame {
  readonly view: GPUTextureView;
  readonly drawCalls: number;
  readonly dispatchCalls: number;
  readonly uploadBytes: number;
  /** Whether reprojection was enabled for this pass; individual pixels can reject it. */
  readonly historyValid: boolean;
}

/** Full-screen HDR resolve with separately owned read/write history textures. */
export class TemporalResolve {
  private histories: readonly [HistoryTarget, HistoryTarget] | undefined;
  private bindGroups: readonly [GPUBindGroup, GPUBindGroup] | undefined;
  private boundHdr: GPUTextureView | undefined;
  private boundMotion: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private writeIndex: 0 | 1 = 0;
  private hasHistory = false;
  private disposed = false;
  private readonly options = new Uint32Array(4);
  readonly initialUploadBytes = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly uniform: GPUBuffer,
  ) {}

  static async create(device: GPUDevice): Promise<TemporalResolve> {
    const shader = device.createShaderModule({ label: 'Strata temporal reprojection shader', code: temporalShader });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'Strata HDR temporal resolve', layout: 'auto',
      vertex: { module: shader, entryPoint: 'vertexMain' },
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    if (device.limits.maxBufferSize < uniformBytes) {
      throw new StrataError('UNSUPPORTED_LIMIT', 'Temporal options exceed maxBufferSize.');
    }
    const uniform = device.createBuffer({
      label: 'Strata temporal options', size: uniformBytes, usage: bufferUsage.uniform | bufferUsage.copyDestination,
    });
    return new TemporalResolve(device, pipeline, uniform);
  }

  get gpuBufferBytes(): number { return this.disposed ? 0 : uniformBytes; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.width * this.height * historyTexelBytes * 2; }

  private resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    const created: GPUTexture[] = [];
    const target = (index: number): HistoryTarget => {
      const texture = this.device.createTexture({
        label: `Strata temporal history ${index}`, size: [width, height], format: 'rgba16float',
        usage: textureUsage.textureBinding | textureUsage.renderAttachment,
      });
      created.push(texture);
      return { texture, view: texture.createView() };
    };
    let histories: readonly [HistoryTarget, HistoryTarget];
    try { histories = [target(0), target(1)]; }
    catch (cause) { for (const texture of created) texture.destroy(); throw cause; }
    for (const history of this.histories ?? []) history.texture.destroy();
    this.histories = histories;
    this.width = width;
    this.height = height;
    this.writeIndex = 0;
    this.hasHistory = false;
    this.bindGroups = undefined;
    this.boundHdr = undefined;
    this.boundMotion = undefined;
  }

  encode(
    encoder: GPUCommandEncoder, inputs: TemporalInputs, width: number, height: number,
    historyValid: boolean, timestampWrites?: GPURenderPassTimestampWrites,
  ): TemporalFrame {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This temporal resolve has been disposed.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new StrataError('INVALID_SIZE', 'Temporal dimensions must be positive integers within device limits.');
    }
    this.resize(width, height);
    const histories = this.histories!;
    if (!this.bindGroups || this.boundHdr !== inputs.hdr || this.boundMotion !== inputs.motion) {
      const group = (writeIndex: 0 | 1) => this.device.createBindGroup({
        label: `Strata temporal inputs ${writeIndex}`, layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: inputs.hdr }, { binding: 1, resource: inputs.motion },
          { binding: 2, resource: histories[1 - writeIndex]!.view },
          { binding: 3, resource: { buffer: this.uniform } },
        ],
      });
      this.bindGroups = [group(0), group(1)];
      this.boundHdr = inputs.hdr;
      this.boundMotion = inputs.motion;
    }
    const useHistory = historyValid && this.hasHistory;
    this.options.set([width, height, useHistory ? 1 : 0, 0]);
    this.device.queue.writeBuffer(this.uniform, 0, this.options);
    const view = histories[this.writeIndex].view;
    const pass = encoder.beginRenderPass({
      label: 'Strata HDR temporal resolve',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      ...(timestampWrites === undefined ? {} : { timestampWrites }),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this.writeIndex]);
    pass.draw(3);
    pass.end();
    this.writeIndex = this.writeIndex === 0 ? 1 : 0;
    this.hasHistory = true;
    return { view, drawCalls: 1, dispatchCalls: 0, uploadBytes: uniformBytes, historyValid: useHistory };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.uniform.destroy();
    for (const history of this.histories ?? []) history.texture.destroy();
    this.histories = undefined;
    this.bindGroups = undefined;
    this.boundHdr = undefined;
    this.boundMotion = undefined;
    this.hasHistory = false;
  }
}
