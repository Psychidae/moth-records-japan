import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createResumePlan, executeResumePlan, parseReadinessManifest, type ResumePlan } from '../scripts/recheck-environment.ts';

const manifest=readFileSync('scripts/secrets-manifest.tsv','utf8');
const names=parseReadinessManifest(manifest);
const workflows=new Set(['sync-inat.yml','sync-gbif.yml','publish-data.yml']);
const allReady={inaturalist:true,gbif:true,publicData:true};
const waiting={inaturalist:false,gbif:false,publicData:false};
const fakeSecret='fixture-canary-must-never-appear';
function check(required:string,values:Record<string,string>={},manifestText:string|null=manifest) {
  const root=mkdtempSync(join(tmpdir(),'moth-readiness-'));mkdirSync(join(root,'scripts'));
  if(manifestText!==null)writeFileSync(join(root,'scripts/secrets-manifest.tsv'),manifestText);
  const output=join(root,'output'); const summary=join(root,'summary'); writeFileSync(output,'');writeFileSync(summary,'');
  try {
    const result=spawnSync('bash',[resolve('.github/actions/require-env/check.sh')],{encoding:'utf8',env:{PATH:process.env.PATH??'/usr/bin:/bin',GITHUB_WORKSPACE:root,GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary,REQUIRED_ENV_NAMES:required,...values}});
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,output:readFileSync(output,'utf8'),summary:readFileSync(summary,'utf8')};
  } finally {rmSync(root,{recursive:true,force:true});}
}
const json=(value:unknown)=>new Response(JSON.stringify(value));
const plan:ResumePlan[]=[{id:'inaturalist',workflow:'sync-inat.yml',state:'ready',reason:'fixture'},{id:'gbif',workflow:'sync-gbif.yml',state:'ready',reason:'fixture'}];
const defaults={environment:'staging' as const,token:fakeSecret,runId:'123-1',repository:'Psychidae/moth-records-japan'};

describe('require-env without disclosing values',()=> {
  it('returns ready=false with missing names only and exits successfully',()=> {
    const result=check('SUPABASE_SERVICE_ROLE_KEY\nCONTACT_EMAIL');
    expect(result.status).toBe(0);expect(result.output).toBe('ready=false\nmissing=SUPABASE_SERVICE_ROLE_KEY,CONTACT_EMAIL\n');expect(result.summary).toContain('待機: SUPABASE_SERVICE_ROLE_KEY,CONTACT_EMAIL');
  });
  it('accepts present values without printing or persisting them and treats whitespace as missing',()=> {
    const result=check('SUPABASE_SERVICE_ROLE_KEY CONTACT_EMAIL',{SUPABASE_SERVICE_ROLE_KEY:fakeSecret,CONTACT_EMAIL:'fixture-contact@example.invalid'});
    expect(result.status).toBe(0);expect(result.output).toBe('ready=true\nmissing=\n');
    expect(JSON.stringify(result)).not.toMatch(/fixture-canary|fixture-contact/);
    expect(check('GBIF_PASSWORD',{GBIF_PASSWORD:' \t\n'}).output).toContain('ready=false');
  });
  it('rejects unknown names, shell fragments, duplicates and non-GitHub manifest targets',()=> {
    for(const required of ['UNKNOWN_KEY','SUPABASE_SERVICE_ROLE_KEY;echo x','$(echo bad)','CONTACT_EMAIL CONTACT_EMAIL','TURNSTILE_SECRET_KEY','']) {
      const result=check(required);expect(result.status).not.toBe(0);expect(result.output).toBe('');expect(result.stdout).not.toContain('bad');
    }
    expect(check('CONTACT_EMAIL',{},manifest+'CONTACT_EMAIL\tvariable\tgithub\tA\tx\tx\n').status).not.toBe(0);
    expect(check('CONTACT_EMAIL',{},'').status).not.toBe(0);
    expect(check('CONTACT_EMAIL',{},null).status).not.toBe(0);
  });
  it('validates the selected environment and main before creating a protected job',()=> {
    for(const [environment,ref,valid] of [['staging','refs/heads/main',true],['production','refs/heads/main',true],['unknown','refs/heads/main',false],['production\nmalicious','refs/heads/main',false],['production','refs/heads/feature',false]]) {
      const root=mkdtempSync(join(tmpdir(),'moth-recheck-input-'));const output=join(root,'output');writeFileSync(output,'');
      try {
        const result=spawnSync('bash',[resolve('scripts/validate-recheck.sh')],{encoding:'utf8',env:{PATH:process.env.PATH??'/usr/bin:/bin',REQUESTED_ENVIRONMENT:String(environment),GITHUB_REF:String(ref),GITHUB_OUTPUT:output}});
        expect(result.status===0).toBe(valid);expect(readFileSync(output,'utf8')).toBe(valid?`environment=${String(environment)}\n`:'');
      } finally {rmSync(root,{recursive:true,force:true});}
    }
  });
});

