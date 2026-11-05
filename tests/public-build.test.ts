import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeTable } from '../packages/public-data/src/index.ts';
import { buildPublicData, nextVersion } from '../pipelines/build-public-data/src/build.ts';
import { exportSourceSql, type PublicSource } from '../pipelines/build-public-data/src/source.ts';
import { StagingStore } from '../pipelines/external/src/http.ts';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(),'moth-build-test-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path,{recursive:true,force:true}); });
const date = '2026-11-06T00:00:00Z';
function fixture(): PublicSource {
  const family = {id:1,taxon_code:'M000001',parent_id:null,rank:'family' as const,scientific_name:'Testidae',name_ja:'テスト科',family:'Testidae',authorship:null,status:'accepted' as const,sensitivity:0};
  return {taxa:[family,{...family,id:2,taxon_code:'M000002',parent_id:1,rank:'genus',scientific_name:'Testus'},{...family,id:3,taxon_code:'M000003',parent_id:2,rank:'species',scientific_name:'Testus testus'}],names:[{taxon_id:3,name:'別名'}],regions:[{id:1,code:'PR01',parent_id:null,region_type:'prefecture',name_ja:'北海道',name_en:'Hokkaido',area_group:'Hokkaido',sort_order:1},{id:2,code:'IS0001',parent_id:1,region_type:'island',name_ja:'試験島',name_en:'Test Island',area_group:null,sort_order:2}],references:[{id:1,ref_code:'R000001',status:'published',title:'Test reference',title_en:null,year:2000,year_text:null,container_title:'Test Journal',volume:'1',issue:null,pages:'1-2',publisher:null,doi:null,authors:'Author'}],profiles:[{id:'11111111-1111-4111-8111-111111111111',display_name:'表示名',public_credit:true}],records:[],snapshots:[],summaries:[],photos:[],releases:[]};
}
function record(overrides: Partial<PublicSource['records'][number]> = {}): PublicSource['records'][number] {
  return {record_code:'D0000001',taxon_id:3,region_id:1,island_id:null,reference_id:1,page:'2',name_as_published:'Testus testus',category:'original',accuracy:'normal',status:'published',submitted_by:'11111111-1111-4111-8111-111111111111',locality_verbatim:'Private exact locality',locality_modern:null,lat:35.12,lon:139.12,event_date_verbatim:'2000.1.1',date_start:'2000-01-01',date_end:null,collector_verbatim:'Collector',specimen_ref:'A1',note:'Record note',individual_count:1,sex:'male',life_stage:'adult',depository:'Collection',coord_uncertainty_m:10,...overrides};
}
const readTable = (directory: string,path: string) => decodeTable(JSON.parse(readFileSync(join(directory,path),'utf8')) as unknown);

