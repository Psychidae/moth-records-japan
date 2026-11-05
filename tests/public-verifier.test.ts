import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { columns, detailColumns, encodeTable, tableSchema, type Scalar, type TableFormat } from '../packages/public-data/src/index.js';
import { verifyPublicDirectory as verifyDirectory, type TrustedPublicRegion } from '../pipelines/build-public-data/src/verify.js';

const code = 'M000001';
const generatedAt = '2026-11-06T00:00:00.000Z';
const regionPath = 'records/region/PR01.json';
const genusPath = 'records/genus/unplaced-M000001.json';
const csvPath = 'downloads/PR01.csv.gz';
const formulaLeading = (value: string) => /^[\u0000-\u001f]/.test(value) || /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(value);
const trustedRegions = new Map<string, TrustedPublicRegion>([['PR01', { regionType: 'prefecture', parent: null }]]);
function verifyPublicDirectory(directory: string, sensitivity: ReadonlyMap<string, number>,
  options: { maxBytes?: number; trustedRegions?: ReadonlyMap<string, TrustedPublicRegion> } = {}) {
  return verifyDirectory(directory, sensitivity, { ...options, trustedRegions: options.trustedRegions ?? trustedRegions });
}

function mergeRecord(row: Record<string, Scalar>, changes: Partial<Record<string, Scalar>>): Record<string, Scalar> {
  const result = { ...row };
  for (const [key, value] of Object.entries(changes)) if (value !== undefined) result[key] = value;
  return result;
}

function record(sensitivity = 0): Record<string, Scalar> {
  const row: Record<string, Scalar> = {
    record_code: 'D0000001', taxon: code, region: 'PR01', island: null, reference: 'R000001',
    page: '12', name_as_published: 'Example first', category: 'original', accuracy: 'normal',
    status: 'published', credit: null, locality_verbatim: 'Sample site', locality_modern: null,
    lat: 35, lon: 139, event_date_verbatim: null, date_start: null, date_end: null,
    collector_verbatim: null, specimen_ref: null, note: null, individual_count: null,
    sex: null, life_stage: null, depository: null, coord_uncertainty_m: null,
  };
  if (sensitivity > 0) for (const column of detailColumns) row[column] = null;
  return row;
}

function values(format: TableFormat, row: Record<string, Scalar>): Scalar[] {
  return columns[format].map(column => {
    const value = row[column];
    if (value === undefined) throw new Error('Incomplete test row');
    return value;
  });
}

