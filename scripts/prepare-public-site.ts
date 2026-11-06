import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { latestVersion, loadPublicRelease } from '../apps/public/src/lib/data.ts';
import { cloudflareHeaders } from '../apps/public/src/lib/headers.ts';
const repository=fileURLToPath(new URL('../',import.meta.url));
const publicDirectory=join(repository,'apps/public/public');
const root=join(publicDirectory,'data');
const releaseBuild=process.argv.includes('--release');
if(process.env.MOTH_PUBLIC_BOOTSTRAP==='1' && (releaseBuild || process.env.GITHUB_ENVIRONMENT==='production')) throw new Error('Development bootstrap forbidden in release/production context');
const hasRelease=existsSync(root) && (()=>{try{latestVersion(root);return true;}catch{return false;}})();
if(!hasRelease) {
  if(process.env.MOTH_PUBLIC_BOOTSTRAP!=='1') throw new Error('Verified public artifact missing; release builds never bootstrap. Explicit local/check-only option: MOTH_PUBLIC_BOOTSTRAP=1');
  const result=spawnSync(process.execPath,['--experimental-strip-types','pipelines/build-public-data/src/cli.ts','--seed','--output',root],{cwd:repository,stdio:'inherit'});
  if(result.status!==0) throw new Error('Offline seed generation failed');
  writeFileSync(join(root,'_development-origin.json'),JSON.stringify({version:latestVersion(root),kind:'offline-seed'})+'\n');
}
const release=loadPublicRelease(root);
if(release.hasDevelopmentArtifact && (releaseBuild || process.env.MOTH_PUBLIC_BOOTSTRAP!=='1')) throw new Error('Offline seed is for explicit development/check builds only; move development versions outside public before release');
mkdirSync(publicDirectory,{recursive:true});
writeFileSync(join(publicDirectory,'_headers'),cloudflareHeaders);
console.log(`公開サイト入力: ${release.version} / ${release.origin}（配信は未実行）`);