describe('public data builder', () => {
  it('generates allowlisted columnar files, checksums, consented credit and unpublished exclusion', () => {
    const source = fixture(); source.records=[record(),record({record_code:'D0000002',status:'pending',note:'secret@example.org'})];
    const result = buildPublicData(source,{outputRoot:root(),generatedAt:date});
    expect(result.counts.records).toBe(1);
    const records = readTable(result.directory,'records/region/PR01.json');
    expect(records[0]?.credit).toBe('表示名'); expect(records[0]?.reference).toBe('R000001');
    expect(readFileSync(join(result.directory,'names.json'),'utf8')).not.toMatch(/11111111|submitted_by|secret@example/);
    expect(readTable(result.directory,'summary/matrix.json')).toEqual([{taxon:'M000003',region:'PR01',evidence:1,discovery:false}]);
    source.profiles[0]!.public_credit=false;
    const second = buildPublicData(source,{outputRoot:root(),generatedAt:date}); expect(readTable(second.directory,'records/region/PR01.json')[0]?.credit).toBe(null);
  });
  it('redacts all sensitive details, coarsens islands, and exposes sensitivity2 only as regional presence', () => {
    const source = fixture(); source.taxa[2]!.sensitivity=1;
    source.taxa.push({...source.taxa[2]!,id:4,taxon_code:'M000004',scientific_name:'Testus secretus',sensitivity:2});
    source.references.push({...source.references[0]!,id:2,ref_code:'R000002',title:'Hidden-only reference'});
    source.records=[record({region_id:2,island_id:2}),record({record_code:'D0000002',taxon_id:4,reference_id:2,region_id:2,island_id:2})];
    const result = buildPublicData(source,{outputRoot:root(),generatedAt:date});
    expect(result.counts.records).toBe(1); expect(result.counts.references).toBe(1);
    const output = readTable(result.directory,'records/region/PR01.json')[0];
    expect(output?.island).toBe(null); expect(output?.note).toBe(null); expect(output?.lat).toBe(null); expect(output?.locality_verbatim).toBe(null);
    expect(readTable(result.directory,'records/region/IS0001.json')).toEqual([]);
    expect(readTable(result.directory,'summary/matrix.json').map(r => r.region)).toEqual(['PR01','PR01']);
    expect(readTable(result.directory,'summary/matrix.json').find(r=>r.taxon==='M000004')).toMatchObject({evidence:6,discovery:false});
    expect(readTable(result.directory,'references/index.json').some(r => r.ref_code==='R000002')).toBe(false);
  });
  it('preserves evidence priority, ignores board/misidentification for scores and labels uncollected external sources', () => {
    const source = fixture(); source.records=[record({category:'board'}),record({record_code:'D0000002',accuracy:'misidentification'})];
    let result = buildPublicData(source,{outputRoot:root(),generatedAt:date});
    expect(readTable(result.directory,'summary/matrix.json')).toEqual([]);
    const national = JSON.parse(readFileSync(join(result.directory,'summary/national.json'),'utf8')) as {external:{gbif:{status:string}}};
    expect(national.external.gbif.status).toBe('uncollected');
    source.snapshots=[{id:1,source:'gbif',fetched_at:date,doi:'10.15468/dl.fixture',citation:'GBIF fixture'}]; source.summaries=[{snapshot_id:1,taxon_id:3,region_id:1,evidence:'specimen',occurrence_count:5}];
    result=buildPublicData(source,{outputRoot:root(),generatedAt:date}); expect(readTable(result.directory,'summary/matrix.json')[0]).toMatchObject({evidence:3,discovery:true});
    source.records.push(record({record_code:'D0000003',category:'citation'}));
    result=buildPublicData(source,{outputRoot:root(),generatedAt:date}); expect(readTable(result.directory,'summary/matrix.json')[0]).toMatchObject({evidence:2,discovery:false});
  });
  it('fails atomically for nonpublic references, unsafe text and unsafe island ancestry', () => {
    for (const alter of [
      (s:PublicSource) => { s.references[0]!.status='pending'; },
      (s:PublicSource) => { s.records[0]!.note='secret@example.org'; },
      (s:PublicSource) => { s.records[0]!.note='50c9509d-22c7-4a22-a47d-8c48425ef4a7'; },
      (s:PublicSource) => { s.taxa[2]!.sensitivity=1; s.records[0]!.region_id=2; s.regions[1]!.parent_id=null; },
    ]) {
      const source=fixture(); source.records=[record()]; alter(source); const output=root();
      expect(() => buildPublicData(source,{outputRoot:output,generatedAt:date})).toThrow();
      expect(readdirSync(output)).toEqual([]);
    }
  });
  it('splits large region/genus/CSV files and neutralizes spreadsheet formulas without changing the private original', () => {
    const source=fixture(); source.records=Array.from({length:120},(_,i) => record({record_code:`D${String(i+1).padStart(7,'0')}`,locality_verbatim:'=HYPERLINK("https://example.org")',note:`${i}:`+'x'.repeat(1000)}));
    const result=buildPublicData(source,{outputRoot:root(),generatedAt:date,maxBytes:20_000});
    expect(readdirSync(join(result.directory,'records/region/PR01')).some(n=>n.startsWith('family-M000001-part-'))).toBe(true);
    const csvName=readdirSync(join(result.directory,'downloads')).find(n=>n.startsWith('PR01-part-')); expect(csvName).toBeDefined();
    const csv=gunzipSync(readFileSync(join(result.directory,'downloads',csvName!))).toString('utf8'); expect(csv).toContain("'=HYPERLINK");
    expect(source.records[0]?.locality_verbatim).toBe('=HYPERLINK("https://example.org")');
  });
  it('uses JST for version months and refuses to overwrite an existing artifact', () => {
    expect(nextVersion([{version:'2026.11.1'}],'2026-10-31T15:30:00Z')).toBe('2026.11.2');
    const output=root(); buildPublicData(fixture(),{outputRoot:output,generatedAt:date});
    expect(()=>buildPublicData(fixture(),{outputRoot:output,generatedAt:date})).toThrow('already exists');
  });
  it('round-trips CSV neutralization for Unicode whitespace and DEL controls', () => {
    const source=fixture(); source.records=[record({note:'\u00a0=1'}),record({record_code:'D0000002',note:'\u007ftext'})];
    const result=buildPublicData(source,{outputRoot:root(),generatedAt:date});
    const csv=gunzipSync(readFileSync(join(result.directory,'downloads/PR01.csv.gz'))).toString('utf8');
    expect(csv).toContain("'\u00a0=1"); expect(csv).toContain("'\u007ftext");
  });
  it('keeps the migration projection identical to the inspectable source query', () => {
    const filename=readdirSync('supabase/migrations').find(n=>n.endsWith('_public_source_export.sql'))!;
    expect(readFileSync(join('supabase/migrations',filename),'utf8')).toContain(exportSourceSql.trim().replace(/;$/,''));
  });
  it('registers only building releases and refuses a conflicting existing version', async () => {
    for (const conflict of [false,true]) {
      const calls:RequestInit[]=[];
      const store=new StagingStore('https://zbbmvrmmxhrytwqrjyyk.supabase.co','fixture-only',async (_url,init)=> {
        if (init) calls.push(init);
        if (init?.method==='POST') { expect(JSON.parse(String(init.body))).toMatchObject({status:'building'}); expect(new Headers(init.headers).get('Prefer')).toContain('ignore-duplicates'); return new Response(null,{status:204}); }
        return new Response(JSON.stringify([{version:'2026.11.1',counts:{records:0},artifact_sha256:(conflict?'b':'a').repeat(64)}]));
      });
      if (conflict) await expect(store.registerBuild('2026.11.1',{records:0},'a'.repeat(64))).rejects.toThrow('different content');
      else await expect(store.registerBuild('2026.11.1',{records:0},'a'.repeat(64))).resolves.toBeUndefined();
      expect(calls.some(c=>c.method==='PATCH'||c.method==='DELETE')).toBe(false);
    }
  });
});
