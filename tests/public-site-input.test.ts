import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { manifestSchema,nationalSchema } from '../apps/public/src/lib/data.ts';
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
      const data=join(root,'apps/public/public/data');
      const marker=z.object({version:z.string()}).parse(JSON.parse(readFileSync(join(data,'_development-origin.json'),'utf8')) as unknown);
      const next='2088.12.1';cpSync(join(data,marker.version),join(data,next),{recursive:true});
      const summary=nationalSchema.parse(JSON.parse(readFileSync(join(data,next,'summary/national.json'),'utf8')) as unknown);summary.version=next;
      const text=JSON.stringify(summary);writeFileSync(join(data,next,'summary/national.json'),text);
      const manifest=manifestSchema.parse(JSON.parse(readFileSync(join(data,next,'manifest.json'),'utf8')) as unknown);manifest.version=next;
      const file=manifest.files.find(f=>f.path==='summary/national.json');if(!file)throw new Error('Missing fixture summary');file.bytes=Buffer.byteLength(text);file.sha256=createHash('sha256').update(text).digest('hex');
      writeFileSync(join(data,next,'manifest.json'),JSON.stringify(manifest));
      expect(run(false,true).stderr).toContain('move development versions outside public');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
