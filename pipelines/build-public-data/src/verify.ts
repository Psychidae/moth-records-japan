import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { columns, decodeTable, detailColumns, needsCsvNeutralization as formulaLeading, tableSchema, type Scalar, type TableFormat } from '../../../packages/public-data/src/index.ts';

const maximumBytes = 8 * 1024 * 1024;
const taxonCode = z.string().regex(/^M\d{6}$/);
const regionPattern = '(?:PR(?:0[1-9]|[1-3][0-9]|4[0-7])|IS\\d{4}|OT\\d{2})';
const regionCode = z.string().regex(new RegExp('^' + regionPattern + '$'));
const nullableText = z.string().max(2000).nullable();
const lifeStage = z.enum(['adult', 'larva', 'pupa', 'egg', 'mine', 'unknown']).nullable();
const dateTime = z.iso.datetime({ offset: true });
const version = z.string().regex(/^\d{4}\.(?:0[1-9]|1[0-2])\.[1-9]\d*$/);
const countsSchema = z.strictObject({
  taxa: z.number().int().nonnegative(), species: z.number().int().nonnegative(),
  subspecies: z.number().int().nonnegative(), regions: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(), references: z.number().int().nonnegative(),
});
const externalSchema = z.strictObject({
  status: z.enum(['uncollected', 'collected']), fetchedAt: dateTime.nullable(),
  doi: z.string().regex(/^10\.\d{4,9}\/\S+$/).nullable(), citation: z.string().min(1).max(2000).nullable(),
}).superRefine((value, context) => {
  if (value.status === 'uncollected' && [value.fetchedAt, value.doi, value.citation].some(item => item !== null)) {
    context.addIssue({ code: 'custom', message: 'Uncollected source cannot claim collected metadata' });
  }
  if (value.status === 'collected' && (value.fetchedAt === null || value.citation === null)) {
    context.addIssue({ code: 'custom', message: 'Collected source must include its citation and fetch time' });
  }
});
const nationalSchema = z.strictObject({
  format: z.literal('national-v1'), version, generatedAt: dateTime, counts: countsSchema,
  external: z.strictObject({ inaturalist: externalSchema, gbif: externalSchema }),
  evidenceCounts: z.strictObject({
    original: z.number().int().nonnegative(), citation: z.number().int().nonnegative(),
    specimen: z.number().int().nonnegative(), photo_rg: z.number().int().nonnegative(),
    needs_review: z.number().int().nonnegative(),
    presence_only: z.number().int().nonnegative(),
  }),
});
const manifestSchema = z.strictObject({
  version, generatedAt: dateTime, counts: countsSchema,
  files: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })),
  licenses: z.strictObject({ taxonomy: z.literal('CC0 1.0'), records: z.literal('CC BY 4.0') }),
});
const recordSchema = z.strictObject({
  record_code: z.string().regex(/^D\d{7}$/), taxon: taxonCode, region: regionCode,
  island: z.string().regex(/^IS\d{4}$/).nullable(), reference: z.string().regex(/^R\d{6}$/),
  page: z.string().min(1).max(40), name_as_published: z.string().min(1).max(300),
  category: z.enum(['original', 'citation', 'unconfirmed', 'unknown', 'board']),
  accuracy: z.enum(['normal', 'needs_review', 'misidentification']), status: z.literal('published'),
  credit: z.string().min(1).max(80).nullable(),
  locality_verbatim: z.string().min(1).max(500).nullable(), locality_modern: nullableText,
  lat: z.number().finite().min(20).max(46.5).nullable(), lon: z.number().finite().min(122).max(154).nullable(),
  event_date_verbatim: nullableText, date_start: z.iso.date().nullable(), date_end: z.iso.date().nullable(),
  collector_verbatim: nullableText, specimen_ref: nullableText, note: nullableText,
  individual_count: z.number().int().nonnegative().nullable(), sex: z.enum(['male', 'female', 'both', 'unknown']).nullable(),
  life_stage: lifeStage, depository: nullableText, coord_uncertainty_m: z.number().int().nonnegative().nullable(),
});
const rowSchemas = {
  'names-v1': z.strictObject({ taxon: taxonCode, scientific_name: z.string().min(1), name_ja: nullableText, other_names: z.string() }),
  'taxa-v1': z.strictObject({
    taxon: taxonCode, parent: taxonCode.nullable(),
    rank: z.enum(['family', 'subfamily', 'tribe', 'subtribe', 'genus', 'subgenus', 'species', 'subspecies']),
    scientific_name: z.string().min(1), name_ja: nullableText, family: nullableText, authorship: nullableText,
    status: z.enum(['accepted', 'unidentified', 'doubtful', 'south_kuril', 'excluded', 'merged', 'deprecated']),
    sensitivity: z.number().int().min(0).max(2),
  }),
  'regions-v1': z.strictObject({
    region: regionCode, region_type: z.enum(['prefecture', 'island', 'other']),
    name_ja: z.string().min(1), name_en: z.string().min(1), parent: regionCode.nullable(),
    area_group: nullableText, sort_order: z.number().int(),
  }),
  'records-v1': recordSchema,
  'references-v1': z.strictObject({
    ref_code: z.string().regex(/^R\d{6}$/), title: z.string().min(1), title_en: nullableText,
    year: z.number().int().min(1700).max(2100).nullable(), year_text: nullableText, container_title: nullableText,
    volume: nullableText, issue: nullableText, pages: nullableText, publisher: nullableText,
    doi: z.string().regex(/^10\.\d{4,9}\/\S+$/).nullable(), authors: z.string(),
  }),
  'matrix-v1': z.strictObject({ taxon: taxonCode, region: regionCode, evidence: z.number().int().min(1).max(6), discovery: z.boolean() }),
  'photos-v1': z.strictObject({
    taxon: taxonCode, observation_url: z.string().regex(/^https:\/\/www\.inaturalist\.org\/observations\/[1-9]\d*$/),
    image_url: z.string().regex(/^https:\/\/(?:static\.inaturalist\.org|inaturalist-open-data\.s3\.amazonaws\.com)\/photos\/[^\s]+$/),
    license_code: z.enum(['cc0', 'cc-by', 'cc-by-nc', 'cc-by-sa', 'cc-by-nc-sa']),
    attribution: z.string().min(1).max(2000), life_stage: lifeStage,
  }),
} as const;

