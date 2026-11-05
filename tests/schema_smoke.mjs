// docs/02_schema.sql の権限検証。PGlite 上で Supabase の認証環境を模して実行する。
// 実行: node tests/schema_smoke.mjs <02_schema.sql のパス>
// 本番リポジトリでは supabase/tests に pgTAP として移植し、同じ観点を維持すること。
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const db = new PGlite({ extensions: { pg_trgm } });
const U = {
  owner1: "00000000-0000-0000-0000-000000000001",
  owner2: "00000000-0000-0000-0000-000000000002",
  admin: "00000000-0000-0000-0000-000000000003",
  reviewer: "00000000-0000-0000-0000-000000000004",
  alice: "00000000-0000-0000-0000-000000000005",
};

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt()->>'sub','')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`);
await db.exec(readFileSync(process.argv[2], "utf8"));
await db.exec(`
  grant all on all tables in schema public to service_role;
  grant usage on schema app to service_role;
  grant usage on all sequences in schema public to service_role;
`);

let pass = 0;
const fails = [];
async function as(user, aal, fn) {
  await db.exec("begin");
  const claims = user ? JSON.stringify({ sub: user, aal }) : "{}";
  await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await db.exec(`set local role ${user ? "authenticated" : "anon"}`);
  try {
    const r = await fn();
    await db.exec("commit");
    return r;
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}
async function ok(name, fn) {
  try { await fn(); pass++; console.log("ok   ", name); }
  catch (e) { fails.push(name); console.log("FAIL ", name, "-", e.message); }
}
async function denied(name, fn, code) {
  try { await fn(); fails.push(name); console.log("FAIL ", name, "- 許可されてしまった"); }
  catch (e) {
    if (code && !e.message.includes(code)) { fails.push(name); console.log("FAIL ", name, "-", e.message); return; }
    pass++; console.log("ok   ", name, `(${e.message})`);
  }
}

// 初期データ（管理者権限で投入）
await db.exec(`
  insert into auth.users(id) values ${Object.values(U).map((u) => `('${u}')`).join(",")};
  insert into public.profiles(id, display_name) values ${Object.entries(U).map(([k, u]) => `('${u}','${k}')`).join(",")};
  insert into public.role_assignments(user_id, role) values
    ('${U.owner1}','owner'),('${U.owner2}','owner'),('${U.admin}','admin'),('${U.reviewer}','reviewer');
  insert into public.regions(code, region_type, name_ja, name_en) values ('PR01','prefecture','北海道','Hokkaido');
  insert into public.taxa(taxon_code, rank, scientific_name) values ('M000001','species','Issikiomartyria nudata');
  insert into public.feature_flags(key, description) values ('submissions_open','投稿受付');
`);
await db.exec(`
  begin;
  insert into public.references_(ref_code, ref_type, title, status, submitted_by)
    values ('R000001','article','seed paper','published','${U.alice}');
  commit;
