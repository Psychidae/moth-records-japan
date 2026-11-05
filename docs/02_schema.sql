-- 日本産蛾類記録データベース 初期スキーマ
-- Supabase の migration として supabase/migrations/0001_init.sql へそのまま移す。
-- 前提: auth.users, auth.uid(), auth.jwt() と anon / authenticated / service_role ロールは Supabase が提供する。
-- 方針: 全テーブル RLS 有効・既定拒否。状態遷移は app スキーマの SECURITY DEFINER 関数だけが行う。

create extension if not exists pg_trgm;

create schema if not exists app;

-- ---------------------------------------------------------------- 利用者と権限
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  orcid text check (orcid ~ '^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$'),
  affiliation text check (char_length(affiliation) <= 200),
  public_credit boolean not null default true,
  status text not null default 'active' check (status in ('active','suspended')),
  trust_level smallint not null default 0 check (trust_level between 0 and 2),
  created_at timestamptz not null default now()
);

create table public.role_assignments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('reviewer','editor','admin','owner')),
  scope_family text,          -- reviewer の担当科。null は全分類群
  scope_region_id bigint,     -- reviewer の担当地域。null は全国
  status text not null default 'active' check (status in ('pending','active','revoked')),
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (requested_by is null or approved_by is null or requested_by <> approved_by)
);
create index on public.role_assignments (user_id) where status = 'active';

-- ---------------------------------------------------------------- 地域
create table public.regions (
  id bigint generated always as identity primary key,
  code text not null unique,             -- PR01..PR47, IS0001.., OT01..
  region_type text not null check (region_type in ('prefecture','island','other')),
  name_ja text not null,
  name_en text not null,
  parent_id bigint references public.regions(id),
  area_group text,
  jis_code char(2),
  gadm_gid text,
  inat_place_id bigint,
  lat numeric(8,5),
  lon numeric(8,5),
  sort_order integer not null default 0
);
alter table public.role_assignments
  add foreign key (scope_region_id) references public.regions(id);

-- ---------------------------------------------------------------- 分類基盤
create table public.backbone_versions (
  id bigint generated always as identity primary key,
  source text not null,
  version_label text not null,
  source_url text not null,
  sha256 char(64) not null,
  license text not null,
  imported_at timestamptz not null default now(),
  unique (source, version_label)
);

create table public.listmj_rows (
  backbone_version_id bigint not null references public.backbone_versions(id),
  row_number integer not null,
  raw jsonb not null,
  primary key (backbone_version_id, row_number)
);

create table public.taxa (
  id bigint generated always as identity primary key,
  taxon_code text not null unique check (taxon_code ~ '^M\d{6}$'),  -- 永久ID。再利用しない
  rank text not null check (rank in ('family','subfamily','tribe','subtribe','genus','subgenus','species','subspecies')),
  parent_id bigint references public.taxa(id),
  scientific_name text not null,
  authorship text,
  publication_year text,
  name_ja text,
  family text,
  sort_order integer not null default 0,
  status text not null default 'accepted' check (status in
    ('accepted','unidentified','doubtful','south_kuril','excluded','merged','deprecated')),
  merged_into bigint references public.taxa(id),
  listmj_status text,
  listmj_change text,
  is_name_collision boolean not null default false,
  sensitivity smallint not null default 0 check (sensitivity between 0 and 2),
  inat_taxon_id bigint,
  gbif_usage_key bigint,
  backbone_version_id bigint references public.backbone_versions(id),
  source_row integer,
  updated_at timestamptz not null default now()
);
create index on public.taxa (parent_id);
create index on public.taxa (family);
create index on public.taxa using gin (scientific_name gin_trgm_ops);

create table public.journals (
  id bigint generated always as identity primary key,
  title text not null unique,
  title_alt text[] not null default '{}',
  issn text,
  publisher text,
  archive_url text check (archive_url is null or archive_url ~ '^https://'),
  purchase_note text
);

