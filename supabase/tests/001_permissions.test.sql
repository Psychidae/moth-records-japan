-- Complete, ordered port of all 56 assertions in tests/schema_smoke.mjs.
-- The original Japanese descriptions are the coverage keys; do not remove them.
-- Fixture rows and all test changes are rolled back, including extension setup.
begin;
create schema if not exists extensions;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(56);

-- Run application SQL as a genuine database role. This is deliberately SECURITY
-- INVOKER: RLS and column privileges must run as anon/authenticated, not postgres.
-- Restore the caller's role and claims on both success and exception.
create function pg_temp.run_as(p_user uuid, p_aal text, p_sql text, p_capture boolean default false)
returns jsonb language plpgsql as $helper$
declare
  v_original_role name := current_user;
  v_original_claims text := current_setting('request.jwt.claims', true);
  v_result jsonb;
  v_rows bigint;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '{}'
    else jsonb_build_object('sub', p_user::text, 'aal', p_aal)::text end, true);
  execute format('set local role %I', case when p_user is null then 'anon' else 'authenticated' end);
  if p_capture then
    execute p_sql into v_result;
  else
    execute p_sql;
  end if;
  get diagnostics v_rows = row_count;
  execute format('set local role %I', v_original_role);
  perform set_config('request.jwt.claims', coalesce(v_original_claims, ''), true);
  return jsonb_build_object('value', v_result, 'row_count', v_rows);
exception when others then
  execute format('set local role %I', v_original_role);
  perform set_config('request.jwt.claims', coalesce(v_original_claims, ''), true);
  raise;
end
$helper$;

-- Explicit negative identity values keep fixture lookups independent of seeds
-- and existing sequence values. Codes/UUIDs occupy an isolated test namespace.
insert into auth.users(id) values
  ('f0040000-0000-0000-0000-000000000001'),
  ('f0040000-0000-0000-0000-000000000002'),
  ('f0040000-0000-0000-0000-000000000003'),
  ('f0040000-0000-0000-0000-000000000004'),
  ('f0040000-0000-0000-0000-000000000005'),
  ('f0040000-0000-0000-0000-000000000009');
insert into public.profiles(id, display_name) values
  ('f0040000-0000-0000-0000-000000000001', 'pgTAP owner1'),
  ('f0040000-0000-0000-0000-000000000002', 'pgTAP owner2'),
  ('f0040000-0000-0000-0000-000000000003', 'pgTAP admin'),
  ('f0040000-0000-0000-0000-000000000004', 'pgTAP reviewer'),
  ('f0040000-0000-0000-0000-000000000005', 'pgTAP alice'),
  ('f0040000-0000-0000-0000-000000000009', 'pgTAP bob');
insert into public.role_assignments(id, user_id, role) overriding system value values
  (-904001, 'f0040000-0000-0000-0000-000000000001', 'owner'),
  (-904002, 'f0040000-0000-0000-0000-000000000002', 'owner'),
  (-904003, 'f0040000-0000-0000-0000-000000000003', 'admin'),
  (-904004, 'f0040000-0000-0000-0000-000000000004', 'reviewer');
insert into public.regions(id, code, region_type, name_ja, name_en) overriding system value
  values (-904001, 'TAP04', 'prefecture', '権限テスト用地域', 'Permission test region');
insert into public.taxa(id, taxon_code, rank, scientific_name) overriding system value
  values (-904001, 'M999901', 'species', 'Issikiomartyria nudata');
insert into public.feature_flags(key, description) values ('pgtap_t04', '権限テスト用フラグ');
insert into public.references_(id, ref_code, ref_type, title, status, submitted_by) overriding system value
  values (-904001, 'R999901', 'article', 'pgTAP seed paper', 'published',
    'f0040000-0000-0000-0000-000000000005');

-- 01-03: anonymous table privileges, rather than a misleading empty result.
select throws_like($$select pg_temp.run_as(null, null, 'select * from public.taxa')$$,
  '%permission denied%', '匿名は taxa を読めない');
select throws_like($$select pg_temp.run_as(null, null, 'select * from public.records')$$,
  '%permission denied%', '匿名は records を読めない');
select throws_like($$select pg_temp.run_as(null, null, 'select * from public.audit_log')$$,
  '%permission denied%', '匿名は監査ログを読めない');

-- 04-12: submissions, forged review configuration, review, and zero-row UPDATE.
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, taxon_id,
    category, region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904001, 'D9999001', -904001, '12', 'Issikiomartyria nudata', -904001,
    'original', -904001, '札幌市', 'pending', 'f0040000-0000-0000-0000-000000000005')