`);

const REC = (status = "pending", code = "D0000001") => `
  insert into public.records(record_code, reference_id, page, name_as_published, taxon_id, category, region_id,
    locality_verbatim, status, submitted_by)
  values ('${code}', 1, '12', 'Issikiomartyria nudata', 1, 'original', 1, '札幌市', '${status}', '${U.alice}')`;

await denied("匿名は taxa を読めない", () => as(null, null, () => db.query("select * from public.taxa")), "permission denied");
await denied("匿名は records を読めない", () => as(null, null, () => db.query("select * from public.records")), "permission denied");
await denied("匿名は監査ログを読めない", () => as(null, null, () => db.query("select * from public.audit_log")), "permission denied");

await ok("投稿者は pending を投稿できる", () => as(U.alice, "aal1", () => db.exec(REC())));
await denied("投稿者は published で投稿できない", () => as(U.alice, "aal1", () => db.exec(REC("published", "D0000002"))));
await denied("投稿者は自分の記録を公開へ更新できない",
  () => as(U.alice, "aal1", () => db.exec("update public.records set status='published' where id=1")));
await denied("他人名義で投稿できない", () => as(U.reviewer, "aal1", () => db.exec(REC("pending", "D0000003"))));
await denied("投稿者は審査関数を使えない",
  () => as(U.alice, "aal1", () => db.query("select app.review_submission('records',1,'published')")), "forbidden");
await denied("set_config で審査を偽装できない", () => as(U.alice, "aal1", async () => {
  await db.query("select set_config('app.in_review','on',true)");
  await db.exec("update public.records set status='published' where id=1");
}));
await ok("審査者は他人の投稿を公開できる",
  () => as(U.reviewer, "aal1", () => db.query("select app.review_submission('records',1,'published')")));
await ok("投稿者が公開済み記録を読める", () => as(U.alice, "aal1", async () => {
  const r = await db.query("select status from public.records where id=1");
  if (r.rows[0].status !== "published") throw new Error("not published");
}));
await denied("公開済み記録は投稿者が直接変更できない", () => as(U.alice, "aal1", async () => {
  const r = await db.query("update public.records set page='13' where id=1 returning id");
  if (r.rows.length === 0) throw new Error("0行更新で拒否");
}));

await ok("審査者自身の投稿を用意", () => as(U.reviewer, "aal1", () => db.exec(`
  insert into public.records(record_code, reference_id, page, name_as_published, category, region_id,
    locality_verbatim, status, submitted_by)
  values ('D0000004', 1, '1', 'x', 'original', 1, '札幌', 'pending', '${U.reviewer}')`)));
await denied("自分の投稿は自己承認できない",
  () => as(U.reviewer, "aal1", async () => {
    const id = (await db.query("select id from public.records where record_code='D0000004'")).rows[0].id;
    await db.query(`select app.review_submission('records',${id},'published')`);
  }), "self_review_forbidden");

await denied("MFAなしの管理者はフラグを変更できない", () => as(U.admin, "aal1", async () => {
  await db.exec("update public.feature_flags set enabled=true where key='submissions_open'");
}));
await ok("MFAありの管理者はフラグを変更できる", () => as(U.admin, "aal2", async () => {
  const r = await db.query("update public.feature_flags set enabled=true where key='submissions_open' returning key");
  if (r.rows.length !== 1) throw new Error("更新されない");
}));
await denied("投稿者はフラグを変更できない", () => as(U.alice, "aal2", async () => {
  const r = await db.query("update public.feature_flags set enabled=false returning key");
  if (r.rows.length === 0) throw new Error("0行更新で拒否");
}));

await denied("管理者は管理者を任命できない",
  () => as(U.admin, "aal2", () => db.query(`select app.request_role('${U.alice}','admin')`)), "forbidden");
await denied("MFAなしのオーナーは任命できない",
  () => as(U.owner1, "aal1", () => db.query(`select app.request_role('${U.alice}','admin')`)), "mfa_required");
await denied("自分への権限付与はできない",
  () => as(U.owner1, "aal2", () => db.query(`select app.request_role('${U.owner1}','admin')`)), "self_grant_forbidden");
await ok("オーナーは管理者任命を申請できる",
  () => as(U.owner1, "aal2", () => db.query(`select app.request_role('${U.alice}','admin')`)));
const pendingId = (await db.query("select id from public.role_assignments where status='pending'")).rows[0].id;
await denied("申請者本人は承認できない",
  () => as(U.owner1, "aal2", () => db.query(`select app.approve_role(${pendingId})`)), "second_person_required");
await denied("承認前は管理者権限を持たない", () => as(U.alice, "aal2", async () => {
  const r = await db.query("select app.has_role(array['admin']) as v");
  if (!r.rows[0].v) throw new Error("権限なし");
}));
await ok("別のオーナーが承認できる",
  () => as(U.owner2, "aal2", () => db.query(`select app.approve_role(${pendingId})`)));
await ok("承認後は管理者権限を持つ", () => as(U.alice, "aal2", async () => {
  const r = await db.query("select app.has_role(array['admin']) as v");
  if (!r.rows[0].v) throw new Error("権限なし");
}));
await denied("オーナーは2名未満にできない", () => as(U.owner2, "aal2", async () => {
  const id = (await db.query(`select id from public.role_assignments where user_id='${U.owner1}'`)).rows[0].id;
  await db.query(`select app.revoke_role(${id})`);
}), "at_least_two_owners_required");
await denied("投稿者は role_assignments へ直接書けない", () => as(U.reviewer, "aal2", () =>
  db.exec(`insert into public.role_assignments(user_id, role) values ('${U.reviewer}','owner')`)), "permission denied");
await denied("trust_level は本人が変更できない", () => as(U.reviewer, "aal2", () =>
  db.exec(`update public.profiles set trust_level=2 where id='${U.reviewer}'`)), "permission denied");

await denied("監査ログは更新できない", () => db.exec("update public.audit_log set action='x'"), "append_only");
await denied("監査ログは削除できない", () => db.exec("delete from public.audit_log"), "append_only");
await ok("記録の変更が監査ログに残る", async () => {
  const r = await db.query("select count(*)::int c from public.audit_log where table_name='records'");
  if (r.rows[0].c < 2) throw new Error("件数不足");
});
await denied("拡張外の座標は入らない", () => db.exec(`
  insert into public.records(record_code, reference_id, page, name_as_published, category, region_id,
    locality_verbatim, status, submitted_by, lat, lon)
  values ('D0000009',1,'1','x','original',1,'x','pending','${U.alice}',10,100); commit;`).finally(() => db.exec("rollback")));
await denied("http の外部リンクは入らない", () => db.exec(`
  insert into public.documents(doc_code, kind, provider, external_url)
  values ('F0000001','external','x','http://example.com/a.pdf')`));

// 文献リポジトリ
await db.exec(`
  insert into public.journals(title) values ('蛾類通信');
  insert into public.journal_issues(journal_id, volume, issue, year) values (1,'1','1',1970);
  insert into public.journal_issues(journal_id, volume, issue, year, scan_blocked, block_reason)
  values (1,'310','1',2024,true,'学会が頒布中');
  insert into public.documents(doc_code, kind, provider, status, malware_result, submitted_by, rights_basis,
    pd_reference_year, rights_evidence)
  values ('F0000002','hosted','upload','awaiting_review','clean','${U.alice}','author_self',null,null),
         ('F0000003','hosted','upload','awaiting_review','infected','${U.alice}','author_self',null,null),
         ('F0000005','hosted','upload','awaiting_review','clean','${U.alice}','author_self',null,null),
         ('F0000006','hosted','upload','awaiting_review','clean','${U.alice}','public_domain',1990,'没年の出典'),
         ('F0000007','hosted','upload','awaiting_review','clean','${U.alice}','public_domain',1950,'没年の出典'),
         ('F0000008','hosted','upload','awaiting_review','clean','${U.alice}','author_self',null,null);
  insert into public.document_issues(document_id, journal_issue_id)
  select d.id, i.id from public.documents d, public.journal_issues i
  where d.doc_code='F0000005' and i.scan_blocked;
  insert into public.rights_policies(name, basis, access_level, evidence_note, status, requested_by)
  values ('許諾なし','prohibited','metadata_only','x','active','${U.owner1}'),
         ('学会許諾','permission','open','許諾書あり','pending','${U.admin}');
