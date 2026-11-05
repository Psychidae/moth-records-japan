import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const SNAPSHOT = {
  source: 'List-MJ',
  version: '3-210603',
  url: 'http://listmj.mothprog.com/dl/ListMJ3-210603DL.xlsx',
  license: 'CC0-1.0',
  workbook: 'ListMJ3-210603DL.xlsx',
  workbookBytes: 522_244,
  workbookSha256: '741184a92458724bec03b2e7a5641c31a3bfbfe85a529929ca9b0af70e69a072',
  rowsFile: 'listmj3_210603_rows.jsonl',
  rowsSha256: 'b66ab1736da9027c570dc743768e4370007b49bd95a1e45da118c7c9461c0d2c',
} as const;

const sourceRowSchema = z.object({
  row: z.number().int().min(2),
  cells: z.record(z.string().regex(/^[A-V]$/), z.string()),
}).strict().refine(({ cells }) => ['B', 'J', 'L'].every((key) => (cells[key] ?? '').length > 0),
  'Family, genus placeholder/name, and species epithet are required');

export type ListMjRow = z.infer<typeof sourceRowSchema>;
export type TaxonRank = 'family' | 'subfamily' | 'tribe' | 'subtribe' | 'genus' | 'subgenus' | 'species' | 'subspecies';
export type ListMjStatus = 'accepted' | 'unidentified' | 'south_kuril' | 'doubtful' | 'excluded';
export interface ListMjTaxon {
  taxonCode: string;
  rank: TaxonRank;
  parentCode: string | null;
  scientificName: string;
  authorship: string | null;
  publicationYear: string | null;
  nameJa: string | null;
  family: string;
  sortOrder: number;
  status: ListMjStatus;
  listmjStatus: string | null;
  listmjChange: string | null;
  isNameCollision: boolean;
  sourceRow: number;
}
export interface ListMjName {
  taxonCode: string;
  name: string;
  nameType: 'scientific' | 'ja_standard' | 'ja_alias' | 'ja_other';
  authorship: string | null;
}
export interface ListMjCollision {
  scientificName: string;
  rows: number[];
  taxonCodes: string[];
  namesJa: (string | null)[];
}
export interface ListMjImportReport {
  source: {
    name: string; version: string; url: string; license: string;
    workbook: string; workbookBytes: number; workbookSha256: string;
    rowsFile: string; rowsSha256: string;
  };
  counts: {
    dataRows: number;
    species: number;
    subspecies: number;
    nominotypicalSubspecies: number;
    unidentifiedSpeciesEpithets: number;
    collisionGroups: number;
    families: number;
    parentlessSubspecies: number;
  };
  speciesStatuses: Record<ListMjStatus, number>;
  collisionGroups: ListMjCollision[];
  siteStatusDiscrepancy: {
    scope: 'species';
    siteCounts: Record<ListMjStatus, number>;
    importedCounts: Record<ListMjStatus, number>;
    importedMinusSite: Record<ListMjStatus, number>;
    note: string;
  };
}
export interface ListMjImportResult {
  sql: string;
  report: ListMjImportReport;
  taxa: ListMjTaxon[];
  names: ListMjName[];
  rows: ListMjRow[];
}

const statuses: ListMjStatus[] = ['accepted', 'unidentified', 'south_kuril', 'doubtful', 'excluded'];
const emptyStatuses = (): Record<ListMjStatus, number> => ({
  accepted: 0, unidentified: 0, south_kuril: 0, doubtful: 0, excluded: 0,
});
const value = (row: ListMjRow, column: string): string => row.cells[column] ?? '';
const nullable = (text: string): string | null => text.length > 0 ? text : null;
const cleanEpithet = (text: string): string => text.replace(/<[^>]*>/g, '');
const codeAt = (ordinal: number): string => `M${String(ordinal).padStart(6, '0')}`;
const speciesKey = (row: ListMjRow): string => JSON.stringify([value(row, 'J'), cleanEpithet(value(row, 'L'))]);

/** Apply the documented priority, including exclusions before unidentified epithets. */
export function classifyListMjStatus(row: ListMjRow): ListMjStatus {
  const original = value(row, 'U');
  if (original === '日本のリストから除外') return 'excluded';
  if (original === '正体不明種') return 'doubtful';
  if (original.includes('南千島') || value(row, 'V').includes('南千島')) return 'south_kuril';
  if (/^sp[.,]/.test(cleanEpithet(value(row, 'L')))) return 'unidentified';
  return 'accepted';
}

