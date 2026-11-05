import { z } from 'zod';
const text = z.string().nullable();
const id = z.number().int().positive();
const coordinate = z.union([z.number().finite(),z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)]).nullable();
const status = z.enum(['draft', 'pending', 'published', 'rejected', 'withdrawn']);
export const sourceSchema = z.object({
  taxa: z.array(z.object({ id, taxon_code: z.string().regex(/^M\d{6}$/), parent_id: id.nullable(), rank: z.enum(['family','subfamily','tribe','subtribe','genus','subgenus','species','subspecies']), scientific_name: z.string().min(1), name_ja: text, family: text, authorship: text, status: z.enum(['accepted','unidentified','doubtful','south_kuril','excluded','merged','deprecated']), sensitivity: z.number().int().min(0).max(2) })),
  names: z.array(z.object({ taxon_id: id, name: z.string() })),
  regions: z.array(z.object({ id, code: z.string().regex(/^(PR\d{2}|IS\d{4}|OT\d{2})$/), parent_id: id.nullable(), region_type: z.enum(['prefecture','island','other']), name_ja: z.string(), name_en: z.string(), area_group: text, sort_order: z.number().int() })),
  references: z.array(z.object({ id, ref_code: z.string().regex(/^R\d{6}$/), status, title: z.string(), title_en: text, year: z.number().int().nullable(), year_text: text, container_title: text, volume: text, issue: text, pages: text, publisher: text, doi: text, authors: z.string() })),
  profiles: z.array(z.object({ id: z.string().uuid(), display_name: z.string(), public_credit: z.boolean() })),
  records: z.array(z.object({ record_code: z.string().regex(/^D\d{7}$/), taxon_id: id.nullable(), region_id: id, island_id: id.nullable(), reference_id: id, page: z.string(), name_as_published: z.string(), category: z.enum(['original','citation','unconfirmed','unknown','board']), accuracy: z.enum(['normal','needs_review','misidentification']), status, submitted_by: z.string().uuid().nullable(), locality_verbatim: z.string(), locality_modern: text, lat: coordinate, lon: coordinate, event_date_verbatim: text, date_start: text, date_end: text, collector_verbatim: text, specimen_ref: text, note: text, individual_count: z.number().int().nonnegative().nullable(), sex: text, life_stage: text, depository: text, coord_uncertainty_m: z.number().int().nonnegative().nullable() })),
  snapshots: z.array(z.object({ id, source: z.enum(['inaturalist','gbif']), fetched_at: z.string(), doi: text, citation: text })),
  summaries: z.array(z.object({ snapshot_id: id, taxon_id: id, region_id: id, evidence: z.enum(['photo_rg','photo_needs_id','specimen','other']), occurrence_count: z.number().int().nonnegative() })),
  photos: z.array(z.object({ taxon_id: id, observation_url: z.string().url(), image_url: z.string().url(), license_code: z.enum(['cc0','cc-by','cc-by-nc','cc-by-sa','cc-by-nc-sa']), attribution: z.string().min(1), life_stage: text })),
  releases: z.array(z.object({ version: z.string().regex(/^\d{4}\.\d{2}\.\d+$/) })),
});
export type PublicSource = z.infer<typeof sourceSchema>;

// Explicit projections keep raw provenance and private moderation fields out of
// the export boundary. A saved source file is private and is never published.
export const exportSourceSql = `select jsonb_build_object(
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
) as data;`;
