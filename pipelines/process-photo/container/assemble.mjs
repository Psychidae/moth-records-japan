import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, readlink, lstat, writeFile, symlink, utimes, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifySignatures } from './signatures.mjs';

const root = '/runtime';
const pins = JSON.parse(await readFile('/opt/recipe/inputs.json', 'utf8'));
const signatures = await verifySignatures('/opt/signatures');
const inventory = JSON.parse(await readFile('/opt/recipe/debian-inventory.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = async (from, to) => {
  await mkdir(dirname(to), { recursive: true, mode: 0o755 });
  await cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
};
// Dynamic modules are retained, but no shell, Python, apt, npm, compiler,
// freshclam, networking utilities, daemon or service configuration is copied.
// Materialize library symlinks while still in the trusted builder. Debian's
// BLAS/LAPACK links can traverse /etc/alternatives, which is not a runtime input.
await mkdir(`${root}/usr/lib`, { recursive: true, mode: 0o755 });
await cp('/usr/lib/x86_64-linux-gnu', `${root}/usr/lib/x86_64-linux-gnu`, { recursive: true, dereference: true });
await cp('/usr/lib64', `${root}/usr/lib64`, { recursive: true, dereference: true });
await copy('/usr/lib/locale', `${root}/usr/lib/locale`);
await symlink('usr/lib', `${root}/lib`);
await symlink('usr/lib64', `${root}/lib64`);
for (const binary of ['/usr/local/bin/node', '/usr/bin/clamscan', '/usr/bin/vipsthumbnail', '/usr/bin/sigtool']) await copy(binary, root + binary);
for (const file of ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/localtime', '/usr/lib/os-release']) await copy(file, root + file);
await copy('/usr/share/zoneinfo', `${root}/usr/share/zoneinfo`);
await symlink('../usr/lib/os-release', `${root}/etc/os-release`);
await writeFile(`${root}/etc/passwd`, 'photo:x:65532:65532:Photo processor:/tmp/empty:/nonexistent\n');
await writeFile(`${root}/etc/group`, 'photo:x:65532:\n');
for (const directory of ['work', 'tmp', 'in', 'out', 'var/lib/clamav', 'usr/share/moth-photo-runtime']) await mkdir(join(root, directory), { recursive: true, mode: directory === 'tmp' ? 0o1777 : 0o755 });
for (const file of signatures.files) await copy(`/opt/signatures/${file.name}`, `${root}/var/lib/clamav/${file.name}`);
await copy('/opt/npm/node_modules', `${root}/work/node_modules`);
await copy('/opt/npm/package.json', `${root}/work/package.json`);
const source = [];
for (const path of pins.source) {
  const bytes = await readFile(`/opt/source/${path}`);
  source.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  await copy(`/opt/source/${path}`, `${root}/work/${path}`);
}
// This checks actual linked executables/imports inside the assembled filesystem,
// not builder-installed libraries. It does not execute a photo or bypass its guard.
for (const binary of ['/usr/local/bin/node', '/usr/bin/clamscan', '/usr/bin/vipsthumbnail', '/usr/bin/sigtool']) {
  execFileSync('/usr/sbin/chroot', [root, binary, '--version'], { timeout: 30000, maxBuffer: 16384, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
}
execFileSync('/usr/sbin/chroot', [root, '/usr/local/bin/node', '--experimental-strip-types', '--input-type=module', '-e', 'await import("/work/pipelines/process-photo/src/cli.ts")'], { timeout: 30000, maxBuffer: 16384, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
// Preserve distribution copyright/license notices without shipping doc tools.
for (const name of await readdir('/usr/share/doc')) {
  const path = `/usr/share/doc/${name}/copyright`;
  try { await copy(path, `${root}/usr/share/doc/${name}/copyright`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const metadata = `${root}/usr/share/moth-photo-runtime`;
await copy('/opt/recipe/inputs.json', `${metadata}/inputs.json`);
await copy('/opt/recipe/package-lock.json', `${metadata}/package-lock.json`);
await copy('/opt/recipe/debian-inventory.json', `${metadata}/debian-inventory.json`);
const recipe = [];
for (const name of (await readdir('/opt/recipe')).sort()) {
  if (name === 'debian-inventory.json') continue;
  const bytes = await readFile(`/opt/recipe/${name}`);
  recipe.push({ path: `pipelines/process-photo/container/${name}`, bytes: bytes.length, sha256: hash(bytes) });
}
const files = [];
async function walk(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const absolute = join(directory, name), stat = await lstat(absolute), path = absolute.slice(root.length);
    if (stat.isDirectory()) await walk(absolute);
    else if (stat.isSymbolicLink()) files.push({ path, link: await readlink(absolute) });
    else if (stat.isFile()) {
      const bytes = await readFile(absolute);
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
      // No writable runtime source/database or set-ID executable.
      await chmod(absolute, (stat.mode & 0o111) ? 0o555 : 0o444);
    } else throw Error(`Unexpected runtime file: ${path}`);
  }
}
await walk(root);
await writeFile(`${metadata}/runtime-files.json`, JSON.stringify(files, null, 2) + '\n', { mode: 0o444 });
const provenance = { format: 'photo-runtime-provenance-v1', platform: pins.platform, node_version: process.version, base_image: pins.node_image, debian_snapshot: pins.debian_snapshot, packages: inventory.packages, archives: inventory.archives, signatures, source, recipe, runtime_files_sha256: hash(await readFile(`${metadata}/runtime-files.json`)), qualification: 'not-qualified-until-independent-linux-acceptance-passes' };
await writeFile(`${metadata}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n', { mode: 0o444 });
// Stable file timestamps for identical pinned inputs. OCI exporter metadata can
// still differ; the image content ID and complete file inventory are recorded.
const epoch = Date.parse(signatures.daily_built_at) / 1000;
async function normalize(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await normalize(path);
    await utimes(path, epoch, epoch);
  }
  await utimes(directory, epoch, epoch);
}
await normalize(root);
