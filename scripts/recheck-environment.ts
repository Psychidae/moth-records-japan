import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const environmentSchema=z.enum(['staging','production']);
const manifestRow=z.tuple([z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),z.enum(['secret','variable','ci_only']),z.enum(['github','supabase','both']),z.enum(['A','B']),z.string().min(1),z.string().min(1)]);
export function parseReadinessManifest(text:string):Set<string> {
  const names=new Set<string>();
  const seen=new Set<string>();
  for(const line of text.split(/\r?\n/)) {
    if(!line || line.startsWith('#')) continue;
    const row=manifestRow.parse(line.split('\t'));
    if(seen.has(row[0])) throw new Error('Duplicate configuration name');
    seen.add(row[0]);
    if(row[1]==='ci_only') continue;
    names.add(row[0]);
  }
  if(!names.size) throw new Error('Empty configuration manifest');
  return names;
}
const definitions=[
  {id:'database',workflow:'deploy-staging.yml',required:['SUPABASE_ACCESS_TOKEN'],implemented:false,readyKey:null},
  {id:'inaturalist',workflow:'sync-inat.yml',required:['SUPABASE_SERVICE_ROLE_KEY','CONTACT_EMAIL'],implemented:true,readyKey:'inaturalist'},
  {id:'gbif',workflow:'sync-gbif.yml',required:['SUPABASE_SERVICE_ROLE_KEY','GBIF_USERNAME','GBIF_PASSWORD'],implemented:true,readyKey:'gbif'},
  {id:'public_data',workflow:'publish-data.yml',required:['SUPABASE_SERVICE_ROLE_KEY'],implemented:true,readyKey:'publicData'},
  {id:'deployment',workflow:'deploy-staging.yml',required:['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'],implemented:false,readyKey:null},
] as const;
const readinessSchema=z.strictObject({inaturalist:z.boolean(),gbif:z.boolean(),publicData:z.boolean()});
export type ResumePlan={id:string;workflow:string;state:'ready'|'waiting'|'unimplemented';reason:string};
export function createResumePlan(environment:unknown,readiness:unknown,availableWorkflows:ReadonlySet<string>,registeredNames:ReadonlySet<string>):ResumePlan[] {
  const target=environmentSchema.parse(environment); const ready=readinessSchema.parse(readiness);
  return definitions.map(job=> {
    if(job.required.some(name=>!registeredNames.has(name))) throw new Error('Workflow requires an unregistered configuration name');
    if(target==='production' || !job.implemented || !availableWorkflows.has(job.workflow)) return {id:job.id,workflow:job.workflow,state:'unimplemented',reason:target==='production'?'production対応は未実装':'処理は未実装'};
    return {id:job.id,workflow:job.workflow,state:ready[job.readyKey]?'ready':'waiting',reason:ready[job.readyKey]?'設定確認済み':'必要な設定が未登録'};
  });
}

