import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitViewportSize, watchDisplayDensity } from './viewport.ts';

test('Fit renders at native density for ordinary, Retina and fractional displays', () => {
  assert.deepEqual(fitViewportSize(640, 360, 1, 8192), { width: 640, height: 360 });
  assert.deepEqual(fitViewportSize(640, 360, 2, 8192), { width: 1280, height: 720 });
  assert.deepEqual(fitViewportSize(639.5, 359.25, 1.5, 8192), { width: 959, height: 539 });
});

test('the device cap preserves both wide and portrait layout proportions', () => {
  assert.deepEqual(fitViewportSize(6000, 3000, 2, 8192), { width: 8192, height: 4096 });
  assert.deepEqual(fitViewportSize(3000, 6000, 2, 8192), { width: 4096, height: 8192 });
  assert.deepEqual(fitViewportSize(1234.5, 678.25, 3, 2048), { width: 2048, height: 1125 });
});

test('hidden content defers sizing, and invalid density or device limits fail explicitly', () => {
  for (const [width, height] of [[0, 400], [640, 0], [-1, 10], [NaN, 10], [10, Infinity]]) {
    assert.equal(fitViewportSize(width, height, 2, 8192), null);
  }
  for (const density of [0, -1, NaN, Infinity]) assert.throws(() => fitViewportSize(640, 360, density, 8192));
  for (const cap of [0, 1.5, Infinity, NaN]) assert.throws(() => fitViewportSize(640, 360, 2, cap));
});

test('density-only changes rearm the media query and disposal removes callbacks', () => {
  const controller = new AbortController();
  const source = new EventTarget();
  const queries = [];
  source.devicePixelRatio = 1;
  source.matchMedia = media => {
    const query = new EventTarget();
    query.media = media;
    queries.push(query);
    return query;
  };
  const sizes = [];
  watchDisplayDensity(source, () => sizes.push(fitViewportSize(640, 360, source.devicePixelRatio, 8192)), controller.signal);
  assert.equal(queries[0].media, '(resolution: 1dppx)');
  source.devicePixelRatio = 2;
  queries[0].dispatchEvent(new Event('change'));
  assert.deepEqual(sizes, [{ width: 1280, height: 720 }]);
  assert.equal(queries[1].media, '(resolution: 2dppx)');
  queries[0].dispatchEvent(new Event('change'));
  assert.equal(sizes.length, 1, 'Old density listeners must be retired');
  source.devicePixelRatio = 1.5;
  source.dispatchEvent(new Event('resize'));
  assert.deepEqual(sizes[1], { width: 960, height: 540 });
  assert.equal(queries[2].media, '(resolution: 1.5dppx)');
  controller.abort();
  queries[2].dispatchEvent(new Event('change'));
  source.dispatchEvent(new Event('resize'));
  assert.equal(sizes.length, 2);
});

test('an already disposed density observer installs no listeners', () => {
  const controller = new AbortController(); controller.abort();
  watchDisplayDensity({ matchMedia: () => assert.fail('No media listener expected') }, () => assert.fail('No callback expected'), controller.signal);
});
