import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRuntimePermissions } from './permissions.mjs';

for (const mask of [0o022, 0o077]) test(`image permission normalization corrects umask ${mask.toString(8)} and preserves the boundary`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moth-image-permissions-'));
  const root = join(directory, 'runtime');
  const previous = process.umask(mask);
  try {
    await mkdir(root);
    await mkdir(join(root, 'tmp'), { mode: 0o1777 });
    // Platforms differ in mkdir's sticky-bit handling, but umask removes both
    // non-owner write bits everywhere. The old code left the runtime UID blocked.
    assert.equal((await lstat(join(root, 'tmp'))).mode & 0o777, 0o777 & ~mask);
    await mkdir(join(root, 'work'), { mode: 0o700 });
    await writeFile(join(root, 'work/source'), 'unchanged source', { mode: 0o600 });
    await writeFile(join(root, 'work/executable'), 'unchanged executable', { mode: 0o700 });
    const outside = join(directory, 'outside');
    await writeFile(outside, 'outside unchanged', { mode: 0o600 });
    await symlink(outside, join(root, 'work/external-link'));
    await normalizeRuntimePermissions(root);
    assert.equal((await lstat(join(root, 'tmp'))).mode & 0o7777, 0o1777);
    assert.equal((await lstat(join(root, 'work'))).mode & 0o7777, 0o755);
    assert.equal((await lstat(join(root, 'work/source'))).mode & 0o7777, 0o444);
    assert.equal((await lstat(join(root, 'work/executable'))).mode & 0o7777, 0o555);
    assert.equal((await lstat(outside)).mode & 0o7777, 0o600);
    assert.equal(await readFile(join(root, 'work/source'), 'utf8'), 'unchanged source');
    await normalizeRuntimePermissions(root); // Idempotent after final hardening.
    assert.equal((await lstat(join(root, 'tmp'))).mode & 0o7777, 0o1777);
    await assert.rejects(normalizeRuntimePermissions('relative-root'));
    await symlink(root, join(directory, 'linked-root'));
    await assert.rejects(normalizeRuntimePermissions(join(directory, 'linked-root')));
  } finally {
    process.umask(previous);
    await chmod(root, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
