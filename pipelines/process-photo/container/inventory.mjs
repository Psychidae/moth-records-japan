import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const pins = JSON.parse(await readFile('/opt/recipe/inputs.json', 'utf8'));
const archives = [];
for (const name of (await readdir('/var/cache/apt/archives')).sort()) {
  if (!name.endsWith('.deb')) continue;
  const path = `/var/cache/apt/archives/${name}`;
  const bytes = await readFile(path);
  const [pkg, version, architecture] = execFileSync('dpkg-deb', ['-f', path, 'Package', 'Version', 'Architecture'], { encoding: 'utf8' }).trim().split('\n').map(line => line.replace(/^[^:]+: /, ''));
  archives.push({ name, package: pkg, version, architecture, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const [name, expected] of Object.entries(pins.packages)) {
  const archive = archives.find(item => item.package === name);
  if (!archive || archive.version !== expected.version || archive.sha256 !== expected.sha256) throw Error(`Pinned Debian archive mismatch: ${name}`);
}
const packages = execFileSync('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n'], { encoding: 'utf8' }).trim().split('\n').sort().map(line => {
  const [name, version, architecture] = line.split('\t');
  return { name, version, architecture };
});
if (process.version !== pins.node_version) throw Error('Pinned Node version required');
await writeFile('/opt/recipe/debian-inventory.json', JSON.stringify({ packages, archives }, null, 2) + '\n');