function csv(records: Record<string, Scalar>[], neutralize = true): string {
  function cell(value: Scalar): string {
    if (value === null) return '';
    const string = String(value);
    const safe = neutralize && typeof value === 'string' && formulaLeading(string) ? "'" + string : string;
    return /[,"\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
  }
  return columns['records-v1'].join(',') + '\n'
    + records.map(row => values('records-v1', row).map(cell).join(',')).join('\n')
    + (records.length > 0 ? '\n' : '');
}

function fixture(sensitivity = 0, override: Partial<Record<string, Scalar>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'moth-public-verifier-'));
  const files = new Set<string>();
  const publicRecord = mergeRecord(record(sensitivity), override);
  const records = sensitivity === 2 ? [] : [publicRecord];
  const counts = { taxa: 1, species: 1, subspecies: 0, regions: 1, records: records.length, references: 1 };
  function write(path: string, content: string | Uint8Array) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
    files.add(path);
  }
  function json(path: string, value: unknown) { write(path, JSON.stringify(value)); }
  function table(path: string, format: TableFormat, rows: Record<string, Scalar>[]) {
    json(path, encodeTable(format, rows.map(row => values(format, row))));
  }
  function rehash() {
    json('manifest.json', {
      version: '2026.11.1', generatedAt, counts,
      files: [...files].filter(path => path !== 'manifest.json').sort().map(path => {
        const data = readFileSync(join(directory, path));
        return { path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength };
      }),
      licenses: { taxonomy: 'CC0 1.0', records: 'CC BY 4.0' },
    });
  }
  function mutateTable(path: string, change: (value: ReturnType<typeof tableSchema.parse>) => void) {
    const value = tableSchema.parse(JSON.parse(readFileSync(join(directory, path), 'utf8')) as unknown);
    change(value); json(path, value); rehash();
  }
  table('names.json', 'names-v1', [{ taxon: code, scientific_name: 'Example first', name_ja: 'テストガ', other_names: '' }]);
  table('taxon-tree.json', 'taxa-v1', [{ taxon: code, parent: null, rank: 'species',
    scientific_name: 'Example first', name_ja: 'テストガ', family: 'Exampleidae', authorship: null,
    status: 'accepted', sensitivity }]);
  table('regions.json', 'regions-v1', [{ region: 'PR01', region_type: 'prefecture',
    name_ja: '北海道', name_en: 'Hokkaido', parent: null, area_group: null, sort_order: 1 }]);
  table('summary/matrix.json', 'matrix-v1', [{ taxon: code, region: 'PR01', evidence: sensitivity === 2 ? 6 : 1, discovery: false }]);
  table('references/index.json', 'references-v1', [{ ref_code: 'R000001', title: 'Example published reference',
    title_en: null, year: 2000, year_text: null, container_title: null, volume: null, issue: null,
    pages: null, publisher: null, doi: null, authors: 'Example author' }]);
  table(genusPath, 'records-v1', records);
  table(regionPath, 'records-v1', records);
  write(csvPath, gzipSync(csv(records)));
  const uncollected = { status: 'uncollected', fetchedAt: null, doi: null, citation: null };
  function writeNational() {
    json('summary/national.json', { format: 'national-v1', version: '2026.11.1', generatedAt, counts,
      external: { inaturalist: uncollected, gbif: uncollected },
      evidenceCounts: { original: sensitivity === 2 ? 0 : 1, citation: 0, specimen: 0, photo_rg: 0, needs_review: 0, presence_only: sensitivity === 2 ? 1 : 0 } });
  }
  writeNational();
  rehash();
  return { directory, files, counts, publicRecord, write, json, table, rehash, mutateTable, writeNational,
    trusted: new Map([[code, sensitivity]]), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe('public directory verification from private sensitivity settings', () => {
  it('accepts complete columnar output, both JSON views and quoted/neutralized CSV with independent checksums', () => {
    const f = fixture(0, { note: '=SUM(1,2)\nsecond "line"' });
    try {
      expect(verifyPublicDirectory(f.directory, f.trusted)).toEqual({ files: 10, records: 1 });
      expect(verifyPublicDirectory(f.directory, f.trusted, { maxBytes: 8 * 1024 * 1024 })).toEqual({ files: 10, records: 1 });
    } finally { f.cleanup(); }
  });

  it('accepts redacted sensitivity 1 and presence-only sensitivity 2 without inventing collection metadata', () => {
    for (const sensitivity of [1, 2]) {
      const f = fixture(sensitivity);
      try { expect(verifyPublicDirectory(f.directory, f.trusted).records).toBe(sensitivity === 2 ? 0 : 1); }
      finally { f.cleanup(); }
    }
  });

  it('rejects sensitive detail values, all sensitivity 2 record rows, and falsified or missing public sensitivity tags', () => {
    const detail = fixture(1);
    try {
      detail.mutateTable(genusPath, table => { table.dictionaries.locality_verbatim = ['sensitive site']; });
      expect(() => verifyPublicDirectory(detail.directory, detail.trusted)).toThrow('Sensitive record');
    } finally { detail.cleanup(); }
    const presence = fixture(2);
    try {
      presence.table(genusPath, 'records-v1', [presence.publicRecord]); presence.rehash();
      expect(() => verifyPublicDirectory(presence.directory, presence.trusted)).toThrow('Sensitivity 2');
    } finally { presence.cleanup(); }
    const forged = fixture(1);
    try {
      forged.mutateTable('taxon-tree.json', table => { table.dictionaries.sensitivity = [0]; });
      expect(() => verifyPublicDirectory(forged.directory, forged.trusted)).toThrow('private source');
      forged.mutateTable('taxon-tree.json', table => {
        const index = table.columns.indexOf('sensitivity');
        table.columns.splice(index, 1); delete table.dictionaries.sensitivity;
        for (const row of table.rows) row.splice(index, 1);
      });
      expect(() => verifyPublicDirectory(forged.directory, forged.trusted)).toThrow();
    } finally { forged.cleanup(); }
  });
  it('conceals sensitivity2 evidence sources and discovery while forbidding presence-only labels for other taxa', () => {
    for (const [sensitivity,evidence,discovery] of [[2,1,false],[2,4,true],[2,6,true],[0,6,false],[1,6,false]] as const) {
      const f=fixture(sensitivity);
      try {
        f.table('summary/matrix.json','matrix-v1',[{taxon:code,region:'PR01',evidence,discovery}]); f.rehash();
        expect(()=>verifyPublicDirectory(f.directory,f.trusted)).toThrow();
      } finally { f.cleanup(); }
    }
  });

  it('rejects unpublished statuses and records whose taxon has no trusted sensitivity entry', () => {
    const pending = fixture();
    try {
      pending.mutateTable(genusPath, table => { table.dictionaries.status = ['pending']; });
      expect(() => verifyPublicDirectory(pending.directory, pending.trusted)).toThrow();
    } finally { pending.cleanup(); }
    const unknown = fixture();
    try {
      unknown.mutateTable(genusPath, table => { table.dictionaries.taxon = ['M999999']; });
      expect(() => verifyPublicDirectory(unknown.directory, unknown.trusted)).toThrow('not trusted');
    } finally { unknown.cleanup(); }
  });

  it('scans unused dictionary entries and all nested keys/values before any schema can strip them', () => {
    for (const injected of ['secret@example.org', '50c9509d-22c7-4a22-a47d-8c48425ef4a7']) {
      const f = fixture();
      try {
        f.mutateTable('names.json', table => { table.dictionaries.name_ja?.push(injected); });
        expect(() => verifyPublicDirectory(f.directory, f.trusted)).toThrow(/Email|UUID/);
      } finally { f.cleanup(); }
    }
    const privateField = fixture();
    try {
      const original: unknown = JSON.parse(readFileSync(join(privateField.directory, 'names.json'), 'utf8'));
      privateField.json('names.json', { ...Object(original), nested: { submitted_by: 'not-even-a-uuid' } });
      privateField.rehash();
      expect(() => verifyPublicDirectory(privateField.directory, privateField.trusted)).toThrow('Private field');
    } finally { privateField.cleanup(); }
    const unknown = fixture();
    try {
      const original: unknown = JSON.parse(readFileSync(join(unknown.directory, 'names.json'), 'utf8'));
      unknown.json('names.json', { ...Object(original), nested: { harmless: 'still unknown' } }); unknown.rehash();
      expect(() => verifyPublicDirectory(unknown.directory, unknown.trusted)).toThrow();
    } finally { unknown.cleanup(); }
  });

  it('rejects unknown paths, symlinks and manifest changes that omit or mismatch actual files', () => {
    const unknown = fixture();
    try {
      unknown.json('hidden/private.json', { value: 'secret@example.org' }); unknown.rehash();
      expect(() => verifyPublicDirectory(unknown.directory, unknown.trusted)).toThrow('Unknown public output');
    } finally { unknown.cleanup(); }
    const symlink = fixture();
    try {
      mkdirSync(join(symlink.directory, 'photos'));
      symlinkSync(join(symlink.directory, 'names.json'), join(symlink.directory, 'photos/M999999.json'));
      expect(() => verifyPublicDirectory(symlink.directory, symlink.trusted)).toThrow('symlink');
    } finally { symlink.cleanup(); }
    const wrongHash = fixture();
    try {
      wrongHash.write('names.json', readFileSync(join(wrongHash.directory, 'names.json'), 'utf8') + ' ');
      expect(() => verifyPublicDirectory(wrongHash.directory, wrongHash.trusted)).toThrow('hash or size');
    } finally { wrongHash.cleanup(); }
    const unknownCode = fixture();
    try {
      unknownCode.table('photos/M999999.json', 'photos-v1', []); unknownCode.rehash();
      expect(() => verifyPublicDirectory(unknownCode.directory, unknownCode.trusted)).toThrow('unknown taxon');
    } finally { unknownCode.cleanup(); }
  });

  it('checks decompressed CSV privacy and sensitivity even after the attacker recomputes manifest hashes', () => {
    const cases: { sensitivity: number; change: Partial<Record<string, Scalar>> }[] = [
      { sensitivity: 0, change: { status: 'rejected' } },
      { sensitivity: 0, change: { note: 'hidden@example.org' } },
      { sensitivity: 0, change: { note: 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c' } },
      { sensitivity: 1, change: { locality_verbatim: 'sensitive site' } },
    ];
    for (const test of cases) {
      const f = fixture(test.sensitivity);
      try {
        f.write(csvPath, gzipSync(csv([mergeRecord(f.publicRecord, test.change)]))); f.rehash();
        expect(() => verifyPublicDirectory(f.directory, f.trusted)).toThrow();
      } finally { f.cleanup(); }
    }
  });

  it('rejects unneutralized formula text, including whitespace-prefixed formulas, without rejecting safe apostrophes', () => {
    for (const value of ['=1+1', '+1', '-cmd', '@command', '\tcommand', ' \uFEFF =1+1']) {
      const f = fixture(0, { note: value });
      try {
        expect(verifyPublicDirectory(f.directory, f.trusted).records).toBe(1);
        f.write(csvPath, gzipSync(csv([f.publicRecord], false))); f.rehash();
        expect(() => verifyPublicDirectory(f.directory, f.trusted)).toThrow('formula-leading');
      } finally { f.cleanup(); }
    }
    const apostrophe = fixture(0, { note: "'=literal" });
    try { expect(verifyPublicDirectory(apostrophe.directory, apostrophe.trusted).records).toBe(1); }
    finally { apostrophe.cleanup(); }
  });

  it('requires CSV/JSON consistency and rejects malformed CSV columns and compressed output bombs', () => {
    const mismatch = fixture();
    try {
      mismatch.write(csvPath, gzipSync(csv([{ ...mismatch.publicRecord, note: 'changed only in CSV' }]))); mismatch.rehash();
      expect(() => verifyPublicDirectory(mismatch.directory, mismatch.trusted)).toThrow('does not match');
      mismatch.write(csvPath, gzipSync(gunzipSync(readFileSync(join(mismatch.directory, csvPath))).toString().replace('record_code', 'private_id')));
      mismatch.rehash();
      expect(() => verifyPublicDirectory(mismatch.directory, mismatch.trusted)).toThrow('CSV columns');
    } finally { mismatch.cleanup(); }
    const bomb = fixture();
    try {
      bomb.write(csvPath, gzipSync('x'.repeat(8 * 1024 * 1024 + 1))); bomb.rehash();
      expect(() => verifyPublicDirectory(bomb.directory, bomb.trusted)).toThrow();
      expect(() => verifyPublicDirectory(bomb.directory, bomb.trusted, { maxBytes: 8 * 1024 * 1024 + 1 })).toThrow();
    } finally { bomb.cleanup(); }
  });

  it('uses the private region hierarchy to reject sensitive island records, island matrix cells and public hierarchy forgery', () => {
    const islandRegions = new Map<string, TrustedPublicRegion>([
      ...trustedRegions, ['IS0001', { regionType: 'island', parent: 'PR01' }],
    ]);
    function addIsland(f: ReturnType<typeof fixture>) {
      f.table('regions.json', 'regions-v1', [
        { region: 'PR01', region_type: 'prefecture', name_ja: '北海道', name_en: 'Hokkaido',
          parent: null, area_group: null, sort_order: 1 },
        { region: 'IS0001', region_type: 'island', name_ja: '試験島', name_en: 'Test Island',
          parent: 'PR01', area_group: null, sort_order: 2 },
      ]);
      f.counts.regions = 2; f.writeNational(); f.rehash();
    }
    const recordIsland = fixture(1);
    try {
      addIsland(recordIsland);
      expect(verifyPublicDirectory(recordIsland.directory, recordIsland.trusted, { trustedRegions: islandRegions }).records).toBe(1);
      recordIsland.table(genusPath, 'records-v1', [{ ...recordIsland.publicRecord, island: 'IS0001' }]);
      recordIsland.rehash();
      expect(() => verifyPublicDirectory(recordIsland.directory, recordIsland.trusted, { trustedRegions: islandRegions }))
        .toThrow('island region');
    } finally { recordIsland.cleanup(); }
    for (const sensitivity of [1, 2]) {
      const matrixIsland = fixture(sensitivity);
      try {
        addIsland(matrixIsland);
        matrixIsland.table('summary/matrix.json', 'matrix-v1', [{ taxon: code, region: 'IS0001', evidence: 1, discovery: false }]);
        matrixIsland.rehash();
        expect(() => verifyPublicDirectory(matrixIsland.directory, matrixIsland.trusted, { trustedRegions: islandRegions }))
          .toThrow('Sensitive matrix');
      } finally { matrixIsland.cleanup(); }
    }
    const forged = fixture(1);
    try {
      addIsland(forged);
      forged.mutateTable('regions.json', table => { table.dictionaries.region_type = ['prefecture', 'prefecture']; });
      expect(() => verifyPublicDirectory(forged.directory, forged.trusted, { trustedRegions: islandRegions })).toThrow('private source');
    } finally { forged.cleanup(); }
  });

  it('does not expose observation links or images for sensitivity 1 or 2 taxa', () => {
    for (const sensitivity of [1, 2]) {
      const f = fixture(sensitivity);
      try {
        f.table('photos/' + code + '.json', 'photos-v1', [{
          taxon: code, observation_url: 'https://www.inaturalist.org/observations/123',
          image_url: 'https://static.inaturalist.org/photos/123/square.jpg', license_code: 'cc-by',
          attribution: 'Example photographer', life_stage: null,
        }]);
        f.rehash();
        expect(() => verifyPublicDirectory(f.directory, f.trusted)).toThrow('Sensitive taxon');
      } finally { f.cleanup(); }
    }
  });
});
