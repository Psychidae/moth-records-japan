-- Provider ingestion is callable only by the trusted job. All fixtures and
-- successful/failed ingestions below disappear at the final rollback.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

create function pg_temp.ingest_as(p_role name, p_payload jsonb) returns bigint
language plpgsql security invoker as $helper$
declare
  v_original_role name := current_user;
  v_result bigint;
begin
  execute format('set local role %I', p_role);
  select public.ingest_external_snapshot(p_payload) into v_result;
  execute format('set local role %I', v_original_role);
  return v_result;
exception when others then
  execute format('set local role %I', v_original_role);
  raise;
end $helper$;

create function pg_temp.external_fixture() returns jsonb
language sql as $fixture$
  select jsonb_build_object(
    'source','inaturalist','fetchedAt','1900-01-01T00:00:00Z',
    'queryNote','{"endpoint":"/pgTAP/transaction-fixture","photos_collected":false}',
    'citation','pgTAP transaction fixture','doi',null,
    'mappings',jsonb_build_array(jsonb_build_object('taxonCode','M990001','externalId',991234999)),
    'summaries',jsonb_build_array(jsonb_build_object('taxonCode','M990001','regionCode','PR01','evidence','photo_rg','count',2)),
    'photos','[]'::jsonb
  )
$fixture$;

insert into public.taxa(id,taxon_code,rank,scientific_name) overriding system value values
  (-908001,'M990001','species','External pgTAP first'),
  (-908002,'M990002','species','External pgTAP second');
create temporary table external_baseline as select count(*)::integer as snapshots from public.external_snapshots;

select ok(not has_function_privilege('anon','public.ingest_external_snapshot(jsonb)','EXECUTE'),
  '匿名には外部集計RPCの実行権限がない');
select ok(not has_function_privilege('authenticated','public.ingest_external_snapshot(jsonb)','EXECUTE'),
  'ログイン利用者には外部集計RPCの実行権限がない');
select ok(has_function_privilege('service_role','public.ingest_external_snapshot(jsonb)','EXECUTE'),
  '信頼されたジョブだけが外部集計RPCを実行できる');
select throws_ok($$ select pg_temp.ingest_as('anon',pg_temp.external_fixture()) $$,
  '42501','permission denied for function ingest_external_snapshot','匿名の実RPC呼出しを拒否する');
select throws_ok($$ select pg_temp.ingest_as('authenticated',pg_temp.external_fixture()) $$,
  '42501','permission denied for function ingest_external_snapshot','ログイン利用者の実RPC呼出しを拒否する');
select ok(not has_column_privilege('authenticated','public.external_snapshots','payload_digest','INSERT')
  and not has_column_privilege('authenticated','public.external_snapshots','payload_digest','UPDATE'),
  'ログイン利用者はスナップショット識別情報を書き込めない');
select ok((select not prosecdef and proconfig @> array['search_path=""']::text[]
  from pg_proc where oid='public.ingest_external_snapshot(jsonb)'::regprocedure),
  '外部集計RPCは呼出し元権限と固定search_pathで動く');
select lives_ok($$ select pg_temp.ingest_as('service_role',pg_temp.external_fixture()) $$,
  'service_roleによる検証済み集計の保存が成功する');
select is((select count(*)::integer from public.external_snapshots),
  (select snapshots+1 from external_baseline),'成功した集計はスナップショットを1件だけ作る');

select throws_ok($$ select pg_temp.ingest_as('service_role',
  jsonb_set(jsonb_set(jsonb_set(pg_temp.external_fixture(),'{fetchedAt}','"1900-01-02T00:00:00Z"'),
    '{mappings}','[{"taxonCode":"M990002","externalId":991234998}]'),
    '{summaries}','[{"taxonCode":"M999998","regionCode":"PR01","evidence":"photo_rg","count":1}]')) $$,
  'P0001','unmatched_external_summary_or_photo','後続の不正集計でRPC全体を失敗させる');
select ok((select inat_taxon_id is null from public.taxa where taxon_code='M990002')
  and (select count(*)::integer from public.external_snapshots)=(select snapshots+1 from external_baseline),
  '不正集計の前に行った対応づけもスナップショットも残らない');
select is(pg_temp.ingest_as('service_role',pg_temp.external_fixture()),
  pg_temp.ingest_as('service_role',pg_temp.external_fixture()),'同一集計を再投入しても既存IDを返す');

select * from finish(true);
rollback;
