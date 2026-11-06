import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Astro prerender bundles this module; resolve from the selected checkout, not a relocated import.meta.url.
export const dataRoot = join(process.cwd(),existsSync(join(process.cwd(),'apps/public')) ? 'apps/public/public/data' : 'public/data');
const countsSchema = z.strictObject({taxa:z.number().int().nonnegative(),species:z.number().int().nonnegative(),subspecies:z.number().int().nonnegative(),regions:z.number().int().nonnegative(),records:z.number().int().nonnegative(),references:z.number().int().nonnegative()});
export const manifestSchema = z.strictObject({version:z.string().regex(/^\d{4}\.\d{2}\.\d+$/),generatedAt:z.iso.datetime({offset:true}),counts:countsSchema,files:z.array(z.strictObject({path:z.string().regex(/^(?!.*(?:^|\/)\.\.\/)[a-zA-Z0-9_./-]+$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()})),licenses:z.strictObject({taxonomy:z.literal('CC0 1.0'),records:z.literal('CC BY 4.0')})});
const externalSchema = z.strictObject({status:z.enum(['uncollected','collected']),fetchedAt:z.iso.datetime({offset:true}).nullable(),doi:z.string().nullable(),citation:z.string().nullable()});
export const nationalSchema = z.strictObject({format:z.literal('national-v1'),version:z.string(),generatedAt:z.iso.datetime({offset:true}),counts:countsSchema,external:z.strictObject({inaturalist:externalSchema,gbif:externalSchema}),evidenceCounts:z.strictObject({original:z.number().int().nonnegative(),citation:z.number().int().nonnegative(),specimen:z.number().int().nonnegative(),photo_rg:z.number().int().nonnegative(),needs_review:z.number().int().nonnegative(),presence_only:z.number().int().nonnegative()})});
export function latestVersion(root = dataRoot): string {
  const versions = existsSync(root) ? readdirSync(root).filter(v => /^\d{4}\.\d{2}\.\d+$/.test(v)) : [];
  const selected = versions.sort((a,b) => {const aa=a.split('.').map(Number),bb=b.split('.').map(Number);return (aa[0]??0)-(bb[0]??0)||(aa[1]??0)-(bb[1]??0)||(aa[2]??0)-(bb[2]??0);}).at(-1);
  if (!selected) throw new Error('Verified public artifact required. Offline development only: MOTH_PUBLIC_BOOTSTRAP=1 pnpm build');
  return selected;
}
export function readPublicJson(path: string, version: string|undefined = undefined, root = dataRoot): unknown {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..') || path.startsWith('/')) throw new Error('Invalid public data path');
  const selected=z.string().regex(/^\d{4}\.\d{2}\.\d+$/).parse(version ?? latestVersion(root));
  return JSON.parse(readFileSync(join(root,selected,path),'utf8')) as unknown;
}
export function loadPublicRelease(root = dataRoot) {
  const version=latestVersion(root);
  if(lstatSync(root).isSymbolicLink()) throw new Error('Public data symlink forbidden');
  const manifests=new Map<string,z.infer<typeof manifestSchema>>();
  function files(directory:string,prefix=''):string[] {
    return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
      const path=join(directory,entry.name);const relative=prefix+entry.name;
      if(entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error('Public data symlink forbidden');
      if(entry.isDirectory()) return files(path,relative+'/');
      if(!entry.isFile()) throw new Error('Unknown public file type');
      return [relative];
    });
  }
  for(const entry of readdirSync(root,{withFileTypes:true})) {
    if(entry.isSymbolicLink()) throw new Error('Public data symlink forbidden');
    if(entry.name==='_development-origin.json' && entry.isFile()) continue;
    if(!/^\d{4}\.\d{2}\.\d+$/.test(entry.name) || !entry.isDirectory()) throw new Error('Unknown item in public data root');
    const current=manifestSchema.parse(readPublicJson('manifest.json',entry.name,root));
    if(current.version!==entry.name) throw new Error('Public version mismatch');
    const expected=['manifest.json',...current.files.map(f=>f.path)].sort();
    if(new Set(expected).size!==expected.length || JSON.stringify(files(join(root,entry.name)).sort())!==JSON.stringify(expected)) throw new Error('Public manifest coverage mismatch');
    for(const file of current.files) {
      if(file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Invalid manifest path');
      const data=readFileSync(join(root,entry.name,file.path));
      if(data.length!==file.bytes || createHash('sha256').update(data).digest('hex')!==file.sha256) throw new Error('Public artifact hash mismatch');
    }
    manifests.set(entry.name,current);
  }
  const manifest=manifests.get(version);
  if(!manifest) throw new Error('Public manifest missing');
  const national=nationalSchema.parse(readPublicJson('summary/national.json',version,root));
  if(national.version!==version || JSON.stringify(national.counts)!==JSON.stringify(manifest.counts)) throw new Error('Public summary mismatch');
  const markerPath=join(root,'_development-origin.json');
  const marker=existsSync(markerPath) ? z.strictObject({version:z.string(),kind:z.literal('offline-seed')}).parse(JSON.parse(readFileSync(markerPath,'utf8')) as unknown) : null;
  if(marker && !manifests.has(marker.version)) throw new Error('Development marker has no matching public version');
  return {version,manifest,national,hasDevelopmentArtifact:marker!==null,origin:marker?.version===version ? 'offline-seed' as const : 'supplied-artifact' as const};
}
