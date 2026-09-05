import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareGalleryOutput } from './gallery-output.mjs';

test('gallery output resolves external paths but rejects Git directory, worktree file and symlink ancestors before creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-output-test-'));
  try {
    const output = await prepareGalleryOutput(join(root, 'external', 'new'));
    await access(output);
    for (const kind of ['repo', 'worktree']) {
      const directory = join(root, kind);
      await mkdir(directory);
      if (kind === 'repo') await mkdir(join(directory, '.git'));
      else await writeFile(join(directory, '.git'), 'gitdir: /unused');
      const link = join(root, `${kind}-link`);
      await symlink(directory, link);
      for (const candidate of [directory, link]) {
        await assert.rejects(prepareGalleryOutput(join(candidate, 'new', 'capture')), /outside every Git worktree/);
        await assert.rejects(access(join(directory, 'new')), { code: 'ENOENT' });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
