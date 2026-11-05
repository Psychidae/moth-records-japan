begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(6);
create function pg_temp.export_as(p_role name) returns jsonb language plpgsql security invoker as $$
declare original_role name := current_user; result jsonb;
begin
  execute format('set local role %I',p_role);
  result := public.export_public_source();
  execute format('set local role %I',original_role); return result;
exception when others then
  execute format('set local role %I',original_role); raise;
end $$;
select throws_ok($$select pg_temp.export_as('anon')$$,'42501','permission denied for function export_public_source','匿名はprivate公開元snapshotを取得できない');
select throws_ok($$select pg_temp.export_as('authenticated')$$,'42501','permission denied for function export_public_source','利用者はprivate公開元snapshotを取得できない');
select lives_ok($$select pg_temp.export_as('service_role')$$,'信頼されたジョブだけが公開元snapshotを取得できる');
select ok((select not prosecdef and proconfig @> array['search_path=""']::text[] from pg_proc where oid='public.export_public_source()'::regprocedure),'公開元exportはinvokerと固定search_pathで動く');
select is(jsonb_array_length(public.export_public_source()->'references'),0,'pending文献を公開元投影へ含めない');
select is(jsonb_array_length(public.export_public_source()->'records'),0,'未公開・存在しない記録を公開元投影へ含めない');
select * from finish(true);
rollback;