describe('resume planning and execution evidence',()=> {
  it('records missing keys and unimplemented DB/deployment honestly without any dispatch',async()=> {
    const created=createResumePlan('staging',waiting,workflows,names);const report:string[]=[];
    expect(created.map(item=>item.state)).toEqual(['unimplemented','waiting','waiting','waiting','unimplemented']);
    await executeResumePlan(created,{...defaults,token:'',report:message=>report.push(message),transport:async()=>{throw new Error('Network must not run');}});
    expect(report.filter(line=>line.startsWith('待機:'))).toHaveLength(3);expect(report.join('\n')).not.toContain('実行完了');
  });
  it('refuses unknown environments, missing manifest references and malformed readiness flags',()=> {
    expect(()=>createResumePlan('unknown',allReady,workflows,names)).toThrow();
    const incomplete=new Set(names);incomplete.delete('CONTACT_EMAIL');expect(()=>createResumePlan('staging',allReady,workflows,incomplete)).toThrow('unregistered');
    expect(()=>createResumePlan('staging',{...allReady,gbif:'true'},workflows,names)).toThrow();
    expect(createResumePlan('staging',allReady,new Set(['sync-inat.yml']),names).find(j=>j.id==='gbif')?.state).toBe('unimplemented');
  });
  it('does not route production to staging, even if someone injects a ready plan',async()=> {
    const created=createResumePlan('production',allReady,workflows,names);expect(created.every(j=>j.state==='unimplemented')).toBe(true);
    let calls=0;const transport=async()=>{calls++;return json({});};
    await executeResumePlan(created,{...defaults,environment:'production',transport});
    await expect(executeResumePlan(plan,{...defaults,environment:'production',transport})).rejects.toThrow('Production');expect(calls).toBe(0);
  });
  it('dispatches known main workflows sequentially and follows the exact returned run ID',async()=> {
    const calls:string[]=[];const report:string[]=[];let current=0;
    await executeResumePlan(plan,{...defaults,report:message=>report.push(message),sleep:async()=>undefined,transport:async(url,init)=> {
      calls.push(`${init?.method??'GET'} ${url}`);
      if(init?.method==='POST') {current++;expect(JSON.parse(String(init.body))).toEqual({ref:'main',inputs:{recheck_id:`123-1-${current}`}});return json({workflow_run_id:current});}
      if(url.includes('/jobs?')) return json({jobs:[{steps:[{name:'Run configured task',conclusion:'success'}]}]});
      return json({id:current,event:'workflow_dispatch',head_branch:'main',display_title:`Recheck 123-1-${current}`,status:'completed',conclusion:'success'});
    }});
    expect(report).toEqual(['実行完了: inaturalist (run 1)','実行完了: gbif (run 2)']);expect(report.join('')).not.toContain(fakeSecret);
    const second=calls.findIndex(line=>line.startsWith('POST')&&line.includes('sync-gbif'));
    expect(calls.slice(0,second).some(line=>line.includes('/runs/1/jobs'))).toBe(true);
  });
  it('stops after a child failure and reports skipped execution as waiting, never completion',async()=> {
    for(const outcome of ['failure','skipped','missing']) {
      let posts=0;const report:string[]=[];
      const promise=executeResumePlan(plan,{...defaults,report:message=>report.push(message),transport:async(url,init)=> {
        if(init?.method==='POST'){posts++;return json({workflow_run_id:1});}
        if(url.includes('/jobs?')) return json({jobs:[{steps:outcome==='missing'?[]:[{name:'Run configured task',conclusion:'skipped'}]}]});
        return json({id:1,event:'workflow_dispatch',head_branch:'main',display_title:'Recheck 123-1-1',status:'completed',conclusion:outcome==='failure'?'failure':'success'});
      }});
      if(outcome==='skipped') {await promise;expect(report[0]).toContain('待機:');}
      else await expect(promise).rejects.toThrow();
      expect(posts).toBe(1);expect(report.join('')).not.toContain('実行完了');
    }
  });
  it('times out without duplicate dispatches, rejects mismatched runs and never emits API response secrets',async()=> {
    let now=0;let posts=0;
    await expect(executeResumePlan(plan,{...defaults,now:()=>now,sleep:async ms=>{now+=ms;},timeoutMs:1000,transport:async(_url,init)=>{if(init?.method==='POST'){posts++;return json({workflow_run_id:1});}return json({id:1,event:'workflow_dispatch',head_branch:'main',display_title:'Recheck 123-1-1',status:'in_progress',conclusion:null});}})).rejects.toThrow('timed out');expect(posts).toBe(1);
    await expect(executeResumePlan(plan,{...defaults,transport:async(_url,init)=>init?.method==='POST'?json({workflow_run_id:1}):json({id:2,event:'workflow_dispatch',head_branch:'main',display_title:'Recheck 123-1-1',status:'completed',conclusion:'success'})})).rejects.toThrow('mismatch');
    await expect(executeResumePlan(plan,{...defaults,transport:async()=>new Response(fakeSecret,{status:403})})).rejects.toThrow('Workflow API HTTP 403');
    await expect(executeResumePlan([{id:'inaturalist',workflow:'untrusted.yml',state:'ready',reason:''}],{...defaults,transport:async()=>{throw new Error('must not call');}})).rejects.toThrow('Unapproved');
  });
});