const privateKeys = new Set(['submittedby', 'reviewedby', 'userid', 'profileid', 'actorid', 'ownerid',
  'email', 'contactemail', 'iphash', 'sourceiphash', 'password', 'token', 'authorization', 'apikey',
  'usermetadata', 'rawusermetadata', 'rawappmetadata', 'raw', 'provenance', 'payloaddigest', 'querynote',
  'seedsource', 'seedkey', 'sourcerawhtml', 'sourcehtmlsha256', 'sourceitemindex']);
const uuidPattern = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function inspectString(value: string): void {
  if (uuidPattern.test(value)) throw new Error('UUID found in public output');
  if (emailPattern.test(value)) throw new Error('Email found in public output');
}

/** Scan the original object, including every unused dictionary value, before parsing. */
export function verifyRawPublicObject(input: unknown): void {
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') inspectString(value);
    else if (Array.isArray(value)) for (const item of value) pending.push(item);
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        inspectString(key);
        if (privateKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) throw new Error('Private field found in public output');
        pending.push(item);
      }
    }
  }
}

function pathKind(path: string): TableFormat | 'manifest' | 'national' | 'csv' {
  const fixed: Readonly<Record<string, TableFormat | 'manifest' | 'national'>> = {
    'manifest.json': 'manifest', 'names.json': 'names-v1', 'taxon-tree.json': 'taxa-v1',
    'regions.json': 'regions-v1', 'summary/national.json': 'national',
    'summary/matrix.json': 'matrix-v1', 'references/index.json': 'references-v1',
  };
  if (Object.hasOwn(fixed, path)) return fixed[path] ?? 'manifest';
  if (/^photos\/M\d{6}\.json$/.test(path)) return 'photos-v1';
  if (/^records\/genus\/(?:M\d{6}|unplaced-M\d{6})(?:\/taxon-M\d{6}(?:-part-\d{4})?)?\.json$/.test(path)) return 'records-v1';
  if (new RegExp('^records/region/' + regionPattern + '(?:/family-(?:M\\d{6}|unplaced)(?:-part-\\d{4})?)?\\.json$').test(path)) return 'records-v1';
  if (new RegExp('^downloads/' + regionPattern + '(?:-part-\\d{4})?\\.csv\\.gz$').test(path)) return 'csv';
  throw new Error('Unknown public output path');
}