function readVerifiedRows(directory: string): ListMjRow[] {
  const manifest = new Map<string, string>();
  for (const line of readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const entry = z.string().regex(/^[a-f0-9]{64} {2}[A-Za-z0-9_.-]+$/).parse(line);
    const checksum = entry.slice(0, 64);
    const filename = entry.slice(66);
    if (manifest.has(filename)) throw new Error(`Duplicate checksum entry: ${filename}`);
    manifest.set(filename, checksum);
  }
  const checked = new Map<string, Buffer>();
  for (const [filename, expected] of [
    [SNAPSHOT.workbook, SNAPSHOT.workbookSha256],
    [SNAPSHOT.rowsFile, SNAPSHOT.rowsSha256],
  ] as const) {
    if (manifest.get(filename) !== expected) throw new Error(`Unrecognized snapshot checksum: ${filename}`);
    const bytes = readFileSync(join(directory, filename));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`SHA-256 mismatch: ${filename}`);
    }
    checked.set(filename, bytes);
  }
  if (checked.get(SNAPSHOT.workbook)?.length !== SNAPSHOT.workbookBytes) {
    throw new Error('Workbook byte count does not match the verified snapshot');
  }
  const bytes = checked.get(SNAPSHOT.rowsFile);
  if (!bytes) throw new Error('Verified JSONL is missing');
  const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/);
  return lines.map((line, index) => {
    const row = sourceRowSchema.parse(JSON.parse(line) as unknown);
    if (row.row !== index + 2) throw new Error(`Nonconsecutive Excel source row: ${row.row}`);
    return row;
  });
}

function buildTaxa(rows: ListMjRow[]): ListMjTaxon[] {
  // Reserve every source-row code before assigning any higher-rank code.
  const taxa: ListMjTaxon[] = rows.map((row, index) => ({
    taxonCode: codeAt(index + 1),
    rank: value(row, 'M') ? 'subspecies' : 'species',
    parentCode: null,
    scientificName: [value(row, 'J'), cleanEpithet(value(row, 'L')), value(row, 'M')].filter(Boolean).join(' '),
    authorship: nullable(value(row, 'N')),
    publicationYear: nullable(value(row, 'O')),
    nameJa: nullable(value(row, 'Q')),
    family: value(row, 'B'),
    sortOrder: index + 1,
    status: classifyListMjStatus(row),
    listmjStatus: nullable(value(row, 'U')),
    listmjChange: nullable(value(row, 'V')),
    isNameCollision: false,
    sourceRow: row.row,
  }));
  const parentSpecies = new Map<string, ListMjTaxon[]>();
  for (const [index, row] of rows.entries()) {
    const taxon = taxa[index];
    if (!taxon) throw new Error(`Missing source taxon at Excel row ${row.row}`);
    if (taxon.rank === 'species') {
      const key = speciesKey(row);
      const candidates = parentSpecies.get(key) ?? [];
      candidates.push(taxon);
      parentSpecies.set(key, candidates);
    }
  }
  const higherTaxa = new Map<string, ListMjTaxon>();
  const hierarchy: { rank: TaxonRank; scientificColumn: string; japaneseColumn?: string }[] = [
    { rank: 'family', scientificColumn: 'B', japaneseColumn: 'C' },
    { rank: 'subfamily', scientificColumn: 'D', japaneseColumn: 'E' },
    { rank: 'tribe', scientificColumn: 'F', japaneseColumn: 'G' },
    { rank: 'subtribe', scientificColumn: 'H', japaneseColumn: 'I' },
    { rank: 'genus', scientificColumn: 'J' },
    { rank: 'subgenus', scientificColumn: 'K' },
  ];
  const unknownGenera = new Set(['Gen.', 'Oecophorinae Gen.', 'Chrysomeleiidae Gen.']);
  for (const [index, row] of rows.entries()) {
    const taxon = taxa[index];
    if (!taxon) throw new Error(`Missing source taxon at Excel row ${row.row}`);
    let parentCode: string | null = null;
    for (const level of hierarchy) {
      const scientificName = value(row, level.scientificColumn);
      if (!scientificName) continue;
      // A placeholder genus is kept in the verbatim scientific name, but must
      // never become a genus node. Its species attaches to the known upper rank.
      if ((level.rank === 'genus' || level.rank === 'subgenus') && unknownGenera.has(value(row, 'J'))) continue;
      const key = JSON.stringify([level.rank, parentCode, scientificName]);
      let upper = higherTaxa.get(key);
      if (!upper) {
        upper = {
          taxonCode: codeAt(rows.length + higherTaxa.size + 1),
          rank: level.rank,
          parentCode,
          scientificName,
          authorship: null,
          publicationYear: null,
          nameJa: level.japaneseColumn ? nullable(value(row, level.japaneseColumn)) : null,
          family: value(row, 'B'),
          sortOrder: index + 1,
          status: 'accepted',
          listmjStatus: null,
          listmjChange: null,
          isNameCollision: false,
          sourceRow: row.row,
        };
        higherTaxa.set(key, upper);
      }
      parentCode = upper.taxonCode;
    }
    if (taxon.rank === 'subspecies') {
      const candidates = parentSpecies.get(speciesKey(row)) ?? [];
      if (candidates.length !== 1) {
        throw new Error(`Subspecies at Excel row ${row.row} has ${candidates.length} candidate parent species`);
      }
      taxon.parentCode = candidates[0]?.taxonCode ?? null;
    } else {
      taxon.parentCode = parentCode;
    }
  }
  return [...taxa, ...higherTaxa.values()];
}

