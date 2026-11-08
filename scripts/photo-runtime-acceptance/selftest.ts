import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, symlink, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {childEnvironment, freshSignature, imageId, jpegFacts, readBounded, sha256, sizes, syntheticJpeg, validateContainer, validateOutputs} from './contract.ts';

test('deterministic original synthetic fixture has bounded pixels and explicit invented metadata', () => {
  const bytes = syntheticJpeg();
  assert.deepEqual(bytes, syntheticJpeg()); assert.ok(bytes.length < 16000);
  assert.equal(bytes.length, 15241);
  assert.equal(sha256(bytes), '23bb15a925c42fd00d492debe658716b72d0c963e35b7c4870c719e73c17005f');
  assert.deepEqual(jpegFacts(bytes, false), {width: 2400, height: 1600, metadata: [225, 254]});
  assert.throws(() => jpegFacts(bytes, true), /Metadata/);
  assert.equal(bytes.includes(Buffer.from('EICAR')), false);
});
test('acceptance local identity rejects tags, repositories, short digests and shell input', () => {
  assert.equal(imageId(`sha256:${'a'.repeat(64)}`), `sha256:${'a'.repeat(64)}`);
  for (const bad of ['node:24', 'sha256:abc', `ghcr.io/psychidae/moth-photo-processor@sha256:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, '; touch /tmp/x']) assert.throws(() => imageId(bad));
});
test('AV verification rejects old, future, missing and unparseable signatures', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  assert.equal(freshSignature('ClamAV 1.4.3/12345/Fri Jan 02 01:00:00 2026', now), '2026-01-02T01:00:00.000Z');
  for (const version of ['ClamAV 1.4.3/12345/Thu Jan 01 00:00:00 2026', 'ClamAV 1.4.3/12345/Sat Jan 03 02:00:00 2026', 'ClamAV 1.4.3', 'fake/12345/Fri Jan 02 01:00:00 2026']) assert.throws(() => freshSignature(version, now));
});
test('structural verifier rejects truncated files, trailers, malformed markers and metadata', () => {
  const bytes = syntheticJpeg();
  for (const invalid of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from('trailer')]), Buffer.from('not a jpeg'), Buffer.from([255, 216, 255, 225, 255, 255, ...Array<number>(20).fill(0)])]) assert.throws(() => jpegFacts(invalid, false));
});

// Pure structural test fixtures, never submitted as evidence of a decoder run.
function structuralOutputs() {
  const files = new Map<number, Buffer>();
  const input = syntheticJpeg();
  let offset = 2;
  for (let i = 0; i < 2; i++) offset += 2 + input.readUInt16BE(offset + 2);
  for (const size of sizes) {
    const bytes = Buffer.concat([input.subarray(0, 2), input.subarray(offset)]);
    const frame = bytes.indexOf(Buffer.from([255, 192]));
    bytes.writeUInt16BE(Math.round(size * 2 / 3), frame + 5); bytes.writeUInt16BE(size, frame + 7);
    files.set(size, bytes);
  }
  const variants = [...files].map(([size, bytes]) => {const facts = jpegFacts(bytes, true); return {size, bytes: bytes.length, sha256: sha256(bytes), width: facts.width, height: facts.height};});
  return {files, manifest: {format: 'processed-photo-v2', source_sha256: sha256(input), source_bytes: input.length, malware_result: 'clean', regeneration: 'decode-reencode-stripped', isolation: 'network-none-no-credentials', variants}};
}
test('independent output validation checks all fields, sizes, bytes, SHA, geometry and strip contract', () => {
  const {manifest, files} = structuralOutputs();
  assert.deepEqual(validateOutputs(manifest, files), manifest);
  for (const change of [{source_sha256: 'a'.repeat(64)}, {source_bytes: 1}, {malware_result: 'unknown'}, {isolation: 'host'}, {private_key: 'extra'}, {variants: manifest.variants.slice(1)}, {variants: [manifest.variants[0], manifest.variants[0], ...manifest.variants.slice(2)]}]) assert.throws(() => validateOutputs({...manifest, ...change}, files));
  for (const change of [{sha256: 'b'.repeat(64)}, {bytes: 1}, {width: 1}, {height: 1}, {size: 200}]) assert.throws(() => validateOutputs({...manifest, variants: [{...manifest.variants[0], ...change}, ...manifest.variants.slice(1)]}, files));
  const extra = new Map(files); extra.set(99, syntheticJpeg()); assert.throws(() => validateOutputs(manifest, extra));
  const metadata = new Map(files); metadata.set(2048, syntheticJpeg()); assert.throws(() => validateOutputs(manifest, metadata));
});
test('bounded reads reject symlinks, directories, empty and oversized files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moth-acceptance-selftest-'));
  try {
    await writeFile(join(directory, 'data'), 'safe'); await writeFile(join(directory, 'empty'), ''); await symlink(join(directory, 'data'), join(directory, 'link'));
    assert.equal((await readBounded(join(directory, 'data'), 4)).toString(), 'safe');
    for (const [path, size] of [[join(directory, 'data'), 3], [join(directory, 'empty'), 4], [join(directory, 'link'), 4], [directory, 100]] as const) await assert.rejects(readBounded(path, size));
  } finally {await rm(directory, {recursive: true, force: true});}
});
function containerFixture() {
  const source = syntheticJpeg(), image = `sha256:${'a'.repeat(64)}`, root = `/tmp/moth-photo-job-${'b'.repeat(32)}`;
  return {expected: {image, root, source}, value: [{Image: image, Config: {Image: image, User: '65532:65532', WorkingDir: '/work', Entrypoint: null, Env: Object.entries(childEnvironment).map(([key, value]) => `${key}=${value}`), Cmd: ['node', '--experimental-strip-types', '/work/pipelines/process-photo/src/cli.ts', '/in/input.jpg', '/out', sha256(source), String(source.length)]}, HostConfig: {NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], LogConfig: {Type: 'none', Config: {}}, PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', Devices: [], DeviceRequests: null, VolumesFrom: null, PidsLimit: 64, Memory: 1073741824, NanoCpus: 1000000000, Tmpfs: {'/tmp': 'rw,nosuid,nodev,noexec,size=256m'}, Binds: null}, Mounts: [{Type: 'bind', Source: root + '/input.jpg', Destination: '/in/input.jpg', RW: false}, {Type: 'bind', Source: root + '/derived', Destination: '/out', RW: true}], State: {Status: 'exited', Running: false, OOMKilled: false, ExitCode: 0, Error: ''}}]};
}
test('actual Docker configuration is checked, not only declared launch arguments', () => {
  const {value, expected} = containerFixture();
  assert.ok(validateContainer(value, expected, true));
  for (const change of [{NetworkMode: 'bridge'}, {ReadonlyRootfs: false}, {Privileged: true}, {CapDrop: []}, {CapAdd: ['NET_ADMIN']}, {SecurityOpt: []}, {Memory: 0}, {PidsLimit: 0}, {NanoCpus: 0}, {Tmpfs: {}}, {Binds: ['/run/docker.sock:/run/docker.sock']}, {LogConfig: {Type: 'json-file', Config: {}}}, {PidMode: 'host'}, {IpcMode: 'host'}, {Devices: [{PathOnHost: '/dev/sda'}]}, {VolumesFrom: ['other']}]) assert.throws(() => validateContainer([{...value[0], HostConfig: {...value[0]!.HostConfig, ...change}}], expected));
  for (const change of [{User: '0'}, {Entrypoint: ['/bin/sh']}, {WorkingDir: '/tmp'}, {Env: [...value[0]!.Config.Env, 'TOKEN=unexpected']}, {Cmd: ['true']}]) assert.throws(() => validateContainer([{...value[0], Config: {...value[0]!.Config, ...change}}], expected));
  for (const change of [{OOMKilled: true}, {ExitCode: 1}, {Running: true}, {Error: 'error'}]) assert.throws(() => validateContainer([{...value[0], State: {...value[0]!.State, ...change}}], expected, true));
  assert.throws(() => validateContainer([{...value[0], Mounts: [...value[0]!.Mounts, {Type: 'bind', Source: '/repo', Destination: '/work', RW: false}]}], expected));
});
test('workflow has no service credentials or publication and pins trusted actions', async () => {
  const workflow = await readFile('.github/workflows/photo-runtime-acceptance.yml', 'utf8');
  assert.match(workflow, /contents: read/); assert.match(workflow, /runs-on: ubuntu-24.04/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|packages: write|id-token:|pull_request_target|docker login|docker push|pnpm install/);
  for (const match of workflow.matchAll(/uses: (.+)/g)) assert.match(match[1]!, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
  const runner = await readFile('scripts/photo-runtime-acceptance/run.sh', 'utf8');
  assert.match(runner, /mount -t tmpfs -o size=64m/); assert.match(runner, /sudo umount/);
  assert.match(runner, /480s docker start --attach/); assert.match(runner, /trap on_exit EXIT/);
  assert.match(runner, /--log-driver none/); assert.match(runner, /ulimit -f 2048/);
  assert.doesNotMatch(runner, /docker pull|docker push|docker login|--privileged|--network host/);
});