$sql$)->>'row_count')::bigint, 1::bigint, '投稿者は pending を投稿できる');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, category,
    region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904002, 'D9999002', -904001, '12', 'Issikiomartyria nudata', 'original',
    -904001, '札幌市', 'published', 'f0040000-0000-0000-0000-000000000005')
$sql$)$$, '%status_change_requires_review%', '投稿者は published で投稿できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$update public.records set status='published' where id=-904001$sql$)$$,
  '%status_change_requires_review%', '投稿者は自分の記録を公開へ更新できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, category,
    region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904003, 'D9999003', -904001, '12', 'Issikiomartyria nudata', 'original',
    -904001, '札幌市', 'pending', 'f0040000-0000-0000-0000-000000000005')
$sql$)$$, '%submitted_by_must_be_self%', '他人名義で投稿できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$select app.review_submission('records', -904001, 'published')$sql$)$$,
  '%forbidden%', '投稿者は審査関数を使えない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1', $sql$
  with forged as materialized (select set_config('app.in_review', 'on', true))
  update public.records set status='published' from forged where id=-904001
$sql$)$$, '%status_change_requires_review%', 'set_config で審査を偽装できない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.review_submission('records', -904001, 'published')$sql$)$$,
  '審査者は他人の投稿を公開できる');
select is(pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$select to_jsonb(status) from public.records where id=-904001$sql$, true)->>'value',
  'published', '投稿者が公開済み記録を読める');
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$update public.records set page='13' where id=-904001 returning to_jsonb(id)$sql$,
  true)->>'row_count')::bigint, 0::bigint, '公開済み記録は投稿者が直接変更できない');

-- 13-14: self-review must fail at the privileged database function.
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, category,
    region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904004, 'D9999004', -904001, '1', 'x', 'original', -904001, '札幌',
    'pending', 'f0040000-0000-0000-0000-000000000004')
$sql$)->>'row_count')::bigint, 1::bigint, '審査者自身の投稿を用意');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.review_submission('records', -904004, 'published')$sql$)$$,
  '%self_review_forbidden%', '自分の投稿は自己承認できない');

-- 15-17: MFA and actual affected-row checks for configuration changes.
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000003', 'aal1',
  $sql$update public.feature_flags set enabled=true where key='pgtap_t04'$sql$)$$,
  '%row-level security%', 'MFAなしの管理者はフラグを変更できない');
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000003', 'aal2',
  $sql$update public.feature_flags set enabled=true where key='pgtap_t04' returning to_jsonb(key)$sql$,
  true)->>'row_count')::bigint, 1::bigint, 'MFAありの管理者はフラグを変更できる');
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal2',
  $sql$update public.feature_flags set enabled=false where key='pgtap_t04' returning to_jsonb(key)$sql$,
  true)->>'row_count')::bigint, 0::bigint, '投稿者はフラグを変更できない');

-- 18-28: role assignment, MFA, two independent owners, and column grants.
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000003', 'aal2',
  $sql$select app.request_role('f0040000-0000-0000-0000-000000000005', 'admin')$sql$)$$,
  '%forbidden%', '管理者は管理者を任命できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000001', 'aal1',
  $sql$select app.request_role('f0040000-0000-0000-0000-000000000005', 'admin')$sql$)$$,
  '%mfa_required%', 'MFAなしのオーナーは任命できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000001', 'aal2',
  $sql$select app.request_role('f0040000-0000-0000-0000-000000000001', 'admin')$sql$)$$,
  '%self_grant_forbidden%', '自分への権限付与はできない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000001', 'aal2',
  $sql$select app.request_role('f0040000-0000-0000-0000-000000000005', 'admin')$sql$)$$,
  'オーナーは管理者任命を申請できる');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000001', 'aal2', $sql$
  select app.approve_role((select id from public.role_assignments
    where user_id='f0040000-0000-0000-0000-000000000005' and role='admin' and status='pending'))
$sql$)$$, '%second_person_required%', '申請者本人は承認できない');
select is(pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal2',
  $sql$select to_jsonb(app.has_role(array['admin']))$sql$, true)->'value',
  'false'::jsonb, '承認前は管理者権限を持たない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000002', 'aal2', $sql$
  select app.approve_role((select id from public.role_assignments
    where user_id='f0040000-0000-0000-0000-000000000005' and role='admin' and status='pending'))
$sql$)$$, '別のオーナーが承認できる');
select is(pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal2',
  $sql$select to_jsonb(app.has_role(array['admin']))$sql$, true)->'value',
  'true'::jsonb, '承認後は管理者権限を持つ');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000002', 'aal2',
  $sql$select app.revoke_role(-904001)$sql$)$$,
  '%at_least_two_owners_required%', 'オーナーは2名未満にできない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal2', $sql$
  insert into public.role_assignments(user_id, role)
  values ('f0040000-0000-0000-0000-000000000004', 'owner')
