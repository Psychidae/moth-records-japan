import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readdir, lstat, realpath} from 'node:fs/promises';
import {join} from 'node:path';

export const sizes = [2048, 1024, 500, 240] as const;
export const sourcePaths = [
  'packages/schema/photo-processing.ts',
  'pipelines/process-photo/src/artifacts.ts',
  'pipelines/process-photo/src/cli.ts',
  'pipelines/process-photo/src/index.ts',
  'pipelines/process-photo/src/sandbox-plan.ts',
] as const;
export const childEnvironment = {
  PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp/empty',
  TMPDIR: '/tmp/work', VIPS_CONCURRENCY: '1', VIPS_DISC_THRESHOLD: '64m',
};
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function imageId(value: string): string {
  assert.match(value, /^sha256:[a-f0-9]{64}$/);
  return value;
}

/** An original, deterministic baseline JPEG, not a mock decoder output.
 * One grayscale component; every 8x8 DCT block has DC=0 and EOB, yielding
 * neutral gray. The two one-bit Huffman codes are canonical, not all-ones.
 * No image library, external photo, random source or downloaded fixture is used.
 */
export function syntheticJpeg(): Buffer {
  const segment = (marker: number, bytes: Buffer) => {
    const header = Buffer.from([255, marker, 0, 0]);
    header.writeUInt16BE(bytes.length + 2, 2);
    return Buffer.concat([header, bytes]);
  };
  const huffman = (kind: number) => Buffer.from([kind, 1, ...Array<number>(15).fill(0), 0]);
  // Little-endian TIFF with one Orientation=1 IFD entry. All metadata is invented.
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000100000000000000', 'hex');
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment(225, exif),
    segment(254, Buffer.from('Synthetic acceptance fixture. No person, place or original photo.')),
    segment(219, Buffer.from([0, ...Array<number>(64).fill(16)])),
    segment(192, Buffer.from([8, 0x06, 0x40, 0x09, 0x60, 1, 1, 0x11, 0])), // 2400 x 1600
    segment(196, Buffer.concat([huffman(0), huffman(0x10)])),
    segment(218, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.alloc(15000), // 300 * 200 blocks, two zero bits per block; no stuffing needed.
    Buffer.from([255, 217]),
  ]);
}

/** Independent bounded structural parser, without importing the processor validator.
 * Entropy decoding remains in libvips in the isolated image, never on the host.
 */
export function jpegFacts(bytes: Buffer, stripped: boolean) {
  assert.ok(bytes.length >= 16 && bytes.length <= 10 * 1024 * 1024, 'JPEG byte bound');
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'JPEG SOI');
  let offset = 2, width = 0, height = 0, scans = 0, segments = 0;
  const metadata: number[] = [];
  while (offset < bytes.length) {
    assert.ok(++segments < 10000, 'JPEG segment bound');
    assert.equal(bytes[offset++], 255, 'JPEG marker');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    assert.ok(marker !== undefined && marker !== 0 && marker !== 216 && !(marker >= 208 && marker <= 215));
    if (marker === 217) {
      assert.equal(offset, bytes.length, 'No JPEG trailer');
      assert.ok(width > 0 && height > 0 && scans > 0, 'Complete JPEG');
      return {width, height, metadata};
    }
    assert.ok(offset + 2 <= bytes.length);
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length, 'JPEG segment length');
    if ((marker >= 224 && marker <= 239) || marker === 254) {
      metadata.push(marker);
      if (stripped) {
        assert.equal(marker, 224, 'Metadata survived normalization');
        assert.equal(length, 16);
        assert.equal(bytes.subarray(offset + 2, offset + 7).toString('ascii'), 'JFIF\0');
        assert.equal(bytes[offset + 7], 1);
        assert.ok(bytes[offset + 8]! <= 2 && bytes[offset + 9]! <= 2);
        assert.equal(bytes[offset + 14], 0);
        assert.equal(bytes[offset + 15], 0);
      }
    }
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      assert.ok([192, 193, 194].includes(marker), 'Supported JPEG frame');
      assert.ok(length >= 8 && !width && !height);
      assert.equal(bytes[offset + 2], 8);
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      assert.ok(width > 0 && height > 0 && width * height <= 40_000_000 && Math.max(width, height) <= 20000);
    }
    offset += length;
    if (marker === 218) {
      assert.ok(width && height && length >= 6);
      scans++;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) {offset++; continue;}
        let end = offset + 1;
        while (bytes[end] === 255) end++;
        const next = bytes[end];
        if (next === 0 || (next !== undefined && next >= 208 && next <= 215)) {offset = end + 1; continue;}
        break;
      }
    }
  }
  throw Error('Missing JPEG EOI');
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Exact JSON fields');
}
export function validateOutputs(raw: unknown, files: ReadonlyMap<number, Buffer>, source = syntheticJpeg()) {
  const manifest = object(raw);
  keys(manifest, ['format', 'source_sha256', 'source_bytes', 'malware_result', 'regeneration', 'isolation', 'variants']);
  assert.equal(manifest.format, 'processed-photo-v2');
  assert.equal(manifest.source_sha256, sha256(source));
  assert.equal(manifest.source_bytes, source.length);
  assert.equal(manifest.malware_result, 'clean');
  assert.equal(manifest.regeneration, 'decode-reencode-stripped');
  assert.equal(manifest.isolation, 'network-none-no-credentials');
  assert.ok(Array.isArray(manifest.variants));
  assert.equal(manifest.variants.length, 4); assert.equal(files.size, 4);
  const seen = new Set<number>();
  for (const input of manifest.variants) {
    const variant = object(input);
    keys(variant, ['size', 'sha256', 'bytes', 'width', 'height']);
    const size = Number(variant.size);
    assert.ok(sizes.includes(size as typeof sizes[number]) && variant.size === size && !seen.has(size));
    seen.add(size);
    const bytes = files.get(size); assert.ok(bytes);
    assert.equal(variant.bytes, bytes.length); assert.equal(variant.sha256, sha256(bytes));
    assert.notEqual(variant.sha256, manifest.source_sha256, 'Real regeneration required');
    const geometry = jpegFacts(bytes, true);
    assert.equal(variant.width, geometry.width); assert.equal(variant.height, geometry.height);
    assert.equal(geometry.width, size, 'Expected synthetic landscape width');
    assert.ok(Math.abs(geometry.height - size * 2 / 3) <= 1, 'Expected aspect ratio');
  }
  return manifest;
}

