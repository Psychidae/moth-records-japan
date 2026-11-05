import { describe, expect, it } from 'vitest';
import { SerialApi, StagingStore, type TaxonRow, type Transport } from '../pipelines/external/src/http.ts';
import { syncInat } from '../pipelines/sync-inat/src/sync.ts';

const taxon: TaxonRow = { taxon_code: 'M000001', scientific_name: 'Testus testus', rank: 'species', is_name_collision: false, family: 'Testidae', authorship: null, inat_taxon_id: null, gbif_usage_key: null };
const regions = Array.from({ length: 47 }, (_, n) => ({ code: `PR${String(n + 1).padStart(2, '0')}`, inat_place_id: n + 1, gadm_gid: `JPN.${n + 1}_1` }));
function fakeApi(transport: Transport) {
  let now = 0;
  return new SerialApi(transport, 2000, () => now, async ms => { now += ms; });
}
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('serial external API scheduler', () => {
  it('spaces simultaneous calls, lookups and retries by at least two seconds', async () => {
    let now = 0;
    const starts: number[] = [];
    const api = new SerialApi(async () => { starts.push(now); return starts.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : json({}); }, 2000, () => now, async ms => { now += ms; });
    await Promise.all([api.request('https://example.org/a'), api.request('https://example.org/b'), api.request('https://example.org/c')]);
    expect(starts).toEqual([0, 2000, 4000, 6000]);
  });
  it('uses HTTP-date and fallback delays, then fails after three retries', async () => {
    let now = 0;
    const starts: number[] = [];
    const api = new SerialApi(async () => { starts.push(now); return new Response('', { status: 429, headers: starts.length === 1 ? { 'Retry-After': new Date(10_000).toUTCString() } : {} }); }, 2000, () => now, async ms => { now += ms; });
    await expect(api.request('https://example.org')).rejects.toThrow('retry limit');
    expect(starts).toEqual([0, 10_000, 70_000, 130_000]);
  });
});

describe('iNaturalist aggregate import', () => {
  it('uses outer counts, unique exact name/rank, both grades and verified licensed observation photos; discards raw coordinates', async () => {
    const calls: URL[] = [];
    const api = fakeApi(async url => {
      const request = new URL(url); calls.push(request);
      if (request.pathname.endsWith('/taxa')) return json({ total_results: 1, results: [{ id: 10, name: taxon.scientific_name, rank: 'species', is_active: true }] });
      if (request.pathname.endsWith('/observations')) return json({ results: [{ id: 123, uri: 'https://www.inaturalist.org/observations/123', geojson: { coordinates: [139, 35] }, photos: [
        { url: 'https://static.inaturalist.org/photos/1/medium.jpg', license_code: null, attribution: 'No license' },
        { url: 'https://static.inaturalist.org/photos/2/medium.jpg', license_code: 'cc-by', attribution: 'Photo author' },
        { url: 'https://unapproved.example/photos/3.jpg', license_code: 'cc-by', attribution: 'Other' },
      ] }] });
      return json({ total_results: 1, results: [{ count: request.searchParams.get('quality_grade') === 'research' ? 3 : 2, taxon: { id: 10, name: taxon.scientific_name, rank: 'species', observations_count: 9999, default_photo: { url: 'https://example.org/ignored' } } }], coordinates: [139, 35] });
    });
    const result = await syncInat([taxon], regions, 'Project/0.1 (contact@example.org)', api, '2026-11-06T00:00:00Z');
    expect(result.snapshot.summaries).toHaveLength(94);
    expect(result.snapshot.summaries.slice(0, 2).map(s => [s.evidence, s.count])).toEqual([['photo_rg', 3], ['photo_needs_id', 2]]);
    expect(result.snapshot.mappings).toEqual([{ taxonCode: 'M000001', externalId: 10 }]);
    expect(result.snapshot.photos).toHaveLength(1);
    expect(result.unmatched).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/coordinates|geojson|9999|default_photo/);
    const counts = calls.filter(u => u.pathname.endsWith('/species_counts'));
    expect(counts).toHaveLength(94);
    for (const url of counts) {
      expect(url.searchParams.get('taxon_id')).toBe('47157');
      expect(url.searchParams.get('without_taxon_id')).toBe('47224');
      expect(url.searchParams.get('per_page')).toBe('500');
    }
  });
  it('does not choose duplicate local identities, fuzzy names or unsupported leaf ranks', async () => {
    let lookups = 0;
    const api = fakeApi(async url => {
      if (new URL(url).pathname.endsWith('/taxa')) { lookups++; return json({ total_results: 1, results: [{ id: 11, name: 'Testus other', rank: 'species', is_active: true }] }); }
      return json({ total_results: 3, results: [
        { count: 1, taxon: { id: 10, name: 'Collision', rank: 'species' } },
        { count: 1, taxon: { id: 11, name: taxon.scientific_name, rank: 'species' } },
        { count: 1, taxon: { id: 12, name: 'Testus', rank: 'genus' } },
      ] });
    });
    const result = await syncInat([taxon, { ...taxon, taxon_code: 'M000002', scientific_name: 'Collision', is_name_collision: true }, { ...taxon, taxon_code: 'M000003', scientific_name: 'Collision', is_name_collision: true }], regions, 'Project/0.1', api, undefined, false);
    expect(result.snapshot.summaries).toEqual([]);
    expect(result.snapshot.mappings).toEqual([]);
    expect(result.unmatched).toHaveLength(3);
    expect(lookups).toBe(1);
  });
  it('fails rather than publish a truncated or duplicate page', async () => {
    await expect(syncInat([taxon], regions, 'Project', fakeApi(async () => json({ total_results: 501, results: [{ count: 1, taxon: { id: 10, name: 'Unknown', rank: 'genus' } }] })), undefined, false)).rejects.toThrow('Incomplete');
    await expect(syncInat([taxon], regions, 'Project', fakeApi(async () => json({ total_results: 2, results: [1, 2].map(() => ({ count: 1, taxon: { id: 10, name: 'Unknown', rank: 'genus' } })) })), undefined, false)).rejects.toThrow('Duplicate');
  });
  it('caps valid photos at six and uses one scheduler for all photo requests', async () => {
    const api = fakeApi(async url => new URL(url).pathname.endsWith('/observations') ? json({ results: [{ id: 123, uri: 'https://www.inaturalist.org/observations/123', photos: Array.from({ length: 10 }, (_, i) => ({ url: `https://static.inaturalist.org/photos/${i}/medium.jpg`, license_code: 'cc-by', attribution: 'Author' })) }] }) : json({ total_results: 1, results: [{ count: 1, taxon: { id: 10, name: taxon.scientific_name, rank: 'species' } }] }));
    const result = await syncInat([{ ...taxon, inat_taxon_id: 10 }], regions, 'Project', api);
    expect(result.snapshot.photos).toHaveLength(6);
  });
  it('pins scheduled writes to staging and never accepts production URLs', () => {
    expect(() => new StagingStore('https://cvdidoprdpvcbnncxtie.supabase.co', 'not-a-secret')).toThrow();
  });
});