function outputFiles(directory: string): string[] {
  const root = lstatSync(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Public output must be a real directory');
  const rootPath = realpathSync(directory);
  const result: string[] = [];
  const allowedDirectory = (path: string) => ['summary', 'records', 'records/genus', 'records/region', 'references', 'photos', 'downloads'].includes(path)
    || /^records\/genus\/(?:M\d{6}|unplaced-M\d{6})$/.test(path)
    || new RegExp('^records/region/' + regionPattern + '$').test(path);
  function walk(path: string) {
    for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
      const item = path === '' ? entry.name : path + '/' + entry.name;
      const absolute = join(directory, item);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Public output contains a symlink or path escape');
      const actual = relative(rootPath, realpathSync(absolute));
      if (actual === '..' || actual.startsWith('..' + sep)) throw new Error('Public output contains a symlink or path escape');
      if (stat.isDirectory()) {
        if (!allowedDirectory(item)) throw new Error('Unknown public output directory');
        walk(item);
      } else if (stat.isFile()) {
        pathKind(item);
        result.push(item);
        if (result.length > 18000) throw new Error('Public output exceeds 18000 files');
      } else throw new Error('Unsupported public output entry');
    }
  }
  walk('');
  return result.sort();
}

function decodePublicTable(input: unknown, format: TableFormat): Record<string, Scalar>[] {
  const table = tableSchema.parse(input);
  if (table.format !== format) throw new Error('Public table format does not match its path');
  const rows = decodeTable(table);
  const shape: Record<string, z.ZodType> = rowSchemas[format].shape;
  for (const [column, values] of Object.entries(table.dictionaries)) {
    const fieldSchema = shape[column];
    if (!fieldSchema) throw new Error('Unknown public dictionary column');
    for (const value of values) fieldSchema.parse(value);
    const position = table.columns.indexOf(column);
    const used = new Set(table.rows.map(row => row[position]));
    if (used.size !== values.length) throw new Error('Unused public dictionary value');
  }
  for (const row of rows) rowSchemas[format].parse(row);
  return rows;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let started = false; let skipLf = false;
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  for (const character of text) {
    if (skipLf) { skipLf = false; if (character === '\n') continue; }
    started = true;
    if (state === 'quoted') {
      if (character === '"') state = 'closed'; else field += character;
    } else if (state === 'closed' && character === '"') {
      field += '"'; state = 'quoted';
    } else if (character === ',') {
      row.push(field); field = ''; state = 'plain';
    } else if (character === '\n' || character === '\r') {
      row.push(field); rows.push(row); row = []; field = ''; state = 'plain'; started = false; skipLf = character === '\r';
    } else if (state === 'closed') throw new Error('Malformed quoted public CSV');
    else if (character === '"') {
      if (field !== '') throw new Error('Unexpected quote in public CSV');
      state = 'quoted';
    } else field += character;
  }
  if (state === 'quoted') throw new Error('Incomplete quoted public CSV');
  if (started) { row.push(field); rows.push(row); }
  return rows;
}

const numericRecordColumns = new Set(['lat', 'lon', 'individual_count', 'coord_uncertainty_m']);
const nullableRecordColumns = new Set(['island', 'credit', ...detailColumns]);
const orderedRecord = (row: Record<string, Scalar>) => JSON.stringify(columns['records-v1'].map(column => row[column]));

