-- 写真機能のテーブルと権限。docs/12_photos.md の定義。
-- PH01 で supabase/migrations の新しい migration へ移す。docs/02_schema.sql と既存 migration の適用後に流す。
-- 検証: node tests/photos_schema_smoke.mjs docs/02_schema.sql docs/12_photos_schema.sql

-- ---------------------------------------------------------------- 既存の表の変更
-- 写真の信頼度は記録の trust_level と分ける。写真の実績で文献の記録が自動公開されないようにする。
alter table public.profiles
  add column photo_trust_level smallint not null default 0 check (photo_trust_level between 0 and 1);

alter table public.suggestions drop constraint suggestions_target_type_check;
alter table public.suggestions add constraint suggestions_target_type_check check (target_type in
  ('taxon','record','reference','region','type_record','page','photo','other'));

-- ---------------------------------------------------------------- 観察
create sequence public.photo_observation_code_seq;

create table public.photo_observations (
  id bigint generated always as identity primary key,
  observation_code text not null unique                 -- 永久ID。再利用しない
    default ('PH' || lpad(nextval('public.photo_observation_code_seq')::text, 7, '0'))
    check (observation_code ~ '^PH\d{7,}$'),
  source text not null default 'portal' check (source in ('portal','inat_import')),
  status text not null default 'draft' check (status in
    ('draft','pending','published','rejected','withdrawn','takedown')),
  current_taxon_id bigint references public.taxa(id),   -- app.move_photo_observation だけが変更する
  region_id bigint references public.regions(id),
  observed_on date,
  life_stage text not null default 'unknown' check (life_stage in ('adult','larva','pupa','egg','mine','unknown')),
  locality_text text check (char_length(locality_text) <= 200),
  locality_public boolean not null default false,
  note text check (char_length(note) <= 1000),
  declared_own_work boolean not null default false,     -- 本人撮影の申告
  declared_at timestamptz,
  post_review_sampled boolean not null default false,
  -- iNaturalist。座標はこの表に持たない。同時投稿の座標はブラウザから iNaturalist へ直接送る
  inat_uuid uuid not null unique default gen_random_uuid(),
  inat_state text not null default 'none' check (inat_state in ('none','requested','confirmed','failed')),
  inat_observation_id bigint unique,
  inat_community_taxon_id bigint,
  inat_taxon_mismatch boolean not null default false,
  inat_checked_at timestamptz,
  submitted_by uuid references public.profiles(id),
  review_note text check (char_length(review_note) <= 1000),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (status = 'draft' or current_taxon_id is not null),
  check (status = 'draft' or source = 'inat_import' or declared_own_work),
  check (source = 'portal' or inat_observation_id is not null)
);
create index on public.photo_observations (current_taxon_id) where status = 'published';
create index on public.photo_observations (status, created_at);
create index on public.photo_observations (submitted_by);
create index on public.photo_observations (inat_state) where inat_state <> 'none';

-- ---------------------------------------------------------------- 写真
create table public.photos (
  id bigint generated always as identity primary key,
  observation_id bigint not null references public.photo_observations(id),
  position smallint not null default 1 check (position between 1 and 4),
  storage text not null check (storage in ('r2','inat')),
  state text not null default 'uploading' check (state in ('uploading','quarantined','ready','rejected','removed')),
  object_key text,                                      -- r2: 公開バケットの鍵
  image_url text check (image_url ~ '^https://'),       -- inat: 許可ホストの画像URL
  inat_photo_id bigint,
  license_code text not null check (license_code in ('cc0','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa')),
  creator_name text not null check (char_length(creator_name) between 1 and 120),
  width integer,
  height integer,
  bytes bigint,
  original_sha256 text,
  stored_sha256 text,
  malware_result text check (malware_result in ('clean','infected')),
  created_at timestamptz not null default now(),
  unique (observation_id, position),
  check ((storage = 'r2' and image_url is null) or (storage = 'inat' and image_url is not null))
);
create unique index on public.photos (stored_sha256) where state = 'ready' and stored_sha256 is not null;

-- ---------------------------------------------------------------- 同定の履歴（追記のみ）
create table public.photo_identifications (
  id bigint generated always as identity primary key,
  observation_id bigint not null references public.photo_observations(id),
  taxon_id bigint not null references public.taxa(id),
  previous_taxon_id bigint references public.taxa(id),
  kind text not null check (kind in
    ('initial','owner_move','reviewer_move','suggestion','taxon_change','inat_import')),
  reason text check (char_length(reason) <= 1000),
  suggestion_id bigint references public.suggestions(id),
  identified_by uuid references public.profiles(id) on delete set null,   -- null は自動処理
  created_at timestamptz not null default now()
);
create index on public.photo_identifications (observation_id, created_at);

