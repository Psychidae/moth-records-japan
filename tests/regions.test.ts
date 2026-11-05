import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRegionImport } from '../pipelines/regions/src/import.js';
import { createTestDatabase } from './helpers/database.js';

const result = buildRegionImport();
const sourceFiles = ['prefectures.csv', 'islands.csv', 'other_regions.csv', 'adjacency.csv'];
function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'moth-region-seeds-'));
  for (const filename of sourceFiles) writeFileSync(join(directory, filename), readFileSync(join('seed', filename)));
  return directory;
}

describe('region seed evidence and validation', () => {
  it('retains all 47 verified prefecture IDs and separate island/South Kurils units', () => {
    expect(result.report.counts).toEqual({ prefectures: 47, islands: 90, other: 1, regions: 138, adjacencyEdges: 174 });
    const prefectures = result.regions.filter(region => region.regionType === 'prefecture');
    expect(prefectures.map(region => region.code)).toEqual(Array.from({ length: 47 }, (_, index) => `PR${String(index + 1).padStart(2, '0')}`));
    expect(new Set(prefectures.map(region => region.gadmGid)).size).toBe(47);
    expect(new Set(prefectures.map(region => region.inatPlaceId)).size).toBe(47);
    expect(prefectures.every(region => region.gadmGid !== null && region.inatPlaceId !== null)).toBe(true);
    expect(result.regions.find(region => region.code === 'PR42')).toMatchObject({ nameJa: '長崎県', gadmGid: 'JPN.27_1', inatPlaceId: 13080 });
    expect(result.regions.find(region => region.code === 'OT01')).toMatchObject({ regionType: 'other', nameJa: '南千島', parentCode: null, gadmGid: null, inatPlaceId: null });
    expect(createHash('sha256').update(readFileSync('seed/prefectures.csv')).digest('hex'))
      .toBe('50915fe153d5c10f98209314d227330b66ec9ab8bbf3bd97fa2fb2c30e915b93');
    expect(result.report.warnings.join('\n')).toContain('Naoasaki');
  });

  it('covers the specified island groups with source URLs and valid prefecture parents', () => {
    const islands = result.regions.filter(region => region.regionType === 'island');
    const names = new Set(islands.map(region => region.nameJa));
    for (const name of ['利尻島', '礼文島', '奥尻島', '佐渡島', '島後', '西ノ島', '中ノ島', '知夫里島', '壱岐島', '対馬',
      '福江島', '久賀島', '奈留島', '若松島', '中通島', '上甑島', '中甑島', '下甑島', '種子島', '屋久島',
      '口之島', '宝島', '奄美大島', '徳之島', '沖永良部島', '与論島', '沖縄島', '久米島', '宮古島', '石垣島',
      '西表島', '与那国島', '北大東島', '南大東島', '沖大東島', '大島', '八丈島', '青ヶ島', '父島', '母島',
      '聟島', '硫黄島', '南鳥島', '沖ノ鳥島']) expect(names.has(name), name).toBe(true);
    expect(islands.filter(region => region.areaGroup === 'izu')).toHaveLength(11);
    expect(islands.filter(region => region.areaGroup === 'ogasawara')).toHaveLength(22);
    for (const island of islands) {
      expect(result.regions.find(region => region.code === island.parentCode)?.regionType).toBe('prefecture');
      expect(island.sourceUrl).toMatch(/^https:\/\//);
      expect(island.gadmGid).toBeNull();
      expect(island.inatPlaceId).toBeNull();
    }
    expect(buildRegionImport().sql).toBe(result.sql);
    for (const source of result.report.sources) {
      expect(source.sha256).toBe(createHash('sha256').update(readFileSync(join('seed', source.filename))).digest('hex'));
    }
  });

  it('uses symmetric shared-land prefecture borders, including island boundary exceptions', () => {
    const edges = new Set(result.adjacency.map(edge => `${edge.regionCode}:${edge.neighborCode}`));
    expect(edges.size).toBe(174);
    for (const edge of result.adjacency) {
      expect(edge.regionCode).not.toBe(edge.neighborCode);
      expect(edges.has(`${edge.neighborCode}:${edge.regionCode}`)).toBe(true);
    }
    const neighbors = (code: string) => result.adjacency.filter(edge => edge.regionCode === code).map(edge => edge.neighborCode).sort();
    expect(neighbors('PR20')).toEqual(['PR10', 'PR11', 'PR15', 'PR16', 'PR19', 'PR21', 'PR22', 'PR23']);
    expect(neighbors('PR01')).toEqual([]);
    expect(neighbors('PR47')).toEqual([]);
    for (const key of ['PR33:PR37', 'PR34:PR38', 'PR24:PR26']) expect(edges.has(key)).toBe(true);
    for (const key of ['PR01:PR02', 'PR35:PR40', 'PR28:PR36', 'PR30:PR36', 'PR14:PR12']) expect(edges.has(key)).toBe(false);
  });

  it('rejects absent/duplicate IDs, invalid parents and asymmetric/self/duplicate adjacency', () => {
    const cases: { filename: string; change: (source: string) => string }[] = [
      { filename: 'prefectures.csv', change: source => source.replace('13078', '') },
      { filename: 'prefectures.csv', change: source => source.replace('JPN.3_1', 'JPN.12_1') },
      { filename: 'islands.csv', change: source => source.replace(',PR01,', ',PR99,') },
      { filename: 'other_regions.csv', change: source => source.replace('Southern Kuril Islands,,', 'Southern Kuril Islands,PR01,') },
      { filename: 'adjacency.csv', change: source => source.replace('PR02,PR03\n', '') },
      { filename: 'adjacency.csv', change: source => `${source}PR02,PR03\n` },
      { filename: 'adjacency.csv', change: source => `${source}PR02,PR02\n` },
      { filename: 'adjacency.csv', change: source => source.replace('PR02,PR03', 'PR02,PR99') },
    ];
    for (const sample of cases) {
      const directory = fixtureDirectory();
      try {
        const path = join(directory, sample.filename);
        writeFileSync(path, sample.change(readFileSync(path, 'utf8')));
        expect(() => buildRegionImport(directory), sample.filename).toThrow();
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
});

describe('region SQL and provenance permissions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDatabase();
    for (const filename of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join('supabase/migrations', filename), 'utf8'));
    }
    await db.exec(result.sql);
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });

  it('loads 138 regions, preserves both external prefecture IDs and keeps island coordinates unknown', async () => {
    expect((await db.query('select region_type,count(*)::int as count from public.regions group by region_type order by region_type')).rows)
      .toEqual([{ region_type: 'island', count: 90 }, { region_type: 'other', count: 1 }, { region_type: 'prefecture', count: 47 }]);
    expect((await db.query("select count(*)::int as count from public.regions where region_type='prefecture' and (gadm_gid is null or inat_place_id is null)")).rows).toEqual([{ count: 0 }]);
    expect((await db.query(`select count(*)::int as count from public.regions i left join public.regions p on p.id=i.parent_id
      where i.region_type='island' and (p.region_type is distinct from 'prefecture' or i.lat is not null or i.lon is not null)`)).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select region_type,parent_id from public.regions where code='OT01'")).rows).toEqual([{ region_type: 'other', parent_id: null }]);
  });

  it('replays without changing permanent IDs or overwriting administrator edits', async () => {
    const before = await db.query('select id,code from public.regions order by code');
    await db.exec("update public.regions set name_ja='管理者の表記',sort_order=999 where code='IS0001'");
    await db.exec(result.sql);
    expect((await db.query('select id,code from public.regions order by code')).rows).toEqual(before.rows);
    expect((await db.query("select name_ja,sort_order from public.regions where code='IS0001'")).rows).toEqual([{ name_ja: '管理者の表記', sort_order: 999 }]);
  });

  it('stops atomically when a CSV tries to reuse an existing island code for a different source identity', async () => {
    const directory = fixtureDirectory();
    try {
      const path = join(directory, 'islands.csv');
      writeFileSync(path, readFileSync(path, 'utf8').replace('利尻島', '別の島'));
      const changed = buildRegionImport(directory);
      await expect(db.exec(changed.sql)).rejects.toThrow(/identity conflict/);
      await db.exec('rollback');
      expect((await db.query('select count(*)::int as count from public.regions')).rows).toEqual([{ count: 138 }]);
      expect((await db.query("select name_ja from public.regions where code='IS0001'")).rows).toEqual([{ name_ja: '管理者の表記' }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps region provenance read-only to users and rejects partial nullable provenance', async () => {
    expect((await db.query(`select has_table_privilege('authenticated','public.regions','SELECT') as can_read,
      has_column_privilege('authenticated','public.regions','seed_source','INSERT') as source_insert,
      has_column_privilege('authenticated','public.regions','seed_key','UPDATE') as key_update,
      has_table_privilege('anon','public.regions','SELECT') as anon_read`)).rows)
      .toEqual([{ can_read: true, source_insert: false, key_update: false, anon_read: false }]);
    await expect(db.exec(`insert into public.regions(code,region_type,name_ja,name_en,seed_source)
      values ('OT99','other','不完全','Incomplete','seed:islands.csv')`)).rejects.toThrow(/regions_seed_identity_check/);
    expect((await db.query("select count(*)::int as count from pg_tables where schemaname='public' and not rowsecurity")).rows).toEqual([{ count: 0 }]);
  });
});