function markCollisions(taxa: ListMjTaxon[]): ListMjCollision[] {
  const names = new Map<string, ListMjTaxon[]>();
  for (const taxon of taxa) {
    if (taxon.rank !== 'species' && taxon.rank !== 'subspecies') continue;
    const group = names.get(taxon.scientificName) ?? [];
    group.push(taxon);
    names.set(taxon.scientificName, group);
  }
  return [...names.entries()].filter(([, group]) => group.length > 1).map(([scientificName, group]) => {
    for (const taxon of group) taxon.isNameCollision = true;
    return {
      scientificName,
      rows: group.map((taxon) => taxon.sourceRow),
      taxonCodes: group.map((taxon) => taxon.taxonCode),
      namesJa: group.map((taxon) => taxon.nameJa),
    };
  });
}

function buildNames(taxa: ListMjTaxon[], rows: ListMjRow[]): ListMjName[] {
  const names: ListMjName[] = [];
  const keys = new Set<string>();
  const append = (taxon: ListMjTaxon, name: string | null, nameType: ListMjName['nameType']): void => {
    if (!name) return;
    const key = JSON.stringify([taxon.taxonCode, name, nameType]);
    if (keys.has(key)) return;
    keys.add(key);
    names.push({ taxonCode: taxon.taxonCode, name, nameType, authorship: nameType === 'scientific' ? taxon.authorship : null });
  };
  for (const taxon of taxa) {
    append(taxon, taxon.scientificName, 'scientific');
    append(taxon, taxon.nameJa, 'ja_standard');
  }
  for (const [index, row] of rows.entries()) {
    const taxon = taxa[index];
    if (!taxon) throw new Error(`Missing name owner at Excel row ${row.row}`);
    // Only S is specified as a list; R remains verbatim, including annotations.
    append(taxon, nullable(value(row, 'R')), 'ja_alias');
    for (const name of value(row, 'S').replace(/[\[\]]/g, '').split('，')) {
      append(taxon, nullable(name.trim()), 'ja_other');
    }
  }
  return names;
}

