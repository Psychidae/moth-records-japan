import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTsvRows, streamOccurrenceArchive } from '../pipelines/sync-gbif/src/archive.js';

const header = ['scientificName', 'datasetKey', 'level1Gid', 'taxonKey', 'countryCode',
  'acceptedTaxonKey', 'speciesKey', 'taxonRank', 'basisOfRecord'];
const row = ['Example first', 'dataset-example', 'JPN.12_1', '123', 'JP', '123', '123', 'SPECIES', 'PRESERVED_SPECIMEN'];
const text = header.join('\t') + '\n' + row.join('\t') + '\n';

async function* chunked(value: string, size = 7) {
  const bytes = new TextEncoder().encode(value);
  for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
}

async function collect(rows: AsyncIterable<Record<string, string>>) {
  const result: Record<string, string>[] = [];
  for await (const item of rows) result.push(item);
  return result;
}

function makeArchive(files: Record<string, string>, stored = false): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'moth-gbif-fixture-'));
  try {
    for (const [filename, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, filename)), { recursive: true });
      writeFileSync(join(directory, filename), contents);
    }
    execFileSync('zip', [stored ? '-q0' : '-q', join(directory, 'fixture.zip'), ...Object.keys(files)], { cwd: directory });
    return readFileSync(join(directory, 'fixture.zip'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function response(bytes: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 13) controller.enqueue(bytes.subarray(index, index + 13));
      controller.close();
    },
  }));
}

function archiveDirectories(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith('moth-gbif-archive-')).sort();
}

describe('bounded streaming Darwin Core TSV parser', () => {
  it('reads columns by name, across UTF-8 byte boundaries, quoted tabs and multiline fields', async () => {
    const quoted = '"テスト ""first""\tline\r\nsecond"';
    const source = '\uFEFF' + header.join('\t') + '\r\n' + [quoted, ...row.slice(1)].join('\t') + '\r\n';
    expect(await collect(parseTsvRows(chunked(source, 1), { fieldsEnclosedBy: '"' }))).toEqual([{
      scientificName: 'テスト "first"\tline\r\nsecond', datasetKey: 'dataset-example', level1Gid: 'JPN.12_1',
      taxonKey: '123', countryCode: 'JP', acceptedTaxonKey: '123', speciesKey: '123',
      taxonRank: 'SPECIES', basisOfRecord: 'PRESERVED_SPECIMEN',
    }]);
    expect(await collect(parseTsvRows(chunked(text.trimEnd())))).toHaveLength(1);
    expect(await collect(parseTsvRows(chunked(header.join('\t') + '\n')))).toEqual([]);
  });

  it('recognizes official term URI local names and rejects duplicate normalized columns', async () => {
    const names = header.map(name => name === 'level1Gid'
      ? 'http://rs.gbif.org/terms/gadm/3.0/level1Gid'
      : 'http://rs.gbif.org/terms/1.0/' + name);
    expect((await collect(parseTsvRows(chunked(names.join('\t') + '\n' + row.join('\t') + '\n'))))[0]?.level1Gid)
      .toBe('JPN.12_1');
    await expect(collect(parseTsvRows(chunked(header.join('\t') + '\thttp://rs.gbif.org/terms/gadm/3.0/level1Gid\n'))))
      .rejects.toThrow('Duplicate');
  });

  it('fails on missing GADM data, malformed widths, invalid UTF-8 and incomplete/stray quotes', async () => {
    const malformed = [
      '',
      header.filter(name => name !== 'level1Gid').join('\t') + '\n',
      header.join('\t') + '\n' + row.slice(1).join('\t') + '\n',
      header.join('\t') + '\n' + row.join('\t') + '\textra\n',
      header.join('\t') + '\n"unfinished',
      header.join('\t') + '\n' + ['bad"quote', ...row.slice(1)].join('\t') + '\n',
      header.join('\t') + '\n' + ['"closed"stray', ...row.slice(1)].join('\t') + '\n',
      header.join('\t') + '\t__proto__\n',
    ];
    for (const source of malformed) await expect(collect(parseTsvRows(chunked(source), { fieldsEnclosedBy: '"' }))).rejects.toThrow();
    await expect(collect(parseTsvRows(chunked(malformed[1] ?? '')))).rejects.toThrow('level1Gid');
    async function* invalidUtf8() { yield new Uint8Array([0xff]); }
    await expect(collect(parseTsvRows(invalidUtf8()))).rejects.toThrow();
  });

  it('stops a record before it can exceed one MiB of raw field data', async () => {
    const tooLong = header.join('\t') + '\n' + ['x'.repeat(1024 * 1024), ...row.slice(1)].join('\t') + '\n';
    await expect(collect(parseTsvRows(chunked(tooLong, 16384)))).rejects.toThrow('1 MiB');
  });

  it('preserves literal quotes in the official unenclosed GBIF format', async () => {
    for (const name of ['"literal', 'literal "middle" quote', '"unclosed "quotes']) {
      const source = header.join('\t') + '\n' + [name, ...row.slice(1)].join('\t') + '\n';
      expect((await collect(parseTsvRows(chunked(source, 1), { fieldsEnclosedBy: '' })))[0]?.scientificName).toBe(name);
    }
  });
});

