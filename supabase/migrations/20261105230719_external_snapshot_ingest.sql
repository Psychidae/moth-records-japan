-- External providers are reduced to counts and licensed photos before this RPC.
-- The digest permits a safe replay; neither raw observations nor coordinates
-- have a destination in this allowlisted input contract.
alter table public.external_snapshots
  add column payload_digest char(32),
  add constraint external_snapshots_payload_digest_check
    check (payload_digest is null or payload_digest ~ '^[a-f0-9]{32}$'),
  add constraint external_snapshots_source_digest_unique unique (source, payload_digest);
revoke insert (payload_digest), update (payload_digest)
  on public.external_snapshots from public, anon, authenticated;

create function public.ingest_external_snapshot(payload jsonb) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare
  v_source text;
  v_fetched_at timestamptz;
  v_query jsonb;
  v_digest text;
  v_id bigint;
  v_entry jsonb;
  v_taxon public.taxa%rowtype;
  v_external_id bigint;
begin
  if jsonb_typeof(payload) is distinct from 'object'
     or not (payload ?& array['source','fetchedAt','queryNote','citation','doi','mappings','summaries','photos'])
     or exists (select 1 from jsonb_object_keys(payload) as k where k <> all
       (array['source','fetchedAt','queryNote','citation','doi','mappings','summaries','photos'])) then
    raise exception 'invalid_snapshot_keys';
  end if;
  v_source := payload->>'source';
  if jsonb_typeof(payload->'source') is distinct from 'string'
     or v_source not in ('inaturalist','gbif')
     or jsonb_typeof(payload->'fetchedAt') is distinct from 'string'
     or (payload->>'fetchedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
     or jsonb_typeof(payload->'queryNote') is distinct from 'string'
     or length(payload->>'queryNote') not between 2 and 20000
     or jsonb_typeof(payload->'citation') is distinct from 'string'
     or length(btrim(payload->>'citation')) not between 1 and 2000
     or jsonb_typeof(payload->'doi') not in ('null','string')
     or (v_source = 'inaturalist' and payload->'doi' <> 'null'::jsonb)
     or (v_source = 'gbif' and
       (jsonb_typeof(payload->'doi') <> 'string' or (payload->>'doi') !~ '^10\.\d{4,9}/\S+$'))
     or jsonb_typeof(payload->'mappings') is distinct from 'array'
     or jsonb_typeof(payload->'summaries') is distinct from 'array'
     or jsonb_typeof(payload->'photos') is distinct from 'array' then
    raise exception 'invalid_snapshot_metadata';
  end if;
  v_fetched_at := (payload->>'fetchedAt')::timestamptz;
  v_query := (payload->>'queryNote')::jsonb;
  if jsonb_typeof(v_query) is distinct from 'object' then
    raise exception 'invalid_snapshot_query';
  end if;
  if (v_query ? 'photos_collected' and jsonb_typeof(v_query->'photos_collected') <> 'boolean')
     or (jsonb_array_length(payload->'photos') > 0
       and v_query->'photos_collected' is distinct from 'true'::jsonb) then
    raise exception 'invalid_snapshot_photo_collection_state';
  end if;
  -- Inspect nested query objects as well as the root. Authentication and raw
  -- location fields may never become snapshot provenance.
  if exists (
    with recursive nodes(value) as (
      select v_query
      union all
      select child.value from nodes n cross join lateral (
        select value from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)
        union all
        select value from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)
      ) child
    )
    select 1 from nodes n cross join lateral
      jsonb_object_keys(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end) as k
    where lower(k) = any (array['lat','lon','latitude','longitude','coordinates','raw',
      'password','authorization','token','api_key','apikey','credentials'])
  ) then
    raise exception 'forbidden_snapshot_query_field';
  end if;

  -- Validate every entry before making any changes. A later constraint error
  -- also rolls back the entire RPC statement, including all mapping changes.
  for v_entry in select value from jsonb_array_elements(payload->'mappings') order by value->>'taxonCode' loop
    if jsonb_typeof(v_entry) is distinct from 'object'
       or not (v_entry ?& array['taxonCode','externalId'])
       or exists (select 1 from jsonb_object_keys(v_entry) as k where k <> all (array['taxonCode','externalId']))
       or jsonb_typeof(v_entry->'taxonCode') is distinct from 'string'
       or (v_entry->>'taxonCode') !~ '^M\d{6}$'
       or jsonb_typeof(v_entry->'externalId') is distinct from 'number'
       or (v_entry->>'externalId') !~ '^[1-9][0-9]*$'
       or (v_entry->>'externalId')::numeric > 9007199254740991 then
      raise exception 'invalid_external_mapping';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(payload->'mappings') as e
      group by e->>'taxonCode' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(payload->'mappings') as e
      group by e->>'externalId' having count(*) > 1) then
    raise exception 'duplicate_external_mapping';
  end if;
  for v_entry in select value from jsonb_array_elements(payload->'summaries') loop
    if jsonb_typeof(v_entry) is distinct from 'object'
       or not (v_entry ?& array['taxonCode','regionCode','evidence','count'])
       or exists (select 1 from jsonb_object_keys(v_entry) as k where k <> all
         (array['taxonCode','regionCode','evidence','count']))
       or jsonb_typeof(v_entry->'taxonCode') is distinct from 'string'
       or (v_entry->>'taxonCode') !~ '^M\d{6}$'
       or jsonb_typeof(v_entry->'regionCode') is distinct from 'string'
       or (v_entry->>'regionCode') !~ '^PR(0[1-9]|[1-3][0-9]|4[0-7])$'
       or jsonb_typeof(v_entry->'evidence') is distinct from 'string'
       or not ((v_source='inaturalist' and v_entry->>'evidence' in ('photo_rg','photo_needs_id'))
         or (v_source='gbif' and v_entry->>'evidence'='specimen'))
       or jsonb_typeof(v_entry->'count') is distinct from 'number'
       or (v_entry->>'count') !~ '^[1-9][0-9]*$'
       or (v_entry->>'count')::numeric > 2147483647 then
      raise exception 'invalid_occurrence_summary';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(payload->'summaries') as e
      group by e->>'taxonCode',e->>'regionCode',e->>'evidence' having count(*) > 1) then
    raise exception 'duplicate_occurrence_summary';
  end if;
  if v_source <> 'inaturalist' and jsonb_array_length(payload->'photos') > 0 then
    raise exception 'invalid_external_photo_source';
  end if;
  for v_entry in select value from jsonb_array_elements(payload->'photos') loop
    if jsonb_typeof(v_entry) is distinct from 'object'
       or not (v_entry ?& array['taxonCode','observationUrl','imageUrl','licenseCode','attribution','lifeStage'])
       or exists (select 1 from jsonb_object_keys(v_entry) as k where k <> all
         (array['taxonCode','observationUrl','imageUrl','licenseCode','attribution','lifeStage']))
       or jsonb_typeof(v_entry->'taxonCode') is distinct from 'string'
       or (v_entry->>'taxonCode') !~ '^M\d{6}$'
       or jsonb_typeof(v_entry->'observationUrl') is distinct from 'string'
       or length(v_entry->>'observationUrl') > 2048
       or (v_entry->>'observationUrl') !~ '^https://www\.inaturalist\.org/observations/[1-9][0-9]*$'
       or jsonb_typeof(v_entry->'imageUrl') is distinct from 'string'
       or length(v_entry->>'imageUrl') > 2048
       or (v_entry->>'imageUrl') !~ '^https://(static\.inaturalist\.org|inaturalist-open-data\.s3\.amazonaws\.com)/photos/[^[:space:]]+$'
       or jsonb_typeof(v_entry->'licenseCode') is distinct from 'string'
       or v_entry->>'licenseCode' not in ('cc0','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa')
       or jsonb_typeof(v_entry->'attribution') is distinct from 'string'
       or length(btrim(v_entry->>'attribution')) not between 1 and 2000
       or jsonb_typeof(v_entry->'lifeStage') not in ('null','string')
       or (jsonb_typeof(v_entry->'lifeStage')='string'
         and v_entry->>'lifeStage' not in ('adult','larva','pupa','egg','mine','unknown')) then
      raise exception 'invalid_external_photo';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(payload->'photos') as e
      group by e->>'taxonCode' having count(*) > 6)
     or exists (select 1 from jsonb_array_elements(payload->'photos') as e
      group by e->>'taxonCode',e->>'imageUrl' having count(*) > 1) then
    raise exception 'invalid_external_photo_count';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('external_snapshot:' || v_source));
  v_digest := pg_catalog.md5(payload::text);
  select id into v_id from public.external_snapshots
    where source=v_source and payload_digest=v_digest;
  if found then return v_id; end if;

  for v_entry in select value from jsonb_array_elements(payload->'mappings') order by value->>'taxonCode' loop
    select * into v_taxon from public.taxa where taxon_code=v_entry->>'taxonCode' for update;
    if not found or v_taxon.rank not in ('species','subspecies') or v_taxon.is_name_collision then
      raise exception 'external_mapping_taxon_not_unique';
    end if;
    v_external_id := (v_entry->>'externalId')::bigint;
    if (v_source='inaturalist' and v_taxon.inat_taxon_id is not null and v_taxon.inat_taxon_id <> v_external_id)
       or (v_source='gbif' and v_taxon.gbif_usage_key is not null and v_taxon.gbif_usage_key <> v_external_id)
       or exists (select 1 from public.taxa t where t.id <> v_taxon.id and
         ((v_source='inaturalist' and t.inat_taxon_id=v_external_id)
           or (v_source='gbif' and t.gbif_usage_key=v_external_id))) then
      raise exception 'external_mapping_conflict';
    end if;
    if v_source='inaturalist' and v_taxon.inat_taxon_id is null then
      update public.taxa set inat_taxon_id=v_external_id where id=v_taxon.id;
    elsif v_source='gbif' and v_taxon.gbif_usage_key is null then
      update public.taxa set gbif_usage_key=v_external_id where id=v_taxon.id;
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(payload->'summaries') e
    left join public.taxa t on t.taxon_code=e->>'taxonCode'
    left join public.regions r on r.code=e->>'regionCode'
    where t.id is null or t.rank not in ('species','subspecies') or t.is_name_collision
      or r.id is null or r.region_type <> 'prefecture'
      or (v_source='inaturalist' and t.inat_taxon_id is null)
      or (v_source='gbif' and t.gbif_usage_key is null)
  ) or exists (
    select 1 from jsonb_array_elements(payload->'photos') e
    left join public.taxa t on t.taxon_code=e->>'taxonCode'
    where t.id is null or t.rank not in ('species','subspecies') or t.is_name_collision or t.inat_taxon_id is null
  ) then
    raise exception 'unmatched_external_summary_or_photo';
  end if;

  insert into public.external_snapshots(source,fetched_at,query_note,citation,doi,payload_digest)
    values (v_source,v_fetched_at,payload->>'queryNote',payload->>'citation',payload->>'doi',v_digest)
    returning id into v_id;
  insert into public.occurrence_summaries(snapshot_id,taxon_id,region_id,evidence,occurrence_count)
    select v_id,t.id,r.id,e->>'evidence',(e->>'count')::integer
    from jsonb_array_elements(payload->'summaries') e
    join public.taxa t on t.taxon_code=e->>'taxonCode'
    join public.regions r on r.code=e->>'regionCode';

  -- A completed photo refresh replaces the affected taxa even if no current
  -- photo has an allowed license. A counts-only run preserves existing photos.
  delete from public.external_photos p using public.taxa t
    where v_source='inaturalist' and v_query->'photos_collected'='true'::jsonb
      and p.taxon_id=t.id and p.source='inaturalist'
      and t.taxon_code in (
        select e->>'taxonCode' from jsonb_array_elements(payload->'mappings') e
        union select e->>'taxonCode' from jsonb_array_elements(payload->'summaries') e
        union select e->>'taxonCode' from jsonb_array_elements(payload->'photos') e
      );
  insert into public.external_photos(taxon_id,source,observation_url,image_url,license_code,attribution,life_stage,fetched_at)
    select t.id,'inaturalist',e->>'observationUrl',e->>'imageUrl',e->>'licenseCode',
      e->>'attribution',e->>'lifeStage',v_fetched_at
    from jsonb_array_elements(payload->'photos') e join public.taxa t on t.taxon_code=e->>'taxonCode';
  return v_id;
end $$;

revoke all on function public.ingest_external_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_external_snapshot(jsonb) to service_role;
