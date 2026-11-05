import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface ImportedRegion {
  code: string;
  regionType: 'prefecture' | 'island' | 'other';
  nameJa: string;
  nameEn: string;
  parentCode: string | null;
  areaGroup: string | null;
  jisCode: string | null;
  gadmGid: string | null;
  inatPlaceId: number | null;
  sortOrder: number;
  sourceUrl: string | null;
}
export interface RegionAdjacency { regionCode: string; neighborCode: string }
export interface RegionImportReport {
  counts: { prefectures: number; islands: number; other: number; regions: number; adjacencyEdges: number };
  sources: { filename: string; sha256: string; rows: number }[];
  warnings: string[];
  adjacencyDefinition: string;
  identityDefinition: string;
}
export interface RegionImportResult {
  sql: string;
  regions: ImportedRegion[];
  adjacency: RegionAdjacency[];
  report: RegionImportReport;
}
interface SeedRegion { region: ImportedRegion; seedSource: string; seedKey: string }

const nonempty = z.string().min(1);
const prefectureCode = z.string().regex(/^PR(?:0[1-9]|[1-3]\d|4[0-7])$/);
const prefectureRowSchema = z.object({
  jis_code: z.string().regex(/^(?:0[1-9]|[1-3]\d|4[0-7])$/),
  name_ja: nonempty,
  name_en: nonempty,
  area_group: nonempty,
  gadm_gid: z.string().regex(/^JPN\.[1-9]\d*_1$/),
  inat_place_id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().safe()),
  inat_display_name: nonempty,
  gbif_gadm_name: nonempty,
}).strict();
const regionRowSchema = z.object({
  code: nonempty,
  name_ja: nonempty,
  name_en: nonempty,
  parent_code: z.string(),
  area_group: nonempty,
  sort_order: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe()),
  source_url: z.url().refine((url) => new URL(url).protocol === 'https:', 'Region evidence URL must use HTTPS'),
}).strict();
const adjacencyRowSchema = z.object({ region_code: prefectureCode, neighbor_code: prefectureCode }).strict();

/** A strict CSV reader, including quoted commas, escaped quotes, CRLF and BOM. */
function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const input = z.string().min(1).parse(text).replace(/^\ufeff/, '');
  const endField = (): void => { record.push(field); field = ''; afterQuote = false; };
  const endRecord = (): void => { endField(); records.push(record); record = []; };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === undefined) throw new Error('Unexpected CSV end');
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else {
        field += character;
      }
      continue;
    }
    if (character === ',') { endField(); continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index++;
      endRecord();
      continue;
    }
    if (afterQuote) throw new Error('Unexpected CSV content after closing quote');
    if (character === '"') {
      if (field.length) throw new Error('Unescaped quote in CSV field');
      quoted = true;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  if (field.length || record.length || afterQuote) endRecord();
  const header = records.shift();
  if (!header || header.some((name) => !name) || new Set(header).size !== header.length) {
    throw new Error('CSV header is missing, empty, or duplicated');
  }
  return records.map((cells, index) => {
    if (cells.length !== header.length) throw new Error(`CSV column count differs at data row ${index + 1}`);
    return Object.fromEntries(header.map((name, column) => [name, cells[column] ?? '']));
  });
}

