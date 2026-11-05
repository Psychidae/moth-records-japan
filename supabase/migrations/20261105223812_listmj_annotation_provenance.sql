-- Preserve exact offline source items independently of editable display text.
alter table public.taxon_changes
  add column source text,
  add column source_item integer,
  add column source_sha256 char(64),
  add column source_raw text,
  add constraint taxon_changes_source_item_check check (
    (source is null and source_item is null and source_sha256 is null and source_raw is null)
    or (source is not null and source <> '' and source_item is not null and source_item > 0
      and source_sha256 is not null and source_sha256 ~ '^[a-f0-9]{64}$' and source_raw is not null and source_raw <> '')
  ),
  add constraint taxon_changes_source_item_unique unique (source, source_sha256, source_item);

alter table public.references_
  add column source_item integer,
  add column source_sha256 char(64),
  add column source_raw text,
  add column source_authors text,
  add constraint references_source_item_check check (
    (source_item is null and source_sha256 is null and source_raw is null and source_authors is null)
    or (metadata_source is not null and metadata_source <> '' and source_item is not null and source_item > 0
      and source_sha256 is not null and source_sha256 ~ '^[a-f0-9]{64}$' and source_raw is not null and source_raw <> '')
  ),
  add constraint references_source_item_unique unique (metadata_source, source_sha256, source_item);

-- Keep all original submission fields writable under their existing RLS/guard.
-- New import provenance is written only by the trusted import, never a user.
revoke insert, update on public.references_ from authenticated;
grant insert (id, ref_code, ref_type, title, title_en, year, year_text, journal_id,
  container_title, volume, issue, pages, publisher, doi, journal_issue_id, language,
  metadata_source, auto_published, status, submitted_by, reviewed_by, reviewed_at,
  created_at, updated_at) on public.references_ to authenticated;
grant update (id, ref_code, ref_type, title, title_en, year, year_text, journal_id,
  container_title, volume, issue, pages, publisher, doi, journal_issue_id, language,
  metadata_source, auto_published, status, submitted_by, reviewed_by, reviewed_at,
  created_at, updated_at) on public.references_ to authenticated;
