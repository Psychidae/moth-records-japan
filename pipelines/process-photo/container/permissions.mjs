import { chmod, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** Normalize only the newly assembled image tree, never the host mount setup. */
export async function normalizeRuntimePermissions(root) {
  if (!isAbsolute(root)) throw Error('Absolute assembled image directory required');
  const first = await lstat(root);
  if (!first.isDirectory() || first.isSymbolicLink()) throw Error('Assembled image must be a real directory');
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return; // Do not traverse or chmod a link target.
    if (stat.isDirectory()) {
      // mkdir's requested mode is masked by umask; chmod is deliberately explicit.
      await chmod(path, relative(root, path) === 'tmp' ? 0o1777 : 0o755);
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (stat.isFile()) {
      await chmod(path, (stat.mode & 0o111) ? 0o555 : 0o444);
    } else throw Error('Unexpected assembled image file type');
  }
  await visit(root);
}
