import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { columns, encodeTable, needsCsvNeutralization, type Scalar, type TableFormat } from '../../../packages/public-data/src/index.ts';
import { sourceSchema, type PublicSource } from './source.ts';
import { verifyPublicDirectory } from './verify.ts';

const byteLimit = 8 * 1024 * 1024;
export function nextVersion(releases: {version: string}[], date: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).formatToParts(new Date(date));
  const prefix = `${parts.find(p => p.type === 'year')?.value}.${parts.find(p => p.type === 'month')?.value}.`;
  return `${prefix}${Math.max(0, ...releases.filter(r => r.version.startsWith(prefix)).map(r => Number(r.version.slice(prefix.length)))) + 1}`;
}
const csvCell = (value: Scalar): string => {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && needsCsvNeutralization(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
export function buildPublicData(input: unknown, options: { outputRoot: string; generatedAt?: string; version?: string; maxBytes?: number }): {directory: string; version: string; counts: {taxa:number; species:number; subspecies:number; regions:number; records:number; references:number}; manifestSha256: string} {
  const source = sourceSchema.parse(input);
  const generatedAt = z.iso.datetime({ offset: true }).parse(options.generatedAt ?? new Date().toISOString());
  const version = z.string().regex(/^\d{4}\.\d{2}\.\d+$/).parse(options.version ?? nextVersion(source.releases, generatedAt));
  const maxBytes = z.number().int().positive().max(byteLimit).parse(options.maxBytes ?? byteLimit);
  const destination = join(options.outputRoot, version);
  if (existsSync(destination)) throw new Error('Public version already exists; use a new version');
  const temporary = mkdtempSync(join(tmpdir(), 'moth-public-build-'));
  try {
    const files: {path:string; sha256:string; bytes:number}[] = [];
    function write(path: string, value: string | Buffer) {
      const data = Buffer.from(value);
      if (data.length > maxBytes) throw new Error(`Public file exceeds size limit: ${path}`);
      mkdirSync(dirname(join(temporary, path)), { recursive: true }); writeFileSync(join(temporary, path), data);
      files.push({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
    }
    const jsonText = (value: unknown) => `${JSON.stringify(value)}\n`;
    function table(path: string, format: TableFormat, rows: Scalar[][]) { write(path, jsonText(encodeTable(format, rows))); }
    function chunked(path: string, format: TableFormat, rows: Scalar[][]) {
      const parts: string[] = [];
      function divide(values: Scalar[][]) {
        const data = jsonText(encodeTable(format, values));
        if (Buffer.byteLength(data) <= maxBytes) { parts.push(data); return; }
        if (values.length < 2) throw new Error('A public row exceeds the shard limit');
        const midpoint = Math.ceil(values.length / 2); divide(values.slice(0, midpoint)); divide(values.slice(midpoint));
      }
      divide(rows);
      parts.forEach((data,i) => write(parts.length === 1 ? path : path.replace(/\.json$/,`-part-${String(i+1).padStart(4,'0')}.json`),data));
    }
    const taxa = new Map(source.taxa.map(t => [t.id, t]));
    const taxaByCode = new Map(source.taxa.map(t => [t.taxon_code, t]));
    const regions = new Map(source.regions.map(r => [r.id, r]));
    const references = new Map(source.references.filter(r => r.status === 'published').map(r => [r.id, r]));
    const profiles = new Map(source.profiles.map(p => [p.id, p]));
    if (taxa.size !== source.taxa.length || taxaByCode.size !== source.taxa.length || regions.size !== source.regions.length) throw new Error('Duplicate source identity');
    function publicRegion(id: number, sensitivity: number) {
      let region = regions.get(id); const visited = new Set<number>();
      if (!region) throw new Error('Unresolved public region');
      while (sensitivity > 0 && (region.region_type === 'island' || region.code.startsWith('IS'))) {
        if (visited.has(region.id) || region.parent_id === null) throw new Error('Sensitive island has no safe ancestor');
        visited.add(region.id); region = regions.get(region.parent_id);
        if (!region) throw new Error('Sensitive island has no safe ancestor');
      }
      return region;
    }
    function ancestor(id: number, rank: string): string | null {
      const visited = new Set<number>(); let current = taxa.get(id);
      while (current) {
        if (visited.has(current.id)) throw new Error('Taxonomic parent cycle'); visited.add(current.id);
        if (current.rank === rank) return current.taxon_code;
        if (current.parent_id === null) return null;
        current = taxa.get(current.parent_id);
        if (!current) throw new Error('Missing taxonomic parent');
      }
      return null;
    }
    const namesByTaxon = new Map<number, Set<string>>();
    for (const name of source.names) { if (!taxa.has(name.taxon_id)) throw new Error('Name has no taxon'); const names = namesByTaxon.get(name.taxon_id) ?? new Set<string>(); names.add(name.name); namesByTaxon.set(name.taxon_id, names); }
    table('names.json', 'names-v1', source.taxa.map(t => [t.taxon_code,t.scientific_name,t.name_ja,[...(namesByTaxon.get(t.id) ?? [])].filter(n => n !== t.scientific_name && n !== t.name_ja).join('\n')]));
    table('taxon-tree.json', 'taxa-v1', source.taxa.map(t => { ancestor(t.id, '__validate_all_parents__'); return [t.taxon_code,t.parent_id === null ? null : taxa.get(t.parent_id)?.taxon_code ?? null,t.rank,t.scientific_name,t.name_ja,t.family,t.authorship,t.status,t.sensitivity]; }));
    table('regions.json', 'regions-v1', source.regions.map(r => {
      if (!(r.code.startsWith('PR') && r.region_type === 'prefecture' || r.code.startsWith('IS') && r.region_type === 'island' || r.code.startsWith('OT') && r.region_type === 'other')) throw new Error('Regional code/type mismatch');
      let current = r; const visited = new Set<number>();
      while (current.parent_id !== null) { if (visited.has(current.id)) throw new Error('Regional parent cycle'); visited.add(current.id); const parent = regions.get(current.parent_id); if (!parent) throw new Error('Missing regional parent'); current = parent; }
      return [r.code,r.region_type,r.name_ja,r.name_en,r.parent_id === null ? null : regions.get(r.parent_id)?.code ?? null,r.area_group,r.sort_order];
    }));

    const matrix = new Map<string, number>();
    const addEvidence = (taxonCode: string, regionCode: string, evidence: number) => { const key = `${taxonCode}:${regionCode}`; const value=taxaByCode.get(taxonCode)?.sensitivity===2 ? 6 : evidence; matrix.set(key, Math.min(value, matrix.get(key) ?? Infinity)); };
    const visible: {row: Scalar[]; genus: string; family: string; taxon: string; region: string}[] = [];
    const hiddenOnlyReferences = new Set<number>(); const visibleReferences = new Set<number>();
    for (const record of source.records) {
      if (record.status !== 'published') continue;
      const taxon = record.taxon_id === null ? undefined : taxa.get(record.taxon_id);
      const region = taxon ? publicRegion(record.region_id,taxon.sensitivity) : undefined; const reference = references.get(record.reference_id);
      if (!taxon || !region || !reference) throw new Error('Published record has an unresolved taxon, region or nonpublic reference');
      if (record.island_id !== null && !regions.has(record.island_id)) throw new Error('Record has an unresolved island');
      if (record.accuracy !== 'misidentification' && record.category !== 'board') {
        const evidence = record.accuracy === 'normal' && record.category === 'original' ? 1 : record.accuracy === 'normal' && record.category === 'citation' ? 2 : record.accuracy === 'needs_review' || record.category === 'unconfirmed' ? 5 : null;
        if (evidence !== null) addEvidence(taxon.taxon_code, region.code, evidence);
      }
      if (taxon.sensitivity === 2) { hiddenOnlyReferences.add(record.reference_id); continue; }
      visibleReferences.add(record.reference_id);
      const profile = record.submitted_by === null ? undefined : profiles.get(record.submitted_by);
      const base: Scalar[] = [record.record_code,taxon.taxon_code,region.code,taxon.sensitivity > 0 || record.island_id === null ? null : regions.get(record.island_id)?.code ?? null,reference.ref_code,record.page,record.name_as_published,record.category,record.accuracy,'published',profile?.public_credit ? profile.display_name : null];
      const details: Scalar[] = [record.locality_verbatim,record.locality_modern,record.lat,record.lon,record.event_date_verbatim,record.date_start,record.date_end,record.collector_verbatim,record.specimen_ref,record.note,record.individual_count,record.sex,record.life_stage,record.depository,record.coord_uncertainty_m];
      visible.push({ row: [...base,...details.map(value => taxon.sensitivity === 1 ? null : value)], genus: ancestor(taxon.id,'genus') ?? `unplaced-${taxon.taxon_code}`, family: ancestor(taxon.id,'family') ?? 'unplaced', taxon: taxon.taxon_code, region: region.code });
    }
    const publishedReferences = [...references.values()].filter(r => !hiddenOnlyReferences.has(r.id) || visibleReferences.has(r.id));
    table('references/index.json','references-v1',publishedReferences.map(r => [r.ref_code,r.title,r.title_en,r.year,r.year_text,r.container_title,r.volume,r.issue,r.pages,r.publisher,r.doi,r.authors]));
    const latest = new Map<'inaturalist'|'gbif',PublicSource['snapshots'][number]>();
    for (const snapshot of source.snapshots) {
      if (!Number.isFinite(Date.parse(snapshot.fetched_at))) throw new Error('Invalid external snapshot date');
      const previous = latest.get(snapshot.source);
      if (!previous || Date.parse(previous.fetched_at) < Date.parse(snapshot.fetched_at) || previous.fetched_at === snapshot.fetched_at && previous.id < snapshot.id) latest.set(snapshot.source,snapshot);
    }
    const latestIds = new Set([...latest.values()].map(s => s.id));
    for (const summary of source.summaries) {
      if (!latestIds.has(summary.snapshot_id) || summary.occurrence_count <= 0) continue;
      const taxon = taxa.get(summary.taxon_id); const region = taxon ? publicRegion(summary.region_id,taxon.sensitivity) : undefined;
      if (!taxon || !region) throw new Error('External summary has an unresolved code');
      const evidence = summary.evidence === 'specimen' ? 3 : summary.evidence === 'photo_rg' ? 4 : summary.evidence === 'photo_needs_id' ? 5 : null;
      if (evidence !== null) addEvidence(taxon.taxon_code,region.code,evidence);
    }
    const evidenceCounts = {original:0,citation:0,specimen:0,photo_rg:0,needs_review:0,presence_only:0};
    table('summary/matrix.json','matrix-v1',[...matrix].sort(([a],[b]) => a.localeCompare(b)).map(([key,evidence]) => { const [taxon,region] = key.split(':'); const name = (['original','citation','specimen','photo_rg','needs_review','presence_only'] as const)[evidence-1]; if (name) evidenceCounts[name]++; return [taxon ?? null,region ?? null,evidence,evidence === 3 || evidence === 4]; }));
    for (const [scope, key] of [['genus','genus'],['region','region']] as const) {
      const groups = new Map<string, typeof visible>();
      for (const entry of visible) { const group = groups.get(entry[key]) ?? []; group.push(entry); groups.set(entry[key],group); }
      if (scope === 'region') for (const region of source.regions) if (!groups.has(region.code)) groups.set(region.code,[]);
      for (const [code,entries] of groups) {
        const path = `records/${scope}/${code}.json`;
        const data = jsonText(encodeTable('records-v1',entries.map(e => e.row)));
        if (Buffer.byteLength(data) <= maxBytes) { write(path,data); continue; }
        const shards = new Map<string, Scalar[][]>();
        for (const entry of entries) { const shard = scope === 'region' ? `family-${entry.family}` : `taxon-${entry.taxon}`; const rows = shards.get(shard) ?? []; rows.push(entry.row); shards.set(shard,rows); }
        for (const [shard,rows] of shards) chunked(`records/${scope}/${code}/${shard}.json`,'records-v1',rows);
      }
    }
    for (const region of source.regions) {
      const rows = visible.filter(r => r.region === region.code).map(r => r.row);
      const csv = (values: Scalar[][]) => `${[...columns['records-v1']].map(csvCell).join(',')}\r\n${values.map(row => row.map(csvCell).join(',')).join('\r\n')}${values.length ? '\r\n' : ''}`;
      function csvShards(path: string, values: Scalar[][]) {
        const parts: string[] = [];
        function divide(rows: Scalar[][]) {
          const text = csv(rows);
          if (Buffer.byteLength(text) <= maxBytes) { parts.push(text); return; }
          if (rows.length < 2) throw new Error('A CSV row exceeds the shard limit');
          const midpoint = Math.ceil(rows.length/2); divide(rows.slice(0,midpoint)); divide(rows.slice(midpoint));
        }
        divide(values);
        parts.forEach((text,i) => write(parts.length === 1 ? path : path.replace(/\.csv\.gz$/,`-part-${String(i+1).padStart(4,'0')}.csv.gz`),gzipSync(text)));
      }
      csvShards(`downloads/${region.code}.csv.gz`,rows);
    }
    const photos = new Map<string, Scalar[][]>();
    for (const photo of source.photos) {
      const taxon = taxa.get(photo.taxon_id); if (!taxon) throw new Error('Photo has no taxon');
      if (taxon.sensitivity > 0) continue;
      const rows = photos.get(taxon.taxon_code) ?? [];
      rows.push([taxon.taxon_code,photo.observation_url,photo.image_url,photo.license_code,photo.attribution,photo.life_stage]);
      if (rows.length > 6) throw new Error('Too many public photos'); photos.set(taxon.taxon_code,rows);
    }
    for (const [taxon,rows] of photos) table(`photos/${taxon}.json`,'photos-v1',rows);
    const counts = {taxa:source.taxa.length,species:source.taxa.filter(t => t.rank === 'species').length,subspecies:source.taxa.filter(t => t.rank === 'subspecies').length,regions:source.regions.length,records:visible.length,references:publishedReferences.length};
    const external = Object.fromEntries((['inaturalist','gbif'] as const).map(name => { const snapshot = latest.get(name); return [name,{status:snapshot ? 'collected' : 'uncollected',fetchedAt:snapshot?.fetched_at ?? null,doi:snapshot?.doi ?? null,citation:snapshot?.citation ?? null}]; }));
    write('summary/national.json',jsonText({format:'national-v1',version,generatedAt,counts,external,evidenceCounts}));
    const manifest = {version,generatedAt,counts,files:files.sort((a,b) => a.path.localeCompare(b.path)),licenses:{taxonomy:'CC0 1.0',records:'CC BY 4.0'}};
    writeFileSync(join(temporary,'manifest.json'),jsonText(manifest));
    verifyPublicDirectory(temporary,new Map(source.taxa.map(t => [t.taxon_code,t.sensitivity])),{maxBytes,trustedRegions:new Map(source.regions.map(r => [r.code,{regionType:r.region_type,parent:r.parent_id === null ? null : regions.get(r.parent_id)?.code ?? null}]))});
    mkdirSync(options.outputRoot,{recursive:true}); renameSync(temporary,destination);
    return {directory:destination,version,counts,manifestSha256:createHash('sha256').update(readFileSync(join(destination,'manifest.json'))).digest('hex')};
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
