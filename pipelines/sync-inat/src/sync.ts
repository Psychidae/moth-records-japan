import { z } from 'zod';
import { SerialApi, readJson, type TaxonRow, type RegionRow, type Snapshot } from '../../external/src/http.ts';

const ApiTaxon = z.object({ id: z.number().int().positive(), name: z.string().min(1), rank: z.string().min(1), is_active: z.boolean().optional() });
const Counts = z.object({ total_results: z.number().int().nonnegative(), results: z.array(z.object({ count: z.number().int().positive(), taxon: ApiTaxon })) });
const Taxa = z.object({ total_results: z.number().int().nonnegative(), results: z.array(ApiTaxon) });
const Licenses = ['cc0', 'cc-by', 'cc-by-nc', 'cc-by-sa', 'cc-by-nc-sa'];
const Observations = z.object({ results: z.array(z.object({ id: z.number().int().positive(), uri: z.string().url(), photos: z.array(z.object({ url: z.string().url(), license_code: z.string().nullable(), attribution: z.string().nullable() })) })) });
export type Unmatched = { name: string; rank: string; externalId: number; reason: string };

export async function syncInat(taxa: TaxonRow[], regions: RegionRow[], userAgent: string, api = new SerialApi(), fetchedAt = new Date().toISOString(), includePhotos = true): Promise<{snapshot: Snapshot; unmatched: Unmatched[]}> {
  if (regions.length !== 47 || new Set(regions.map(r => r.code)).size !== 47 || new Set(regions.map(r => r.inat_place_id)).size !== 47 ||
    !Array.from({ length: 47 }, (_, i) => `PR${String(i + 1).padStart(2, '0')}`).every(code => regions.some(r => r.code === code))) throw new Error('All 47 prefectures are required');
  const request = async (path: string, parameters: Record<string, string>) => readJson(await api.request(`https://api.inaturalist.org/v1/${path}?${new URLSearchParams(parameters)}`, { headers: { 'User-Agent': userAgent } }));
  const snapshot: Snapshot = { source: 'inaturalist', fetchedAt, queryNote: JSON.stringify({ endpoint: '/v1/observations/species_counts', taxon_id: 47157, without_taxon_id: 47224, quality_grades: ['research', 'needs_id'], regions: regions.map(r => ({ code: r.code, place_id: r.inat_place_id })), request_interval_ms: 2000, photos_collected: includePhotos }), citation: 'iNaturalist community observations; prefectural counts, research / needs_id kept separately', doi: null, mappings: [], summaries: [], photos: [] };
  const unmatched = new Map<number, Unmatched>();
  const resolved = new Map<number, TaxonRow | null>();
  const matched = new Map<string, number>();
  async function resolve(remote: z.infer<typeof ApiTaxon>): Promise<TaxonRow | null> {
    if (resolved.has(remote.id)) return resolved.get(remote.id) ?? null;
    const byId = taxa.filter(t => t.inat_taxon_id === remote.id);
    let local: TaxonRow | undefined;
    let reason = 'no_unique_exact_match';
    if (byId.length === 1 && !byId[0]?.is_name_collision && byId[0]?.rank === remote.rank) local = byId[0];
    else if (byId.length === 0 && ['species', 'subspecies'].includes(remote.rank)) {
      const candidates = taxa.filter(t => t.scientific_name === remote.name && t.rank === remote.rank);
      if (candidates.length === 1 && !candidates[0]?.is_name_collision && candidates[0]?.inat_taxon_id === null) {
        const result = Taxa.parse(await request('taxa', { q: remote.name, rank: remote.rank, is_active: 'true', per_page: '500' }));
        const exact = result.results.filter(t => t.name === remote.name && t.rank === remote.rank && t.is_active === true);
        if (result.total_results <= 500 && exact.length === 1 && exact[0]?.id === remote.id) local = candidates[0];
      }
    } else reason = byId.length ? 'ambiguous_existing_mapping' : 'unsupported_leaf_rank';
    if (local && [...matched.entries()].some(([code, id]) => code === local?.taxon_code && id !== remote.id)) {
      throw new Error('Multiple remote identities map to one local taxon');
    }
    if (local) {
      matched.set(local.taxon_code, remote.id);
      if (local.inat_taxon_id === null) snapshot.mappings.push({ taxonCode: local.taxon_code, externalId: remote.id });
    } else unmatched.set(remote.id, { name: remote.name, rank: remote.rank, externalId: remote.id, reason });
    resolved.set(remote.id, local ?? null);
    return local ?? null;
  }
  for (const region of regions) for (const [grade, evidence] of [['research', 'photo_rg'], ['needs_id', 'photo_needs_id']] as const) {
    let seen = 0;
    let expected: number | undefined;
    const identities = new Set<number>();
    for (let page = 1; ; page++) {
      const result = Counts.parse(await request('observations/species_counts', { taxon_id: '47157', without_taxon_id: '47224', place_id: String(region.inat_place_id), quality_grade: grade, per_page: '500', page: String(page) }));
      expected ??= result.total_results;
      if (result.total_results !== expected || result.results.length > 500) throw new Error('iNaturalist pagination changed during collection');
      for (const entry of result.results) {
        if (identities.has(entry.taxon.id)) throw new Error('Duplicate iNaturalist taxon in prefecture/grade');
        identities.add(entry.taxon.id);
        const local = await resolve(entry.taxon);
        if (local) snapshot.summaries.push({ taxonCode: local.taxon_code, regionCode: region.code, evidence, count: entry.count });
      }
      seen += result.results.length;
      if (seen === expected) break;
      if (seen > expected || result.results.length < 500 || page >= 100) throw new Error('Incomplete iNaturalist pagination');
    }
  }
  if (includePhotos) for (const [taxonCode, id] of matched) {
    const observations = Observations.parse(await request('observations', { taxon_id: String(id), country_code: 'JP', photos: 'true', photo_license: Licenses.join(','), per_page: '30', order_by: 'created_at', order: 'desc' }));
    const urls = new Set<string>();
    for (const observation of observations.results) for (const photo of observation.photos) {
      if (urls.size >= 6 || urls.has(photo.url) || !Licenses.includes(photo.license_code ?? '') || !photo.attribution?.trim()) continue;
      const observationUrl = new URL(observation.uri);
      const imageUrl = new URL(photo.url);
      if (observationUrl.protocol !== 'https:' || !['www.inaturalist.org', 'inaturalist.org'].includes(observationUrl.hostname) || imageUrl.protocol !== 'https:' || !['static.inaturalist.org', 'inaturalist-open-data.s3.amazonaws.com'].includes(imageUrl.hostname)) continue;
      urls.add(photo.url);
      snapshot.photos.push({ taxonCode, observationUrl: observation.uri, imageUrl: photo.url, licenseCode: photo.license_code ?? '', attribution: photo.attribution, lifeStage: null });
    }
  }
  return { snapshot, unmatched: [...unmatched.values()] };
}