function buildReport(rows: ListMjRow[], taxa: ListMjTaxon[], collisionGroups: ListMjCollision[]): ListMjImportReport {
  const species = taxa.filter((taxon) => taxon.rank === 'species');
  const subspecies = taxa.filter((taxon) => taxon.rank === 'subspecies');
  const speciesStatuses = emptyStatuses();
  for (const taxon of species) speciesStatuses[taxon.status]++;
  const siteCounts: Record<ListMjStatus, number> = {
    accepted: 6149, unidentified: 338, doubtful: 61, south_kuril: 57, excluded: 23,
  };
  const importedMinusSite = emptyStatuses();
  for (const status of statuses) importedMinusSite[status] = speciesStatuses[status] - siteCounts[status];
  const counts = {
    dataRows: rows.length,
    species: species.length,
    subspecies: subspecies.length,
    nominotypicalSubspecies: rows.filter((row) => value(row, 'M') && value(row, 'M') === cleanEpithet(value(row, 'L'))).length,
    unidentifiedSpeciesEpithets: rows.filter((row) => !value(row, 'M') && /^sp[.,]/.test(cleanEpithet(value(row, 'L')))).length,
    collisionGroups: collisionGroups.length,
    families: taxa.filter((taxon) => taxon.rank === 'family').length,
    parentlessSubspecies: subspecies.filter((taxon) => taxon.parentCode === null).length,
  };
  const expectedCounts: typeof counts = {
    dataRows: 7465, species: 6628, subspecies: 837, nominotypicalSubspecies: 299,
    unidentifiedSpeciesEpithets: 338, collisionGroups: 4, families: 88, parentlessSubspecies: 0,
  };
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
    throw new Error(`List-MJ acceptance counts differ: ${JSON.stringify(counts)}`);
  }
  const expectedStatuses: Record<ListMjStatus, number> = {
    accepted: 6183, unidentified: 335, south_kuril: 59, doubtful: 28, excluded: 23,
  };
  for (const status of statuses) {
    if (speciesStatuses[status] !== expectedStatuses[status]) throw new Error(`List-MJ species status differs: ${status}`);
  }
  const expectedCollisionRows = [[371, 392], [2753, 2770], [2870, 2871], [5961, 5962]];
  if (JSON.stringify(collisionGroups.map((group) => group.rows)) !== JSON.stringify(expectedCollisionRows)) {
    throw new Error('List-MJ collision groups differ from the verified source rows');
  }
  return {
    source: {
      name: SNAPSHOT.source, version: SNAPSHOT.version, url: SNAPSHOT.url, license: SNAPSHOT.license,
      workbook: SNAPSHOT.workbook, workbookBytes: SNAPSHOT.workbookBytes, workbookSha256: SNAPSHOT.workbookSha256,
      rowsFile: SNAPSHOT.rowsFile, rowsSha256: SNAPSHOT.rowsSha256,
    },
    counts,
    speciesStatuses,
    collisionGroups,
    siteStatusDiscrepancy: {
      scope: 'species', siteCounts, importedCounts: { ...speciesStatuses }, importedMinusSite,
      note: '総数6,628種は一致するが、サイト集計の疑問61種に対してExcel列からの規則判定は28種。差は推測で補わず、神保氏への相談時に確認する。',
    },
  };
}

function literal(input: string | number | boolean | null): string {
  if (input === null) return 'null';
  if (typeof input === 'string') return `'${input.replace(/'/g, "''")}'`;
  return String(input);
}

function insertBatches(table: string, entries: (string | number | boolean | null)[][]): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < entries.length; offset += 400) {
    chunks.push(`insert into ${table} values\n${entries.slice(offset, offset + 400).map((row) => `(${row.map(literal).join(',')})`).join(',\n')};`);
  }
  return chunks.join('\n');
}

