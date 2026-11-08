// Passed as literal Node source to a separate network-none container. No host mount.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {assertPhotoIsolation, PHOTO_CHILD_ENVIRONMENT} from '/work/pipelines/process-photo/src/sandbox-plan.ts';

const source = await readFile('/in/input.jpg');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const status = await readFile('/proc/self/status', 'utf8');
const mounts = await readFile('/proc/self/mountinfo', 'utf8');
const interfaces = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2).map(line => line.split(':')[0]?.trim()).filter(Boolean);
assertPhotoIsolation({platform: process.platform, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(), interfaces, status, mounts, environment: process.env, args: ['/in/input.jpg', '/out', digest(source), String(source.length)]});
const provenance = JSON.parse(await readFile('/usr/share/moth-photo-runtime/provenance.json', 'utf8'));
const command = (binary, args) => execFileSync(binary, args, {env: PHOTO_CHILD_ENVIRONMENT, encoding: 'utf8', timeout: 60000, maxBuffer: 65536, killSignal: 'SIGKILL'}).trim();
const clamscan = command('/usr/bin/clamscan', ['--version']);
const vips = command('/usr/bin/vipsthumbnail', ['--version']);
const signatures = [];
for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(`/var/lib/clamav/${name}`)) {bytes += chunk.length; assert.ok(bytes <= 512 * 1024 * 1024); hash.update(chunk);}
  signatures.push({name, bytes, sha256: hash.digest('hex'), info: command('/usr/bin/sigtool', ['--info', `/var/lib/clamav/${name}`])});
}
const sourceFiles = [];
for (const path of ['packages/schema/photo-processing.ts', 'pipelines/process-photo/src/artifacts.ts', 'pipelines/process-photo/src/cli.ts', 'pipelines/process-photo/src/index.ts', 'pipelines/process-photo/src/sandbox-plan.ts']) {
  const bytes = await readFile(`/work/${path}`);
  sourceFiles.push({path, bytes: bytes.length, sha256: digest(bytes)});
}
// Standard harmless antivirus self-test, generated only in this disposable tmpfs.
// Fail closed if the real official engine does not load/detect under the exact limit.
await mkdir('/tmp/work', {mode: 0o700});
let detected = false;
try {
  await writeFile('/tmp/work/av-self-test.txt', Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=', 'base64'), {flag: 'wx', mode: 0o600});
  try {command('/usr/bin/clamscan', ['--no-summary', '--', '/tmp/work/av-self-test.txt']);}
  catch (error) {detected = error.status === 1 && /FOUND/.test(String(error.stdout));}
  assert.equal(detected, true, 'Real ClamAV self-test required');
} finally {await rm('/tmp/work', {recursive: true, force: true});}
process.stdout.write(JSON.stringify({format: 'photo-runtime-probe-v1', node_version: process.version, clamscan, vips, signatures, source: sourceFiles, provenance, av_self_test: {detected, exit_code: 1}, isolation: {platform: process.platform, uid: process.getuid(), gid: process.getgid(), interfaces, capabilities: status.split('\n').filter(line => /^Cap(Inh|Prm|Eff|Bnd|Amb):|^NoNewPrivs:/.test(line)), environment_keys: Object.keys(process.env).sort()}}) + '\n');
