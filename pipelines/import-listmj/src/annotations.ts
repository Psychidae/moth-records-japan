import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildListMjImport } from './import.ts';
import type { ListMjTaxon } from './import.ts';

const LIST_SHA256 = '98c38adfdc72f5eda05ec37fefb818023123249cd743c4ff3c3b25e278ac1028';
const REFS_SHA256 = '8db7b2532194d617367f769ae426c937ae7fedd41bf27088ea39a7e75e6d928b';
const LIST_SOURCE = 'listmj:list.html';
const REFS_SOURCE = 'listmj:refs.html';

export interface ListMjSpeciesMapping {
  speciesBlock: number;
  sourceRow: number | null;
  taxonCode: string | null;
  scientificName: string | null;
  mappingStatus: 'matched' | 'source_order' | 'ambiguous' | 'unmatched';
  candidateTaxonCodes: string[];
  evidence: string;
}
export interface ListMjAnnotation {
  sourceItem: number;
  speciesBlock: number | null;
  taxonCode: string | null;
  sourceRow: number | null;
  note: string;
  rawHtml: string;
  mappingStatus: 'matched' | 'ambiguous' | 'unmatched';
  candidateTaxonCodes: string[];
}
export interface ListMjReference {
  sourceItem: number;
  refCode: string;
  title: string;
  rawHtml: string;
  authors: string | null;
  year: number | null;
  yearText: string | null;
  containerTitle: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  parseStatus: 'parsed' | 'partial' | 'unparsed';
  unparsedReason: string | null;
}
export interface ListMjAnnotationsReport {
  source: { listHtmlSha256: string; refsHtmlSha256: string };
  counts: {
    speciesBlocks: number; notes: number; references: number;
    parsedReferences: number; partialReferences: number; unparsedReferences: number; incompleteReferences: number;
  };
  acceptance: { expectedNotes: 975; expectedReferences: 282; passed: boolean };
  sourceDiscrepancies: { kind: 'references_count'; expected: 282; actual: number; passed: false }[];
  alignment: {
    skippedSpeciesRows: number[];
    speciesMappings: ListMjSpeciesMapping[];
    unresolvedNotes: number[];
    note: string;
  };
  unparsedReferences: { sourceItem: number; refCode: string; title: string; reason: string }[];
  parsingNote: string;
}
export interface ListMjAnnotationsResult {
  sql: string;
  report: ListMjAnnotationsReport;
  notes: ListMjAnnotation[];
  references: ListMjReference[];
}

function verifiedHtml(directory: string, filename: string, checksum: string): string {
  const manifestEntries = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/);
  const matching = manifestEntries.filter((entry) => entry.slice(66) === filename);
  if (matching.length !== 1 || matching[0] !== `${checksum}  ${filename}`) {
    throw new Error(`Unrecognized List-MJ HTML checksum: ${filename}`);
  }
  const bytes = readFileSync(join(directory, filename));
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error(`SHA-256 mismatch: ${filename}`);
  return z.string().min(1).parse(bytes.toString('utf8'));
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (original: string, entity: string): string => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X')
        ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new Error('Invalid HTML character reference');
      }
      return String.fromCodePoint(code);
    }
    const replacement = named[entity.toLowerCase()];
    if (replacement === undefined) throw new Error(`Unsupported HTML entity: ${original}`);
    return replacement;
  });
}

