import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { encodeTable, type Scalar } from '../packages/public-data/src/index.ts';
import { createSearchIndex, searchNames } from '../packages/public-data/src/search.ts';

// Synthetic name fixtures exercise matching only; they are never public occurrence data.
const rows: Scalar[][] = [
  ['M000001', 'Eumeta japonica', 'オオミノガ', ''],
  ['M000002', 'Currentgenus exemplaris', 'テストコバネ', 'Oldgenus exemplaris\n旧テストコバネ'],
  ['M000004', 'Sharedgenus testus', 'テストガ甲', ''],
  ['M000003', 'Sharedgenus testus', 'テストガ乙', 'テスト別名'],
  ['M000005', 'Eumeta', null, ''],
  ['M000006', 'Example prefixus', 'マエテストガ', 'Eumeta japon'],
  ['M000007', 'Example substringus', 'ウシロテストガ', 'Prefix Eumeta japon suffix'],
];
const makeIndex = () => createSearchIndex(encodeTable('names-v1', rows));

describe('public browser name search', () => {
  it('matches Japanese hiragana and halfwidth names, and fullwidth Latin case', () => {
    const index = makeIndex();
    for (const query of ['おおみのが', 'ｵｵﾐﾉｶﾞ', 'オオミノガ']) expect(searchNames(index, query).map(result => result.taxon)).toEqual(['M000001']);
    expect(searchNames(index, 'ＥＵＭＥＴＡ　ＪＡＰＯＮＩＣＡ')[0]?.taxon).toBe('M000001');
  });

  it('retains the matched old name while guiding a synonym to its current scientific name', () => {
    const [result] = searchNames(makeIndex(), 'oldgenus exemplaris');
    expect(result).toEqual({ taxon: 'M000002', scientificName: 'Currentgenus exemplaris', nameJa: 'テストコバネ', matchedName: 'Oldgenus exemplaris', viaAlias: true, collisionCount: 1 });
    expect(searchNames(makeIndex(), 'きゅうテストコバネ')).toEqual([]);
    expect(searchNames(makeIndex(), '旧てすとこばね')[0]?.viaAlias).toBe(true);
  });

  it('keeps all same-name taxon candidates and orders equal scores by permanent code', () => {
    const results = searchNames(makeIndex(), 'Sharedgenus testus');
    expect(results.map(result => result.taxon)).toEqual(['M000003', 'M000004']);
    expect(results.map(result => result.collisionCount)).toEqual([2, 2]);
    expect(searchNames(makeIndex(), 'テスト別名')[0]?.collisionCount).toBe(2);
  });

  it('orders exact matches before prefixes and substrings while accepting multiple tokens', () => {
    const results = searchNames(makeIndex(), 'Eumeta japon');
    expect(results.map(result => result.taxon)).toEqual(['M000006', 'M000001', 'M000007']);
    expect(searchNames(makeIndex(), 'japonica eumeta')[0]?.taxon).toBe('M000001');
    expect(searchNames(makeIndex(), 'eumeta おおみのが')[0]?.viaAlias).toBe(false);
    expect(searchNames(makeIndex(), 'Currentgenus 旧テストコバネ')[0]?.viaAlias).toBe(true);
    expect(searchNames(makeIndex(), 'Eumeta')[0]?.taxon).toBe('M000005');
  });

  it('handles empty/unknown queries and enforces the input length limit', () => {
    const index = makeIndex();
    for (const query of ['', '　 \n', 'not-a-registered-name']) expect(searchNames(index, query)).toEqual([]);
    expect(() => searchNames(index, 'x'.repeat(161))).toThrow(z.ZodError);
    expect(searchNames(index, 'x'.repeat(160))).toEqual([]);
  });

  it('rejects malformed DTOs, wrong formats, invalid row values and duplicate codes', () => {
    expect(() => createSearchIndex({})).toThrow(z.ZodError);
    expect(() => createSearchIndex(encodeTable('taxa-v1', []))).toThrow(z.ZodError);
    expect(() => createSearchIndex(encodeTable('names-v1', [['M000001', 'Eumeta japonica', 1, '']]))).toThrow(z.ZodError);
    expect(() => createSearchIndex(encodeTable('names-v1', [rows[0] ?? [], rows[0] ?? []]))).toThrow(z.ZodError);
    const invalidIndex = encodeTable('names-v1', rows);
    const first = invalidIndex.rows[0];
    if (!first) throw new Error('Missing fixture row');
    first[0] = 99999;
    expect(() => createSearchIndex(invalidIndex)).toThrow(z.ZodError);
  });

  it('keeps its normalized index independent of later input dictionary mutations', () => {
    const input = encodeTable('names-v1', rows);
    const index = createSearchIndex(input);
    const dictionary = input.dictionaries.scientific_name;
    if (!dictionary) throw new Error('Missing fixture dictionary');
    dictionary[0] = 'Changed after parsing';
    expect(searchNames(index, 'Eumeta japonica')[0]?.scientificName).toBe('Eumeta japonica');
    expect(searchNames(index, 'Changed after parsing')).toEqual([]);
  });
});
