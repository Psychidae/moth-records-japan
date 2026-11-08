import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile, open, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['main.cvd', 'daily.cvd', 'bytecode.cvd'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function inspectSignatures(directory) {
  const files = [];
  for (const name of names) {
    const path = join(directory, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 512 || stat.size > 512 * 1024 * 1024) throw Error(`Bounded regular CVD required: ${name}`);
      bytes = Buffer.alloc(stat.size);
      let count = 0;
      while (count < bytes.length) {
        const part = await handle.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      const after = await handle.stat(), extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
      if (count !== bytes.length || extra.bytesRead || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw Error(`CVD changed while reading: ${name}`);
    } finally { await handle.close(); }
    if (bytes.length < 512 || !bytes.subarray(0, 11).equals(Buffer.from('ClamAV-VDB:'))) throw Error(`Official CVD required: ${name}`);
    const info = execFileSync('/usr/bin/sigtool', ['--info', path], { encoding: 'utf8', timeout: 120000, maxBuffer: 16384 });
    if (!/Verification OK\./.test(info)) throw Error(`CVD signature verification failed: ${name}`);
    const built = /^Build time:\s*(.+)$/m.exec(info)?.[1];
    const timestamp = Date.parse(built ?? '');
    if (!Number.isFinite(timestamp)) throw Error(`CVD build time missing: ${name}`);
    files.push({ name, bytes: bytes.length, sha256: hash(bytes), built_at: new Date(timestamp).toISOString(), info });
  }
  const daily_built_at = files.find(file => file.name === 'daily.cvd').built_at;
  const age = Date.now() - Date.parse(daily_built_at);
  if (age < -3600000 || age > 48 * 3600000) throw Error('ClamAV daily database must be no older than 48 hours');
  return { format: 'photo-signature-lock-v1', origin: 'https://database.clamav.net', daily_built_at, files };
}
export async function verifySignatures(directory) {
  const expected = JSON.parse(await readFile(join(directory, 'signature-lock.json'), 'utf8'));
  const actual = await inspectSignatures(directory);
  // sigtool prints the filename. Compare signed facts, not context-dependent paths.
  const stable = value => ({ format: value.format, origin: value.origin, daily_built_at: value.daily_built_at, files: value.files.map(({ name, bytes, sha256, built_at }) => ({ name, bytes, sha256, built_at })) });
  if (JSON.stringify(stable(expected)) !== JSON.stringify(stable(actual))) throw Error('Signature pin mismatch');
  if ((await readdir(directory)).sort().join(',') !== [...names, 'signature-lock.json'].sort().join(',')) throw Error('Unexpected signature input');
  return expected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'refresh' && directory === '/signatures') {
    if ((await readdir(directory)).length) throw Error('Fresh empty signature output required');
    if ((await readdir('/download')).length) throw Error('Fresh empty bounded download tmpfs required');
    execFileSync('/usr/bin/freshclam', ['--config-file=/opt/recipe/freshclam.conf', '--stdout'], { stdio: 'inherit', timeout: 900000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', TMPDIR: '/tmp' } });
    for (const name of ['freshclam.dat', 'mirrors.dat']) await rm(join('/download', name), { force: true });
    if ((await readdir('/download')).sort().join(',') !== [...names].sort().join(',')) throw Error('Unexpected downloaded signature input');
    const facts = await inspectSignatures('/download');
    for (const name of names) await copyFile(join('/download', name), join(directory, name), constants.COPYFILE_EXCL);
    await writeFile(join(directory, 'signature-lock.json'), JSON.stringify(facts, null, 2) + '\n', { flag: 'wx' });
    await verifySignatures(directory);
  } else if (mode === 'verify' && directory) {
    await verifySignatures(directory);
  } else throw Error('Expected refresh /signatures or verify DIRECTORY');
}
