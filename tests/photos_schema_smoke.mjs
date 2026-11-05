// docs/12_photos_schema.sql の権限検証。PGlite 上で Supabase の認証環境を模して実行する。
// 実行: node tests/photos_schema_smoke.mjs docs/02_schema.sql docs/12_photos_schema.sql
// PH01 で supabase/tests に pgTAP として移植し、同じ観点を維持すること。
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const db = new PGlite({ extensions: { pg_trgm } });
const U = {
  reviewer: "00000000-0000-0000-0000-000000000004",
  alice: "00000000-0000-0000-0000-000000000005",
  bob: "00000000-0000-0000-0000-000000000006",
  carol: "00000000-0000-0000-0000-000000000007",
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
for (const file of process.argv.slice(2)) await db.exec(readFileSync(file, "utf8"));

let pass = 0;
const fails = [];
async function as(user, fn) {
  await db.exec("begin");
  await db.query("select set_config('request.jwt.claims', $1, true)", [user ? JSON.stringify({ sub: user, aal: "aal1" }) : "{}"]);
  await db.exec(`set local role ${user ? "authenticated" : "anon"}`);
  try { const r = await fn(); await db.exec("commit"); return r; }
  catch (e) { await db.exec("rollback"); throw e; }
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
const q = (sql, params) => db.query(sql, params);
const one = async (sql) => (await q(sql)).rows[0];
function expectEq(actual, expected) {
  if (actual !== expected) throw new Error(`期待 ${expected} / 実際 ${actual}`);
}
const flag = (key, enabled) => db.exec(`update public.feature_flags set enabled=${enabled} where key='${key}'`);
const insertDraft = (user) => as(user, () => q(
  `insert into public.photo_observations(submitted_by, declared_own_work, region_id, life_stage)
   values ($1, true, 1, 'adult') returning id, observation_code`, [user]));

await db.exec(`
  insert into auth.users(id) values ${Object.values(U).map((u) => `('${u}')`).join(",")};
  insert into public.profiles(id, display_name) values ${Object.entries(U).map(([k, u]) => `('${u}','${k}')`).join(",")};
  insert into public.role_assignments(user_id, role) values ('${U.reviewer}','reviewer');
  insert into public.regions(code, region_type, name_ja, name_en) values ('PR01','prefecture','北海道','Hokkaido');
  insert into public.taxa(taxon_code, rank, scientific_name, sensitivity) values
    ('M000001','species','Species one',0),('M000002','species','Species two',0),('M000003','species','Species three',2);
`);

// 受付
await denied("機能フラグが偽なら投稿できない", () => insertDraft(U.alice), "row-level security");
await flag("photo_uploads_open", true);
let obs;
await ok("投稿者は下書きを作れる", async () => {
  obs = (await insertDraft(U.alice)).rows[0];
  if (!/^PH\d{7}$/.test(obs.observation_code)) throw new Error(obs.observation_code);
});
await ok("本人撮影の申告時刻が記録される", async () => {
  const r = await one(`select declared_at from public.photo_observations where id=${obs.id}`);
  if (!r.declared_at) throw new Error("declared_at が空");
});
await denied("他人名義では投稿できない", () => as(U.alice, () => q(
  "insert into public.photo_observations(submitted_by) values ($1)", [U.bob])));
await denied("投稿者は公開状態で作れない", () => as(U.alice, () => q(
  "insert into public.photo_observations(submitted_by, status, declared_own_work) values ($1,'published',true)", [U.alice])));
await denied("投稿者は取込元を偽れない", () => as(U.alice, () => q(
  "insert into public.photo_observations(submitted_by, source) values ($1,'inat_import')", [U.alice])), "permission denied");
await denied("投稿者は種の列を直接変更できない", () => as(U.alice, () => q(
  `update public.photo_observations set current_taxon_id=1 where id=${obs.id}`)), "permission denied");
await denied("投稿者はiNaturalistの状態を変更できない", () => as(U.alice, () => q(
  `update public.photo_observations set inat_state='confirmed' where id=${obs.id}`)), "permission denied");
await denied("投稿者は写真の行を作れない", () => as(U.alice, () => q(
  `insert into public.photos(observation_id, storage, license_code, creator_name) values (${obs.id},'r2','cc-by','alice')`)), "permission denied");
await denied("投稿者は写真の信頼度を上げられない", () => as(U.alice, () => q(
  `update public.profiles set photo_trust_level=1 where id='${U.alice}'`)), "permission denied");
await ok("他人の下書きは見えない", async () => {
  const r = await as(U.bob, () => q(`select id from public.photo_observations where id=${obs.id}`));
  expectEq(r.rows.length, 0);
});
await denied("匿名は観察を読めない", () => as(null, () => q("select id from public.photo_observations")), "permission denied");
await denied("匿名は写真を読めない", () => as(null, () => q("select id from public.photos")), "permission denied");

// 提出
await denied("種のない観察は提出できない", () => as(U.alice, () => q(
  `update public.photo_observations set status='pending' where id=${obs.id}`)), "check");
await ok("本人が最初の種を登録できる", async () => {
  await as(U.alice, () => q(`select app.move_photo_observation(${obs.id}, 1)`));
  expectEq((await one(`select kind from public.photo_identifications where observation_id=${obs.id}`)).kind, "initial");
});
await ok("申告を取り消すと時刻も消える", async () => {
  await as(U.alice, () => q(`update public.photo_observations set declared_own_work=false where id=${obs.id}`));
  expectEq((await one(`select declared_at from public.photo_observations where id=${obs.id}`)).declared_at, null);
});
await denied("本人撮影の申告なしでは提出できない", () => as(U.alice, () => q(
  `update public.photo_observations set status='pending' where id=${obs.id}`)), "check");
await ok("申告つきで提出できる", () => as(U.alice, () => q(
  `update public.photo_observations set declared_own_work=true, status='pending' where id=${obs.id}`)));

// 審査
await denied("一般の投稿者は審査できない", () => as(U.bob, () => q(
  `select app.review_photo_observation(${obs.id}, 'published')`)), "forbidden");
await denied("検査済みの写真がなければ公開できない", () => as(U.reviewer, () => q(
  `select app.review_photo_observation(${obs.id}, 'published')`)), "no_ready_photo");
await db.exec(`insert into public.photos(observation_id, storage, state, object_key, license_code, creator_name)
  values (${obs.id},'r2','ready','photos/a.jpg','cc-by','alice')`);
await denied("却下には理由が要る", () => as(U.reviewer, () => q(
  `select app.review_photo_observation(${obs.id}, 'rejected')`)), "reason_required");
await ok("審査者が公開できる", async () => {
  await as(U.reviewer, () => q(`select app.review_photo_observation(${obs.id}, 'published')`));
  expectEq((await one(`select status from public.photo_observations where id=${obs.id}`)).status, "published");
});
const own = (await insertDraft(U.reviewer)).rows[0];
await as(U.reviewer, () => q(`select app.move_photo_observation(${own.id}, 1)`));
await as(U.reviewer, () => q(`update public.photo_observations set status='pending' where id=${own.id}`));
await db.exec(`insert into public.photos(observation_id, storage, state, object_key, license_code, creator_name)
  values (${own.id},'r2','ready','photos/b.jpg','cc0','reviewer')`);
await denied("審査者は自分の写真を公開できない", () => as(U.reviewer, () => q(
  `select app.review_photo_observation(${own.id}, 'published')`)), "self_review");
await ok("他の利用者は公開済みの観察と写真を読める", async () => {
  const r = await as(U.bob, () => q(
    `select p.id from public.photos p join public.photo_observations o on o.id=p.observation_id where o.id=${obs.id}`));
  expectEq(r.rows.length, 1);
});
await ok("他の利用者は未公開の写真を読めない", async () => {
  const r = await as(U.bob, () => q(`select id from public.photos where observation_id=${own.id}`));
  expectEq(r.rows.length, 0);
});
await denied("公開後に本人が内容を直接編集できない", async () => {
  const r = await as(U.alice, () => q(`update public.photo_observations set note='x' where id=${obs.id} returning id`));
  if (!r.rows.length) throw new Error("更新0件");
}, "更新0件");

// 移動
await denied("他人は移動できない", () => as(U.bob, () => q(
  `select app.move_photo_observation(${obs.id}, 2)`)), "forbidden");
await denied("同じ種へは移動できない", () => as(U.alice, () => q(
  `select app.move_photo_observation(${obs.id}, 1)`)), "same_taxon");
await ok("信頼度0の本人移動は再審査へ戻る", async () => {
  await as(U.alice, () => q(`select app.move_photo_observation(${obs.id}, 2, '翅の斑紋を再確認')`));
  const r = await one(`select status, current_taxon_id, reviewed_by from public.photo_observations where id=${obs.id}`);
  expectEq(r.status, "pending"); expectEq(Number(r.current_taxon_id), 2); expectEq(r.reviewed_by, null);
  expectEq((await one(`select count(*)::int n from public.photo_identifications where observation_id=${obs.id}`)).n, 2);
});
await as(U.reviewer, () => q(`select app.review_photo_observation(${obs.id}, 'published')`));
await db.exec(`update public.profiles set photo_trust_level=1 where id='${U.alice}'`);
await ok("信頼度1の本人移動は公開のまま", async () => {
  await as(U.alice, () => q(`select app.move_photo_observation(${obs.id}, 1)`));
  expectEq((await one(`select status from public.photo_observations where id=${obs.id}`)).status, "published");
});
await denied("審査者の移動には理由が要る", () => as(U.reviewer, () => q(
  `select app.move_photo_observation(${obs.id}, 2)`)), "reason_required");
await ok("審査者は理由つきで移動できる", async () => {
  await as(U.reviewer, () => q(`select app.move_photo_observation(${obs.id}, 2, '交尾器で確認')`));
  const r = await one(`select kind, identified_by from public.photo_identifications where observation_id=${obs.id} order by id desc limit 1`);
  expectEq(r.kind, "reviewer_move"); expectEq(r.identified_by, U.reviewer);
});
await denied("履歴は書き換えられない", () => as(U.reviewer, () => q(
  "update public.photo_identifications set reason='x'")), "permission denied");
await denied("履歴は消せない", () => as(U.reviewer, () => q(
  "delete from public.photo_identifications")), "permission denied");

// 修正提案
const suggest = (code, n, by) => db.exec(`insert into public.suggestions
  (suggestion_code, target_type, target_code, kind, body, submitter_id)
  values ('S000000${n}','photo','${code}','misidentification','別の種に見えます','${by}')`);
await suggest(obs.observation_code, 1, U.bob);
await suggest("PH9999999", 2, U.bob);
await suggest(obs.observation_code, 3, U.reviewer);
await denied("投稿者は提案を適用できない", () => as(U.alice, () => q(
  `select app.move_photo_observation(${obs.id}, 1, '提案を適用', 1)`)), "forbidden");
await denied("別の写真への提案は適用できない", () => as(U.reviewer, () => q(
  `select app.move_photo_observation(${obs.id}, 1, '提案を適用', 2)`)), "suggestion_not_open");
await denied("自分の提案は適用できない", () => as(U.reviewer, () => q(
  `select app.move_photo_observation(${obs.id}, 1, '提案を適用', 3)`)), "suggestion_not_open");
await ok("審査者が提案を適用すると決定まで記録される", async () => {
  await as(U.reviewer, () => q(`select app.move_photo_observation(${obs.id}, 1, '提案を適用', 1)`));
  expectEq((await one("select status from public.suggestions where id=1")).status, "accepted");
  expectEq((await one(`select kind from public.photo_identifications where observation_id=${obs.id} order by id desc limit 1`)).kind, "suggestion");
});

// iNaturalist
await denied("同時投稿は機能フラグが偽なら使えない", () => as(U.alice, () => q(
  `select app.request_inat_post(${obs.id})`)), "feature_disabled");
await flag("inat_cross_post", true);
await denied("他人の観察は同時投稿できない", () => as(U.bob, () => q(
  `select app.request_inat_post(${obs.id})`)), "forbidden");
await ok("本人は同時投稿を要求でき、発行済みのUUIDを受け取る", async () => {
  const r = await as(U.alice, () => q(`select app.request_inat_post(${obs.id}) as uuid`));
  const row = await one(`select inat_uuid, inat_state from public.photo_observations where id=${obs.id}`);
  expectEq(r.rows[0].uuid, row.inat_uuid); expectEq(row.inat_state, "requested");
});
const sensitive = (await insertDraft(U.alice)).rows[0];
await as(U.alice, () => q(`select app.move_photo_observation(${sensitive.id}, 3)`));
await as(U.alice, () => q(`update public.photo_observations set status='pending' where id=${sensitive.id}`));
await denied("最も厳しい機微種は同時投稿できない", () => as(U.alice, () => q(
  `select app.request_inat_post(${sensitive.id})`)), "sensitive_taxon");
await db.exec(`insert into public.photo_observations(source, status, current_taxon_id, inat_observation_id, submitted_by)
  values ('inat_import','published',1,12345,'${U.bob}')`);
const imported = await one("select id from public.photo_observations where source='inat_import'");
await denied("取込の登録者は種を移動できない", () => as(U.bob, () => q(
  `select app.move_photo_observation(${imported.id}, 2)`)), "forbidden");
await denied("取込の観察は同時投稿できない", () => as(U.bob, () => q(
  `select app.request_inat_post(${imported.id})`)), "forbidden");

// 取り下げと公開停止
await denied("他人は取り下げられない", () => as(U.bob, () => q(
  `select app.withdraw_photo_observation(${obs.id})`)), "forbidden");
await ok("本人は取り下げられる", async () => {
  await as(U.alice, () => q(`select app.withdraw_photo_observation(${obs.id})`));
  expectEq((await one(`select status from public.photo_observations where id=${obs.id}`)).status, "withdrawn");
});
await denied("取り下げた観察は移動できない", () => as(U.reviewer, () => q(
  `select app.move_photo_observation(${obs.id}, 2, '理由')`)), "not_movable");
await denied("公開停止は対象が1件必要", () => q(
  "insert into public.takedown_requests(requester_name, requester_contact, body) values ('a','b','対象がない申し出')"), "takedown_requests_one_target");
await ok("写真の公開停止を受け付けられる", () => q(
  `insert into public.takedown_requests(photo_observation_id, requester_name, requester_contact, body)
   values (${obs.id},'a','b','写真の公開停止を希望')`));

await ok("写真の表でRLSが有効", async () => {
  const r = await q(`select relname from pg_class where relname in ('photo_observations','photos','photo_identifications')
    and relrowsecurity and relforcerowsecurity`);
  expectEq(r.rows.length, 3);
});
await ok("新しい機能フラグは初期値が偽", async () => {
  await flag("photo_uploads_open", false); await flag("inat_cross_post", false);
  expectEq((await one(`select count(*)::int n from public.feature_flags where enabled and key in
    ('photo_import_open','photo_uploads_open','photo_layer','inat_cross_post','auto_publish_trusted_photos')`)).n, 0);
});

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
