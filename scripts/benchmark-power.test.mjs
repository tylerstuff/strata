import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPower } from './benchmark-power.mjs';

test('uses the active power profile and rejects changes or unverified required AC conditions', () => {
  const ac = { source: 'AC Power', lowPowerMode: { 'AC Power': 0, 'Battery Power': 1 } };
  const expected = checkPower(ac, undefined, true);
  assert.deepEqual(expected, { source: 'AC Power', lowPowerMode: 0 });
  assert.deepEqual(checkPower(ac, expected, true), expected);
  assert.throws(() => checkPower({ ...ac, source: 'Battery Power' }, expected), /changed/);
  assert.throws(() => checkPower({ ...ac, lowPowerMode: { 'AC Power': 1 } }, expected), /changed/);
  assert.throws(() => checkPower({ source: null, lowPowerMode: null }, undefined, true), /requires AC/);
  assert.throws(() => checkPower({ ...ac, source: 'Battery Power' }, undefined, true), /requires AC/);
  assert.deepEqual(checkPower({ source: null, lowPowerMode: null }), { source: null, lowPowerMode: null });
});
