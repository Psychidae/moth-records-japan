import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/database.js';

function snapshot() {
  return {
    source: 'inaturalist',
    fetchedAt: '2026-11-06T00:00:00.000Z',
    queryNote: JSON.stringify({ endpoint: '/v1/observations/species_counts', taxon_id: 47157, without_taxon_id: 47224, photos_collected: true }),
    citation: 'iNaturalist species counts',
    doi: null,
    mappings: [{ taxonCode: 'M900001', externalId: 123 }],
    summaries: [{ taxonCode: 'M900001', regionCode: 'PR01', evidence: 'photo_rg', count: 7 }],
    photos: [{
      taxonCode: 'M900001', observationUrl: 'https://www.inaturalist.org/observations/1234',
      imageUrl: 'https://static.inaturalist.org/photos/1234/square.jpg', licenseCode: 'cc-by',
      attribution: 'Example photographer (CC BY)', lifeStage: null,
    }],
  };
}

describe('atomic external snapshot RPC', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDatabase();
    // Hosted Supabase also grants functions directly to API roles by default.
    // Revoking PUBLIC alone must not be enough for this RPC to pass the test.
    await db.exec('alter default privileges in schema public grant execute on functions to anon, authenticated, service_role');
    for (const filename of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join('supabase/migrations', filename), 'utf8'));
    }
    await db.exec(`
      insert into public.taxa(taxon_code,rank,scientific_name,is_name_collision) values
        ('M900001','species','Example first',false),
        ('M900002','species','Example second',false),
        ('M900003','species','Example collision',true),
        ('M900004','genus','Example',false);
      insert into public.regions(code,region_type,name_ja,name_en) values
        ('PR01','prefecture','北海道','Hokkaido'),('IS9001','island','試験島','Test Island');
    `);
  }, 60000);
  afterAll(async () => { if (db) await db.close(); });

  async function serviceRun(run: () => Promise<void>) {
    await db.exec('begin; set local role service_role');
    try { await run(); } finally { await db.exec('rollback'); }
  }
  const ingest = (payload: unknown) => db.query<{ id: string }>(
    'select public.ingest_external_snapshot($1::jsonb)::text as id', [JSON.stringify(payload)],
  );

  it('allows only the service role to call an invoker function and keeps the new column private', async () => {
    expect((await db.query(`select
      has_function_privilege('anon','public.ingest_external_snapshot(jsonb)','EXECUTE') as anon_execute,
      has_function_privilege('authenticated','public.ingest_external_snapshot(jsonb)','EXECUTE') as user_execute,
      has_function_privilege('service_role','public.ingest_external_snapshot(jsonb)','EXECUTE') as service_execute,
      has_column_privilege('authenticated','public.external_snapshots','payload_digest','INSERT') as user_insert,
      has_column_privilege('authenticated','public.external_snapshots','payload_digest','UPDATE') as user_update,
      p.prosecdef as definer, p.proconfig @> array['search_path=""']::text[] as fixed_path
      from pg_proc p where p.oid='public.ingest_external_snapshot(jsonb)'::regprocedure`)).rows)
      .toEqual([{ anon_execute: false, user_execute: false, service_execute: true,
        user_insert: false, user_update: false, definer: false, fixed_path: true }]);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`begin; set local role ${role}`);
      try { await expect(ingest(snapshot())).rejects.toThrow(/permission denied/); }
      finally { await db.exec('rollback'); }
    }
    expect((await db.query("select count(*)::int as count from pg_tables where schemaname='public' and not rowsecurity")).rows)
      .toEqual([{ count: 0 }]);
  });

  it('atomically saves mappings, private provenance, counts and licensed photos with exact replay idempotency', async () => {
    await serviceRun(async () => {
      const first = await ingest(snapshot());
      const auditBefore = await db.query('select count(*)::int as count from public.audit_log');
      expect((await ingest(snapshot())).rows).toEqual(first.rows);
      expect((await db.query('select count(*)::int as count from public.audit_log')).rows).toEqual(auditBefore.rows);
      expect((await db.query(`select s.source,s.doi,s.query_note,c.occurrence_count,c.evidence,t.inat_taxon_id::int as external_id
        from public.external_snapshots s join public.occurrence_summaries c on c.snapshot_id=s.id
        join public.taxa t on t.id=c.taxon_id`)).rows)
        .toEqual([{ source: 'inaturalist', doi: null, query_note: snapshot().queryNote,
          occurrence_count: 7, evidence: 'photo_rg', external_id: 123 }]);
      expect((await db.query('select license_code,attribution from public.external_photos')).rows)
        .toEqual([{ license_code: 'cc-by', attribution: 'Example photographer (CC BY)' }]);
      expect((await db.query('select count(*)::int as count from public.external_snapshots')).rows).toEqual([{ count: 1 }]);
    });
  });

  it('stores the GBIF DOI and exact request while keeping provider mappings separate', async () => {
    await serviceRun(async () => {
      const payload = { ...snapshot(), source: 'gbif', doi: '10.15468/dl.example', photos: [],
        queryNote: JSON.stringify({ format: 'DWCA', checklistKey: 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c', predicate: { type: 'equals', key: 'COUNTRY', value: 'JP' } }),
        mappings: [{ taxonCode: 'M900001', externalId: 10378476 }],
        summaries: [{ taxonCode: 'M900001', regionCode: 'PR01', evidence: 'specimen', count: 3 }],
      };
      await ingest(payload);
      expect((await db.query('select source,doi,query_note from public.external_snapshots')).rows)
        .toEqual([{ source: 'gbif', doi: '10.15468/dl.example', query_note: payload.queryNote }]);
      expect((await db.query("select gbif_usage_key::int as gbif,inat_taxon_id from public.taxa where taxon_code='M900001'")).rows)
        .toEqual([{ gbif: 10378476, inat_taxon_id: null }]);
    });
  });

  it('rolls back all preceding mapping writes if a later taxon, region or identity is unmatched', async () => {
    const invalids: unknown[] = [
      { ...snapshot(), mappings: [...snapshot().mappings, { taxonCode: 'M999999', externalId: 456 }] },
      { ...snapshot(), summaries: [{ taxonCode: 'M900002', regionCode: 'PR01', evidence: 'photo_rg', count: 1 }] },
      { ...snapshot(), summaries: [{ taxonCode: 'M900001', regionCode: 'PR47', evidence: 'photo_rg', count: 1 }] },
      { ...snapshot(), mappings: [{ taxonCode: 'M900003', externalId: 123 }] },
      { ...snapshot(), mappings: [{ taxonCode: 'M900004', externalId: 123 }] },
    ];
    for (const payload of invalids) {
      await expect(ingest(payload)).rejects.toThrow(/unmatched|not_unique/);
      expect((await db.query("select inat_taxon_id from public.taxa where taxon_code='M900001'")).rows).toEqual([{ inat_taxon_id: null }]);
      expect((await db.query('select count(*)::int as count from public.external_snapshots')).rows).toEqual([{ count: 0 }]);
    }
  });

  it('never overwrites a mapping or assigns an already used provider identifier to another taxon', async () => {
    await db.exec('begin');
    try {
      await ingest(snapshot());
      await db.exec('savepoint incompatible');
      await expect(ingest({ ...snapshot(), fetchedAt: '2026-11-07T00:00:00Z',
        mappings: [{ taxonCode: 'M900001', externalId: 456 }] })).rejects.toThrow(/mapping_conflict/);
      await db.exec('rollback to savepoint incompatible');
      await expect(ingest({ ...snapshot(), fetchedAt: '2026-11-07T00:00:00Z',
        mappings: [{ taxonCode: 'M900002', externalId: 123 }] })).rejects.toThrow(/mapping_conflict/);
      await db.exec('rollback to savepoint incompatible');
      expect((await db.query("select inat_taxon_id::int as id from public.taxa where taxon_code='M900001'")).rows).toEqual([{ id: 123 }]);
      expect((await db.query('select count(*)::int as count from public.external_snapshots')).rows).toEqual([{ count: 1 }]);
    } finally { await db.exec('rollback'); }
  });

  it('rejects raw fields, coordinates, credentials, invalid counts, licenses, ranks and duplicated entries', async () => {
    const firstPhoto = snapshot().photos[0];
    const invalids: unknown[] = [
      { ...snapshot(), coordinates: [35, 139] },
      { ...snapshot(), mappings: [{ ...snapshot().mappings[0], latitude: 35 }] },
      { ...snapshot(), summaries: [{ ...snapshot().summaries[0], raw: {} }] },
      { ...snapshot(), queryNote: JSON.stringify({ nested: [{ coordinates: [35, 139] }] }) },
      { ...snapshot(), queryNote: JSON.stringify({ predicate: { password: 'do-not-store' } }) },
      { ...snapshot(), queryNote: '[]' },
      { ...snapshot(), queryNote: '{bad json' },
      { ...snapshot(), fetchedAt: 'yesterday' },
      { ...snapshot(), summaries: [{ ...snapshot().summaries[0], count: 0 }] },
      { ...snapshot(), summaries: [{ ...snapshot().summaries[0], count: 1.5 }] },
      { ...snapshot(), summaries: [{ ...snapshot().summaries[0], count: '1' }] },
      { ...snapshot(), summaries: [{ ...snapshot().summaries[0], evidence: 'specimen' }] },
      { ...snapshot(), mappings: [snapshot().mappings[0], snapshot().mappings[0]] },
      { ...snapshot(), summaries: [snapshot().summaries[0], snapshot().summaries[0]] },
      { ...snapshot(), photos: [{ ...firstPhoto, licenseCode: null }] },
      { ...snapshot(), photos: [{ ...firstPhoto, observationUrl: 'https://attacker.example/observations/1' }] },
      { ...snapshot(), photos: [{ ...firstPhoto, imageUrl: 'https://static.inaturalist.org.attacker.example/photos/1.jpg' }] },
      { ...snapshot(), photos: [{ ...firstPhoto, lat: 35 }] },
      { ...snapshot(), photos: Array.from({ length: 7 }, (_, i) => ({ ...firstPhoto, imageUrl: `https://static.inaturalist.org/photos/${i}/square.jpg` })) },
      { ...snapshot(), source: 'gbif', doi: null, photos: [] },
      { ...snapshot(), source: 'gbif', doi: '10.15468/dl.example' },
    ];
    for (const payload of invalids) {
      await expect(ingest(payload)).rejects.toThrow();
      expect((await db.query('select count(*)::int as count from public.external_snapshots')).rows).toEqual([{ count: 0 }]);
    }
  });

  it('keeps at most six photos per affected taxon on refresh and does not erase other taxa photos', async () => {
    await serviceRun(async () => {
      await ingest(snapshot());
      await ingest({ ...snapshot(), fetchedAt: '2026-11-07T00:00:00Z',
        mappings: [{ taxonCode: 'M900002', externalId: 456 }],
        summaries: [], photos: snapshot().photos.map(photo => ({ ...photo, taxonCode: 'M900002' })) });
      await ingest({ ...snapshot(), fetchedAt: '2026-11-08T00:00:00Z',
        photos: Array.from({ length: 6 }, (_, i) => ({ ...snapshot().photos[0],
          imageUrl: `https://inaturalist-open-data.s3.amazonaws.com/photos/${i}/square.jpg` })) });
      expect((await db.query(`select t.taxon_code,count(*)::int as count from public.external_photos p
        join public.taxa t on t.id=p.taxon_id group by t.taxon_code order by t.taxon_code`)).rows)
        .toEqual([{ taxon_code: 'M900001', count: 6 }, { taxon_code: 'M900002', count: 1 }]);
    });
  });

  it('removes obsolete photos after a completed empty photo refresh and preserves them on counts-only runs', async () => {
    await serviceRun(async () => {
      await ingest(snapshot());
      await ingest({ ...snapshot(), fetchedAt: '2026-11-07T00:00:00Z', photos: [],
        queryNote: JSON.stringify({ endpoint: '/v1/observations/species_counts', photos_collected: false }) });
      expect((await db.query('select count(*)::int as count from public.external_photos')).rows).toEqual([{ count: 1 }]);
      await ingest({ ...snapshot(), fetchedAt: '2026-11-08T00:00:00Z', photos: [] });
      expect((await db.query('select count(*)::int as count from public.external_photos')).rows).toEqual([{ count: 0 }]);
    });
  });
});
