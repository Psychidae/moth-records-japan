import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sourceSchema } from './source.ts';
import { verifyPublicDirectory } from './verify.ts';

const args=z.tuple([z.string().min(1),z.string().min(1)]).parse(process.argv.slice(2));
const raw:unknown=JSON.parse(readFileSync(args[0],'utf8'));
const source=sourceSchema.parse(sourceSchema.safeParse(raw).success ? raw : z.object({rows:z.array(z.object({data:z.unknown()})).length(1)}).parse(raw).rows[0]?.data);
const regions=new Map(source.regions.map(r=>[r.id,r]));
const result=verifyPublicDirectory(args[1],new Map(source.taxa.map(t=>[t.taxon_code,t.sensitivity])),{trustedRegions:new Map(source.regions.map(r=>[r.code,{regionType:r.region_type,parent:r.parent_id===null ? null : regions.get(r.parent_id)?.code ?? null}]))});
console.log(`全出力検査成功: ${result.files}ファイル、公開記録${result.records}件。`);