// This reads immutable, hash-pinned source strings. It never loads a browser,
// follows links, imports scripts, or evaluates the scripts in the source page.
function htmlText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
}
function normalizeMatch(text: string): string {
  // Quotes and "Gen. et" are presentation conventions in list.html. The
  // original XLSX/scientific name and all raw HTML are preserved unchanged.
  return text.replace(/"/g, '').replace(/\s+/g, ' ').trim().replace(/^Gen\.\s+et\b/, 'Gen.');
}
function readableNote(html: string): string {
  return htmlText(html).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}
function classNames(attributes: string): string[] {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  return (match?.[1] ?? match?.[2] ?? '').split(/\s+/);
}

function parseNotes(html: string, species: ListMjTaxon[]): {
  notes: ListMjAnnotation[]; mappings: ListMjSpeciesMapping[]; skippedSpeciesRows: number[];
} {
  const comparison = species.map((taxon) => ({
    taxon, scientificName: normalizeMatch(taxon.scientificName),
    nameJa: taxon.nameJa ? normalizeMatch(taxon.nameJa) : null,
  }));
  const notes: ListMjAnnotation[] = [];
  const mappings: ListMjSpeciesMapping[] = [];
  const skippedSpeciesRows: number[] = [];
  let cursor = 0;
  let family: string | null = null;
  let current: ListMjSpeciesMapping | null = null;
  // Both pinned documents use flat divs and explicit closing li tags. Check
  // those assumptions rather than silently accepting nested/malformed blocks.
  for (const block of html.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi)) {
    const classes = classNames(block[1] ?? '');
    const body = block[2] ?? '';
    if (classes.includes('family')) {
      const higher = /<span\b[^>]*class="highername"[^>]*>([\s\S]*?)<\/span\s*>/i.exec(body);
      family = higher ? htmlText(higher[1] ?? '').trim() : null;
    }
    if (classes.includes('species')) {
      if (/<div\b/i.test(body)) throw new Error('Nested species div requires an explicit parser update');
      const content = normalizeMatch(htmlText(body.replace(/<span\b[^>]*class="whats"[^>]*>[\s\S]*?<\/span\s*>/gi, '')));
      const candidates: { index: number; taxon: ListMjTaxon; score: number }[] = [];
      for (let index = cursor; index < comparison.length; index++) {
        const entry = comparison[index];
        if (!entry || entry.taxon.family !== family
          || (content !== entry.scientificName && !content.startsWith(`${entry.scientificName} `))) continue;
        if (entry.nameJa && !content.includes(entry.nameJa)) continue;
        candidates.push({ index, taxon: entry.taxon, score: entry.nameJa ? 2 : 1 });
      }
      const maximum = Math.max(...candidates.map((candidate) => candidate.score));
      const strongest = candidates.filter((candidate) => candidate.score === maximum);
      const first = strongest[0];
      const candidateTaxonCodes = strongest.map((candidate) => candidate.taxon.taxonCode);
      const canAdvance = first !== undefined && (strongest.length === 1 || first.index === cursor);
      if (canAdvance && first) {
        skippedSpeciesRows.push(...species.slice(cursor, first.index).map((taxon) => taxon.sourceRow));
        cursor = first.index + 1;
        current = {
          speciesBlock: mappings.length + 1, sourceRow: first.taxon.sourceRow,
          taxonCode: first.taxon.taxonCode, scientificName: first.taxon.scientificName,
          mappingStatus: strongest.length === 1 ? 'matched' : 'source_order', candidateTaxonCodes,
          evidence: strongest.length === 1 ? 'monotonic source order, family, full scientific-name prefix and Japanese name when present'
            : 'identical visible candidates; first source row used only as an ordering convention, not an identification',
        };
      } else {
        current = {
          speciesBlock: mappings.length + 1, sourceRow: null, taxonCode: null, scientificName: null,
          mappingStatus: strongest.length ? 'ambiguous' : 'unmatched', candidateTaxonCodes,
          evidence: strongest.length ? 'multiple candidates without an immediate source-order match' : 'no matching remaining source row',
        };
      }
      mappings.push(current);
    }
    if (classes.includes('note')) {
      if (/<div\b/i.test(body)) throw new Error('Nested note div requires an explicit parser update');
      for (const item of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
        const rawHtml = item[1] ?? '';
        const unambiguous = current?.mappingStatus === 'matched';
        notes.push({
          sourceItem: notes.length + 1, speciesBlock: current?.speciesBlock ?? null,
          taxonCode: unambiguous ? current?.taxonCode ?? null : null,
          sourceRow: unambiguous ? current?.sourceRow ?? null : null,
          note: readableNote(rawHtml), rawHtml,
          mappingStatus: unambiguous ? 'matched' : current && current.mappingStatus !== 'unmatched' ? 'ambiguous' : 'unmatched',
          candidateTaxonCodes: current?.candidateTaxonCodes ?? [],
        });
      }
    }
  }
  skippedSpeciesRows.push(...species.slice(cursor).map((taxon) => taxon.sourceRow));
  if (notes.length !== 975) throw new Error(`Pinned list.html note extraction changed: ${notes.length}`);
  if (mappings.length !== 6626) throw new Error(`Pinned list.html species extraction changed: ${mappings.length}`);
  return { notes, mappings, skippedSpeciesRows };
}

