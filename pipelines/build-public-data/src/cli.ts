import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { StagingStore } from '../../external/src/http.ts';
import { buildListMjImport } from '../../import-listmj/src/import.ts';
import { buildRegionImport } from '../../regions/src/import.ts';
import { buildPublicData } from './build.ts';
import { sourceSchema } from './source.ts';

const args = z.array(z.string()).parse(process.argv.slice(2));
for (let i=0;i<args.length;i++) {
  const flag=args[i];
  if (flag === '--source' || flag === '--output') { const value=args[++i]; if (!value || value.startsWith('--')) throw new Error('Missing public-data argument value'); }
  else if (flag !== '--seed' && flag !== '--run') throw new Error('Unknown public-data argument');
}
const seed = args.includes('--seed'); const run = args.includes('--run'); const sourceIndex = args.indexOf('--source');
if (Number(seed)+Number(run)+Number(sourceIndex>=0)>1) throw new Error('Choose one public-data source');
const outputIndex = args.indexOf('--output'); const outputRoot = outputIndex >= 0 ? z.string().min(1).parse(args[outputIndex+1]) : 'apps/public/public/data';
const summary=(message:string)=> { console.log(message); if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,`${message}\n`,{flag:'a'}); };
let input: unknown;
let store: StagingStore | undefined;
if (sourceIndex >= 0) {
  const raw: unknown = JSON.parse(readFileSync(z.string().parse(args[sourceIndex+1]),'utf8'));
  input = sourceSchema.safeParse(raw).success ? raw : z.object({rows:z.array(z.object({data:z.unknown()})).length(1)}).parse(raw).rows[0]?.data;
} else if (seed) {
  const list = buildListMjImport(); const regions = buildRegionImport();
  const taxonIds = new Map(list.taxa.map((t,i) => [t.taxonCode,i+1])); const regionIds = new Map(regions.regions.map((r,i) => [r.code,i+1]));
  input = {taxa:list.taxa.map((t,i) => ({id:i+1,taxon_code:t.taxonCode,parent_id:t.parentCode === null ? null : taxonIds.get(t.parentCode),rank:t.rank,scientific_name:t.scientificName,name_ja:t.nameJa,family:t.family,authorship:t.authorship,status:t.status,sensitivity:0})),names:list.names.map(n => ({taxon_id:taxonIds.get(n.taxonCode),name:n.name})),regions:regions.regions.map((r,i) => ({id:i+1,code:r.code,parent_id:r.parentCode === null ? null : regionIds.get(r.parentCode),region_type:r.regionType,name_ja:r.nameJa,name_en:r.nameEn,area_group:r.areaGroup,sort_order:r.sortOrder})),references:[],profiles:[],records:[],snapshots:[],summaries:[],photos:[],releases:[]};
} else if (run && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  store = new StagingStore(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY); input = await store.publicSource();
}
if (input === undefined) {
  summary('待機: staging設定後に--run、またはprivate sourceを--sourceで指定します。');
} else {
  const result = buildPublicData(input,{outputRoot});
  if (store) await store.registerBuild(result.version,result.counts,result.manifestSha256);
  summary(`生成・全検査完了: ${result.version}、分類群${result.counts.taxa}、公開文献${result.counts.references}、公開記録${result.counts.records}。配信はまだ行っていません。`);
}
