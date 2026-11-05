import { describe, expect, it } from 'vitest';
import { SerialApi, type TaxonRow } from '../pipelines/external/src/http.ts';
import { aggregateGbif, downloadRequest, excludedDataset, legacyBackbone, syncGbif, type ArchiveReader } from '../pipelines/sync-gbif/src/sync.ts';

const taxon: TaxonRow = { taxon_code: 'M000001', scientific_name: 'Testus testus', rank: 'species', is_name_collision: false, family: 'Testidae', authorship: null, inat_taxon_id: null, gbif_usage_key: null };
const regions = Array.from({ length: 47 }, (_, n) => ({ code: `PR${String(n + 1).padStart(2, '0')}`, inat_place_id: n + 1, gadm_gid: `JPN.${n + 1}_1` }));
const row = { level1Gid: 'JPN.1_1', acceptedTaxonKey: '123', taxonKey: '123', speciesKey: '123', datasetKey: '11111111-1111-4111-8111-111111111111', countryCode: 'JP', basisOfRecord: 'PRESERVED_SPECIMEN', scientificName: 'Testus testus Author, 2000', taxonRank: 'SPECIES', family: 'Testidae', decimalLatitude: '35.1234', decimalLongitude: '139.1234' };
async function* rows(...values: Record<string, string>[]) { yield* values; }
const json = (value: unknown) => new Response(JSON.stringify(value));
function api(transport: (url: string, init?: RequestInit) => Promise<Response>) { let now = 0; return new SerialApi(transport, 2000, () => now, async ms => { now += ms; }); }

describe('GBIF legacy and dataset-safe aggregation', () => {
  it('pins both legacy taxonomy contexts and excludes iNaturalist in the exact request', () => {
    expect(downloadRequest.checklistKey).toBe(legacyBackbone);
    expect(downloadRequest.format).toBe('DWCA');
    expect(downloadRequest.sendNotification).toBe(false);
    expect(downloadRequest.predicate.predicates).toContainEqual({ type: 'equals', key: 'TAXON_KEY', value: '797', checklistKey: legacyBackbone });
    expect(downloadRequest.predicate.predicates).toContainEqual({ type: 'not', predicate: { type: 'equals', key: 'DATASET_KEY', value: excludedDataset } });
  });
  it('counts specimen rows by GADM and exact identity, not coordinates or raw locality', async () => {
    let calls = 0;
    const result = await aggregateGbif(rows(row, row, { ...row, datasetKey: excludedDataset }, { ...row, basisOfRecord: 'HUMAN_OBSERVATION' }, { ...row, level1Gid: '', stateProvince: 'Tokyo' }), [taxon], regions, api(async url => {
      calls++; expect(new URL(url).searchParams.get('strict')).toBe('true');
      return json({ usageKey: 123, matchType: 'EXACT', canonicalName: taxon.scientific_name, rank: 'SPECIES', family: 'Testidae' });
    }));
    expect(result.summaries).toEqual([{ taxonCode: 'M000001', regionCode: 'PR01', evidence: 'specimen', count: 2 }]);
    expect(result.mappings).toEqual([{ taxonCode: 'M000001', externalId: 123 }]);
    expect(result.report.excludedRows).toBe(3); expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/decimalLatitude|139.1234|stateProvince/);
  });
  it('leaves fuzzy, ambiguous local names and different ranks unresolved', async () => {
    for (const [matchType, matchRank, taxa] of [
      ['FUZZY', 'SPECIES', [taxon]], ['EXACT', 'SUBSPECIES', [taxon]], ['EXACT', 'SPECIES', [taxon, { ...taxon, taxon_code: 'M000002' }]],
    ] as const) {
      const result = await aggregateGbif(rows(row), [...taxa], regions, api(async () => json({ usageKey: 123, matchType, canonicalName: taxon.scientific_name, rank: matchRank, family: 'Testidae' })));
      expect(result.summaries).toEqual([]); expect(result.mappings).toEqual([]); expect(result.report.unmatchedRows).toBe(1);
    }
  });
  it('rejects alphanumeric COL keys and a missing GADM column', async () => {
    await expect(aggregateGbif(rows({ ...row, acceptedTaxonKey: 'BSJCX' }), [taxon], regions, api(async () => json({})))).rejects.toThrow('decimal');
    const { level1Gid: ignored, ...withoutGadm } = row; void ignored;
    await expect(aggregateGbif(rows(withoutGadm), [taxon], regions, api(async () => json({})))).rejects.toThrow();
  });
});