export interface TrustedPublicRegion {
  regionType: 'prefecture' | 'island' | 'other';
  parent: string | null;
}

export function verifyPublicDirectory(
  directory: string,
  trustedSensitivity: ReadonlyMap<string, number>,
  options: { maxBytes?: number; trustedRegions: ReadonlyMap<string, TrustedPublicRegion> },
): { files: number; records: number } {
  const parsedOptions = z.strictObject({
    maxBytes: z.number().int().positive().max(maximumBytes).optional(),
    trustedRegions: z.map(regionCode, z.strictObject({
      regionType: z.enum(['prefecture', 'island', 'other']), parent: regionCode.nullable(),
    })),
  }).parse(options);
  const limit = parsedOptions.maxBytes ?? maximumBytes;
  const trustedRegions = parsedOptions.trustedRegions;
  for (const [code, sensitivity] of trustedSensitivity) {
    taxonCode.parse(code); z.number().int().min(0).max(2).parse(sensitivity);
  }
  const files = outputFiles(directory);
  for (const required of ['manifest.json', 'names.json', 'taxon-tree.json', 'regions.json', 'summary/national.json', 'summary/matrix.json', 'references/index.json']) {
    if (!files.includes(required)) throw new Error('Missing required public output file');
  }
  const buffers = new Map<string, Buffer>();
  const json = new Map<string, unknown>();
  for (const path of files) {
    const stat = lstatSync(join(directory, path));
    if (stat.size > limit) throw new Error('Public file exceeds its byte limit');
    const data = readFileSync(join(directory, path));
    buffers.set(path, data);
    if (path.endsWith('.json')) {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      verifyRawPublicObject(value);
      json.set(path, value);
    }
  }
  const manifest = manifestSchema.parse(json.get('manifest.json'));
  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (file.path === 'manifest.json' || declared.has(file.path)) throw new Error('Invalid public manifest file list');
    pathKind(file.path);
    declared.add(file.path);
    const data = buffers.get(file.path);
    if (!data || file.bytes !== data.byteLength || file.sha256 !== createHash('sha256').update(data).digest('hex')) {
      throw new Error('Public manifest hash or size mismatch');
    }
  }
  if (declared.size !== files.length - 1 || files.some(path => path !== 'manifest.json' && !declared.has(path))) {
    throw new Error('Public manifest does not cover every output file');
  }
  const national = nationalSchema.parse(json.get('summary/national.json'));
  if (national.version !== manifest.version || national.generatedAt !== manifest.generatedAt
    || JSON.stringify(national.counts) !== JSON.stringify(manifest.counts)) throw new Error('Public metadata does not agree');
  if (national.external.gbif.status === 'collected' && national.external.gbif.doi === null) throw new Error('Collected GBIF source needs a DOI');
  if (national.external.inaturalist.doi !== null) throw new Error('Unexpected iNaturalist DOI');

  const taxa = new Map<string, Record<string, Scalar>>();
  const regions = new Map<string, Record<string, Scalar>>();
  const references = new Set<string>();
  const records = new Map<string, Record<string, Scalar>>();
  const recordLocations = new Map<string, Set<string>>();
  const tables = new Map<string, Record<string, Scalar>[]>();
  for (const path of files) {
    const kind = pathKind(path);
    if (kind === 'manifest' || kind === 'national' || kind === 'csv') continue;
    const rows = decodePublicTable(json.get(path), kind);
    tables.set(path, rows);
    if (kind === 'taxa-v1') for (const row of rows) {
      const code = String(row.taxon);
      if (taxa.has(code) || trustedSensitivity.get(code) !== row.sensitivity) throw new Error('Taxon sensitivity does not match the private source');
      taxa.set(code, row);
    }
    if (kind === 'regions-v1') for (const row of rows) {
      const code = String(row.region);
      const trusted = trustedRegions.get(code);
      if (regions.has(code) || !trusted || row.region_type !== trusted.regionType || row.parent !== trusted.parent) {
        throw new Error('Public region does not match the private source');
      }
      regions.set(code, row);
    }
    if (kind === 'references-v1') for (const row of rows) {
      const code = String(row.ref_code);
      if (references.has(code)) throw new Error('Duplicate public reference');
      references.add(code);
    }
  }
  if (taxa.size !== trustedSensitivity.size) throw new Error('Public taxonomy is missing a trusted taxon');
  if (regions.size !== trustedRegions.size) throw new Error('Public regions are missing a trusted region');
  for (const path of files) {
    for (const match of path.matchAll(/M\d{6}/g)) if (!taxa.has(match[0])) throw new Error('Output path names an unknown taxon');
    const region = path.startsWith('records/region/') ? path.slice('records/region/'.length).split(/[/.]/)[0]
      : path.startsWith('downloads/') ? path.slice('downloads/'.length).split(/[-.]/)[0] : undefined;
    if (region !== undefined && !regions.has(region)) throw new Error('Output path names an unknown region');
  }
  for (const row of taxa.values()) if (row.parent !== null && !taxa.has(String(row.parent))) throw new Error('Unknown public taxon parent');
  for (const row of regions.values()) if (row.parent !== null && !regions.has(String(row.parent))) throw new Error('Unknown public region parent');

  function validateRecord(row: Record<string, Scalar>): void {
    const record = recordSchema.parse(row);
    const sensitivity = trustedSensitivity.get(record.taxon);
    if (sensitivity === undefined || !taxa.has(record.taxon)) throw new Error('Record taxon is not trusted');
    if (sensitivity === 2) throw new Error('Sensitivity 2 permits only regional presence');
    if (sensitivity === 1 && detailColumns.some(column => row[column] !== null)) throw new Error('Sensitive record contains detail fields');
    if (sensitivity >= 1 && (record.island !== null || trustedRegions.get(record.region)?.regionType === 'island')) {
      throw new Error('Sensitive record contains an island region');
    }
    if (!regions.has(record.region) || (record.island !== null && regions.get(record.island)?.region_type !== 'island')) throw new Error('Unknown record region');
    if (!references.has(record.reference)) throw new Error('Unknown public record reference');
    if (record.date_start !== null && record.date_end !== null && record.date_end < record.date_start) throw new Error('Invalid public record date range');
  }
  const matrixKeys = new Set<string>();
  const evidenceCounts = [0, 0, 0, 0, 0, 0];
  const photoCounts = new Map<string, number>();
  for (const [path, rows] of tables) {
    const kind = pathKind(path);
    const localRecordCodes = new Set<string>();
    for (const row of rows) {
      if (kind === 'names-v1' || kind === 'matrix-v1' || kind === 'photos-v1') {
        if (!taxa.has(String(row.taxon))) throw new Error('Unknown public taxon');
      }
      if (kind === 'matrix-v1') {
        if (!regions.has(String(row.region))) throw new Error('Unknown matrix region');
        if ((trustedSensitivity.get(String(row.taxon)) ?? 2) >= 1
          && trustedRegions.get(String(row.region))?.regionType === 'island') throw new Error('Sensitive matrix contains an island region');
        const key = String(row.taxon) + ':' + String(row.region);
        if (matrixKeys.has(key)) throw new Error('Duplicate public matrix cell');
        matrixKeys.add(key);
        const evidence = Number(row.evidence);
        if ((trustedSensitivity.get(String(row.taxon)) === 2) !== (evidence === 6)) throw new Error('Sensitive presence must conceal its evidence source');
        evidenceCounts[evidence - 1] = (evidenceCounts[evidence - 1] ?? 0) + 1;
        if (row.discovery !== (evidence === 3 || evidence === 4)) throw new Error('Invalid public discovery flag');
      }
      if (kind === 'photos-v1') {
        const code = String(row.taxon);
        if ((trustedSensitivity.get(code) ?? 2) >= 1) throw new Error('Sensitive taxon contains public observation photos');
        if (path !== 'photos/' + code + '.json') throw new Error('Photo taxon does not match its path');
        photoCounts.set(code, (photoCounts.get(code) ?? 0) + 1);
        if ((photoCounts.get(code) ?? 0) > 6) throw new Error('Too many public photos for a taxon');
      }
      if (kind === 'records-v1') {
        validateRecord(row);
        const recordCode = String(row.record_code);
        if (localRecordCodes.has(recordCode)) throw new Error('Duplicate public record within a table');
        localRecordCodes.add(recordCode);
        const existing = records.get(recordCode);
        if (existing && orderedRecord(existing) !== orderedRecord(row)) throw new Error('Conflicting copies of a public record');
        records.set(recordCode, row);
        const locations = recordLocations.get(recordCode) ?? new Set<string>();
        locations.add(path.startsWith('records/region/') ? 'region' : 'genus');
        recordLocations.set(recordCode, locations);
        if (path.startsWith('records/region/')) {
          const code = path.slice('records/region/'.length).split(/[/.]/)[0];
          if (code !== row.region) throw new Error('Record region does not match its path');
        }
      }
    }
  }
  for (const path of files.filter(path => pathKind(path) === 'csv')) {
    const compressed = buffers.get(path);
    if (!compressed) throw new Error('Missing public CSV');
    const unpacked = gunzipSync(compressed, { maxOutputLength: limit });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(unpacked);
    inspectString(text);
    const csv = parseCsv(text);
    if (JSON.stringify(csv.shift()) !== JSON.stringify(columns['records-v1'])) throw new Error('Unknown public CSV columns');
    const region = path.slice('downloads/'.length).split(/[-.]/)[0];
    const localRecordCodes = new Set<string>();
    for (const values of csv) {
      if (values.length !== columns['records-v1'].length) throw new Error('Public CSV row width mismatch');
      const expected = records.get(values[0] ?? '');
      if (!expected) throw new Error('CSV contains an unknown public record');
      if (localRecordCodes.has(values[0] ?? '')) throw new Error('Duplicate public record within a CSV');
      localRecordCodes.add(values[0] ?? '');
      const row: Record<string, Scalar> = {};
      for (const [index, column] of columns['records-v1'].entries()) {
        const raw = values[index] ?? '';
        inspectString(raw);
        if (numericRecordColumns.has(column)) {
          if (raw === '') row[column] = null;
          else {
            if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error('Invalid numeric public CSV field');
            row[column] = Number(raw);
          }
        } else {
          if (formulaLeading(raw)) throw new Error('Unneutralized formula-leading public CSV text');
          const value = raw.startsWith("'") && formulaLeading(raw.slice(1)) && raw !== expected[column] ? raw.slice(1) : raw;
          row[column] = value === '' && nullableRecordColumns.has(column) && expected[column] !== '' ? null : value;
        }
      }
      verifyRawPublicObject(row);
      validateRecord(row);
      if (row.region !== region || orderedRecord(row) !== orderedRecord(expected)) throw new Error('CSV does not match its public record');
      recordLocations.get(String(row.record_code))?.add('csv');
    }
  }
  for (const locations of recordLocations.values()) {
    if (!['region', 'genus', 'csv'].every(kind => locations.has(kind))) throw new Error('Public record is missing an output view');
  }
  const expectedCounts = {
    taxa: taxa.size, species: [...taxa.values()].filter(row => row.rank === 'species').length,
    subspecies: [...taxa.values()].filter(row => row.rank === 'subspecies').length, regions: regions.size,
    records: records.size, references: references.size,
  };
  if (JSON.stringify(expectedCounts) !== JSON.stringify(manifest.counts)) throw new Error('Public counts do not match output tables');
  if (JSON.stringify(evidenceCounts) !== JSON.stringify(Object.values(national.evidenceCounts))) throw new Error('Public evidence counts do not match the matrix');
  return { files: files.length, records: records.size };
}
