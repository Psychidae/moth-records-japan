-- 広域分布の地域。docs/14_broad_ranges.md の定義。
-- T13a で supabase/migrations の新しい migration へ移す。

alter table public.regions drop constraint regions_region_type_check;
alter table public.regions add constraint regions_region_type_check
  check (region_type in ('prefecture','island','other','broad'));

create table public.region_members (
  broad_region_id bigint not null references public.regions(id),
  member_region_id bigint not null references public.regions(id),
  primary key (broad_region_id, member_region_id),
  check (broad_region_id <> member_region_id)
);
create index on public.region_members (member_region_id);

-- 広域の親子は「広域 → 都道府県」だけを許す。島を親に持たせない。
create function app.guard_region_member() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select region_type from public.regions where id = new.broad_region_id) <> 'broad' then
    raise exception 'broad_region_required';
  end if;
  if (select region_type from public.regions where id = new.member_region_id) <> 'prefecture' then
    raise exception 'prefecture_member_required';
  end if;
  return new;
end $$;
create trigger guard_region_members before insert or update on public.region_members
  for each row execute function app.guard_region_member();

-- 広域の記録は島を指せない。座標も持たない。
create function app.guard_broad_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select region_type from public.regions where id = new.region_id) = 'broad'
     and (new.island_id is not null or new.lat is not null or new.lon is not null) then
    raise exception 'broad_record_cannot_be_precise';
  end if;
  return new;
end $$;
create trigger guard_broad_records before insert or update on public.records
  for each row execute function app.guard_broad_record();

alter table public.region_members enable row level security;
alter table public.region_members force row level security;
revoke all on public.region_members from public, anon, authenticated;
revoke execute on function app.guard_region_member(), app.guard_broad_record() from public, anon;
grant select on public.region_members to authenticated;
create policy read_region_members on public.region_members for select to authenticated using (true);
create trigger audit_region_members after insert or update or delete on public.region_members
  for each row execute function app.audit_row();
