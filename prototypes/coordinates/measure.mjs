// Optional CPU representation microexperiment, never a browser/frame benchmark.
// The kernels deliberately exclude validation, allocation, hierarchy and interop.
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');

const count = 32_768;
const repeats = 16;
const samples = 7;
const global = new Float64Array(count * 3);
const cells = new Int32Array(count * 3);
const locals = new Float64Array(count * 3);
const local32 = new Float32Array(count * 3);
const output = new Float32Array(count * 3);
const origin = [1_000_000.001, -1_000_000.002, 1_000_000.003];
const originCell = origin.map(value => Math.floor(value / 1024 + 0.5));
const originLocal = origin.map((value, axis) => value - originCell[axis] * 1024);
const originLocal32 = originLocal.map(Math.fround);
for (let i = 0; i < global.length; i++) global[i] = origin[i % 3] + ((i * 37) % 200_000 - 100_000) / 1000;
const setupStart = performance.now();
for (let i = 0; i < global.length; i++) {
  cells[i] = Math.floor(global[i] / 1024 + 0.5);
  locals[i] = global[i] - cells[i] * 1024;
  local32[i] = locals[i];
}
const splitSetupMs = performance.now() - setupStart;
const kernels = {
  globalF64: () => {
    for (let i = 0; i < global.length; i++) output[i] = global[i] - origin[i % 3];
  },
  cellF64: () => {
    for (let i = 0; i < global.length; i++) output[i] = (cells[i] - originCell[i % 3]) * 1024 + (locals[i] - originLocal[i % 3]);
  },
  cellF32: () => {
    for (let i = 0; i < global.length; i++) output[i] = (cells[i] - originCell[i % 3]) * 1024 + (local32[i] - originLocal32[i % 3]);
  },
};
const results = Object.fromEntries(Object.keys(kernels).map(name => [name, { milliseconds: [], maxErrorMeters: 0, checksum: 0 }]));
for (const [name, kernel] of Object.entries(kernels)) {
  for (let warmup = 0; warmup < 32; warmup++) kernel();
  for (let i = 0; i < output.length; i++) {
    const ideal = ((i * 37) % 200_000 - 100_000) / 1000;
    results[name].maxErrorMeters = Math.max(results[name].maxErrorMeters, Math.abs(output[i] - ideal));
    results[name].checksum += output[i];
  }
}
for (let sample = 0; sample < samples; sample++) {
  const names = Object.keys(kernels);
  if (sample % 2) names.reverse();
  for (const name of names) {
    const start = performance.now();
    for (let repeat = 0; repeat < repeats; repeat++) kernels[name]();
    results[name].milliseconds.push(performance.now() - start);
  }
}
for (const result of Object.values(results)) {
  const sorted = [...result.milliseconds].sort((a, b) => a - b);
  result.medianNanosecondsPerPosition = sorted[Math.floor(samples / 2)] * 1e6 / (count * repeats);
}
console.log(JSON.stringify({
  scope: 'CPU typed-array arithmetic only; no GPU, WASM, rendered stability or frame-rate claim',
  sourceSha256,
  node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  count, repeats, samples, warmupPassesPerKernel: 32, splitSetupMs,
  inputBytesPerPosition: { globalF64: global.byteLength / count, cellF64: (cells.byteLength + locals.byteLength) / count, cellF32: (cells.byteLength + local32.byteLength) / count },
  outputBytesPerPosition: output.byteLength / count, results,
}, null, 2));