describe('GBIF request, polling and DOI retention', () => {
  const credentials = { username: 'test-user', password: 'fixture-only' };
  const archive: ArchiveReader = async (_response, consume) => consume(rows(row));
  it('retains DOI/exact request only after success and never forwards Basic authorization to the download', async () => {
    const calls: {url: string; init?: RequestInit}[] = [];
    let polls = 0;
    const result = await syncGbif([{ ...taxon, gbif_usage_key: 123 }], regions, credentials, api(async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/request')) return new Response('0001234-260101000000000');
      if (url.endsWith('.zip')) return new Response('zip fixture handled by mock reader');
      return json({ key: '0001234-260101000000000', status: ++polls === 1 ? 'RUNNING' : 'SUCCEEDED', doi: '10.15468/dl.fixture', downloadLink: 'https://api.gbif.org/v1/occurrence/download/request/fixture.zip' });
    }), archive, async () => undefined, '2026-11-06T00:00:00Z');
    expect(result.snapshot.doi).toBe('10.15468/dl.fixture');
    expect(JSON.parse(result.snapshot.queryNote)).toEqual(downloadRequest);
    expect(result.snapshot.summaries[0]?.count).toBe(1);
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toMatch(/^Basic /);
    expect(calls[0]?.init?.redirect).toBe('error');
    for (const call of calls.slice(1)) expect(new Headers(call.init?.headers).has('Authorization')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/fixture-only|decimalLatitude|coordinates/);
  });
  it('rejects failed downloads, missing DOI and unapproved hosts before any archive processing', async () => {
    for (const status of ['FAILED', 'KILLED', 'CANCELLED']) {
      await expect(syncGbif([], regions, credentials, api(async url => url.endsWith('/request') ? new Response('0001234-260101000000000') : json({ key: '0001234-260101000000000', status })), archive, async () => undefined)).rejects.toThrow(status);
    }
    for (const metadata of [
      { status: 'SUCCEEDED', downloadLink: 'https://api.gbif.org/fixture.zip' },
      { status: 'SUCCEEDED', doi: '10.15468/dl.fixture', downloadLink: 'https://evil.example/fixture.zip' },
    ]) await expect(syncGbif([], regions, credentials, api(async url => url.endsWith('/request') ? new Response('0001234-260101000000000') : json({ key: '0001234-260101000000000', ...metadata })), archive, async () => undefined)).rejects.toThrow();
  });
  it('rejects unapproved redirects without credentials and publishes nothing on a truncated stream', async () => {
    let credentialRequests = 0;
    await expect(syncGbif([], regions, credentials, api(async (_url, init) => {
      credentialRequests++; expect(init?.redirect).toBe('error');
      return new Response('', { status: 307, headers: { location: 'https://api.gbif.org/not-the-credential-endpoint' } });
    }), archive, async () => undefined)).rejects.toThrow('HTTP 307');
    expect(credentialRequests).toBe(1);
    const transport = api(async url => url.endsWith('/request') ? new Response('0001234-260101000000000') : url.endsWith('.zip') ? new Response('', { status: 302, headers: { location: 'https://evil.example/other.zip' } }) : json({ key: '0001234-260101000000000', status: 'SUCCEEDED', doi: '10.15468/dl.fixture', downloadLink: 'https://api.gbif.org/fixture.zip' }));
    await expect(syncGbif([], regions, credentials, transport, archive, async () => undefined)).rejects.toThrow('Unapproved');
    const failedArchive: ArchiveReader = async () => { throw new Error('truncated archive'); };
    await expect(syncGbif([], regions, credentials, api(async url => url.endsWith('/request') ? new Response('0001234-260101000000000') : url.endsWith('.zip') ? new Response('') : json({ key: '0001234-260101000000000', status: 'SUCCEEDED', doi: '10.15468/dl.fixture', downloadLink: 'https://api.gbif.org/fixture.zip' })), failedArchive, async () => undefined)).rejects.toThrow('truncated');
  });
});