/** A conservative structural decomposition; the full citation always remains title. */
export function parseListMjReference(rawHtml: string, sourceItem: number): ListMjReference {
  z.number().int().min(1).max(999999).parse(sourceItem);
  const title = htmlText(z.string().min(1).parse(rawHtml)).trim();
  const reference: ListMjReference = {
    sourceItem, refCode: `R${String(sourceItem).padStart(6, '0')}`, title, rawHtml,
    authors: null, year: null, yearText: null, containerTitle: null, volume: null, issue: null, pages: null,
    parseStatus: 'unparsed', unparsedReason: 'author_year_prefix_not_unambiguous',
  };
  const prefix = /^(.*?)\s*,\s*((?:17|18|19|20)\d{2}[a-z]?(?:\s*\[[^\]]+\])?)\.\s+([\s\S]+)$/.exec(title);
  if (!prefix) return reference;
  reference.authors = prefix[1]?.trim() || null;
  reference.yearText = prefix[2] ?? null;
  reference.year = prefix[2] ? Number.parseInt(prefix[2].slice(0, 4), 10) : null;
  reference.parseStatus = 'partial';
  reference.unparsedReason = 'journal_volume_issue_pages_not_unambiguous';
  const remainder = prefix[3] ?? '';
  // Require a final sentence boundary, explicit volume/issue, and a page-range
  // tail. Books/chapters and ambiguous abbreviations remain partial, not guessed.
  const article = /\.\s+([^.\n]+?)\s+(?:(\d+)\s*)?(?:\(([^)]+)\)\s*)?:\s*([0-9IVXivx][0-9IVXivx,\-–—+ ]*)\.\s*$/.exec(remainder);
  if (!article || (!article[2] && !article[3])) return reference;
  const container = article[1]?.trim() ?? '';
  if (!container || /[,:]/.test(container)) return reference;
  reference.containerTitle = container;
  reference.volume = article[2] ?? null;
  reference.issue = article[3] ?? null;
  reference.pages = article[4]?.trim() ?? null;
  reference.parseStatus = 'parsed';
  reference.unparsedReason = null;
  return reference;
}

function literal(input: string | number | null): string {
  if (input === null) return 'null';
  return typeof input === 'number' ? String(input) : `'${input.replace(/'/g, "''")}'`;
}
function insertValues(table: string, rows: (string | number | null)[][]): string {
  const statements: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 300) {
    statements.push(`insert into ${table} values\n${rows.slice(offset, offset + 300)
      .map((row) => `(${row.map(literal).join(',')})`).join(',\n')};`);
  }
  return statements.join('\n');
}

function buildSql(notes: ListMjAnnotation[], references: ListMjReference[]): string {
  return `-- List-MJ offline annotations/references. No publication or taxonomy change.
-- list.html SHA-256: ${LIST_SHA256}
-- refs.html SHA-256: ${REFS_SHA256}; actual li count 281, specification count 282 (unresolved).
begin;
set local standard_conforming_strings = on;
select pg_advisory_xact_lock(hashtext('listmj:3-210603'));
create temporary table listmj_annotation_notes(source_item integer primary key, taxon_code text,
  source_row integer, note text not null, raw_html text not null) on commit drop;
create temporary table listmj_annotation_references(source_item integer primary key, ref_code text not null,
  title text not null, raw_html text not null, authors text, year integer, year_text text,
  container_title text, volume text, issue text, pages text, parse_status text not null) on commit drop;
${insertValues('listmj_annotation_notes', notes.map((note) => [note.sourceItem, note.taxonCode, note.sourceRow, note.note, note.rawHtml]))}
${insertValues('listmj_annotation_references', references.map((reference) => [
    reference.sourceItem, reference.refCode, reference.title, reference.rawHtml, reference.authors,
    reference.year, reference.yearText, reference.containerTitle, reference.volume, reference.issue,
    reference.pages, reference.parseStatus,
  ]))}
do $listmj_annotations$
declare v_backbone bigint;
begin
  select id into strict v_backbone from public.backbone_versions
    where source='List-MJ' and version_label='3-210603'
      and sha256='741184a92458724bec03b2e7a5641c31a3bfbfe85a529929ca9b0af70e69a072';
  if exists (select 1 from listmj_annotation_notes incoming left join public.taxa owner
    on owner.taxon_code=incoming.taxon_code where incoming.taxon_code is not null
      and (owner.id is null or owner.backbone_version_id is distinct from v_backbone
        or owner.source_row is distinct from incoming.source_row or owner.rank <> 'species')) then
    raise exception 'List-MJ annotation taxon identity conflict';
  end if;
  if exists (select 1 from public.taxon_changes existing join listmj_annotation_notes incoming
    on existing.source=${literal(LIST_SOURCE)} and existing.source_sha256=${literal(LIST_SHA256)}
      and existing.source_item=incoming.source_item where existing.source_raw is distinct from incoming.raw_html) then
    raise exception 'List-MJ immutable annotation source conflict';
  end if;
  if exists (select 1 from public.references_ existing join listmj_annotation_references incoming using (ref_code)
    where existing.metadata_source is distinct from ${literal(REFS_SOURCE)}
      or existing.source_sha256 is distinct from ${literal(REFS_SHA256)}
      or existing.source_item is distinct from incoming.source_item) then
    raise exception 'List-MJ permanent reference code conflict';
  end if;
  if exists (select 1 from public.references_ existing join listmj_annotation_references incoming
    on existing.metadata_source=${literal(REFS_SOURCE)} and existing.source_sha256=${literal(REFS_SHA256)}
      and existing.source_item=incoming.source_item
    where existing.ref_code <> incoming.ref_code or existing.source_raw is distinct from incoming.raw_html) then
    raise exception 'List-MJ immutable reference source identity conflict';
  end if;
  insert into public.taxon_changes(change_type, from_taxon_id, note, source, source_item, source_sha256, source_raw)
    select 'status', owner.id, incoming.note, ${literal(LIST_SOURCE)}, incoming.source_item,
      ${literal(LIST_SHA256)}, incoming.raw_html from listmj_annotation_notes incoming
    left join public.taxa owner on owner.taxon_code=incoming.taxon_code order by incoming.source_item
    on conflict (source, source_sha256, source_item) do nothing;
  insert into public.references_(ref_code, ref_type, title, year, year_text, container_title,
    volume, issue, pages, metadata_source, status, auto_published, source_item, source_sha256,
    source_raw, source_authors)
    select ref_code, case when parse_status='parsed' then 'article' else 'other' end,
      title, year, year_text, container_title, volume, issue, pages, ${literal(REFS_SOURCE)},
      'pending', false, source_item, ${literal(REFS_SHA256)}, raw_html, authors
    from listmj_annotation_references order by source_item
    on conflict (metadata_source, source_sha256, source_item) do nothing;
end
$listmj_annotations$;
commit;
`;
}