-- ---------------------------------------------------------------- 公開停止
alter table public.takedown_requests alter column document_id drop not null;
alter table public.takedown_requests
  add column photo_observation_id bigint references public.photo_observations(id),
  add constraint takedown_requests_one_target check (num_nonnulls(document_id, photo_observation_id) = 1);

-- ---------------------------------------------------------------- 機能フラグ
insert into public.feature_flags(key, enabled, description) values
  ('photo_import_open', false, 'iNaturalistの観察URLから写真を取り込む'),
  ('photo_uploads_open', false, '本サイトへの写真の投稿を受け付ける'),
  ('photo_layer', false, '種ページの投稿写真と地図の写真層を公開する'),
  ('inat_cross_post', false, 'iNaturalistへの同時投稿を有効にする'),
  ('auto_publish_trusted_photos', false, '信頼済み投稿者の通常の写真を自動公開する')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 防御
create function app.stamp_photo_declaration() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.declared_own_work and (tg_op = 'INSERT' or not old.declared_own_work) then
    new.declared_at := now();
  elsif not new.declared_own_work then
    new.declared_at := null;
  end if;
  return new;
end $$;

create trigger stamp_photo_declaration before insert or update of declared_own_work on public.photo_observations
  for each row execute function app.stamp_photo_declaration();
create trigger guard_photo_observations before insert or update on public.photo_observations
  for each row execute function app.guard_submission();
create trigger audit_photo_observations after insert or update or delete on public.photo_observations
  for each row execute function app.audit_row();
create trigger audit_photos after insert or update or delete on public.photos
  for each row execute function app.audit_row();

