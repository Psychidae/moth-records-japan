import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {syntheticJpeg, sha256} from './contract.ts';
const root = process.argv[2];
assert.match(root ?? '', /^\/tmp\/moth-photo-job-[a-f0-9]{32}$/);
const bytes = syntheticJpeg();
const file = await open(root + '/input.jpg', 'wx', 0o600);
try {
  await file.writeFile(bytes);
  // run.sh deliberately uses umask 077, which would mask creation-mode 0444
  // down to 0400. Set the final mode explicitly on this exclusive open FD.
  // Only synthetic bytes become readable; the host job directory stays 0700
  // and the container receives just this file through a read-only bind mount.
  await file.chmod(0o444);
  assert.equal((await file.stat()).mode & 0o777, 0o444);
} finally {await file.close();}
process.stdout.write(`${sha256(bytes)} ${bytes.length}\n`);
