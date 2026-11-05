import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildListMjImport } from '../pipelines/import-listmj/src/import.js';
import { buildListMjAnnotations } from '../pipelines/import-listmj/src/annotations.js';
import { createTestDatabase } from './helpers/database.js';

const taxonomy = buildListMjImport();
const result = buildListMjAnnotations();

describe('List-MJ source notes and references', () => {
  it('preserves all 975 notes and all 281 actual citations and exposes the specification discrepancy', () => {
    expect(result.notes).toHaveLength(975);
    expect(result.references).toHaveLength(281);
    expect(result.report.counts.notes).toBe(975);
    expect(result.report.counts.references).toBe(281);
    expect(result.report.acceptance).toEqual({ expectedNotes: 975, expectedReferences: 282, passed: false });
    expect(result.report.counts.parsedReferences + result.report.counts.partialReferences + result.report.counts.unparsedReferences).toBe(281);
    expect(new Set(result.notes.map(note => note.sourceItem)).size).toBe(975);
    expect(new Set(result.references.map(reference => reference.sourceItem)).size).toBe(281);
    expect(result.references.some(reference => reference.refCode === 'R000282')).toBe(false);
    expect(result.report.sourceDiscrepancies).toEqual(expect.arrayContaining([
      expect.objectContaining({ expected: 282, actual: 281, passed: false }),
    ]));
    expect(result.notes.every(note => note.note.length > 0 && note.rawHtml.length > 0)).toBe(true);
    expect(result.report.alignment.unresolvedNotes).toEqual([]);
    expect(result.notes.every(note => note.mappingStatus === 'matched' && note.taxonCode !== null && note.sourceRow !== null)).toBe(true);
    expect(result.references.every(reference => reference.title.length > 0 && reference.rawHtml.length > 0)).toBe(true);
    for (const reference of result.references.filter(reference => reference.parseStatus !== 'parsed')) {
      expect(result.report.unparsedReferences).toContainEqual(expect.objectContaining({ sourceItem: reference.sourceItem, refCode: reference.refCode }));
    }
    expect(result.report.source).toMatchObject({
      listHtmlSha256: '98c38adfdc72f5eda05ec37fefb818023123249cd743c4ff3c3b25e278ac1028',
      refsHtmlSha256: '8db7b2532194d617367f769ae426c937ae7fedd41bf27088ea39a7e75e6d928b',
    });
  });

  it('binds notes to the actual preceding species block and reports missing HTML entries', () => {
    expect(result.report.counts.speciesBlocks).toBe(6626);
    expect(result.report.alignment.skippedSpeciesRows).toEqual([2871, 5962]);
    expect(result.notes[0]).toMatchObject({ taxonCode: 'M000004', sourceRow: 5 });
    expect(result.notes[0]?.note).toContain('Imada & Kato, 2018');
    expect(result.report.alignment.speciesMappings).toContainEqual(expect.objectContaining({ sourceRow: 371, taxonCode: 'M000370' }));
    expect(result.report.alignment.speciesMappings).toContainEqual(expect.objectContaining({ sourceRow: 392, taxonCode: 'M000391' }));
    expect(result.notes.filter(note => [371, 392, 2753, 2770, 2870, 2871, 5961, 5962].includes(note.sourceRow ?? -1))).toHaveLength(0);
    const blocks = new Map(result.report.alignment.speciesMappings.map(mapping => [mapping.speciesBlock, mapping]));
    for (const note of result.notes.filter(note => note.taxonCode !== null)) {
      expect(taxonomy.taxa.find(taxon => taxon.taxonCode === note.taxonCode)?.rank).toBe('species');
      expect(blocks.get(note.speciesBlock ?? -1)).toMatchObject({ taxonCode: note.taxonCode, sourceRow: note.sourceRow, mappingStatus: 'matched' });
    }
    expect(buildListMjAnnotations().sql).toBe(result.sql);
  });

  it('keeps citation text intact while parsing author/year/journal conservatively', () => {
    expect(result.references[0]).toMatchObject({ sourceItem: 1, refCode: 'R000001', year: 2014 });
    expect(result.references[0]?.title).toContain('Ahn N.-H., Murase M., Arita Y., Hirowatari T., 2014.');
    expect(result.references[0]?.title).toContain('Proleucoptera');
    expect(result.references[0]?.rawHtml).toContain('<i>Proleucoptera</i>');
    expect(result.references[0]?.authors).toContain('Ahn');
    expect(result.references[0]?.containerTitle).toBe('Lepidoptera Science');
    expect(result.references[0]?.volume).toBe('65');
    expect(result.references[0]?.pages).toBe('137–141');
    expect(result.references.find(reference => reference.title.startsWith('Buchner,') && reference.title.includes('2019a.'))?.yearText).toBe('2019a');
  });

  it('rejects changed HTML rather than silently treating a different source as the snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moth-listmj-html-'));
    try {
      cpSync('seed/source', directory, { recursive: true });
      for (const filename of ['list.html', 'refs.html']) {
        writeFileSync(join(directory, filename), '<li>changed source</li>');
        expect(() => buildListMjAnnotations(directory)).toThrow(/sha|hash|checksum/i);
        cpSync(join('seed/source', filename), join(directory, filename));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('List-MJ annotations SQL and protected source provenance', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDatabase();
    for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join('supabase/migrations', file), 'utf8'));
    }
    await db.exec(taxonomy.sql);
    await db.exec(result.sql);
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });

  it('stores exact source items, status annotations and pending citations', async () => {
    expect((await db.query('select count(*)::int as count from public.taxon_changes')).rows).toEqual([{ count: 975 }]);
    expect((await db.query("select count(*)::int as count from public.taxon_changes where change_type<>'status' or source_raw is null")).rows).toEqual([{ count: 0 }]);
    expect((await db.query('select count(*)::int as count from public.taxon_changes where from_taxon_id is null')).rows).toEqual([{ count: 0 }]);
    expect((await db.query('select status,count(*)::int as count from public.references_ group by status')).rows).toEqual([{ status: 'pending', count: 281 }]);
    const originals = await db.query('select title,source_raw from public.references_ order by source_item');
    expect(originals.rows).toEqual(result.references.map(reference => ({ title: reference.title, source_raw: reference.rawHtml })));
  });

  it('replays without duplicating items or overwriting reviewer-edited display text', async () => {
    const before = await db.query('select id,source_item from public.taxon_changes order by source_item');
    const refsBefore = await db.query('select id,ref_code from public.references_ order by ref_code');
    await db.exec("update public.references_ set title='審査者が修正した書誌' where ref_code='R000001'");
    await db.exec(result.sql);
    expect((await db.query('select id,source_item from public.taxon_changes order by source_item')).rows).toEqual(before.rows);
    expect((await db.query('select id,ref_code from public.references_ order by ref_code')).rows).toEqual(refsBefore.rows);
    expect((await db.query("select title from public.references_ where ref_code='R000001'")).rows).toEqual([{ title: '審査者が修正した書誌' }]);
  }, 60000);

  it('protects imported evidence columns while preserving normal submission fields', async () => {
    expect((await db.query(`select has_column_privilege('authenticated','public.references_','source_raw','INSERT') as source_insert,
      has_column_privilege('authenticated','public.references_','source_item','UPDATE') as source_update,
      has_column_privilege('authenticated','public.references_','title','INSERT') as title_insert,
      has_column_privilege('authenticated','public.references_','title','UPDATE') as title_update`)).rows)
      .toEqual([{ source_insert: false, source_update: false, title_insert: true, title_update: true }]);
    const user = 'f0060000-0000-0000-0000-000000000005';
    await db.exec(`insert into auth.users(id) values ('${user}'); insert into public.profiles(id,display_name) values ('${user}','注釈テスト');
      insert into public.references_(ref_code,ref_type,title,status,submitted_by) values ('R900001','article','通常投稿','pending','${user}')`);
    for (const statement of [
      "update public.references_ set source_item=1 where ref_code='R900001'",
      `insert into public.references_(ref_code,ref_type,title,status,submitted_by,source_raw)
        values ('R900002','article','偽装','pending','${user}','forged')`,
    ]) {
      await db.exec('begin');
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: 'aal1' })]);
      await db.exec('set local role authenticated');
      try { await expect(db.exec(statement)).rejects.toThrow(/permission denied/); }
      finally { await db.exec('rollback'); }
    }
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: 'aal1' })]);
    await db.exec('set local role authenticated');
    try {
      expect((await db.query("update public.references_ set title='修正' where ref_code='R900001' returning title")).rows).toEqual([{ title: '修正' }]);
    } finally { await db.exec('rollback'); }
  });

  it('rejects partial provenance even when nullable CHECK expressions could otherwise pass', async () => {
    await expect(db.exec("insert into public.taxon_changes(change_type,source) values ('status','listmj:list.html')")).rejects.toThrow(/taxon_changes_source_item_check/);
    await expect(db.exec("insert into public.references_(ref_code,ref_type,title,source_item) values ('R900003','article','不完全',1)")).rejects.toThrow(/references_source_item_check/);
  });
});
