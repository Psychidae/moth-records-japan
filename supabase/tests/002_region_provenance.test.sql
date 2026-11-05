-- Additional permission checks for the T07 source-identity columns.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

select ok(has_table_privilege('authenticated', 'public.regions', 'SELECT'),
  'ログイン利用者は地域を参照できる');
select ok(not has_column_privilege('authenticated', 'public.regions', 'seed_source', 'INSERT'),
  'ログイン利用者は地域の出典を偽装登録できない');
select ok(not has_column_privilege('authenticated', 'public.regions', 'seed_key', 'UPDATE'),
  'ログイン利用者は地域の出典識別を変更できない');
select ok(not has_table_privilege('anon', 'public.regions', 'SELECT'),
  '匿名は地域DBへ直接接続して読めない');

select * from finish(true);
rollback;
