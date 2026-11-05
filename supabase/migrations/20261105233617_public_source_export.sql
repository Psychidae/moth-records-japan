-- Atomic private source projection for the trusted public-data builder.
create function public.export_public_source() returns jsonb
language sql stable security invoker set search_path = '' as $source$
select jsonb_build_object(
  'taxa',coalesce((select jsonb_agg(to_jsonb(t) order by taxon_code) from (select id,taxon_code,parent_id,rank,scientific_name,name_ja,family,authorship,status,sensitivity from public.taxa) t),'[]'::jsonb),
  'names',coalesce((select jsonb_agg(to_jsonb(n)) from (select taxon_id,name from public.taxon_names order by id) n),'[]'::jsonb),
  'regions',coalesce((select jsonb_agg(to_jsonb(r) order by code) from (select id,code,parent_id,region_type,name_ja,name_en,area_group,sort_order from public.regions) r),'[]'::jsonb),
  'references',coalesce((select jsonb_agg(to_jsonb(r) order by ref_code) from (select id,ref_code,status,title,title_en,year,year_text,coalesce(container_title,(select title from public.journals where id=journal_id)) container_title,volume,issue,pages,publisher,doi,coalesce((select string_agg(concat_ws(' ',family_name,given_name),'、' order by position) from public.reference_authors where reference_id=r.id),'') authors from public.references_ r where status='published') r),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from (select id,display_name,public_credit from public.profiles) p),'[]'::jsonb),
  'records',coalesce((select jsonb_agg(to_jsonb(r) order by record_code) from (select record_code,taxon_id,region_id,island_id,reference_id,page,name_as_published,category,accuracy,status,submitted_by,locality_verbatim,locality_modern,lat,lon,event_date_verbatim,date_start,date_end,collector_verbatim,specimen_ref,note,individual_count,sex,life_stage,depository,coord_uncertainty_m from public.records where status='published') r),'[]'::jsonb),
  'snapshots',coalesce((select jsonb_agg(to_jsonb(s)) from (select id,source,fetched_at,doi,citation from public.external_snapshots) s),'[]'::jsonb),
  'summaries',coalesce((select jsonb_agg(to_jsonb(s)) from (select snapshot_id,taxon_id,region_id,evidence,occurrence_count from public.occurrence_summaries) s),'[]'::jsonb),
  'photos',coalesce((select jsonb_agg(to_jsonb(p)) from (select taxon_id,observation_url,image_url,license_code,attribution,life_stage from public.external_photos) p),'[]'::jsonb),
  'releases',coalesce((select jsonb_agg(jsonb_build_object('version',version)) from public.releases),'[]'::jsonb)
) as data
$source$;
revoke all on function public.export_public_source() from public, anon, authenticated;
grant execute on function public.export_public_source() to service_role;