describe('private temporary GBIF ZIP streaming', () => {
  it('streams only the root occurrence member, uses private permissions and removes the archive after success', async () => {
    const before = archiveDirectories();
    const archive = makeArchive({ 'meta.xml': '<archive/>', 'occurrence.txt': text, 'multimedia.txt': 'ignored raw member' });
    const result = await streamOccurrenceArchive(response(archive), async rows => {
      const created = archiveDirectories().filter(name => !before.includes(name));
      expect(created).toHaveLength(1);
      const directory = join(tmpdir(), created[0] ?? 'missing');
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, 'download.zip')).mode & 0o777).toBe(0o600);
      return collect(rows);
    });
    expect(result).toEqual([Object.fromEntries(header.map((name, index) => [name, row[index]]))]);
    expect(archiveDirectories()).toEqual(before);
  });

  it('fails on missing/nested occurrence members, malformed ZIPs and schema failures, always cleaning up', async () => {
    const before = archiveDirectories();
    const archives = [
      makeArchive({ 'meta.xml': '<archive/>' }),
      makeArchive({ 'nested/occurrence.txt': text }),
      new TextEncoder().encode('not a ZIP archive'),
      makeArchive({ 'occurrence.txt': header.filter(name => name !== 'level1Gid').join('\t') + '\n' }),
      makeArchive({ 'occurrence.txt': header.join('\t') + '\n"unfinished' }),
    ];
    for (const archive of archives) {
      await expect(streamOccurrenceArchive(response(archive), collect)).rejects.toThrow();
      expect(archiveDirectories()).toEqual(before);
    }
  });

  it('always reads actual archives in the official unenclosed GBIF format', async () => {
    const name = '"literal unclosed "quote';
    const archive = makeArchive({ 'occurrence.txt': header.join('\t') + '\n' + [name, ...row.slice(1)].join('\t') + '\n' });
    expect((await streamOccurrenceArchive(response(archive), collect))[0]?.scientificName).toBe(name);
  });

  it('refuses traversal members without extracting anything', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moth-gbif-fixture-'));
    const before = archiveDirectories();
    try {
      mkdirSync(join(directory, 'nested'));
      writeFileSync(join(directory, 'occurrence.txt'), text);
      execFileSync('zip', ['-q', join(directory, 'fixture.zip'), '../occurrence.txt'], { cwd: join(directory, 'nested') });
      await expect(streamOccurrenceArchive(response(readFileSync(join(directory, 'fixture.zip'))), collect)).rejects.toThrow('Unsafe ZIP');
      expect(archiveDirectories()).toEqual(before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects CRC failures even when the emitted TSV remains structurally valid', async () => {
    const before = archiveDirectories();
    const archive = Buffer.from(makeArchive({ 'occurrence.txt': text }, true));
    const position = archive.indexOf(Buffer.from('Example first'));
    expect(position).toBeGreaterThan(0);
    archive[position] = 'X'.charCodeAt(0);
    await expect(streamOccurrenceArchive(response(archive), collect)).rejects.toThrow('failed validation');
    expect(archiveDirectories()).toEqual(before);
  });

  it('cleans up after a consumer error or incomplete consumption and cancels failed response streams', async () => {
    const before = archiveDirectories();
    const archive = makeArchive({ 'occurrence.txt': text });
    await expect(streamOccurrenceArchive(response(archive), async rows => {
      for await (const item of rows) {
        expect(item.level1Gid).toBe('JPN.12_1');
        throw new Error('consumer failed');
      }
      return null;
    })).rejects.toThrow('consumer failed');
    expect(archiveDirectories()).toEqual(before);
    await expect(streamOccurrenceArchive(response(archive), async () => 1)).rejects.toThrow('complete archive');
    expect(archiveDirectories()).toEqual(before);
    const failedResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('download interrupted')); },
    }));
    await expect(streamOccurrenceArchive(failedResponse, collect)).rejects.toThrow('download interrupted');
    expect(archiveDirectories()).toEqual(before);
  });

  it('rejects unavailable and declared oversize downloads before processing raw data', async () => {
    const before = archiveDirectories();
    await expect(streamOccurrenceArchive(new Response('unavailable', { status: 503 }), collect)).rejects.toThrow('unavailable');
    let cancelled = false;
    const oversize = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: { 'content-length': String(2 * 1024 * 1024 * 1024 + 1) } });
    await expect(streamOccurrenceArchive(oversize, collect))
      .rejects.toThrow('2 GiB');
    expect(cancelled).toBe(true);
    expect(archiveDirectories()).toEqual(before);
  });
});
