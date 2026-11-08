import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {childEnvironment, freshSignature, imageId, object, readBounded, readOutputs, sha256, sourcePaths, syntheticJpeg, validateContainer} from './contract.ts';

const [mode, root, evidence, image] = process.argv.slice(2);
assert.ok(root && evidence && image);
imageId(image);
const fixture = syntheticJpeg();
assert.deepEqual(await readBounded(join(root, 'input.jpg'), 10485760), fixture);
const json = async (name: string) => JSON.parse((await readBounded(join(evidence, name), 2 * 1024 * 1024)).toString('utf8')) as unknown;
if (mode === 'container') {
  validateContainer(await json('container-before.json'), {image, root, source: fixture});
} else {
  assert.equal(mode, 'result');
  const container = validateContainer(await json('container-after.json'), {image, root, source: fixture}, true);
  const outputs = await readOutputs(join(root, 'derived'));
  const probe = object(await json('runtime-probe.json'));
  assert.equal(probe.format, 'photo-runtime-probe-v1');
  assert.match(String(probe.node_version), /^v24\./);
  assert.match(String(probe.vips), /vips-\d+\.\d+/);
  const signatureDate = freshSignature(String(probe.clamscan));
  assert.deepEqual(probe.av_self_test, {detected: true, exit_code: 1});
  const isolation = object(probe.isolation);
  assert.equal(isolation.platform, 'linux'); assert.equal(isolation.uid, 65532); assert.equal(isolation.gid, 65532);
  assert.deepEqual(isolation.interfaces, ['lo']);
  assert.ok(Array.isArray(isolation.capabilities));
  assert.equal(isolation.capabilities.length, 6);
  assert.ok(isolation.capabilities.every(line => typeof line === 'string' && /^(?:Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+0+|NoNewPrivs:\s+1)$/.test(line)));
  assert.ok(Array.isArray(isolation.environment_keys));
  assert.ok(isolation.environment_keys.every(key => typeof key === 'string' && [...Object.keys(childEnvironment), 'HOSTNAME', 'PWD'].includes(key)));
  const provenance = object(probe.provenance);
  assert.equal(provenance.format, 'photo-runtime-provenance-v1');
  assert.match(String(provenance.base_image), /@sha256:[a-f0-9]{64}$/);
  assert.ok(provenance.debian_snapshot && provenance.packages);
  assert.ok(Array.isArray(probe.source));
  const sources = [];
  for (const path of sourcePaths) {
    const bytes = await readFile(path);
    const expected = {path, bytes: bytes.length, sha256: sha256(bytes)};
    const actual: Record<string, unknown>[] = (probe.source as unknown[]).map(object).filter(value => value.path === path);
    assert.deepEqual(actual, [expected], 'Image must contain exact checked-out processor source');
    sources.push(expected);
  }
  assert.equal(probe.source.length, sourcePaths.length);
  const pinned = object(provenance.signatures);
  assert.ok(Array.isArray(probe.signatures) && Array.isArray(pinned.files));
  assert.equal(probe.signatures.length, 3); assert.equal(pinned.files.length, 3);
  for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
    const actual: Record<string, unknown>[] = (probe.signatures as unknown[]).map(object).filter(value => value.name === name);
    const expected: Record<string, unknown>[] = (pinned.files as unknown[]).map(object).filter(value => value.name === name);
    assert.equal(actual.length, 1); assert.equal(expected.length, 1);
    assert.equal(actual[0]!.sha256, expected[0]!.sha256); assert.match(String(actual[0]!.sha256), /^[a-f0-9]{64}$/);
    assert.equal(actual[0]!.bytes, expected[0]!.bytes);
    assert.ok(Number(actual[0]!.bytes) > 0 && Number(actual[0]!.bytes) <= 512 * 1024 * 1024);
    assert.match(String(actual[0]!.info), /Verification OK/);
  }
  assert.equal(new Date(String(pinned.daily_built_at)).toISOString(), signatureDate);
  const receipt = {
    format: 'photo-runtime-acceptance-v1', scope: 'synthetic-only-no-registration-or-publication',
    accepted_at: new Date().toISOString(), source_commit: process.env.GITHUB_SHA ?? null,
    run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    image_id: image, image_kind: 'local-docker-content-id-not-registry-manifest',
    fixture: {recipe: 'baseline-gray-2400x1600-v1', sha256: sha256(fixture), bytes: fixture.length, width: 2400, height: 1600, original_photos_used: 0},
    source: sources, engines: {node: probe.node_version, clamscan: probe.clamscan, vips: probe.vips, signatures: probe.signatures},
    base_image: provenance.base_image, debian_snapshot: provenance.debian_snapshot,
    provenance_sha256: sha256(JSON.stringify(provenance)), isolation, av_self_test: probe.av_self_test,
    output: outputs, container_state: container.State,
    real_db_calls: 0, real_storage_calls: 0, production_intake_enabled: false,
  };
  await writeFile(join(evidence, 'acceptance-candidate.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write('Synthetic output checks passed; container and tmpfs cleanup still required.\n');
}
