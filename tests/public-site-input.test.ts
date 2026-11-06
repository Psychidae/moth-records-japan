import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
describe('public build input isolation',()=>{
  it('requires explicit development seed use, refuses release use, and never silently reuses a seed as real data',()=>{
    const root=mkdtempSync(join(tmpdir(),'moth-build-input-'));
    try{
      for(const path of ['pipelines','packages','seed']) cpSync(path,join(root,path),{recursive:true,filter:source=>!source.includes('node_modules')});
      mkdirSync(join(root,'scripts'));cpSync('scripts/prepare-public-site.ts',join(root,'scripts/prepare-public-site.ts'));
      mkdirSync(join(root,'apps/public/src/lib'),{recursive:true});
      for(const file of ['data.ts','headers.ts']) cpSync(`apps/public/src/lib/${file}`,join(root,'apps/public/src/lib',file));
      symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
      const run=(bootstrap:boolean,release=false)=>spawnSync(process.execPath,['--experimental-strip-types','scripts/prepare-public-site.ts',...(release?['--release']:[])],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH??'',...(bootstrap?{MOTH_PUBLIC_BOOTSTRAP:'1'}:{})}});
      expect(run(false).status).not.toBe(0);
      expect(run(true,true).stderr).toContain('forbidden');
      const generated=run(true);expect(generated.status,generated.stderr).toBe(0);
      expect(generated.stdout).toContain('offline-seed');
      expect(readFileSync(join(root,'apps/public/public/data/_development-origin.json'),'utf8')).toContain('offline-seed');
      expect(run(false).stderr).toContain('explicit development/check');
      expect(run(true,true).status).not.toBe(0);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
