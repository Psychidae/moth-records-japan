// Build-only smoke executed inside chroot as the real runtime UID/GID.
// It does not invoke the photo CLI or substitute for namespace/AV acceptance.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';

assert.equal(process.getuid(), 65532);
assert.equal(process.getgid(), 65532);
const filesystem = await lstat('/');
assert.equal(filesystem.mode & 0o7777, 0o755);
assert.equal(filesystem.uid, 0);
assert.equal(filesystem.gid, 0);
const tmp = await lstat('/tmp');
assert.equal(tmp.mode & 0o7777, 0o1777);
assert.equal(tmp.uid, 0);
assert.equal(tmp.gid, 0);
for (const path of ['/work', '/in', '/out', '/var/lib/clamav', '/usr/share/moth-photo-runtime']) {
  await access(path, constants.R_OK | constants.X_OK);
  await assert.rejects(access(path, constants.W_OK), { code: 'EACCES' });
}
for (const path of ['/work/pipelines/process-photo/src/cli.ts', '/work/node_modules/zod/package.json', '/usr/share/moth-photo-runtime/provenance.json']) {
  assert.ok((await readFile(path)).length > 0);
  await assert.rejects(access(path, constants.W_OK), { code: 'EACCES' });
}
for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
  const path = `/var/lib/clamav/${name}`;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(512);
    assert.equal((await handle.read(header, 0, 512, 0)).bytesRead, 512);
    assert.equal(header.subarray(0, 11).toString('ascii'), 'ClamAV-VDB:');
  } finally { await handle.close(); }
  await assert.rejects(access(path, constants.W_OK), { code: 'EACCES' });
}
await mkdir('/tmp/work', { mode: 0o700 });
try {
  const work = await lstat('/tmp/work');
  assert.equal(work.uid, 65532);
  assert.equal(work.gid, 65532);
  assert.equal(work.mode & 0o7777, 0o700);
  await writeFile('/tmp/work/permission-smoke', 'runtime uid write/read/remove\n', { flag: 'wx', mode: 0o600 });
  assert.equal(await readFile('/tmp/work/permission-smoke', 'utf8'), 'runtime uid write/read/remove\n');
} finally { await rm('/tmp/work', { recursive: true }); }
await assert.rejects(lstat('/tmp/work'), { code: 'ENOENT' });
await import('/work/pipelines/process-photo/src/cli.ts');