/** Preserve every real source item, including unresolved bibliographic metadata. */
export function buildListMjAnnotations(sourceDirectory = 'seed/source'): ListMjAnnotationsResult {
  const backbone = buildListMjImport(sourceDirectory);
  const listHtml = verifiedHtml(sourceDirectory, 'list.html', LIST_SHA256);
  const refsHtml = verifiedHtml(sourceDirectory, 'refs.html', REFS_SHA256);
  const { notes, mappings, skippedSpeciesRows } = parseNotes(listHtml, backbone.taxa.filter((taxon) => taxon.rank === 'species'));
  const references = [...refsHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)]
    .map((item, index) => parseListMjReference(item[1] ?? '', index + 1));
  // This is the actual, independently counted hash-pinned source, not the
  // specification's 282. Do not create a placeholder to disguise the difference.
  if (references.length !== 281) throw new Error(`Pinned refs.html extraction changed: ${references.length}`);
  const incomplete = references.filter((reference) => reference.parseStatus !== 'parsed');
  const report: ListMjAnnotationsReport = {
    source: { listHtmlSha256: LIST_SHA256, refsHtmlSha256: REFS_SHA256 },
    counts: {
      speciesBlocks: mappings.length, notes: notes.length, references: references.length,
      parsedReferences: references.filter((reference) => reference.parseStatus === 'parsed').length,
      partialReferences: references.filter((reference) => reference.parseStatus === 'partial').length,
      unparsedReferences: references.filter((reference) => reference.parseStatus === 'unparsed').length,
      incompleteReferences: incomplete.length,
    },
    acceptance: { expectedNotes: 975, expectedReferences: 282, passed: notes.length === 975 && Number(references.length) === 282 },
    sourceDiscrepancies: [{ kind: 'references_count', expected: 282, actual: references.length, passed: false }],
    alignment: {
      skippedSpeciesRows, speciesMappings: mappings,
      unresolvedNotes: notes.filter((note) => note.mappingStatus !== 'matched').map((note) => note.sourceItem),
      note: 'HTMLは6,626 speciesブロック、XLSXは6,628行。科学名全体・和名・科・単調な原順序で対応し、行2871と5962がHTMLに現れない。同一表示のWestermanniaは原順序の便宜的対応であり同定の根拠ではない。曖昧なブロックの注釈は税群を強制設定しない。',
    },
    unparsedReferences: incomplete.map((reference) => ({
      sourceItem: reference.sourceItem, refCode: reference.refCode, title: reference.title,
      reason: reference.unparsedReason ?? 'incomplete_metadata',
    })),
    parsingNote: 'titleはHTMLタグを除去・文字参照を復号した原引用全文。source_rawはli内のHTMLをそのまま保持。著者列は原文字列を保持し、人名分割は推測しない。誌名・巻号・頁の構造を安全に分けられない書籍等はpartialとして不足一覧に残す。countsのparsed/partial/unparsedは相互排他的。incompleteReferencesとunparsedReferences一覧はpartialとunparsedの両方を含む。parsedは構造的な正規表現一致であり書誌の外部照合済みを意味しない。',
  };
  return { sql: buildSql(notes, references), report, notes, references };
}
