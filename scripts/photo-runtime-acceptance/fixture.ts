import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {syntheticJpeg, sha256} from './contract.ts';
const root = process.argv[2];
assert.match(root ?? '', /^\/tmp\/moth-photo-job-[a-f0-9]{32}$/);
const bytes = syntheticJpeg();
await writeFile(root + '/input.jpg', bytes, {flag: 'wx', mode: 0o444});
process.stdout.write(`${sha256(bytes)} ${bytes.length}\n`);
