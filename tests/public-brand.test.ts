import { cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { assertBrandPng,verifyPublicAssets } from '../apps/public/src/lib/public-assets.ts';
describe('approved PNG branding boundary',()=>{
  it('ships the four small RGBA PNGs and refuses invalid format or oversized images',()=>{
    expect(()=>verifyPublicAssets('apps/public/public')).not.toThrow();
    const png=readFileSync('apps/public/public/assets/actias-aliena-192.png');
    expect(()=>assertBrandPng(png,192,32768)).not.toThrow();
    expect(()=>assertBrandPng(png,96,32768)).toThrow();expect(()=>assertBrandPng(png,192,100)).toThrow();
    expect(()=>assertBrandPng(Buffer.from('<svg/>'),192,32768)).toThrow();
    const opaque=Buffer.from(png);opaque[25]=2;expect(()=>assertBrandPng(opaque,192,32768)).toThrow();
  });
  it('rejects unknown root/asset files, symlinks and modified PNG payloads',()=>{
    const root=mkdtempSync(join(tmpdir(),'moth-brand-'));
    try{
      mkdirSync(join(root,'data'));cpSync('apps/public/public/assets',join(root,'assets'),{recursive:true});
      writeFileSync(join(root,'private.json'),'{}');expect(()=>verifyPublicAssets(root)).toThrow('Unknown file');rmSync(join(root,'private.json'));
      writeFileSync(join(root,'assets','unapproved.png'),'x');expect(()=>verifyPublicAssets(root)).toThrow();rmSync(join(root,'assets','unapproved.png'));
      const path=join(root,'assets','actias-aliena-32.png');const png=readFileSync(path);const changed=Buffer.from(png);changed[changed.length-1]=0;writeFileSync(path,changed);expect(()=>verifyPublicAssets(root)).toThrow('hash');
      rmSync(path);symlinkSync(join(process.cwd(),'apps/public/public/assets/actias-aliena-32.png'),path);expect(()=>verifyPublicAssets(root)).toThrow('Unknown public brand');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