type Transport=(url:string,init?:RequestInit)=>Promise<Response>;
const dispatchSchema=z.object({workflow_run_id:z.number().int().positive().safe()});
const runSchema=z.object({id:z.number().int().positive().safe(),event:z.literal('workflow_dispatch'),head_branch:z.literal('main'),display_title:z.string(),status:z.string(),conclusion:z.string().nullable()});
const jobsSchema=z.object({jobs:z.array(z.object({steps:z.array(z.object({name:z.string(),conclusion:z.string().nullable()}))}))});
export async function executeResumePlan(plan:ResumePlan[], options:{environment:'staging'|'production';token:string;runId:string;repository:string;transport?:Transport;now?:()=>number;sleep?:(ms:number)=>Promise<void>;timeoutMs?:number;report?:(message:string)=>void}):Promise<void> {
  const environment=environmentSchema.parse(options.environment);
  if(environment==='production'&&plan.some(item=>item.state==='ready')) throw new Error('Production resume targets are not implemented');
  z.literal('Psychidae/moth-records-japan').parse(options.repository);
  z.string().regex(/^[1-9]\d*-[1-9]\d*$/).parse(options.runId);
  const transport=options.transport??fetch; const now=options.now??Date.now; const sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+z.number().int().positive().max(5*60*60_000).parse(options.timeoutMs??5*60*60_000);
  const report=options.report??(()=>undefined);
  const allowed=new Set<string>(definitions.filter(d=>d.implemented).map(d=>d.workflow));
  async function request(path:string,init:RequestInit={}):Promise<Response> {
    if(now()>=deadline) throw new Error('Recheck timed out; a child run may still be active');
    const result=await transport(`https://api.github.com/repos/Psychidae/moth-records-japan/actions/${path}`,{...init,redirect:'error',headers:{Authorization:`Bearer ${options.token}`,'Content-Type':'application/json',Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...init.headers},signal:AbortSignal.timeout(30_000)});
    if(!result.ok) throw new Error(`Workflow API HTTP ${result.status}`);
    return result;
  }
  for(const [index,item] of plan.entries()) {
    if(item.state!=='ready') {report(`${item.state==='waiting'?'待機':'未実装'}: ${item.id}`);continue;}
    if(!allowed.has(item.workflow)||!definitions.some(d=>d.implemented&&d.id===item.id&&d.workflow===item.workflow)) throw new Error('Unapproved resume workflow');
    z.string().min(1).parse(options.token);
    const marker=`${options.runId}-${index+1}`;
    const dispatched=await request(`workflows/${item.workflow}/dispatches`,{method:'POST',body:JSON.stringify({ref:'main',inputs:{recheck_id:marker}})});
    const id=dispatchSchema.parse(await dispatched.json()).workflow_run_id;
    report(`起動: ${item.id} (run ${id})`);
    while(true) {
      const run=runSchema.parse(await (await request(`runs/${id}`)).json());
      if(run.id!==id||run.display_title!==`Recheck ${marker}`) throw new Error('Recheck workflow run mismatch');
      if(run.status==='completed') {
        if(run.conclusion!=='success') throw new Error(`Child workflow did not succeed: ${item.id}`);
        const jobs=jobsSchema.parse(await (await request(`runs/${id}/jobs?per_page=100`)).json());
        const steps=jobs.jobs.flatMap(job=>job.steps).filter(step=>step.name==='Run configured task');
        if(steps.length!==1) throw new Error('Child workflow has no unique execution evidence');
        if(steps[0]?.conclusion==='skipped') {report(`待機: ${item.id} (run ${id})。後続は再開していません。`);return;}
        if(steps[0]?.conclusion!=='success') throw new Error(`Child task did not succeed: ${item.id}`);
        report(`実行完了: ${item.id} (run ${id})`);break;
      }
      await sleep(15_000);
    }
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const input=z.strictObject({environment:environmentSchema,repo:z.literal('Psychidae/moth-records-japan'),runId:z.string(),attempt:z.string(),token:z.string(),inaturalist:z.enum(['true','false']),gbif:z.enum(['true','false']),publicData:z.enum(['true','false'])}).parse({environment:process.env.RECHECK_ENVIRONMENT,repo:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,token:process.env.GH_TOKEN??'',inaturalist:process.env.READY_INAT,gbif:process.env.READY_GBIF,publicData:process.env.READY_PUBLIC_DATA});
  const names=parseReadinessManifest(readFileSync('scripts/secrets-manifest.tsv','utf8'));
  const available=new Set(definitions.map(d=>d.workflow).filter(name=>{try {readFileSync(`.github/workflows/${name}`);return true;}catch{return false;}}));
  const plan=createResumePlan(input.environment,{inaturalist:input.inaturalist==='true',gbif:input.gbif==='true',publicData:input.publicData==='true'},available,names);
  const report=(message:string)=>{console.log(message);if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`${message}\n`);};
  await executeResumePlan(plan,{environment:input.environment,token:input.token,repository:input.repo,runId:`${input.runId}-${input.attempt}`,report});
}