$sql$)$$, '%permission denied%', '投稿者は role_assignments へ直接書けない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal2',
  $sql$update public.profiles set trust_level=2 where id='f0040000-0000-0000-0000-000000000004'$sql$)$$,
  '%permission denied%', 'trust_level は本人が変更できない');

-- 29-33: append-only audit history and validated coordinates/links.
select throws_like($$update public.audit_log set action='x' where table_name='records'
  and row_pk='-904001'$$, '%append_only%', '監査ログは更新できない');
select throws_like($$delete from public.audit_log where table_name='records'
  and row_pk='-904001'$$, '%append_only%', '監査ログは削除できない');
select ok((select count(*) >= 2 from public.audit_log where table_name='records' and row_pk='-904001'),
  '記録の変更が監査ログに残る');
select throws_like($$insert into public.records(id, record_code, reference_id, page, name_as_published,
  category, region_id, locality_verbatim, status, submitted_by, lat, lon) overriding system value
  values (-904009, 'D9999009', -904001, '1', 'x', 'original', -904001, 'x', 'pending',
    'f0040000-0000-0000-0000-000000000005', 10, 100)$$,
  '%records_lat_check%', '拡張外の座標は入らない');
select throws_like($$insert into public.documents(id, doc_code, kind, provider, external_url)
  overriding system value values (-904001, 'F9999001', 'external', 'x', 'http://example.com/pgtap-t04.pdf')$$,
  '%documents_external_url_check%', 'http の外部リンクは入らない');

-- Literature-repository fixtures, still within the same rollback-only transaction.
insert into public.journals(id, title) overriding system value values (-904001, 'pgTAP 蛾類通信');
insert into public.journal_issues(id, journal_id, volume, issue, year) overriding system value
  values (-904001, -904001, '1', '1', 1970);
insert into public.journal_issues(id, journal_id, volume, issue, year, scan_blocked, block_reason)
  overriding system value values (-904002, -904001, '310', '1', 2024, true, '学会が頒布中');
insert into public.documents(id, doc_code, kind, provider, status, malware_result, submitted_by,
  rights_basis, pd_reference_year, rights_evidence) overriding system value values
  (-904002, 'F9999002', 'hosted', 'upload', 'awaiting_review', 'clean',
    'f0040000-0000-0000-0000-000000000005', 'author_self', null, null),
  (-904003, 'F9999003', 'hosted', 'upload', 'awaiting_review', 'infected',
    'f0040000-0000-0000-0000-000000000005', 'author_self', null, null),
  (-904005, 'F9999005', 'hosted', 'upload', 'awaiting_review', 'clean',
    'f0040000-0000-0000-0000-000000000005', 'author_self', null, null),
  (-904006, 'F9999006', 'hosted', 'upload', 'awaiting_review', 'clean',
    'f0040000-0000-0000-0000-000000000005', 'public_domain', 1990, '没年の出典'),
  (-904007, 'F9999007', 'hosted', 'upload', 'awaiting_review', 'clean',
    'f0040000-0000-0000-0000-000000000005', 'public_domain', 1950, '没年の出典'),
  (-904008, 'F9999008', 'hosted', 'upload', 'awaiting_review', 'clean',
    'f0040000-0000-0000-0000-000000000005', 'author_self', null, null);
insert into public.document_issues(document_id, journal_issue_id) values (-904005, -904002);
insert into public.rights_policies(id, name, basis, access_level, evidence_note, status, requested_by)
  overriding system value values
  (-904001, 'pgTAP 許諾なし', 'prohibited', 'metadata_only', 'x', 'active',
    'f0040000-0000-0000-0000-000000000001'),
  (-904002, 'pgTAP 学会許諾', 'permission', 'open', '許諾書あり', 'pending',
    'f0040000-0000-0000-0000-000000000003');

-- 34-39: document visibility, write grants, and required rights evidence.
select throws_like($$select pg_temp.run_as(null, null, 'select * from public.documents')$$,
  '%permission denied%', '匿名は文書を読めない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1', $sql$
  insert into public.documents(doc_code, kind, provider, external_url)
  values ('F9999004', 'external', 'x', 'https://example.com/pgtap-t04.pdf')
$sql$)$$, '%permission denied%', '投稿者は文書を直接追加できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$update public.documents set status='published' where id=-904002$sql$)$$,
  '%permission denied%', '投稿者は文書を公開へ変更できない');
