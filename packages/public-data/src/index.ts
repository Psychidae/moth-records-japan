import { z } from 'zod';

export const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalar>;
// Wire values are distinct from the priority-row numbers in docs/03 section 6.
// Sparse matrices omit 0; sensitivity 2 always uses 6 without source/discovery.
export const evidenceCodes = {none:0,original:1,citation:2,specimen:3,photo_rg:4,needs_review:5,presence_only:6} as const;
export const needsCsvNeutralization = (value:string):boolean => /^[\x00-\x1f\x7f]/.test(value) || /^[\s\uFEFF]*[=+\-@]/.test(value);
export const tableSchema = z.strictObject({ format: z.string(), columns: z.array(z.string()).min(1), dictionaries: z.record(z.string(), z.array(scalar)), rows: z.array(z.array(z.number().int().nonnegative())) });
export type ColumnarTable = z.infer<typeof tableSchema>;
export const columns = {
  'names-v1': ['taxon', 'scientific_name', 'name_ja', 'other_names'],
  'taxa-v1': ['taxon', 'parent', 'rank', 'scientific_name', 'name_ja', 'family', 'authorship', 'status', 'sensitivity'],
  'regions-v1': ['region', 'region_type', 'name_ja', 'name_en', 'parent', 'area_group', 'sort_order'],
  'records-v1': ['record_code', 'taxon', 'region', 'island', 'reference', 'page', 'name_as_published', 'category', 'accuracy', 'status', 'credit', 'locality_verbatim', 'locality_modern', 'lat', 'lon', 'event_date_verbatim', 'date_start', 'date_end', 'collector_verbatim', 'specimen_ref', 'note', 'individual_count', 'sex', 'life_stage', 'depository', 'coord_uncertainty_m'],
  'references-v1': ['ref_code', 'title', 'title_en', 'year', 'year_text', 'container_title', 'volume', 'issue', 'pages', 'publisher', 'doi', 'authors'],
  'matrix-v1': ['taxon', 'region', 'evidence', 'discovery'],
  'photos-v1': ['taxon', 'observation_url', 'image_url', 'license_code', 'attribution', 'life_stage'],
} as const;
export type TableFormat = keyof typeof columns;
export const detailColumns = columns['records-v1'].slice(11);

export function encodeTable(format: TableFormat, values: Scalar[][]): ColumnarTable {
  const names = [...columns[format]];
  const dictionaries: Record<string, Scalar[]> = Object.fromEntries(names.map(name => [name, []]));
  const indexes = names.map(() => new Map<Scalar, number>());
  const rows = values.map(row => {
    if (row.length !== names.length) throw new Error('Public row column count mismatch');
    return row.map((value, i) => {
      scalar.parse(value);
      const name = names[i]; const index = indexes[i];
      if (name === undefined || index === undefined) throw new Error('Unknown public column');
      const known = index.get(value);
      if (known !== undefined) return known;
      const dictionary = dictionaries[name];
      if (dictionary === undefined) throw new Error('Missing public dictionary');
      const next = dictionary.length; dictionary.push(value); index.set(value, next); return next;
    });
  });
  return { format, columns: names, dictionaries, rows };
}

export function decodeTable(input: unknown): Record<string, Scalar>[] {
  const table = tableSchema.parse(input);
  const expected = columns[table.format as TableFormat];
  if (!expected || JSON.stringify(table.columns) !== JSON.stringify(expected) || JSON.stringify(Object.keys(table.dictionaries).sort()) !== JSON.stringify([...expected].sort())) throw new Error('Unknown public table columns');
  return table.rows.map(row => {
    if (row.length !== table.columns.length) throw new Error('Public row width mismatch');
    return Object.fromEntries(table.columns.map((column, i) => {
      const index = row[i]; const values = table.dictionaries[column];
      if (index === undefined || values === undefined || index >= values.length) throw new Error('Public dictionary index out of range');
      return [column, values[index] ?? null];
    }));
  });
}