describe('workflow protection and manifest alignment',()=> {
  it('requires block or quoted YAML scalars when shell summaries contain colon-space',()=> {
    const invalidInline=(source:string)=>[...source.matchAll(/^\s*(?:-\s*)?run:\s+(.+)$/gm)].some(match=> {
      const command=match[1]??'';return !/^[|>"']/.test(command)&&/:\s/.test(command);
    });
    expect(invalidInline("      - run: echo '確認のみ: 処理なし' >> summary")).toBe(true);
    expect(invalidInline("      - run: |\n          echo '確認のみ: 処理なし' >> summary")).toBe(false);
    for(const file of ['sync-inat.yml','sync-gbif.yml','publish-data.yml','recheck-env.yml']) expect(invalidInline(readFileSync(`.github/workflows/${file}`,'utf8'))).toBe(false);
  });
  it('puts secrets and action-write permission only behind the validated Environment job',()=> {
    const workflow=readFileSync('.github/workflows/recheck-env.yml','utf8');const before=workflow.split('  dispatch:')[0]??'';
    expect(before).not.toContain('secrets.');expect(before).not.toContain('actions: write');expect(before).not.toMatch(/^    environment:/m);
    expect(workflow).toContain('environment: ${{ needs.validate.outputs.environment }}');expect(workflow.match(/actions: write/g)).toHaveLength(1);
    expect(workflow).toContain('needs: validate');expect(workflow).not.toContain('pull_request');
  });
  it('guards each existing job before setup and matches vars/secrets to the public metadata manifest',()=> {
    const kinds=new Map(manifest.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const fields=line.split('\t');return [fields[0],fields[1]];}));
    for(const file of ['sync-inat.yml','sync-gbif.yml','publish-data.yml','recheck-env.yml']) {
      const source=readFileSync(`.github/workflows/${file}`,'utf8');expect(source).toContain('uses: ./.github/actions/require-env');
      if(file!=='recheck-env.yml') {expect(source.indexOf('uses: ./.github/actions/require-env')).toBeLessThan(source.indexOf('uses: pnpm/'));expect(source).toContain("if: steps.ready.outputs.ready == 'true'");expect(source).toContain('name: Run configured task');expect(source).toContain("format('Recheck {0}', inputs.recheck_id)");}
      for(const match of source.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}/g)) expect(kinds.get(match[2]),`${file}:${match[2]}`).toBe(match[1]==='secrets'?'secret':'variable');
    }
  });
});
