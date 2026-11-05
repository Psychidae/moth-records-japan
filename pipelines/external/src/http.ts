import { z } from 'zod';

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export class SerialApi {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;
  private requests = 0;
  private readonly transport: Transport;
  private readonly interval: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(transport: Transport = fetch, interval = 2000,
    now = Date.now, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
    this.transport = transport; this.interval = interval; this.now = now; this.sleep = sleep;
  }

  request(url: string, init: RequestInit = {}): Promise<Response> {
    const run = this.tail.then(async () => {
      for (let retry = 0; ; retry++) {
        await this.sleep(Math.max(0, this.lastStart + this.interval - this.now()));
        if (++this.requests > 9500) throw new Error('API daily request safety limit reached');
        this.lastStart = this.now();
        const response = await this.transport(url, { ...init, signal: init.signal ?? AbortSignal.timeout(45_000) });
        if (response.status !== 429) {
          if (init.redirect === 'manual' && response.status >= 300 && response.status < 400) return response;
          if (!response.ok) throw new Error(`External API HTTP ${response.status}`);
          return response;
        }
        await response.body?.cancel();
        if (retry >= 3) throw new Error('External API retry limit reached');
        const value = response.headers.get('retry-after');
        const seconds = value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
        const date = value === null ? NaN : Date.parse(value);
        await this.sleep(Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? Math.max(0, date - this.now()) : 60_000);
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('API response has no body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('API page exceeds safety limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export const Taxon = z.object({ taxon_code: z.string().regex(/^M\d{6}$/), scientific_name: z.string().min(1),
  rank: z.enum(['species', 'subspecies']), is_name_collision: z.boolean(), family: z.string().nullable(),
  authorship: z.string().nullable(), inat_taxon_id: z.number().int().positive().nullable(), gbif_usage_key: z.number().int().positive().nullable() });
export const Region = z.object({ code: z.string().regex(/^PR(0[1-9]|[1-3][0-9]|4[0-7])$/), inat_place_id: z.number().int().positive(), gadm_gid: z.string().regex(/^JPN\.\d+_1$/) });
export type TaxonRow = z.infer<typeof Taxon>;
export type RegionRow = z.infer<typeof Region>;
export type Snapshot = { source: 'inaturalist' | 'gbif'; fetchedAt: string; queryNote: string; citation: string; doi: string | null;
  mappings: {taxonCode: string; externalId: number}[]; summaries: {taxonCode: string; regionCode: string; evidence: 'photo_rg' | 'photo_needs_id' | 'specimen'; count: number}[];
  photos: {taxonCode: string; observationUrl: string; imageUrl: string; licenseCode: string; attribution: string; lifeStage: string | null}[] };

export class StagingStore {
  private readonly root: string;
  private readonly key: string;
  private readonly transport: Transport;
  constructor(url: string, key: string, transport: Transport = fetch) {
    // A scheduled job must never be repointed to production by an environment typo.
    this.root = z.literal('https://zbbmvrmmxhrytwqrjyyk.supabase.co').parse(url);
    z.string().min(1).parse(key);
    this.key = key; this.transport = transport;
  }
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.transport(`${this.root}/rest/v1/${path}`, { ...init, headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Staging database HTTP ${response.status}`);
    return readJson(response);
  }
  async catalog(): Promise<{taxa: TaxonRow[]; regions: RegionRow[]}> {
    const taxa: TaxonRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = z.array(Taxon).parse(await this.request(`taxa?select=taxon_code,scientific_name,rank,is_name_collision,family,authorship,inat_taxon_id,gbif_usage_key&rank=in.(species,subspecies)&order=taxon_code&limit=1000&offset=${offset}`));
      taxa.push(...page);
      if (page.length < 1000) break;
    }
    const regions = z.array(Region).length(47).parse(await this.request('regions?select=code,inat_place_id,gadm_gid&region_type=eq.prefecture&order=code'));
    if (new Set(regions.map(r => r.code)).size !== 47) throw new Error('Duplicate prefecture code');
    return { taxa, regions };
  }
  async publish(payload: Snapshot): Promise<void> {
    z.number().int().positive().parse(await this.request('rpc/ingest_external_snapshot', { method: 'POST', body: JSON.stringify({ payload }) }));
  }
}
