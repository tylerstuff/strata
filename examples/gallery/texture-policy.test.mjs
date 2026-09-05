import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseTextureCap, defaultGalleryTextureCap } from './texture-policy.ts';

const MiB = 1024 * 1024;
const budget = 512 * MiB;
// Reserved Core contract: white fallbacks plus all fixed environment textures.
const fixed = 8 + 540640;
function allocation(cap, gpuTextureBytes, maximumDimension = 16384, textureBudgetBytes = budget) {
  return { requestedMaxTextureDimension: cap, effectiveMaxTextureDimension: Math.min(cap, maximumDimension),
    gpuTextureBytes, textureBudgetBytes, fitsBudget: gpuTextureBytes <= textureBudgetBytes };
}

// Independent square RGBA8 mip arithmetic for synthetic planning fixtures only.
// Production allocation estimates must come from Core's shared planner.
function squareMips(edge) {
  let bytes = 0;
  for (let size = edge; size >= 1; size = Math.floor(size / 2)) bytes += size * size * 4;
  return bytes;
}

test('4096 is the default request; a sufficient budget makes one estimate without changing it', () => {
  const calls = [];
  const result = chooseTextureCap({ estimate: cap => { calls.push(cap); return allocation(cap, squareMips(cap) + fixed); } });
  assert.equal(defaultGalleryTextureCap, 4096);
  assert.deepEqual(calls, [4096]);
  assert.equal(result.status, 'ready');
  assert.equal(result.requestedCap, 4096);
  assert.equal(result.selectedCap, 4096);
  assert.equal(result.effectiveCap, 4096);
  assert.equal(result.budgetFallback, false);
  assert.equal(result.deviceLimited, false);
});

test('two synthetic 8K role copies exceed 512 MiB and select an explicitly reported 4K fallback', () => {
  const result = chooseTextureCap({ requestedCap: 8192, estimate: cap => allocation(cap, 2 * squareMips(cap) + fixed) });
  assert.equal(result.status, 'ready');
  assert.equal(result.requestedCap, 8192);
  assert.equal(result.selectedCap, 4096);
  assert.equal(result.effectiveCap, 4096);
  assert.equal(result.budgetFallback, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].gpuTextureBytes, 715827880 + fixed);
  assert.ok(result.attempts[0].gpuTextureBytes > budget);
  assert.equal(result.attempts[0].withinBudget, false);
  assert.equal(result.attempts[1].gpuTextureBytes, 178956968 + fixed);
  assert.equal(result.attempts[1].withinBudget, true);
});

test('the full estimate includes environment overhead and accepts equality but not excess', () => {
  const old = 6 * squareMips(4096) + 8;
  assert.equal(old, budget, 'Six role copies and white fallbacks exactly fill the old budget');
  const environment = chooseTextureCap({ estimate: cap => allocation(cap, 6 * squareMips(cap) + fixed) });
  assert.equal(environment.selectedCap, 2048);
  assert.equal(environment.attempts[0].gpuTextureBytes, budget + 540640);
  assert.equal(chooseTextureCap({ estimate: cap => allocation(cap, budget) }).selectedCap, 4096);
  assert.equal(chooseTextureCap({ estimate: cap => allocation(cap, cap === 4096 ? budget + 1 : budget) }).selectedCap, 2048);
});

test('adapter limits report physical caps separately and duplicate effective estimates are skipped', () => {
  const calls = [];
  const result = chooseTextureCap({ requestedCap: 8192,
    estimate: cap => { calls.push(cap); return allocation(cap, Math.min(cap, 3000) === 3000 ? 150 : 80, 3000, 100); } });
  assert.deepEqual(calls, [8192, 2048]);
  assert.equal(result.deviceLimited, true);
  assert.equal(result.budgetFallback, true);
  assert.equal(result.selectedCap, 2048);
  assert.deepEqual(result.attempts.map(attempt => attempt.effectiveCap), [3000, 2048]);
  const limited = chooseTextureCap({ requestedCap: 8192, estimate: cap => allocation(cap, squareMips(1024) + fixed, 1024) });
  assert.equal(limited.requestedCap, 8192);
  assert.equal(limited.selectedCap, 8192);
  assert.equal(limited.effectiveCap, 1024);
  assert.equal(limited.deviceLimited, true);
  assert.equal(limited.budgetFallback, false);
});

test('exhausted budgets return unsupported after at most three attempts without a silent lower cap', () => {
  const calls = [];
  const result = chooseTextureCap({ requestedCap: 8192,
    estimate: cap => { calls.push(cap); return allocation(cap, budget + 1); } });
  assert.deepEqual(calls, [8192, 4096, 2048]);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'texture-budget');
  assert.equal(result.selectedCap, null);
  assert.equal(result.effectiveCap, null);
  assert.ok(result.attempts.every(attempt => !attempt.withinBudget));
});

test('non-budget estimator errors propagate unchanged with no retry', () => {
  const failure = new Error('Invalid source image');
  let calls = 0;
  assert.throws(() => chooseTextureCap({ requestedCap: 8192,
    estimate: () => { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 1);
});

test('invalid estimates cannot masquerade as budget fallback or mix device budgets', () => {
  assert.throws(() => chooseTextureCap({ requestedCap: 1024, estimate: () => assert.fail('No estimate expected') }));
  assert.throws(() => chooseTextureCap({ requestedCap: null, estimate: () => assert.fail('No estimate expected') }));
  assert.throws(() => chooseTextureCap({}));
  for (const patch of [{ requestedMaxTextureDimension: 4096 }, { effectiveMaxTextureDimension: 0 },
    { effectiveMaxTextureDimension: 16384 }, { gpuTextureBytes: -1 }, { gpuTextureBytes: NaN },
    { gpuTextureBytes: Infinity }, { gpuTextureBytes: 1.5 }, { textureBudgetBytes: 0 },
    { textureBudgetBytes: Number.MAX_SAFE_INTEGER + 1 }, { fitsBudget: false }]) {
    let calls = 0;
    assert.throws(() => chooseTextureCap({ requestedCap: 8192,
      estimate: cap => { calls++; return { ...allocation(cap, 8), ...patch }; } }));
    assert.equal(calls, 1);
  }
  assert.throws(() => chooseTextureCap({ requestedCap: 8192,
    estimate: cap => allocation(cap, budget + 1, 16384, cap === 8192 ? budget : budget + 10) }), /same device limit and budget/);
  assert.throws(() => chooseTextureCap({ requestedCap: 8192,
    estimate: cap => allocation(cap, budget + 1, cap === 8192 ? 6000 : 3000) }), /same device limit and budget/);
});

test('decisions and attempt evidence are immutable and contain no aliases to estimator objects', () => {
  const estimate = allocation(4096, fixed);
  const result = chooseTextureCap({ estimate: () => estimate });
  estimate.gpuTextureBytes = 0;
  assert.equal(result.attempts[0].gpuTextureBytes, fixed);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.attempts));
  assert.ok(Object.isFrozen(result.attempts[0]));
  assert.throws(() => { result.attempts[0].gpuTextureBytes = 0; }, TypeError);
});