create table public.references_ (
  id bigint generated always as identity primary key,
  ref_code text not null unique check (ref_code ~ '^R\d{6}$'),
  ref_type text not null check (ref_type in ('article','book','chapter','report','thesis','web','other')),
  title text not null,
  title_en text,
  year integer check (year between 1700 and 2100),
  year_text text,
  journal_id bigint references public.journals(id),
  container_title text,
  volume text,
  issue text,
  pages text,
  publisher text,
  doi text unique check (doi is null or doi ~ '^10\.\d{4,9}/\S+$'),
  journal_issue_id bigint,
  language text,
  metadata_source text,
  auto_published boolean not null default false,
  status text not null default 'pending' check (status in ('draft','pending','published','rejected','withdrawn')),
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.references_ (year);
create index on public.references_ using gin (title gin_trgm_ops);

create table public.reference_authors (
  reference_id bigint not null references public.references_(id) on delete cascade,
  position smallint not null,
  family_name text not null,
  given_name text,
  name_roman text,
  primary key (reference_id, position)
);
create index on public.reference_authors (family_name);

create table public.taxon_names (
  id bigint generated always as identity primary key,
  taxon_id bigint not null references public.taxa(id),
  name text not null,
  name_type text not null check (name_type in
    ('scientific','synonym','misapplied','original_combination','ja_standard','ja_alias','ja_other')),
  authorship text,
  reference_id bigint references public.references_(id),
  source text not null default 'listmj',
  unique (taxon_id, name, name_type)
);
create index on public.taxon_names using gin (name gin_trgm_ops);

create table public.taxon_changes (
  id bigint generated always as identity primary key,
  change_type text not null check (change_type in ('rename','synonymize','split','merge','status','new_taxon','new_record')),
  from_taxon_id bigint references public.taxa(id),
  to_taxon_id bigint references public.taxa(id),
  reference_id bigint references public.references_(id),
  note text,
  proposed_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.type_records (
  id bigint generated always as identity primary key,
  taxon_id bigint not null references public.taxa(id),
  original_name text not null,
  original_authorship text,
  reference_id bigint references public.references_(id),
  page text,
  type_status text check (type_status in ('holotype','lectotype','neotype','syntype','paratype','unknown')),
  locality_verbatim text not null,
  locality_modern text,
  region_id bigint references public.regions(id),
  depository text,
  specimen_ref text,
  verification text not null default 'unverified' check (verification in ('unverified','literature','specimen_seen')),
  note text,
  status text not null default 'pending' check (status in ('draft','pending','published','rejected','withdrawn')),
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 記録（本DBの中心）
create table public.records (
  id bigint generated always as identity primary key,
  record_code text not null unique check (record_code ~ '^D\d{7}$'),
  reference_id bigint not null references public.references_(id),
  page text not null check (char_length(page) between 1 and 40),
  name_as_published text not null check (char_length(name_as_published) between 1 and 300),
  taxon_id bigint references public.taxa(id),
  category text not null check (category in ('original','citation','unconfirmed','unknown','board')),
  accuracy text not null default 'normal' check (accuracy in ('normal','needs_review','misidentification')),
  region_id bigint not null references public.regions(id),
  island_id bigint references public.regions(id),
  locality_verbatim text not null check (char_length(locality_verbatim) between 1 and 500),
  locality_modern text,
  lat numeric(8,5) check (lat between 20 and 46.5),
  lon numeric(8,5) check (lon between 122 and 154),
  coord_uncertainty_m integer check (coord_uncertainty_m >= 0),
  event_date_verbatim text,
  date_start date,
  date_end date,
  individual_count integer check (individual_count >= 0),
  sex text check (sex in ('male','female','both','unknown')),
  life_stage text check (life_stage in ('adult','larva','pupa','egg','mine','unknown')),
  collector_verbatim text,
  depository text,
  specimen_ref text,
  cited_record_id bigint references public.records(id),
  note text check (char_length(note) <= 2000),
  entry_method text not null default 'manual' check (entry_method in ('manual','bulk','ai_assisted','import')),
  auto_published boolean not null default false,
  post_review_sampled boolean not null default false,
  status text not null default 'pending' check (status in ('draft','pending','published','rejected','withdrawn')),
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_end is null or date_start is null or date_end >= date_start)
);
create index on public.records (taxon_id) where status = 'published';
create index on public.records (region_id) where status = 'published';
create index on public.records (reference_id);
create index on public.records (status);

create table public.host_records (
  id bigint generated always as identity primary key,
  taxon_id bigint not null references public.taxa(id),
  plant_name_scientific text,
  plant_name_ja text,
  plant_family text,
  reference_id bigint references public.references_(id),
  page text,
  note text,
  status text not null default 'pending' check (status in ('draft','pending','published','rejected','withdrawn')),
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  check (plant_name_scientific is not null or plant_name_ja is not null)
);

-- ---------------------------------------------------------------- 文献リポジトリ
-- 巻号ごとの収蔵管理。外部公開があればリンク、なければスキャンを保持する。
create table public.journal_issues (
  id bigint generated always as identity primary key,
  journal_id bigint not null references public.journals(id),
  volume text,
  issue text,
  year integer check (year between 1700 and 2100),
  scan_wanted boolean not null default false,
  scan_blocked boolean not null default false,   -- 発行元が頒布中の号など。スキャンを受け付けない
  block_reason text,
  claimed_by uuid references public.profiles(id),
  claimed_until date,
  note text,
  unique nulls not distinct (journal_id, volume, issue)
);
alter table public.references_ add foreign key (journal_issue_id) references public.journal_issues(id);

-- 発行元からの一括許諾。基本は documents の1件ごとの権利申告で、これは任意の近道。
create table public.rights_policies (
  id bigint generated always as identity primary key,
  name text not null,
  journal_id bigint references public.journals(id),
  rights_holder text,
  basis text not null check (basis in ('public_domain','open_license','permission','author_consent','prohibited')),
  license_code text,
  access_level text not null check (access_level in ('open','registered','metadata_only')),
  year_from integer,
  year_to integer,
  evidence_note text not null,
  valid_until date,
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  requested_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (requested_by is null or approved_by is null or requested_by <> approved_by)
);

create table public.trusted_domains (
  domain text primary key check (domain ~ '^[a-z0-9.-]+$'),
  provider text not null,
  enabled boolean not null default true
);

create table public.documents (
  id bigint generated always as identity primary key,
  doc_code text not null unique check (doc_code ~ '^F\d{7}$'),
  kind text not null check (kind in ('external','hosted')),
  provider text not null,
  external_url text check (external_url is null or external_url ~ '^https://'),
  title text,
  status text not null default 'pending' check (status in
    ('pending','quarantine','processing','awaiting_review','published','rejected','takedown','dead')),
  access_level text not null default 'metadata_only' check (access_level in ('open','registered','metadata_only')),
  rights_policy_id bigint references public.rights_policies(id),
  -- 登録者の権利申告。根拠のないファイルは受け付けない。
  rights_basis text check (rights_basis in ('author_self','public_domain','open_license','publisher_permission')),
  pd_reference_year integer,   -- 著者の没年。団体名義なら公表年
  rights_evidence text,        -- 没年の出典、ライセンスのURL、許諾の内容
  uploader_declaration jsonb,
  original_sha256 char(64),
  stored_sha256 char(64),
  bytes bigint check (bytes >= 0),
  page_count integer check (page_count >= 0),
  storage_key text,
  ocr_status text check (ocr_status in ('none','done','failed')),
  malware_result text check (malware_result in ('clean','infected','error')),
  http_status integer,
  checked_at timestamptz,
  auto_published boolean not null default false,
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'external' and external_url is not null) or (kind = 'hosted' and external_url is null)),
  check (kind = 'external' or rights_basis is not null or rights_policy_id is not null),
  check (rights_basis is distinct from 'public_domain' or (pd_reference_year is not null and rights_evidence is not null))
);
create unique index on public.documents (stored_sha256) where stored_sha256 is not null;
create unique index on public.documents (external_url) where external_url is not null;

