import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildListMjImport } from '../pipelines/import-listmj/src/import.js';
import { createTestDatabase } from './helpers/database.js';
import { asSupabaseSeedSql } from '../scripts/prepare-supabase-seed.js';

const result = buildListMjImport();
const taxaByCode = new Map(result.taxa.map(taxon => [taxon.taxonCode, taxon]));
const taxaBySourceRow = new Map(result.taxa.filter(taxon => ['species', 'subspecies'].includes(taxon.rank)).map(taxon => [taxon.sourceRow, taxon]));
const sourceTaxon = (row: number) => taxaBySourceRow.get(row);

describe('List-MJ offline import and provenance', () => {
  it('matches every required acceptance number and reports species-only status differences', () => {
    expect(result.report.counts).toEqual({
      dataRows: 7465, species: 6628, subspecies: 837, nominotypicalSubspecies: 299,
      unidentifiedSpeciesEpithets: 338, collisionGroups: 4, families: 88, parentlessSubspecies: 0,
    });
    expect(result.report.speciesStatuses).toEqual({ accepted: 6183, unidentified: 335, south_kuril: 59, doubtful: 28, excluded: 23 });
    expect(result.report.siteStatusDiscrepancy).toBeDefined();
    expect(result.report.source).toBeDefined();
  });

  it('retains every original row and all raw fields, and allocates row codes before upper ranks', () => {
    const raw: unknown[] = readFileSync('seed/source/listmj3_210603_rows.jsonl', 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as unknown);
    expect(result.rows).toEqual(raw);
    for (let index = 0; index < 7465; index++) {
      const taxon = sourceTaxon(index + 2);
      expect(taxon?.taxonCode).toBe(`M${String(index + 1).padStart(6, '0')}`);
      expect(['species', 'subspecies']).toContain(taxon?.rank);
    }
    expect(result.taxa.filter(taxon => !['species', 'subspecies'].includes(taxon.rank))
      .every(taxon => Number(taxon.taxonCode.slice(1)) > 7465)).toBe(true);
    expect(buildListMjImport().sql).toBe(result.sql);
  });

  it('preserves four separate name-collision pairs with their original identities', () => {
    expect(result.report.collisionGroups.map(group => group.rows).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)))
      .toEqual([[371, 392], [2753, 2770], [2870, 2871], [5961, 5962]]);
    for (const group of result.report.collisionGroups) {
      expect(group.taxonCodes).toHaveLength(2);
      expect(new Set(group.taxonCodes).size).toBe(2);
      for (const row of group.rows) expect(sourceTaxon(row)?.isNameCollision).toBe(true);
    }
    expect(sourceTaxon(371)?.nameJa).toBe('ウスバハルノミノガ');
    expect(sourceTaxon(392)?.nameJa).toBe('ドイミノガ');
  });

  it('keeps genus-unidentified taxa attached above genus and assigns every subspecies to a species', () => {
    expect(result.taxa.filter(taxon => taxon.rank === 'genus').some(taxon => /Gen\.$/.test(taxon.scientificName))).toBe(false);
    for (const row of [348, 1038, 1390, 2831]) {
      const taxon = sourceTaxon(row);
      const parent = taxon?.parentCode ? taxaByCode.get(taxon.parentCode) : undefined;
      expect(parent).toBeDefined();
      expect(['family', 'subfamily', 'tribe', 'subtribe']).toContain(parent?.rank);
    }
    for (const taxon of result.taxa.filter(taxon => taxon.rank === 'subspecies')) {
      expect(taxon.parentCode).toBeTruthy();
      expect(taxaByCode.get(taxon.parentCode ?? '')?.rank).toBe('species');
    }
  });

  it('cleans the documented HTML defect while preserving author, year and Japanese names', () => {
    expect(sourceTaxon(3950)).toMatchObject({ scientificName: 'Euparyphasma maximum', authorship: '(Leech)', publicationYear: '[1889]' });
    expect(sourceTaxon(6386)?.publicationYear).toBe('[1763]');
    expect(sourceTaxon(2554)?.publicationYear).toBe('[1796-99]');
    expect(sourceTaxon(1023)?.publicationYear).toBe('2020 [2021]');
    expect(result.names).toContainEqual(expect.objectContaining({ taxonCode: sourceTaxon(9)?.taxonCode, name: 'シロウマヒロコバネ', nameType: 'ja_alias' }));
    expect(result.names).toContainEqual(expect.objectContaining({ taxonCode: sourceTaxon(1469)?.taxonCode, name: 'クリイガモグリキバガ', nameType: 'ja_other' }));
    expect(result.names.filter(name => name.nameType === 'ja_other').every(name => !/[\[\]，]/.test(name.name))).toBe(true);
    expect(result.taxa.some(taxon => taxon.rank === 'subspecies' && / ssp\.$/.test(taxon.scientificName))).toBe(true);
  });

  it('rejects changed source bytes before generating import SQL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moth-listmj-source-'));
    try {
      cpSync('seed/source', directory, { recursive: true });
      writeFileSync(join(directory, 'listmj3_210603_rows.jsonl'), 'invalid input\n');
      expect(() => buildListMjImport(directory)).toThrow(/hash|sha|checksum/i);
      cpSync('seed/source/listmj3_210603_rows.jsonl', join(directory, 'listmj3_210603_rows.jsonl'));
      writeFileSync(join(directory, 'ListMJ3-210603DL.xlsx'), 'invalid workbook');
      expect(() => buildListMjImport(directory)).toThrow(/hash|sha|checksum|size/i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('List-MJ import SQL on a real local PostgreSQL engine', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDatabase();
    for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join('supabase/migrations', file), 'utf8'));
    }
    await db.exec(readFileSync('supabase/seed.sql', 'utf8'));
    await db.exec(asSupabaseSeedSql(result.sql));
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });

  it('loads all original rows, taxonomy parents and names without bypassing RLS', async () => {
    expect((await db.query(`select rank, count(*)::int as count from public.taxa
      where rank in ('species','subspecies','family') group by rank order by rank`)).rows)
      .toEqual([{ rank: 'family', count: 88 }, { rank: 'species', count: 6628 }, { rank: 'subspecies', count: 837 }]);
    expect((await db.query('select count(*)::int as count from public.listmj_rows')).rows).toEqual([{ count: 7465 }]);
    expect((await db.query(`select count(*)::int as count from public.taxa child left join public.taxa parent on parent.id=child.parent_id
      where child.rank='subspecies' and (parent.id is null or parent.rank<>'species')`)).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select count(*)::int as count from pg_tables where schemaname='public' and not rowsecurity")).rows).toEqual([{ count: 0 }]);
    expect((await db.query('select count(*)::int as count from public.taxon_names')).rows).toEqual([{ count: result.names.length }]);
  });

  it('reimports with stable IDs/codes and preserves administrator decisions', async () => {
    const before = await db.query('select id,taxon_code from public.taxa order by taxon_code');
    const namesBefore = await db.query('select id from public.taxon_names order by id');
    await db.exec("update public.taxa set sensitivity=1, name_ja='管理者が追記' where taxon_code='M000001'");
    await db.exec(result.sql);
    expect((await db.query('select id,taxon_code from public.taxa order by taxon_code')).rows).toEqual(before.rows);
    expect((await db.query('select id from public.taxon_names order by id')).rows).toEqual(namesBefore.rows);
    expect((await db.query("select sensitivity,name_ja from public.taxa where taxon_code='M000001'")).rows).toEqual([{ sensitivity: 1, name_ja: '管理者が追記' }]);
  }, 60000);

  it('stops atomically instead of reusing a code already assigned to an unrelated taxon', async () => {
    const conflicting = await createTestDatabase();
    try {
      for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
        await conflicting.exec(readFileSync(join('supabase/migrations', file), 'utf8'));
      }
      await conflicting.exec("insert into public.taxa(taxon_code,rank,scientific_name) values ('M000001','species','Unrelated prior assignment')");
      await expect(conflicting.exec(result.sql)).rejects.toThrow(/taxon|code|conflict|identity/i);
      await conflicting.exec('rollback');
      expect((await conflicting.query('select taxon_code,scientific_name from public.taxa')).rows)
        .toEqual([{ taxon_code: 'M000001', scientific_name: 'Unrelated prior assignment' }]);
      expect((await conflicting.query('select count(*)::int as count from public.listmj_rows')).rows).toEqual([{ count: 0 }]);
      expect((await conflicting.query('select count(*)::int as count from public.taxon_names')).rows).toEqual([{ count: 0 }]);
      expect((await conflicting.query('select count(*)::int as count from public.backbone_versions')).rows).toEqual([{ count: 0 }]);
    } finally { await conflicting.close(); }
  }, 60000);

  it('keeps the CLI seed adapter atomic and refuses ambiguous wrappers', () => {
    const adapted = asSupabaseSeedSql(result.sql);
    expect(adapted.startsWith('do $supabase_seed$ begin execute $supabase_seed_body$')).toBe(true);
    expect(adapted).not.toMatch(/^begin;|^commit;/m);
    expect(() => asSupabaseSeedSql('select 1;')).toThrow(/transaction/);
    expect(() => asSupabaseSeedSql('begin;\nbegin;\ncommit;')).toThrow(/transaction/);
    expect(() => asSupabaseSeedSql('begin;\nselect $supabase_seed_body$x$supabase_seed_body$;\ncommit;')).toThrow(/delimiter/);
  });
});
