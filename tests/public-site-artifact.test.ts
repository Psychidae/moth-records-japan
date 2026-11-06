import { createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { loadPublicRelease } from '../apps/public/src/lib/data.ts';
const counts={taxa:0,species:0,subspecies:0,regions:0,records:0,references:0};
const external={status:'uncollected',fetchedAt:null,doi:null,citation:null};
function fixture(root:string,version:string){
  const directory=join(root,version);mkdirSync(join(directory,'summary'),{recursive:true});
  const national=JSON.stringify({format:'national-v1',version,generatedAt:'2026-11-06T00:00:00Z',counts,external:{inaturalist:external,gbif:external},evidenceCounts:{original:0,citation:0,specimen:0,photo_rg:0,needs_review:0,presence_only:0}});
  writeFileSync(join(directory,'summary/national.json'),national);
  writeFileSync(join(directory,'manifest.json'),JSON.stringify({version,generatedAt:'2026-11-06T00:00:00Z',counts,files:[{path:'summary/national.json',bytes:Buffer.byteLength(national),sha256:createHash('sha256').update(national).digest('hex')}],licenses:{taxonomy:'CC0 1.0',records:'CC BY 4.0'}}));
  return directory;
}
describe('all shipped public artifact coverage',()=>{
  it('rejects unlisted private files in current or older versions and unknown root items',()=>{
    const root=mkdtempSync(join(tmpdir(),'moth-site-artifact-'));
    try{
      const current=fixture(root,'2026.11.2');expect(loadPublicRelease(root).version).toBe('2026.11.2');
      writeFileSync(join(current,'private-source.json'),'{}');expect(()=>loadPublicRelease(root)).toThrow('coverage');rmSync(join(current,'private-source.json'));
      const older=fixture(root,'2026.11.1');writeFileSync(join(older,'unlisted.json'),'{}');expect(()=>loadPublicRelease(root)).toThrow('coverage');rmSync(older,{recursive:true});
      writeFileSync(join(root,'source-envelope.json'),'{}');expect(()=>loadPublicRelease(root)).toThrow('Unknown item');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('rejects symlinks and mutated listed bytes instead of copying them to dist',()=>{
    const root=mkdtempSync(join(tmpdir(),'moth-site-artifact-'));
    try{
      const current=fixture(root,'2026.11.2');symlinkSync(join(current,'summary/national.json'),join(current,'linked.json'));
      expect(()=>loadPublicRelease(root)).toThrow('symlink');rmSync(join(current,'linked.json'));
      writeFileSync(join(current,'summary/national.json'),'{}');expect(()=>loadPublicRelease(root)).toThrow('hash');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