function readSource(directory: string, filename: string): { rows: Record<string, string>[]; sha256: string } {
  const bytes = readFileSync(join(directory, filename));
  return { rows: parseCsv(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}
function ensureUnique(values: (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
function withIdentity(region: ImportedRegion, filename: string): SeedRegion {
  // Display fields remain editable in the DB. This separately identifies the
  // original source entity so code reuse or a changed source identity fails.
  const identity = {
    code: region.code, regionType: region.regionType, nameJa: region.nameJa,
    parentCode: region.parentCode, jisCode: region.jisCode,
    gadmGid: region.gadmGid, inatPlaceId: region.inatPlaceId,
  };
  return {
    region,
    seedSource: `seed:${filename}`,
    seedKey: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  };
}
function literal(input: string | number | null): string {
  return input === null ? 'null' : typeof input === 'number' ? String(input) : `'${input.replace(/'/g, "''")}'`;
}
function buildSql(regions: SeedRegion[]): string {
  return `-- Verified region seed import; no external-ID or coordinate invention.
-- Existing names, settings, coordinates, parent IDs and database IDs are preserved.
begin;
set local standard_conforming_strings = on;
select pg_advisory_xact_lock(hashtext('regions:seed-import'));
create temporary table region_seed_import(
  code text primary key, region_type text not null, name_ja text not null, name_en text not null,
  parent_code text, area_group text, jis_code char(2), gadm_gid text, inat_place_id bigint,
  sort_order integer not null, seed_source text not null, seed_key text not null
) on commit drop;
insert into region_seed_import values
${regions.map(({ region, seedSource, seedKey }) => `(${[
    region.code, region.regionType, region.nameJa, region.nameEn, region.parentCode,
    region.areaGroup, region.jisCode, region.gadmGid, region.inatPlaceId, region.sortOrder, seedSource, seedKey,
  ].map(literal).join(',')})`).join(',\n')};
do $region_seed$
declare v_type text;
begin
  if exists (select 1 from public.regions existing join region_seed_import incoming using (code)
    where existing.seed_source is distinct from incoming.seed_source
      or existing.seed_key is distinct from incoming.seed_key) then
    raise exception 'Region permanent code/source identity conflict; no existing region overwritten';
  end if;
  if exists (select 1 from public.regions existing join region_seed_import incoming
    on existing.seed_source=incoming.seed_source and existing.seed_key=incoming.seed_key
    where existing.code <> incoming.code) then
    raise exception 'Region source identity already has a different permanent code';
  end if;
  foreach v_type in array array['prefecture','other','island'] loop
    if exists (select 1 from region_seed_import incoming left join public.regions parent
      on parent.code=incoming.parent_code where incoming.region_type=v_type
        and incoming.parent_code is not null and (parent.id is null or parent.region_type <> 'prefecture')) then
      raise exception 'Region island parent is missing or is not a prefecture';
    end if;
    insert into public.regions(code, region_type, name_ja, name_en, parent_id, area_group,
      jis_code, gadm_gid, inat_place_id, sort_order, seed_source, seed_key)
      select incoming.code, incoming.region_type, incoming.name_ja, incoming.name_en, parent.id,
        incoming.area_group, incoming.jis_code, incoming.gadm_gid, incoming.inat_place_id,
        incoming.sort_order, incoming.seed_source, incoming.seed_key
      from region_seed_import incoming left join public.regions parent on parent.code=incoming.parent_code
      where incoming.region_type=v_type order by incoming.sort_order, incoming.code
      on conflict (code) do nothing;
  end loop;
end
$region_seed$;
commit;
`;
}

/** Read only committed CSVs and build deterministic DB/static-data artifacts. */
export function buildRegionImport(seedDirectory = 'seed'): RegionImportResult {
  const prefectureSource = readSource(seedDirectory, 'prefectures.csv');
  const islandSource = readSource(seedDirectory, 'islands.csv');
  const otherSource = readSource(seedDirectory, 'other_regions.csv');
  const adjacencySource = readSource(seedDirectory, 'adjacency.csv');
  const prefectures = prefectureSource.rows.map((row) => prefectureRowSchema.parse(row));
  if (prefectures.length !== 47) throw new Error(`Expected all 47 prefectures, got ${prefectures.length}`);
  ensureUnique(prefectures.map((row) => row.jis_code), 'prefecture JIS code');
  ensureUnique(prefectures.map((row) => row.gadm_gid), 'GADM ID');
  ensureUnique(prefectures.map((row) => row.inat_place_id), 'iNaturalist place ID');
  const expectedJis = Array.from({ length: 47 }, (_, index) => String(index + 1).padStart(2, '0'));
  if (JSON.stringify(prefectures.map((row) => row.jis_code).sort()) !== JSON.stringify(expectedJis)) {
    throw new Error('Prefecture JIS set must be exactly 01 through 47');
  }
  const nagasaki = prefectures.find((row) => row.jis_code === '42');
  if (nagasaki?.gadm_gid !== 'JPN.27_1') throw new Error('Nagasaki must be matched by verified GADM JPN.27_1');
  const prefectureCodes = new Set(prefectures.map((row) => `PR${row.jis_code}`));
  const seeds: SeedRegion[] = prefectures.map((row) => withIdentity({
    code: `PR${row.jis_code}`, regionType: 'prefecture', nameJa: row.name_ja, nameEn: row.name_en,
    parentCode: null, areaGroup: row.area_group, jisCode: row.jis_code, gadmGid: row.gadm_gid,
    inatPlaceId: row.inat_place_id, sortOrder: Number(row.jis_code), sourceUrl: null,
  }, 'prefectures.csv'));
  const islands = islandSource.rows.map((row) => regionRowSchema.parse(row));
  if (!islands.length) throw new Error('Island seed must contain the specified major islands');
  for (const row of islands) {
    z.string().regex(/^IS\d{4}$/).parse(row.code);
    if (!prefectureCodes.has(row.parent_code)) throw new Error(`Unknown island parent prefecture: ${row.parent_code}`);
    seeds.push(withIdentity({
      code: row.code, regionType: 'island', nameJa: row.name_ja, nameEn: row.name_en,
      parentCode: row.parent_code, areaGroup: row.area_group, jisCode: null, gadmGid: null,
      inatPlaceId: null, sortOrder: row.sort_order, sourceUrl: row.source_url,
    }, 'islands.csv'));
  }
  const otherRegions = otherSource.rows.map((row) => regionRowSchema.parse(row));
  if (otherRegions.length !== 1 || otherRegions[0]?.code !== 'OT01') {
    throw new Error('Other-region seed must contain the separate South Kurils region OT01');
  }
  for (const row of otherRegions) {
    if (row.parent_code !== '') throw new Error('South Kurils OT01 must remain a separate other region without a prefecture parent');
    seeds.push(withIdentity({
      code: row.code, regionType: 'other', nameJa: row.name_ja, nameEn: row.name_en,
      parentCode: null, areaGroup: row.area_group, jisCode: null, gadmGid: null,
      inatPlaceId: null, sortOrder: row.sort_order, sourceUrl: row.source_url,
    }, 'other_regions.csv'));
  }
  ensureUnique(seeds.map(({ region }) => region.code), 'region code');
  if (!adjacencySource.rows.length) throw new Error('Prefecture adjacency seed must not be empty');
  const adjacency = adjacencySource.rows.map((row) => {
    const parsed = adjacencyRowSchema.parse(row);
    if (!prefectureCodes.has(parsed.region_code) || !prefectureCodes.has(parsed.neighbor_code)) {
      throw new Error('Unknown prefecture adjacency endpoint');
    }
    if (parsed.region_code === parsed.neighbor_code) throw new Error(`Self adjacency is forbidden: ${parsed.region_code}`);
    return { regionCode: parsed.region_code, neighborCode: parsed.neighbor_code };
  });
  const edgeKeys = adjacency.map((edge) => `${edge.regionCode}:${edge.neighborCode}`);
  ensureUnique(edgeKeys, 'adjacency edge');
  const edgeSet = new Set(edgeKeys);
  for (const edge of adjacency) {
    if (!edgeSet.has(`${edge.neighborCode}:${edge.regionCode}`)) {
      throw new Error(`Asymmetric adjacency: ${edge.regionCode} -> ${edge.neighborCode}`);
    }
  }
  adjacency.sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.neighborCode.localeCompare(right.neighborCode));
  const regions = seeds.map((seed) => seed.region).sort((left, right) => left.code.localeCompare(right.code));
  const report: RegionImportReport = {
    counts: { prefectures: prefectures.length, islands: islands.length, other: otherRegions.length, regions: regions.length, adjacencyEdges: adjacency.length },
    sources: [
      { filename: 'prefectures.csv', sha256: prefectureSource.sha256, rows: prefectureSource.rows.length },
      { filename: 'islands.csv', sha256: islandSource.sha256, rows: islandSource.rows.length },
      { filename: 'other_regions.csv', sha256: otherSource.sha256, rows: otherSource.rows.length },
      { filename: 'adjacency.csv', sha256: adjacencySource.sha256, rows: adjacencySource.rows.length },
    ],
    warnings: nagasaki.gbif_gadm_name !== nagasaki.name_en
      ? [`PR42: source gbif_gadm_name=${nagasaki.gbif_gadm_name}; matching uses GADM ${nagasaki.gadm_gid}, never the display-name spelling.`] : [],
    adjacencyDefinition: 'Directed land-border edges between PR prefecture codes, including shared land boundaries on islands. Every pair has its reverse. IS island codes and OT01 are excluded; sea crossings or bridges alone do not create an edge.',
    identityDefinition: 'seed_key is SHA-256 of canonical original code/type/Japanese name/parent/JIS/GADM/iNaturalist IDs. Database display edits are preserved; a changed source identity or occupied code stops the entire transaction.',
  };
  return { sql: buildSql(seeds), regions, adjacency, report };
}
