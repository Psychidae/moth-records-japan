import { z } from 'zod';
import { SerialApi, readJson, type TaxonRow, type RegionRow, type Snapshot } from '../../external/src/http.ts';
import { streamOccurrenceArchive } from './archive.ts';

export const legacyBackbone = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';
export const excludedDataset = '50c9509d-22c7-4a22-a47d-8c48425ef4a7';
export const downloadRequest = {
  notificationAddresses: [], sendNotification: false, format: 'DWCA', checklistKey: legacyBackbone,
  predicate: { type: 'and', predicates: [
    { type: 'equals', key: 'COUNTRY', value: 'JP' },
    { type: 'equals', key: 'TAXON_KEY', value: '797', checklistKey: legacyBackbone },
    { type: 'not', predicate: { type: 'equals', key: 'DATASET_KEY', value: excludedDataset } },
    { type: 'in', key: 'BASIS_OF_RECORD', values: ['PRESERVED_SPECIMEN', 'MATERIAL_SAMPLE'] },
  ] },
};
const Metadata = z.object({ key: z.string().regex(/^\d+-\d+$/), status: z.enum(['PREPARING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'KILLED', 'CANCELLED', 'SUSPENDED']), doi: z.string().optional(), downloadLink: z.string().url().optional() });
const Match = z.object({ usageKey: z.number().int().positive().safe().optional(), canonicalName: z.string().optional(), rank: z.string().optional(), family: z.string().optional(), matchType: z.string() });
const Row = z.object({ level1Gid: z.string(), acceptedTaxonKey: z.string(), taxonKey: z.string(), speciesKey: z.string(), datasetKey: z.string().uuid(), countryCode: z.string(), basisOfRecord: z.string(), scientificName: z.string(), taxonRank: z.string(), family: z.string().optional() });
function numericKey(value: string): number | null {
  if (!value) return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('GBIF key is not a legacy decimal identifier');
  return Number(value);
}
type Report = { matchedRows: number; excludedRows: number; unmatchedRows: number; unmatched: {name: string; rank: string; externalKey: number; reason: string}[] };
export type ArchiveReader = <T>(response: Response, consume: (rows: AsyncIterable<Record<string, string>>) => Promise<T>) => Promise<T>;

export async function aggregateGbif(rows: AsyncIterable<Record<string, string>>, taxa: TaxonRow[], regions: RegionRow[], api: SerialApi): Promise<{summaries: Snapshot['summaries']; mappings: Snapshot['mappings']; report: Report}> {
  if (regions.length !== 47 || new Set(regions.map(r => r.gadm_gid)).size !== 47) throw new Error('All 47 GADM prefectures are required');
  const report: Report = { matchedRows: 0, excludedRows: 0, unmatchedRows: 0, unmatched: [] };
  const cache = new Map<string, TaxonRow | null>();
  const mapping = new Map<string, number>();
  const counts = new Map<string, number>();
  for await (const input of rows) {
    const row = Row.parse(input); // Unknown columns, including coordinates, are discarded here.
    if (row.datasetKey === excludedDataset || row.countryCode !== 'JP' || !['PRESERVED_SPECIMEN', 'MATERIAL_SAMPLE'].includes(row.basisOfRecord)) { report.excludedRows++; continue; }
    const region = regions.find(r => r.gadm_gid === row.level1Gid);
    const rank = row.taxonRank.toLowerCase();
    if (!region || !row.level1Gid.startsWith('JPN.') || !['species', 'subspecies'].includes(rank)) { report.excludedRows++; continue; }
    const keys = [row.acceptedTaxonKey, row.taxonKey, ...(rank === 'species' ? [row.speciesKey] : [])].map(numericKey).filter((k): k is number => k !== null);
    const key = keys[0];
    if (key === undefined) { report.unmatchedRows++; continue; }
    const cacheKey = `${key}:${rank}:${row.scientificName}:${row.family ?? ''}`;
    let local = cache.get(cacheKey);
    if (local === undefined) {
      const known = taxa.filter(t => t.gbif_usage_key !== null && keys.includes(t.gbif_usage_key) && t.rank === rank && !t.is_name_collision);
      if (known.length === 1) local = known[0] ?? null;
      else if (known.length > 1) local = null;
      else {
        const parameters = new URLSearchParams({ name: row.scientificName, rank: row.taxonRank, strict: 'true', ...(row.family ? { family: row.family } : {}) });
        const match = Match.parse(await readJson(await api.request(`https://api.gbif.org/v1/species/match?${parameters}`)));
        const candidates = taxa.filter(t => t.scientific_name === match.canonicalName && t.rank === match.rank?.toLowerCase() && !t.is_name_collision && t.family === match.family);
        local = match.matchType === 'EXACT' && match.rank?.toLowerCase() === rank && match.usageKey !== undefined && keys.includes(match.usageKey) && candidates.length === 1 && candidates[0]?.gbif_usage_key === null ? candidates[0] ?? null : null;
        if (local && match.usageKey !== undefined) {
          const previous = mapping.get(local.taxon_code);
          if (previous !== undefined && previous !== match.usageKey) throw new Error('Conflicting GBIF taxon mapping');
          if ([...mapping.entries()].some(([code, id]) => code !== local?.taxon_code && id === match.usageKey) || taxa.some(t => t.taxon_code !== local?.taxon_code && t.gbif_usage_key === match.usageKey)) throw new Error('Ambiguous GBIF taxon mapping');
          mapping.set(local.taxon_code, match.usageKey);
        }
      }
      cache.set(cacheKey, local ?? null);
      if (!local) report.unmatched.push({ name: row.scientificName, rank, externalKey: key, reason: 'no_unique_exact_match' });
    }
    if (!local) { report.unmatchedRows++; continue; }
    const countKey = `${local.taxon_code}:${region.code}`;
    const count = (counts.get(countKey) ?? 0) + 1;
    if (count > 2147483647) throw new Error('GBIF count exceeds database range');
    counts.set(countKey, count); report.matchedRows++;
  }
  return { summaries: [...counts].map(([key, count]) => { const [taxonCode, regionCode] = key.split(':'); return { taxonCode: z.string().parse(taxonCode), regionCode: z.string().parse(regionCode), evidence: 'specimen', count }; }), mappings: [...mapping].map(([taxonCode, externalId]) => ({ taxonCode, externalId })), report };
}

export async function syncGbif(taxa: TaxonRow[], regions: RegionRow[], credentials: {username: string; password: string}, api = new SerialApi(), archive: ArchiveReader = streamOccurrenceArchive, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)), fetchedAt = new Date().toISOString()): Promise<{snapshot: Snapshot; report: Report}> {
  z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).parse(credentials.username);
  z.string().min(1).parse(credentials.password);
  const response = await api.request('https://api.gbif.org/v1/occurrence/download/request', { method: 'POST', redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(downloadRequest) });
  const key = z.string().regex(/^\d+-\d+$/).parse((await response.text()).trim().replace(/^"|"$/g, ''));
  let metadata: z.infer<typeof Metadata> | undefined;
  for (let poll = 0; poll < 120; poll++) {
    const current = Metadata.parse(await readJson(await api.request(`https://api.gbif.org/v1/occurrence/download/${key}`)));
    if (current.key !== key) throw new Error('GBIF download key mismatch');
    if (current.status === 'SUCCEEDED') { metadata = current; break; }
    if (current.status !== 'PREPARING' && current.status !== 'RUNNING') throw new Error(`GBIF download ${current.status}`);
    await sleep(60_000);
  }
  if (!metadata?.doi || !metadata.downloadLink) throw new Error('GBIF download incomplete or DOI missing');
  const doi = z.string().regex(/^10\.\d{4,9}\/\S+$/).parse(metadata.doi.replace(/^https:\/\/doi\.org\//, ''));
  let url = new URL(metadata.downloadLink);
  let download: Response | undefined;
  for (let redirect = 0; redirect < 4; redirect++) {
    if (url.protocol !== 'https:' || !['api.gbif.org', 'download.gbif.org'].includes(url.hostname) || url.username || url.password) throw new Error('Unapproved GBIF download host');
    const result = await api.request(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(30 * 60_000) });
    if (result.status >= 300 && result.status < 400) {
      const location = result.headers.get('location'); await result.body?.cancel();
      if (!location) throw new Error('GBIF redirect has no location');
      url = new URL(location, url);
    } else { download = result; break; }
  }
  if (!download) throw new Error('GBIF download redirect limit');
  const result = await archive(download, rows => aggregateGbif(rows, taxa, regions, api));
  return { snapshot: { source: 'gbif', fetchedAt, queryNote: JSON.stringify(downloadRequest), citation: `GBIF.org occurrence download ${key}; legacy GBIF Backbone; ${doi}`, doi, mappings: result.mappings, summaries: result.summaries, photos: [] }, report: result.report };
}
