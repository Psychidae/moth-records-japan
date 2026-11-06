import { z } from 'zod';
import { decodeTable, tableSchema } from './index.ts';

const nameRowSchema = z.strictObject({
  taxon: z.string().regex(/^M\d{6}$/),
  scientific_name: z.string().min(1),
  name_ja: z.string().nullable(),
  other_names: z.string(),
});

const namesSchema = tableSchema.extend({ format: z.literal('names-v1') })
  .transform((table, context) => {
    try {
      return decodeTable(table);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid public names table' });
      return z.NEVER;
    }
  })
  .pipe(z.array(nameRowSchema).superRefine((rows, context) => {
    const codes = new Set<string>();
    rows.forEach((row, index) => {
      if (codes.has(row.taxon)) context.addIssue({ code: 'custom', path: [index, 'taxon'], message: 'Duplicate public taxon code' });
      codes.add(row.taxon);
    });
  }));

interface IndexedName {
  readonly original: string;
  readonly normalized: string;
  readonly viaAlias: boolean;
}

interface IndexedTaxon {
  readonly taxon: string;
  readonly scientificName: string;
  readonly nameJa: string | null;
  readonly names: readonly IndexedName[];
  readonly collisionCount: number;
}

export interface SearchIndex {
  readonly entries: readonly IndexedTaxon[];
}

export interface SearchResult {
  taxon: string;
  scientificName: string;
  nameJa: string | null;
  matchedName: string;
  viaAlias: boolean;
  collisionCount: number;
}

function normalize(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u3041-\u3096]/g, character => String.fromCharCode(character.charCodeAt(0) + 0x60))
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parse the public DTO and normalize its names once, after a user search operation. */
export function createSearchIndex(input: unknown): SearchIndex {
  const rows = namesSchema.parse(input);
  const normalizedNames = new Map<string, string>();
  function cachedNormalize(value: string): string {
    const cached = normalizedNames.get(value);
    if (cached !== undefined) return cached;
    const normalized = normalize(value);
    normalizedNames.set(value, normalized);
    return normalized;
  }
  const collisions = new Map<string, number>();
  for (const row of rows) {
    const scientific = cachedNormalize(row.scientific_name);
    collisions.set(scientific, (collisions.get(scientific) ?? 0) + 1);
  }
  return {
    entries: rows.map(row => {
      const names = new Map<string, IndexedName>();
      function add(original: string, viaAlias: boolean) {
        const normalized = cachedNormalize(original);
        if (normalized && !names.has(normalized)) names.set(normalized, { original, normalized, viaAlias });
      }
      add(row.scientific_name, false);
      if (row.name_ja) add(row.name_ja, false);
      for (const alias of row.other_names.split(/\r?\n/)) add(alias.trim(), true);
      return {
        taxon: row.taxon,
        scientificName: row.scientific_name,
        nameJa: row.name_ja,
        names: [...names.values()],
        collisionCount: collisions.get(cachedNormalize(row.scientific_name)) ?? 1,
      };
    }),
  };
}

/** Return every matching permanent code; an identical scientific name is never merged. */
export function searchNames(index: SearchIndex, query: string): SearchResult[] {
  const normalized = normalize(z.string().max(160).parse(query));
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  const scored: { score: number; result: SearchResult }[] = [];
  for (const entry of index.entries) {
    if (!tokens.every(token => entry.names.some(name => name.normalized.includes(token)))) continue;
    const singleNameMatches = entry.names.filter(name => tokens.every(token => name.normalized.includes(token)));
    const scoreName = (name: IndexedName): number => {
      const match = name.normalized === normalized ? 0 : name.normalized.startsWith(normalized) ? 1 : name.normalized.includes(normalized) ? 2 : 3;
      return match * 2 + Number(name.viaAlias);
    };
    const best = singleNameMatches.sort((a, b) => scoreName(a) - scoreName(b))[0];
    const requiresAlias = !tokens.every(token => entry.names.some(name => !name.viaAlias && name.normalized.includes(token)));
    const alias = requiresAlias ? entry.names.find(name => name.viaAlias && tokens.some(token => name.normalized.includes(token))) : undefined;
    scored.push({
      score: best ? scoreName(best) : 8 + Number(requiresAlias),
      result: {
        taxon: entry.taxon,
        scientificName: entry.scientificName,
        nameJa: entry.nameJa,
        matchedName: best?.original ?? alias?.original ?? entry.scientificName,
        viaAlias: best?.viaAlias ?? requiresAlias,
        collisionCount: entry.collisionCount,
      },
    });
  }
  scored.sort((a, b) => a.score - b.score || (a.result.taxon < b.result.taxon ? -1 : a.result.taxon > b.result.taxon ? 1 : 0));
  return scored.map(entry => entry.result);
}
