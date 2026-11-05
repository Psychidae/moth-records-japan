-- A fixed source identity distinguishes a legitimate replay from code reuse.
alter table public.regions
  add column seed_source text,
  add column seed_key char(64),
  add constraint regions_seed_identity_check check (
    (seed_source is null and seed_key is null)
    or (seed_source is not null and seed_source <> '' and seed_key is not null
      and seed_key ~ '^[a-f0-9]{64}$')
  ),
  add constraint regions_seed_identity_unique unique (seed_source, seed_key);
-- regions remains read-only to authenticated, with existing RLS unchanged.
