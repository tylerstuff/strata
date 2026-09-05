import assert from 'node:assert/strict';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/** Validate existing canonical ancestors before creating any local evidence. */
export async function prepareGalleryOutput(directory) {
  let ancestor = resolve(directory);
  const suffix = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      assert.notEqual(parent, ancestor, 'Cannot resolve gallery output ancestry.');
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  for (let current = ancestor;; current = dirname(current)) {
    let git = false;
    try { await access(join(current, '.git')); git = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(git, false, 'Gallery evidence must stay outside every Git worktree.');
    if (dirname(current) === current) break;
  }
  const target = resolve(ancestor, ...suffix);
  await mkdir(target, { recursive: true });
  assert.equal(await realpath(target), target, 'Gallery output changed during creation.');
  return target;
}