-- ---------------------------------------------------------------- 種の登録と移動
-- 種を変える経路はこの関数だけ。app.apply_taxon_change は kind='taxon_change' で履歴を書く。
create function app.move_photo_observation(
  p_id bigint, p_taxon_id bigint, p_reason text default null, p_suggestion_id bigint default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v public.photo_observations%rowtype;
  v_owner boolean;
  v_staff boolean;
  v_kind text;
  v_status text;
begin
  select * into v from public.photo_observations where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if v.status in ('rejected','withdrawn','takedown') then raise exception 'not_movable'; end if;
  if not exists (select 1 from public.taxa where id = p_taxon_id) then raise exception 'bad_taxon'; end if;
  if v.current_taxon_id = p_taxon_id then raise exception 'same_taxon'; end if;

  v_owner := v.source = 'portal' and v.submitted_by = auth.uid() and app.is_active_user();
  v_staff := app.has_role(array['reviewer','admin','owner']);
  v_status := v.status;

  if p_suggestion_id is not null then
    if not v_staff then raise exception 'forbidden' using errcode = '42501'; end if;
    update public.suggestions
       set status = 'accepted', decision_note = p_reason, decided_by = auth.uid(), decided_at = now()
     where id = p_suggestion_id and target_type = 'photo' and target_code = v.observation_code
       and status in ('new','triaged','needs_info') and submitter_id is distinct from auth.uid();
    if not found then raise exception 'suggestion_not_open'; end if;
    v_kind := 'suggestion';
  elsif v_owner then
    if v.current_taxon_id is null then
      v_kind := 'initial';
    else
      v_kind := 'owner_move';
      if v.status = 'published' and
         (select photo_trust_level from public.profiles where id = auth.uid()) = 0 then
        v_status := 'pending';
      end if;
    end if;
  elsif v_staff then
    if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
    v_kind := 'reviewer_move';
  else
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.photo_observations
     set current_taxon_id = p_taxon_id, status = v_status, inat_taxon_mismatch = false,
         reviewed_by = case when v_status = v.status then reviewed_by end,
         reviewed_at = case when v_status = v.status then reviewed_at end
   where id = p_id;
  insert into public.photo_identifications
    (observation_id, taxon_id, previous_taxon_id, kind, reason, suggestion_id, identified_by)
  values (p_id, p_taxon_id, v.current_taxon_id, v_kind, p_reason, p_suggestion_id, auth.uid());
end $$;

create function app.review_photo_observation(p_id bigint, p_decision text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.photo_observations%rowtype;
begin
  if p_decision not in ('published','rejected') then raise exception 'bad_decision'; end if;
  if not app.has_role(array['reviewer','admin','owner']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.photo_observations where id = p_id for update;
  if not found or v.status <> 'pending' then raise exception 'not_pending'; end if;
  if v.submitted_by = auth.uid() then raise exception 'self_review' using errcode = '42501'; end if;
  if p_decision = 'rejected' and coalesce(btrim(p_note), '') = '' then raise exception 'reason_required'; end if;
  if p_decision = 'published' and not exists (
    select 1 from public.photos where observation_id = p_id and state = 'ready'
  ) then raise exception 'no_ready_photo'; end if;
  update public.photo_observations
     set status = p_decision, review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id;
end $$;

create function app.withdraw_photo_observation(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.photo_observations set status = 'withdrawn'
   where id = p_id and submitted_by = auth.uid() and status in ('draft','pending','published');
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

-- 同時投稿の要求。戻り値の UUID を iNaturalist へ渡し、sync-inat-photos.yml が実在を確かめて confirmed にする。
-- 利用者が申告した観察IDを信用しない。
create function app.request_inat_post(p_id bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.photo_observations%rowtype;
begin
  if not exists (select 1 from public.feature_flags where key = 'inat_cross_post' and enabled) then
    raise exception 'feature_disabled';
  end if;
  select * into v from public.photo_observations where id = p_id for update;
  if not found or v.source <> 'portal' or v.submitted_by is distinct from auth.uid() or not app.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v.status not in ('pending','published') then raise exception 'not_submitted'; end if;
  if v.inat_state = 'confirmed' then raise exception 'already_posted'; end if;
  if (select sensitivity from public.taxa where id = v.current_taxon_id) >= 2 then
    raise exception 'sensitive_taxon';
  end if;
  update public.photo_observations set inat_state = 'requested' where id = p_id;
  return v.inat_uuid;
end $$;

-- ---------------------------------------------------------------- RLS と権限
alter table public.photo_observations enable row level security;
alter table public.photo_observations force row level security;
alter table public.photos enable row level security;
alter table public.photos force row level security;
alter table public.photo_identifications enable row level security;
alter table public.photo_identifications force row level security;

revoke all on public.photo_observations, public.photos, public.photo_identifications from public, anon, authenticated;
revoke all on sequence public.photo_observation_code_seq from public, anon;
grant usage on sequence public.photo_observation_code_seq to authenticated;

revoke execute on function app.stamp_photo_declaration(), app.move_photo_observation(bigint,bigint,text,bigint),
  app.review_photo_observation(bigint,text,text), app.withdraw_photo_observation(bigint),
  app.request_inat_post(bigint) from public, anon;
grant execute on function app.move_photo_observation(bigint,bigint,text,bigint),
  app.review_photo_observation(bigint,text,text), app.withdraw_photo_observation(bigint),
  app.request_inat_post(bigint) to authenticated;

grant select on public.photo_observations, public.photos, public.photo_identifications to authenticated;
-- 列単位で許可する。source, status 以外の審査列, current_taxon_id, inat_* は利用者が書けない。
grant insert (submitted_by, status, region_id, observed_on, life_stage, locality_text, locality_public, note,
  declared_own_work) on public.photo_observations to authenticated;
grant update (status, region_id, observed_on, life_stage, locality_text, locality_public, note, declared_own_work)
  on public.photo_observations to authenticated;

create policy photo_observations_read on public.photo_observations for select to authenticated
  using (status = 'published' or submitted_by = auth.uid()
         or app.has_role(array['reviewer','editor','admin','owner']));
create policy photo_observations_insert on public.photo_observations for insert to authenticated
  with check (submitted_by = auth.uid() and source = 'portal' and status in ('draft','pending')
              and app.is_active_user()
              and exists (select 1 from public.feature_flags f where f.key = 'photo_uploads_open' and f.enabled));
create policy photo_observations_update on public.photo_observations for update to authenticated
  using (submitted_by = auth.uid() and status in ('draft','pending'))
  with check (submitted_by = auth.uid() and status in ('draft','pending'));

-- 親の観察が読める場合だけ読める。photo_observations の RLS がそのまま効く。
create policy photos_read on public.photos for select to authenticated
  using (exists (select 1 from public.photo_observations o where o.id = observation_id));
create policy photo_identifications_read on public.photo_identifications for select to authenticated
  using (exists (select 1 from public.photo_observations o where o.id = observation_id));