-- 1ファイルに複数の号が入る場合がある（例: 蛾類同志會通信 No.4-11）
create table public.document_issues (
  document_id bigint not null references public.documents(id) on delete cascade,
  journal_issue_id bigint not null references public.journal_issues(id),
  primary key (document_id, journal_issue_id)
);

-- 1つのファイルに複数の論文が入る場合の対応表
create table public.document_parts (
  document_id bigint not null references public.documents(id) on delete cascade,
  reference_id bigint not null references public.references_(id),
  pdf_page_start integer not null check (pdf_page_start >= 1),
  pdf_page_end integer not null,
  confidence text not null default 'human' check (confidence in ('human','auto')),
  primary key (document_id, reference_id),
  check (pdf_page_end >= pdf_page_start)
);

create table public.takedown_requests (
  id bigint generated always as identity primary key,
  document_id bigint not null references public.documents(id),
  requester_name text not null,
  requester_contact text not null,
  body text not null check (char_length(body) between 5 and 4000),
  status text not null default 'open' check (status in ('open','upheld','dismissed')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 外部資源
create table public.external_resources (
  id bigint generated always as identity primary key,
  key text not null unique,
  name text not null,
  kind text not null check (kind in ('checklist','guide','board','regional_site','observation','specimen','literature')),
  home_url text not null check (home_url ~ '^https?://'),
  taxon_url_template text,
  owner_note text,
  license_note text,
  permission text not null default 'not_requested'
    check (permission in ('not_requested','requested','home_link_only','deep_link_ok','data_ok','declined')),
  enabled boolean not null default false,
  last_checked_at timestamptz
);

create table public.external_links (
  id bigint generated always as identity primary key,
  resource_id bigint not null references public.external_resources(id),
  target_type text not null check (target_type in ('taxon','region','reference')),
  target_id bigint not null,
  url text not null check (url ~ '^https?://'),
  title text,
  link_kind text not null default 'page' check (link_kind in ('page','discussion')),
  http_status integer,
  checked_at timestamptz,
  status text not null default 'pending' check (status in ('pending','published','rejected','dead')),
  submitted_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  unique (target_type, target_id, url)
);

create table public.external_snapshots (
  id bigint generated always as identity primary key,
  source text not null check (source in ('inaturalist','gbif')),
  fetched_at timestamptz not null default now(),
  query_note text,
  citation text,
  doi text
);

create table public.occurrence_summaries (
  snapshot_id bigint not null references public.external_snapshots(id) on delete cascade,
  taxon_id bigint not null references public.taxa(id),
  region_id bigint not null references public.regions(id),
  evidence text not null check (evidence in ('photo_rg','photo_needs_id','specimen','other')),
  occurrence_count integer not null check (occurrence_count >= 0),
  primary key (snapshot_id, taxon_id, region_id, evidence)
);

create table public.external_photos (
  id bigint generated always as identity primary key,
  taxon_id bigint not null references public.taxa(id),
  source text not null check (source = 'inaturalist'),
  observation_url text not null check (observation_url ~ '^https://'),
  image_url text not null check (image_url ~ '^https://'),
  license_code text not null check (license_code in ('cc0','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa')),
  attribution text not null,
  life_stage text check (life_stage in ('adult','larva','pupa','egg','mine','unknown')),
  fetched_at timestamptz not null default now(),
  unique (taxon_id, image_url)
);

-- ---------------------------------------------------------------- 修正提案とAI下処理
create table public.suggestions (
  id bigint generated always as identity primary key,
  suggestion_code text not null unique check (suggestion_code ~ '^S\d{7}$'),
  target_type text not null check (target_type in ('taxon','record','reference','region','type_record','page','other')),
  target_code text,
  source text not null default 'visitor' check (source in ('visitor','member','ai_watch','automated_check')),
  kind text not null check (kind in ('typo','name_change','distribution','misidentification','link','missing_record','other')),
  body text not null check (char_length(body) between 5 and 4000),
  evidence_doi text,
  evidence_url text check (evidence_url is null or evidence_url ~ '^https?://'),
  evidence_page text,
  submitter_id uuid references public.profiles(id),
  contact_email text,            -- 任意。決定から90日で null 化
  source_ip_hash text,
  status text not null default 'new' check (status in
    ('new','triaged','needs_info','accepted','rejected','spam','duplicate')),
  priority smallint not null default 2 check (priority between 1 and 3),
  duplicate_of bigint references public.suggestions(id),
  assigned_to uuid references public.profiles(id),
  decision_note text,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.suggestions (status, priority, created_at);

create table public.ai_runs (
  id bigint generated always as identity primary key,
  purpose text not null check (purpose in ('suggestion_triage','record_extraction','literature_watch')),
  subject_type text not null,
  subject_id bigint not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(10,4),
  stop_reason text,
  output jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index on public.ai_runs (subject_type, subject_id);

create table public.notification_outbox (
  id bigint generated always as identity primary key,
  channel text not null default 'email' check (channel in ('email','digest')),
  recipient_id uuid references public.profiles(id),
  template text not null,
  payload jsonb not null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- サイト管理
create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.content_pages (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  title_ja text not null,
  title_en text,
  body_md text not null check (char_length(body_md) <= 100000),
  status text not null default 'draft' check (status in ('draft','published')),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.releases (
  id bigint generated always as identity primary key,
  version text not null unique check (version ~ '^\d{4}\.\d{2}\.\d+$'),
  status text not null default 'building' check (status in ('building','live','superseded','failed','rolled_back')),
  notes text,
  counts jsonb,
  artifact_sha256 char(64),
  doi text,
  requested_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  table_name text,
  row_pk text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 権限判定
create function app.is_mfa() returns boolean
language sql stable as $$ select coalesce(auth.jwt()->>'aal','') = 'aal2' $$;

create function app.has_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_assignments r
    join public.profiles p on p.id = r.user_id
    where r.user_id = auth.uid() and r.status = 'active' and p.status = 'active'
      and r.role = any(p_roles)
      and (r.expires_at is null or r.expires_at > now())
  )
$$;

create function app.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active')
$$;

create function app.require_mfa_role(p_roles text[]) returns void
language plpgsql stable as $$
begin
  if not app.has_role(p_roles) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not app.is_mfa() then raise exception 'mfa_required' using errcode = '42501'; end if;
end $$;

-- ---------------------------------------------------------------- 監査
create function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_pk text;
begin
  v_pk := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id', to_jsonb(new)->>'key', to_jsonb(old)->>'key');
  insert into public.audit_log(actor_id, action, table_name, row_pk, before_data, after_data)
  values (auth.uid(), lower(tg_op), tg_table_name, v_pk,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create function app.block_audit_change() returns trigger
language plpgsql as $$
begin raise exception 'audit_log_is_append_only' using errcode = '42501'; end $$;

create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function app.block_audit_change();

do $$
declare t text;
begin
  foreach t in array array['role_assignments','taxa','taxon_names','taxon_changes','type_records','references_',
    'records','host_records','external_resources','external_links','suggestions','feature_flags','site_settings',
    'content_pages','releases','profiles','journal_issues','rights_policies','trusted_domains','documents',
    'document_parts','document_issues','takedown_requests']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
      for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- 投稿の防御
-- 投稿者が直接書けるのは draft / pending のみ。公開は審査関数だけが行う。
create function app.guard_submission() returns trigger
language plpgsql as $$
begin
  -- SECURITY DEFINER の審査関数内では current_user が関数所有者になる。
  -- 利用者が変更できる設定値（set_config）を判定に使ってはならない。
  if current_user in ('service_role','postgres') then
    return new;
  end if;
  if new.status not in ('draft','pending') then
    raise exception 'status_change_requires_review' using errcode = '42501';
  end if;
  if new.submitted_by is distinct from auth.uid() then
    raise exception 'submitted_by_must_be_self' using errcode = '42501';
  end if;
  new.reviewed_by := null;
  new.reviewed_at := null;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['records','references_','type_records','host_records'] loop
    execute format('create trigger guard_%1$s before insert or update on public.%1$I
      for each row execute function app.guard_submission()', t);
  end loop;
end $$;

create function app.review_submission(p_table text, p_id bigint, p_decision text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_submitter uuid; v_rows integer;
begin
  if p_table not in ('records','references_','type_records','host_records') then
    raise exception 'bad_table';
  end if;
  if p_decision not in ('published','rejected') then raise exception 'bad_decision'; end if;
  if not app.has_role(array['reviewer','admin','owner']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  execute format('select submitted_by from public.%I where id = $1 and status = ''pending''', p_table)
    into v_submitter using p_id;
  -- EXECUTE は FOUND を更新しないため、行数は GET DIAGNOSTICS で判定する。
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'not_pending'; end if;
  if v_submitter = auth.uid() then
    raise exception 'self_review_forbidden' using errcode = '42501';
  end if;
  execute format('update public.%I set status = $1, reviewed_by = $2, reviewed_at = now() where id = $3', p_table)
    using p_decision, auth.uid(), p_id;
  insert into public.audit_log(actor_id, action, table_name, row_pk, after_data)
  values (auth.uid(), 'review', p_table, p_id::text, jsonb_build_object('decision', p_decision, 'note', p_note));
end $$;

-- 1文献の記録をまとめて審査する。人の作業を文献単位へ減らすための関数。
create function app.review_reference_batch(p_reference bigint, p_decision text, p_note text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_id bigint;
begin
  if p_decision not in ('published','rejected') then raise exception 'bad_decision'; end if;
  if not app.has_role(array['reviewer','admin','owner']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for v_id in select id from public.records
    where reference_id = p_reference and status = 'pending' and submitted_by is distinct from auth.uid()
  loop
    update public.records set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now() where id = v_id;
    v_count := v_count + 1;
  end loop;
  insert into public.audit_log(actor_id, action, table_name, row_pk, after_data)
  values (auth.uid(), 'review_batch', 'records', p_reference::text,
          jsonb_build_object('decision', p_decision, 'count', v_count, 'note', p_note));
  return v_count;
end $$;

-- スキャンの公開判定。1件ごとの権利申告、または発行元の一括許諾が必要。
-- 2018-12-29 時点で消滅していた権利は復活しないため、没年または団体名義の公表年が1967年以前を満了候補とする。
create function app.publish_document(p_id bigint, p_policy bigint default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.documents; p public.rights_policies;
begin
  if not app.has_role(array['reviewer','admin','owner']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from public.documents where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if v.submitted_by = auth.uid() then raise exception 'self_review_forbidden' using errcode = '42501'; end if;
  if v.kind <> 'hosted' or v.status <> 'awaiting_review' or v.malware_result is distinct from 'clean' then
    raise exception 'not_publishable';
  end if;
  if exists (select 1 from public.document_issues di join public.journal_issues ji on ji.id = di.journal_issue_id
             where di.document_id = p_id and ji.scan_blocked) then
    raise exception 'issue_blocked';
  end if;
  if p_policy is not null then
    select * into p from public.rights_policies where id = p_policy and status = 'active'
      and (valid_until is null or valid_until >= current_date);
    if not found or p.basis = 'prohibited' then raise exception 'rights_not_cleared'; end if;
    update public.documents
       set status = 'published', access_level = p.access_level, rights_policy_id = p.id,
           reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_id;
    return;
  end if;
  if v.rights_basis is null then raise exception 'rights_not_cleared'; end if;
  if v.rights_basis = 'public_domain' and v.pd_reference_year > 1967 then
    raise exception 'rights_not_cleared';
  end if;
  update public.documents
     set status = 'published', access_level = 'open', reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id;
end $$;

-- 権利方針の有効化は別の管理者の承認が必要
create function app.approve_rights_policy(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.rights_policies;
begin
  perform app.require_mfa_role(array['admin','owner']);
  select * into v from public.rights_policies where id = p_id and status = 'pending';
  if not found then raise exception 'not_pending'; end if;
  if v.requested_by = auth.uid() then raise exception 'second_person_required' using errcode = '42501'; end if;
  update public.rights_policies set status = 'active', approved_by = auth.uid() where id = p_id;
end $$;

-- ---------------------------------------------------------------- 権限付与（二者承認）
create function app.request_role(p_user uuid, p_role text, p_family text default null, p_region bigint default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if p_role in ('admin','owner') then
    perform app.require_mfa_role(array['owner']);
  else
    perform app.require_mfa_role(array['admin','owner']);
  end if;
  if p_user = auth.uid() then raise exception 'self_grant_forbidden' using errcode = '42501'; end if;
  insert into public.role_assignments(user_id, role, scope_family, scope_region_id, status, requested_by,
                                      approved_by)
  values (p_user, p_role, p_family, p_region,
          case when p_role in ('admin','owner') then 'pending' else 'active' end,
          auth.uid(), null)
  returning id into v_id;
  return v_id;
end $$;

create function app.approve_role(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.role_assignments;
begin
  perform app.require_mfa_role(array['owner']);
  select * into v from public.role_assignments where id = p_id and status = 'pending';
  if not found then raise exception 'not_pending'; end if;
  if v.requested_by = auth.uid() or v.user_id = auth.uid() then
    raise exception 'second_person_required' using errcode = '42501';
  end if;
  update public.role_assignments set status = 'active', approved_by = auth.uid() where id = p_id;
end $$;

create function app.revoke_role(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.role_assignments;
begin
  select * into v from public.role_assignments where id = p_id;
  if not found then raise exception 'not_found'; end if;
  if v.role in ('admin','owner') then
    perform app.require_mfa_role(array['owner']);
    if v.role = 'owner' and (select count(*) from public.role_assignments
        where role = 'owner' and status = 'active') <= 2 then
      raise exception 'at_least_two_owners_required';
    end if;
  else
    perform app.require_mfa_role(array['admin','owner']);
  end if;
  update public.role_assignments set status = 'revoked', revoked_at = now() where id = p_id;
end $$;

-- ---------------------------------------------------------------- 修正提案の決定
create function app.decide_suggestion(p_id bigint, p_status text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('accepted','rejected','spam','duplicate','needs_info') then raise exception 'bad_status'; end if;
  if not app.has_role(array['reviewer','editor','admin','owner']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.suggestions
     set status = p_status, decision_note = p_note, decided_by = auth.uid(), decided_at = now()
   where id = p_id and status in ('new','triaged','needs_info');
  if not found then raise exception 'not_open'; end if;
end $$;

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- 匿名は一切読めない。公開サイトはDBへ接続しない。
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on schema app from anon;
revoke execute on all functions in schema app from public, anon;

grant usage on schema public, app to authenticated;
grant execute on function app.has_role(text[]), app.is_mfa(), app.is_active_user(), app.require_mfa_role(text[]),
  app.review_submission(text,bigint,text,text), app.request_role(uuid,text,text,bigint),
  app.approve_role(bigint), app.revoke_role(bigint), app.decide_suggestion(bigint,text,text),
  app.review_reference_batch(bigint,text,text), app.publish_document(bigint,bigint),
  app.approve_rights_policy(bigint)
  to authenticated;

-- 投稿サイトが参照する基盤データ
grant select on public.taxa, public.taxon_names, public.regions, public.journals, public.reference_authors,
  public.external_resources, public.feature_flags, public.journal_issues, public.document_parts,
  public.document_issues to authenticated;
create policy read_issues on public.journal_issues for select to authenticated using (true);
create policy read_parts on public.document_parts for select to authenticated using (true);
create policy read_doc_issues on public.document_issues for select to authenticated using (true);
create policy read_taxa on public.taxa for select to authenticated using (true);
create policy read_names on public.taxon_names for select to authenticated using (true);
create policy read_regions on public.regions for select to authenticated using (true);
create policy read_journals on public.journals for select to authenticated using (true);
create policy read_ref_authors on public.reference_authors for select to authenticated using (true);
create policy read_resources on public.external_resources for select to authenticated using (true);
create policy read_flags on public.feature_flags for select to authenticated using (true);

-- プロフィール
-- 列単位で許可する。表全体に UPDATE を与えると、後から列単位で REVOKE しても無効になる。
grant select on public.profiles to authenticated;
grant insert (id, display_name, orcid, affiliation, public_credit) on public.profiles to authenticated;
grant update (display_name, orcid, affiliation, public_credit) on public.profiles to authenticated;
create policy own_profile_read on public.profiles for select to authenticated
  using (id = auth.uid() or app.has_role(array['reviewer','editor','admin','owner']));
create policy own_profile_insert on public.profiles for insert to authenticated
  with check (id = auth.uid() and status = 'active' and trust_level = 0);
create policy own_profile_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- 投稿系（自分の分＋審査者）
do $$
declare t text;
begin
  foreach t in array array['records','references_','type_records','host_records'] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format($p$create policy %1$s_read on public.%1$I for select to authenticated
      using (status = 'published' or submitted_by = auth.uid()
             or app.has_role(array['reviewer','editor','admin','owner']))$p$, t);
    execute format($p$create policy %1$s_insert on public.%1$I for insert to authenticated
      with check (submitted_by = auth.uid() and status in ('draft','pending') and app.is_active_user())$p$, t);
    execute format($p$create policy %1$s_update on public.%1$I for update to authenticated
      using (submitted_by = auth.uid() and status in ('draft','pending'))
      with check (submitted_by = auth.uid() and status in ('draft','pending'))$p$, t);
  end loop;
end $$;
grant usage on all sequences in schema public to authenticated;

-- 管理系
grant select on public.suggestions, public.ai_runs, public.audit_log, public.role_assignments, public.releases
  to authenticated;
create policy suggestions_staff on public.suggestions for select to authenticated
  using (app.has_role(array['reviewer','editor','admin','owner']) or submitter_id = auth.uid());
create policy ai_runs_staff on public.ai_runs for select to authenticated
  using (app.has_role(array['reviewer','editor','admin','owner']));
create policy audit_staff on public.audit_log for select to authenticated
  using (app.has_role(array['admin','owner']));
create policy roles_read on public.role_assignments for select to authenticated
  using (user_id = auth.uid() or app.has_role(array['admin','owner']));
create policy releases_read on public.releases for select to authenticated
  using (app.has_role(array['editor','admin','owner']));

grant select, insert, update on public.content_pages, public.site_settings to authenticated;
create policy pages_editor on public.content_pages for all to authenticated
  using (app.has_role(array['editor','admin','owner']))
  with check (app.has_role(array['editor','admin','owner']) and app.is_mfa());
create policy settings_admin on public.site_settings for all to authenticated
  using (app.has_role(array['admin','owner']))
  with check (app.has_role(array['admin','owner']) and app.is_mfa());
grant update on public.feature_flags to authenticated;
create policy flags_admin on public.feature_flags for update to authenticated
  using (app.has_role(array['admin','owner']))
  with check (app.has_role(array['admin','owner']) and app.is_mfa());

-- 文献リポジトリ。文書の作成と状態変更は Edge Function（service_role）と上の関数だけが行う。
grant select on public.documents, public.rights_policies, public.takedown_requests to authenticated;
create policy documents_read on public.documents for select to authenticated
  using (status = 'published' or submitted_by = auth.uid()
         or app.has_role(array['reviewer','editor','admin','owner']));
create policy rights_read on public.rights_policies for select to authenticated
  using (app.has_role(array['reviewer','editor','admin','owner']));
create policy takedown_read on public.takedown_requests for select to authenticated
  using (app.has_role(array['admin','owner']));
grant insert on public.rights_policies to authenticated;
create policy rights_insert on public.rights_policies for insert to authenticated
  with check (app.has_role(array['admin','owner']) and app.is_mfa()
              and status = 'pending' and requested_by = auth.uid() and approved_by is null);