export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({bigint: true});
    assert.ok(before.isFile() && before.size > 0n && before.size <= BigInt(limit) && before.nlink === 1n);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      assert.ok(result.bytesRead); offset += result.bytesRead;
    }
    assert.equal((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead, 0);
    const after = await file.stat({bigint: true});
    for (const key of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(before[key], after[key]);
    return bytes;
  } finally {await file.close();}
}

export async function readOutputs(directory: string) {
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
  assert.deepEqual((await readdir(directory)).sort(), [...sizes.map(size => `${size}.jpg`), 'manifest.json'].sort());
  const bytes = await readBounded(join(directory, 'manifest.json'), 16384);
  const files = new Map<number, Buffer>();
  for (const size of sizes) files.set(size, await readBounded(join(directory, `${size}.jpg`), 10 * 1024 * 1024));
  return {manifest: validateOutputs(JSON.parse(bytes.toString('utf8')) as unknown, files), manifest_sha256: sha256(bytes)};
}

export function freshSignature(version: string, now = Date.now()): string {
  assert.match(version, /^ClamAV \d+\.\d+\.\d+[^/]*\/\d+\//);
  const displayed = version.trim().split('/').at(-1)!;
  // The scratch image has no local timezone override. ClamAV prints UTC without
  // a zone; do not reinterpret it in the developer laptop's local timezone.
  const time = /\d{4}$/.test(displayed) ? displayed + ' UTC' : displayed;
  const age = now - Date.parse(time);
  assert.ok(Number.isFinite(age) && age >= -3600000 && age < 48 * 3600000, 'Fresh official AV signatures required');
  return new Date(Date.parse(time)).toISOString();
}

export function validateContainer(value: unknown, expected: {image: string; root: string; source: Buffer}, finished = false) {
  assert.ok(Array.isArray(value) && value.length === 1);
  const container = object(value[0]), config = object(container.Config), host = object(container.HostConfig);
  assert.equal(container.Image, imageId(expected.image));
  assert.equal(config.Image, expected.image); assert.equal(config.User, '65532:65532');
  assert.equal(config.WorkingDir, '/work');
  assert.ok(config.Entrypoint === null || Array.isArray(config.Entrypoint) && config.Entrypoint.length === 0);
  assert.ok(Array.isArray(config.Env));
  assert.deepEqual([...config.Env].sort(), Object.entries(childEnvironment).map(([k, v]) => `${k}=${v}`).sort());
  assert.deepEqual(config.Cmd, ['node', '--experimental-strip-types', '/work/pipelines/process-photo/src/cli.ts', '/in/input.jpg', '/out', sha256(expected.source), String(expected.source.length)]);
  assert.equal(host.NetworkMode, 'none'); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ['ALL']); assert.ok(host.CapAdd === null || Array.isArray(host.CapAdd) && host.CapAdd.length === 0);
  assert.deepEqual(host.SecurityOpt, ['no-new-privileges']);
  assert.deepEqual(host.LogConfig, {Type: 'none', Config: {}});
  assert.equal(host.PidMode, ''); assert.equal(host.IpcMode, 'private');
  assert.equal(host.UTSMode, ''); assert.equal(host.UsernsMode, '');
  assert.ok(host.Devices === null || Array.isArray(host.Devices) && host.Devices.length === 0);
  assert.ok(host.DeviceRequests === null || Array.isArray(host.DeviceRequests) && host.DeviceRequests.length === 0);
  assert.ok(host.VolumesFrom === null || Array.isArray(host.VolumesFrom) && host.VolumesFrom.length === 0);
  assert.equal(host.PidsLimit, 64); assert.equal(host.Memory, 1073741824); assert.equal(host.NanoCpus, 1000000000);
  assert.deepEqual(host.Tmpfs, {'/tmp': 'rw,nosuid,nodev,noexec,size=256m'});
  assert.ok(host.Binds === null || Array.isArray(host.Binds) && host.Binds.length === 0);
  assert.ok(Array.isArray(container.Mounts) && container.Mounts.length === 2);
  for (const [destination, source, writable] of [['/in/input.jpg', `${expected.root}/input.jpg`, false], ['/out', `${expected.root}/derived`, true]] as const) {
    const matches: Record<string, unknown>[] = (container.Mounts as unknown[]).map(object).filter(mount => mount.Destination === destination);
    assert.equal(matches.length, 1); const mount = matches[0]!;
    assert.equal(mount.Type, 'bind'); assert.equal(mount.Source, source); assert.equal(mount.RW, writable);
  }
  if (finished) {
    const state = object(container.State);
    assert.equal(state.Status, 'exited'); assert.equal(state.Running, false); assert.equal(state.OOMKilled, false);
    assert.equal(state.ExitCode, 0); assert.equal(state.Error, '');
  }
  return container;
}