function buildSql(rows: ListMjRow[], taxa: ListMjTaxon[], names: ListMjName[]): string {
  return `-- List-MJ ${SNAPSHOT.version}; CC0 1.0; generated offline from verified source.
-- Workbook SHA-256: ${SNAPSHOT.workbookSha256}
-- JSONL SHA-256: ${SNAPSHOT.rowsSha256}
-- Existing imported/manual taxa and name fields are never overwritten.
begin;
set local standard_conforming_strings = on;
select pg_advisory_xact_lock(hashtext('listmj:${SNAPSHOT.version}'));
create temporary table listmj_import_rows(row_number integer primary key, raw jsonb not null) on commit drop;
create temporary table listmj_import_taxa(
  taxon_code text primary key, rank text not null, parent_code text, scientific_name text not null,
  authorship text, publication_year text, name_ja text, family text not null, sort_order integer not null,
  status text not null, listmj_status text, listmj_change text, is_name_collision boolean not null,
  source_row integer not null
) on commit drop;
create temporary table listmj_import_names(taxon_code text not null, name text not null, name_type text not null, authorship text) on commit drop;
${insertBatches('listmj_import_rows', rows.map((row) => [row.row, JSON.stringify(row.cells)]))}
${insertBatches('listmj_import_taxa', taxa.map((taxon) => [
    taxon.taxonCode, taxon.rank, taxon.parentCode, taxon.scientificName, taxon.authorship,
    taxon.publicationYear, taxon.nameJa, taxon.family, taxon.sortOrder, taxon.status,
    taxon.listmjStatus, taxon.listmjChange, taxon.isNameCollision, taxon.sourceRow,
  ]))}
${insertBatches('listmj_import_names', names.map((name) => [name.taxonCode, name.name, name.nameType, name.authorship]))}
do $listmj_import$
declare
  v_backbone bigint;
  v_rank text;
begin
  insert into public.backbone_versions(source, version_label, source_url, sha256, license)
  values (${literal(SNAPSHOT.source)}, ${literal(SNAPSHOT.version)}, ${literal(SNAPSHOT.url)},
    ${literal(SNAPSHOT.workbookSha256)}, ${literal(SNAPSHOT.license)})
  on conflict (source, version_label) do nothing;
  select id into strict v_backbone from public.backbone_versions
    where source=${literal(SNAPSHOT.source)} and version_label=${literal(SNAPSHOT.version)};
  if exists (select 1 from public.backbone_versions where id=v_backbone
    and (sha256 <> ${literal(SNAPSHOT.workbookSha256)} or source_url <> ${literal(SNAPSHOT.url)}
      or license <> ${literal(SNAPSHOT.license)})) then
    raise exception 'List-MJ backbone provenance conflict';
  end if;
  if exists (select 1 from public.listmj_rows r join listmj_import_rows incoming using (row_number)
    where r.backbone_version_id=v_backbone and r.raw is distinct from incoming.raw) then
    raise exception 'List-MJ immutable source row conflict';
  end if;
  if exists (select 1 from public.taxa existing join listmj_import_taxa incoming using (taxon_code)
    where existing.backbone_version_id is distinct from v_backbone
      or existing.source_row is distinct from incoming.source_row or existing.rank <> incoming.rank) then
    raise exception 'List-MJ permanent taxon_code conflict; no codes reassigned';
  end if;
  if exists (select 1 from public.taxa existing join listmj_import_taxa incoming
    on existing.backbone_version_id=v_backbone and existing.source_row=incoming.source_row
      and existing.rank=incoming.rank and existing.taxon_code <> incoming.taxon_code) then
    raise exception 'List-MJ source taxon already has a different permanent code';
  end if;
  insert into public.listmj_rows(backbone_version_id, row_number, raw)
    select v_backbone, row_number, raw from listmj_import_rows order by row_number
    on conflict (backbone_version_id, row_number) do nothing;
  -- Parents must exist before children, independently of permanent code order.
  foreach v_rank in array array['family','subfamily','tribe','subtribe','genus','subgenus','species','subspecies'] loop
    if exists (select 1 from listmj_import_taxa incoming left join public.taxa parent
      on parent.taxon_code=incoming.parent_code
      where incoming.rank=v_rank and incoming.parent_code is not null and parent.id is null) then
      raise exception 'List-MJ missing parent for rank %', v_rank;
    end if;
    insert into public.taxa(taxon_code, rank, parent_id, scientific_name, authorship, publication_year,
      name_ja, family, sort_order, status, listmj_status, listmj_change, is_name_collision,
      backbone_version_id, source_row)
    select incoming.taxon_code, incoming.rank, parent.id, incoming.scientific_name, incoming.authorship,
      incoming.publication_year, incoming.name_ja, incoming.family, incoming.sort_order, incoming.status,
      incoming.listmj_status, incoming.listmj_change, incoming.is_name_collision, v_backbone, incoming.source_row
    from listmj_import_taxa incoming left join public.taxa parent on parent.taxon_code=incoming.parent_code
    where incoming.rank=v_rank order by incoming.sort_order, incoming.taxon_code
    on conflict (taxon_code) do nothing;
  end loop;
  insert into public.taxon_names(taxon_id, name, name_type, authorship, source)
    select owner.id, incoming.name, incoming.name_type, incoming.authorship, 'listmj'
    from listmj_import_names incoming join public.taxa owner on owner.taxon_code=incoming.taxon_code
    on conflict (taxon_id, name, name_type) do nothing;
end
$listmj_import$;
commit;
`;
}

/** Build a deterministic, offline import; no database connection or file writes. */
export function buildListMjImport(sourceDirectory = 'seed/source'): ListMjImportResult {
  const rows = readVerifiedRows(sourceDirectory);
  const taxa = buildTaxa(rows);
  const collisionGroups = markCollisions(taxa);
  const names = buildNames(taxa, rows);
  const report = buildReport(rows, taxa, collisionGroups);
  return { sql: buildSql(rows, taxa, names), report, taxa, names, rows };
}
