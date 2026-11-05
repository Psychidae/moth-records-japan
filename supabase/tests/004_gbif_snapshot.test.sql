-- This is a mock DOI in a rolled-back fixture, never an actual GBIF download.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);
insert into public.taxa(id,taxon_code,rank,scientific_name) overriding system value
  values(-908003,'M990003','species','GBIF pgTAP fixture');
create function pg_temp.gbif_fixture() returns jsonb language sql as $$
  select jsonb_build_object('source','gbif','fetchedAt','1900-01-01T00:00:00Z',
    'queryNote','{"format":"DWCA","checklistKey":"d7dddbf4-2cf0-4f39-9b2a-bb099caae36c","predicate":{"type":"not","predicate":{"type":"equals","key":"DATASET_KEY","value":"50c9509d-22c7-4a22-a47d-8c48425ef4a7"}}}',
    'citation','pgTAP mock DOI fixture','doi','10.15468/dl.pgtapfixture',
    'mappings','[{"taxonCode":"M990003","externalId":991234997}]'::jsonb,
    'summaries','[{"taxonCode":"M990003","regionCode":"PR01","evidence":"specimen","count":2}]'::jsonb,
    'photos','[]'::jsonb)
$$;
select lives_ok($$select public.ingest_external_snapshot(pg_temp.gbif_fixture())$$,
  'GBIFの検証済み標本集計とモックDOIを保存できる');
select is((select doi from public.external_snapshots where citation='pgTAP mock DOI fixture'),
  '10.15468/dl.pgtapfixture','取得DOIを変更せず保持する');
select ok((select query_note::jsonb->>'format'='DWCA' and
  query_note::jsonb->>'checklistKey'='d7dddbf4-2cf0-4f39-9b2a-bb099caae36c'
  from public.external_snapshots where citation='pgTAP mock DOI fixture'),
  '形式とlegacy分類基盤の正確なrequestを保持する');
select throws_ok($$select public.ingest_external_snapshot(jsonb_set(pg_temp.gbif_fixture(),'{doi}','null'))$$,
  'P0001','invalid_snapshot_metadata','DOIなしのGBIF集計を保存しない');
select * from finish(true);
rollback;