`);
const docId = async (c) => (await db.query(`select id from public.documents where doc_code='${c}'`)).rows[0].id;
const d2 = await docId("F0000002"); const d3 = await docId("F0000003");
await denied("匿名は文書を読めない", () => as(null, null, () => db.query("select * from public.documents")), "permission denied");
await denied("投稿者は文書を直接追加できない", () => as(U.alice, "aal1", () => db.exec(`
  insert into public.documents(doc_code, kind, provider, external_url)
  values ('F0000004','external','x','https://example.com/a.pdf')`)), "permission denied");
await denied("投稿者は文書を公開へ変更できない", () => as(U.alice, "aal1", () =>
  db.exec(`update public.documents set status='published' where id=${d2}`)), "permission denied");
await ok("投稿者本人以外の一般利用者は未公開スキャンを読めない", async () => {
  await db.exec(`insert into auth.users(id) values ('00000000-0000-0000-0000-000000000009');
    insert into public.profiles(id, display_name) values ('00000000-0000-0000-0000-000000000009','bob')`);
  await as("00000000-0000-0000-0000-000000000009", "aal1", async () => {
    const r = await db.query("select * from public.documents");
    if (r.rows.length !== 0) throw new Error("見えてしまう");
  });
});
await denied("権利の根拠なしではスキャンを登録できない", () => db.exec(`
  insert into public.documents(doc_code, kind, provider, submitted_by)
  values ('F0000010','hosted','upload','${U.alice}')`), "documents_check");
await denied("保護期間満了の申告には没年と出典が必要", () => db.exec(`
  insert into public.documents(doc_code, kind, provider, submitted_by, rights_basis)
  values ('F0000011','hosted','upload','${U.alice}','public_domain')`), "documents_check");
await denied("没年が1968年以降の満了申告は公開できない", () => as(U.reviewer, "aal1", async () => {
  await db.query(`select app.publish_document(${await docId("F0000006")})`);
}), "rights_not_cleared");
await ok("没年が1967年以前の満了申告は公開できる", () => as(U.reviewer, "aal1", async () => {
  await db.query(`select app.publish_document(${await docId("F0000007")})`);
}));
await ok("著者本人の申告は審査者が公開できる", () => as(U.reviewer, "aal1", async () => {
  await db.query(`select app.publish_document(${await docId("F0000008")})`);
  const r = await db.query("select access_level from public.documents where doc_code='F0000008'");
  if (r.rows[0].access_level !== "open") throw new Error("公開範囲が違う");
}));
await denied("存在しない一括許諾では公開できない",
  () => as(U.reviewer, "aal1", () => db.query(`select app.publish_document(${d2}, 999)`)), "rights_not_cleared");
await denied("禁止の権利方針では公開できない",
  () => as(U.reviewer, "aal1", () => db.query(`select app.publish_document(${d2}, 1)`)), "rights_not_cleared");
await denied("未承認の権利方針では公開できない",
  () => as(U.reviewer, "aal1", () => db.query(`select app.publish_document(${d2}, 2)`)), "rights_not_cleared");
await denied("権利方針の申請者本人は承認できない",
  () => as(U.admin, "aal2", () => db.query("select app.approve_rights_policy(2)")), "second_person_required");
await ok("別の管理者が権利方針を承認できる",
  () => as(U.owner1, "aal2", () => db.query("select app.approve_rights_policy(2)")));
await denied("ウイルス検出のスキャンは公開できない",
  () => as(U.reviewer, "aal1", () => db.query(`select app.publish_document(${d3}, 2)`)), "not_publishable");
await denied("頒布中の号のスキャンは公開できない", () => as(U.reviewer, "aal1", async () => {
  const id = (await db.query("select id from public.documents where doc_code='F0000005'")).rows[0].id;
  await db.query(`select app.publish_document(${id}, 2)`);
}), "issue_blocked");
await denied("自分のスキャンは自己承認できない",
  () => as(U.alice, "aal1", () => db.query(`select app.publish_document(${d2}, 2)`)));
await ok("承認済みの権利方針で公開できる", () => as(U.reviewer, "aal1", async () => {
  await db.query(`select app.publish_document(${d2}, 2)`);
  const r = await db.query(`select status, access_level from public.documents where id=${d2}`);
  if (r.rows[0].status !== "published" || r.rows[0].access_level !== "open") throw new Error("反映されない");
}));
await ok("審査者は文献単位で一括承認でき、自分の投稿は除外される", () => as(U.reviewer, "aal1", async () => {
  await db.exec(`insert into public.records(record_code, reference_id, page, name_as_published, category, region_id,
    locality_verbatim, status, submitted_by)
    values ('D0000005', 1, '1', 'x', 'original', 1, '札幌', 'pending', '${U.reviewer}')`);
}));
await ok("投稿者の記録を用意", () => as(U.alice, "aal1", () => db.exec(`
  insert into public.records(record_code, reference_id, page, name_as_published, category, region_id,
    locality_verbatim, status, submitted_by)
  values ('D0000006', 1, '1', 'x', 'original', 1, '札幌', 'pending', '${U.alice}')`)));
await ok("一括承認の結果", () => as(U.reviewer, "aal1", async () => {
  const r = await db.query("select app.review_reference_batch(1,'published') as n");
  if (r.rows[0].n !== 1) throw new Error("件数 " + r.rows[0].n);
  const own = await db.query("select status from public.records where record_code='D0000005'");
  if (own.rows[0].status !== "pending") throw new Error("自分の投稿が承認された");
}));
await denied("投稿者は一括承認を使えない",
  () => as("00000000-0000-0000-0000-000000000009", "aal1", () => db.query("select app.review_reference_batch(1,'published')")), "forbidden");

const noRls = await db.query(`
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
await ok("全テーブルでRLSが有効", async () => {
  if (noRls.rows.length) throw new Error(noRls.rows.map((r) => r.relname).join(","));
});

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