select is(pg_temp.run_as('f0040000-0000-0000-0000-000000000009', 'aal1',
  $sql$select to_jsonb(count(*)) from public.documents where id in
    (-904002, -904003, -904005, -904006, -904007, -904008)$sql$, true)->'value',
  '0'::jsonb, '投稿者本人以外の一般利用者は未公開スキャンを読めない');
select throws_like($$insert into public.documents(id, doc_code, kind, provider, submitted_by)
  overriding system value values (-904010, 'F9999010', 'hosted', 'upload',
    'f0040000-0000-0000-0000-000000000005')$$,
  '%documents_check%', '権利の根拠なしではスキャンを登録できない');
select throws_like($$insert into public.documents(id, doc_code, kind, provider, submitted_by, rights_basis)
  overriding system value values (-904011, 'F9999011', 'hosted', 'upload',
    'f0040000-0000-0000-0000-000000000005', 'public_domain')$$,
  '%documents_check%', '保護期間満了の申告には没年と出典が必要');

-- 40-51: scan rights, independent approval, malware and blocked issues.
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904006)$sql$)$$,
  '%rights_not_cleared%', '没年が1968年以降の満了申告は公開できない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904007)$sql$)$$,
  '没年が1967年以前の満了申告は公開できる');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1', $sql$
  do $verify$
  begin
    perform app.publish_document(-904008);
    if (select access_level from public.documents where id=-904008) is distinct from 'open' then
      raise exception 'expected author-self document access_level=open';
    end if;
  end
  $verify$
$sql$)$$, '著者本人の申告は審査者が公開できる');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904002, -904999)$sql$)$$,
  '%rights_not_cleared%', '存在しない一括許諾では公開できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904002, -904001)$sql$)$$,
  '%rights_not_cleared%', '禁止の権利方針では公開できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904002, -904002)$sql$)$$,
  '%rights_not_cleared%', '未承認の権利方針では公開できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000003', 'aal2',
  $sql$select app.approve_rights_policy(-904002)$sql$)$$,
  '%second_person_required%', '権利方針の申請者本人は承認できない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000001', 'aal2',
  $sql$select app.approve_rights_policy(-904002)$sql$)$$,
  '別の管理者が権利方針を承認できる');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904003, -904002)$sql$)$$,
  '%not_publishable%', 'ウイルス検出のスキャンは公開できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$select app.publish_document(-904005, -904002)$sql$)$$,
  '%issue_blocked%', '頒布中の号のスキャンは公開できない');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1',
  $sql$select app.publish_document(-904002, -904002)$sql$)$$,
  '%self_review_forbidden%', '自分のスキャンは自己承認できない');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1',
  $sql$
  do $verify$
  begin
    perform app.publish_document(-904002, -904002);
    if not exists (select 1 from public.documents
      where id=-904002 and status='published' and access_level='open') then
      raise exception 'expected approved-policy document status=published and access_level=open';
    end if;
  end
  $verify$
  $sql$)$$,
  '承認済みの権利方針で公開できる');

-- 52-55: batch review uses the reference and excludes the reviewer's own rows.
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, category,
    region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904005, 'D9999005', -904001, '1', 'x', 'original', -904001, '札幌',
    'pending', 'f0040000-0000-0000-0000-000000000004')
$sql$)->>'row_count')::bigint, 1::bigint, '審査者は文献単位で一括承認でき、自分の投稿は除外される');
select is((pg_temp.run_as('f0040000-0000-0000-0000-000000000005', 'aal1', $sql$
  insert into public.records(id, record_code, reference_id, page, name_as_published, category,
    region_id, locality_verbatim, status, submitted_by) overriding system value
  values (-904006, 'D9999006', -904001, '1', 'x', 'original', -904001, '札幌',
    'pending', 'f0040000-0000-0000-0000-000000000005')
$sql$)->>'row_count')::bigint, 1::bigint, '投稿者の記録を用意');
select lives_ok($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000004', 'aal1', $sql$
  do $verify$
  declare v_count integer;
  begin
    v_count := app.review_reference_batch(-904001, 'published');
    if v_count <> 1 then raise exception 'expected one batch-reviewed record, got %', v_count; end if;
    if (select status from public.records where id=-904005) is distinct from 'pending' then
      raise exception 'batch review changed the reviewer-own pending record';
    end if;
  end
  $verify$
$sql$)$$, '一括承認の結果');
select throws_like($$select pg_temp.run_as('f0040000-0000-0000-0000-000000000009', 'aal1',
  $sql$select app.review_reference_batch(-904001, 'published')$sql$)$$,
  '%forbidden%', '投稿者は一括承認を使えない');

-- 56: tables added later also have to opt into RLS.
select is((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and not c.relrowsecurity),
  0::bigint, '全テーブルでRLSが有効');

select * from finish(true);
rollback;
