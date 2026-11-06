import { spawnSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
describe('public name validation with dynamic execution unavailable',()=>{
  it('constructs and parses the search schemas without probing the Function constructor',()=>{
    const code=`let calls=0;globalThis.Function=new Proxy(globalThis.Function,{construct(){calls++;throw Error('dynamic execution forbidden');},apply(){calls++;throw Error('dynamic execution forbidden');}});const {encodeTable}=await import('./packages/public-data/src/index.ts');const {createSearchIndex,searchNames}=await import('./packages/public-data/src/search.ts');const index=createSearchIndex(encodeTable('names-v1',[['M000001','Actias aliena','オオミズアオ','']]));if(searchNames(index,'おおみずあお').length!==1||calls!==0)throw Error('CSP validation failed');`;
    const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',env:{PATH:process.env.PATH??''}});
    expect(result.status,result.stderr).toBe(0);
  });
});
