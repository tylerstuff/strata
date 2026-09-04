import { StrataError } from '../errors.js';
import { CPU_ABI_VERSION, type CpuRuntimeInfo } from './protocol.js';

interface RuntimeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  strata_abi_version: () => number;
  strata_runtime_initialize: () => number;
  strata_runtime_dispose: () => number;
  strata_runtime_is_initialized: () => number;
}

export interface WasmRuntime {
  readonly info: CpuRuntimeInfo;
  readonly exports: RuntimeExports;
}

/** Loads the version-matched module without depending on streaming MIME configuration. */
export async function loadWasmRuntime(url: URL | string): Promise<WasmRuntime> {
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    bytes = await response.arrayBuffer();
  } catch (cause) {
    throw new StrataError('WASM_LOAD_FAILED', `Unable to load Strata WASM from ${url}.`, { cause });
  }

  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports;
    for (const name of [
      'strata_abi_version',
      'strata_runtime_initialize',
      'strata_runtime_dispose',
      'strata_runtime_is_initialized',
    ]) {
      if (typeof exports[name] !== 'function') throw new Error(`Missing WASM export: ${name}`);
    }
    if (!(exports.memory instanceof WebAssembly.Memory) ||
        !(exports.memory.buffer instanceof ArrayBuffer)) {
      throw new Error('Strata WASM must export unshared linear memory.');
    }
    const runtime = exports as RuntimeExports;
    const abiVersion = runtime.strata_abi_version();
    if (abiVersion !== CPU_ABI_VERSION) {
      throw new Error(`Expected CPU ABI ${CPU_ABI_VERSION}, received ${abiVersion}.`);
    }
    if (runtime.strata_runtime_is_initialized() !== 0 ||
        runtime.strata_runtime_initialize() !== 0 ||
        runtime.strata_runtime_is_initialized() !== 1) {
      throw new Error('The Strata WASM module rejected initialization.');
    }
    return {
      info: Object.freeze({ abiVersion, memoryBytes: runtime.memory.buffer.byteLength }),
      exports: runtime,
    };
  } catch (cause) {
    throw new StrataError('WASM_INCOMPATIBLE', 'The Strata WASM module is invalid or incompatible.', {
      cause,
    });
  }
}
