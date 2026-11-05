import { spawn } from 'node:child_process';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxUncompressedBytes = 2 * 1024 * 1024 * 1024;
const maxRowBytes = 1024 * 1024;
const maxMemberListBytes = 1024 * 1024;
const requiredColumns = ['level1Gid', 'acceptedTaxonKey', 'taxonKey', 'speciesKey',
  'datasetKey', 'countryCode', 'basisOfRecord', 'scientificName', 'taxonRank'] as const;
const headerSchema = z.array(z.string().min(1).max(2048)).min(1).max(512);

function columnName(header: string): string {
  let name = header;
  if (/^https?:\/\/(?:rs\.tdwg\.org\/dwc\/terms\/|rs\.gbif\.org\/terms\/(?:1\.0|gadm\/3\.0)\/|purl\.org\/dc\/(?:terms|elements\/1\.1)\/)/.test(header)) {
    name = header.split(/[\/#]/).at(-1) ?? '';
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('Invalid occurrence column name');
  }
  return name;
}

/** Parses one bounded TSV record at a time; no raw occurrence table is retained. */
export async function* parseTsvRows(
  chunks: AsyncIterable<Uint8Array | string>,
  options: { fieldsEnclosedBy?: '' | '"' } = {},
): AsyncGenerator<Record<string, string>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const quoted = options.fieldsEnclosedBy === '"';
  let columns: string[] | undefined;
  let fields: string[] = [];
  let field = '';
  const parser: { state: 'plain' | 'quoted' | 'closed' } = { state: 'plain' };
  let rowBytes = 0;
  let totalBytes = 0;
  let rowStarted = false;
  let skipLf = false;

  function finishRow(): Record<string, string> | undefined {
    fields.push(field);
    let result: Record<string, string> | undefined;
    if (columns === undefined) {
      columns = headerSchema.parse(fields).map(columnName);
      if (new Set(columns).size !== columns.length) throw new Error('Duplicate occurrence column');
      for (const required of requiredColumns) {
        if (!columns.includes(required)) throw new Error(`Missing required occurrence column: ${required}`);
      }
    } else {
      if (fields.length !== columns.length) throw new Error('Occurrence row has wrong column count');
      result = Object.fromEntries(columns.map((column, index) => [column, fields[index] ?? '']));
    }
    fields = [];
    field = '';
    parser.state = 'plain';
    rowBytes = 0;
    rowStarted = false;
    return result;
  }

  function* textRows(text: string): Generator<Record<string, string>> {
    for (const character of text) {
      if (skipLf) {
        skipLf = false;
        if (character === '\n') continue;
      }
      rowStarted = true;
      rowBytes += Buffer.byteLength(character, 'utf8');
      if (rowBytes > maxRowBytes) throw new Error('Occurrence row exceeds 1 MiB');
      if (parser.state === 'quoted') {
        if (character === '"') parser.state = 'closed';
        else field += character;
      } else if (parser.state === 'closed' && character === '"') {
        field += '"';
        parser.state = 'quoted';
      } else if (character === '\t') {
        fields.push(field);
        if (fields.length >= 512) throw new Error('Too many occurrence columns');
        field = '';
        parser.state = 'plain';
      } else if (character === '\n' || character === '\r') {
        const row = finishRow();
        skipLf = character === '\r';
        if (row !== undefined) yield row;
      } else if (parser.state === 'closed') {
        throw new Error('Unexpected character after quoted occurrence field');
      } else if (character === '"' && quoted) {
        if (field !== '') throw new Error('Unexpected quote in occurrence field');
        parser.state = 'quoted';
      } else {
        field += character;
      }
    }
  }

  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid occurrence stream chunk');
    totalBytes += bytes.byteLength;
    if (totalBytes > maxUncompressedBytes) throw new Error('Occurrence stream exceeds 2 GiB');
    yield* textRows(decoder.decode(bytes, { stream: true }));
  }
  yield* textRows(decoder.decode());
  if (parser.state === 'quoted') throw new Error('Incomplete quoted occurrence field');
  if (rowStarted) {
    const row = finishRow();
    if (row !== undefined) yield row;
  }
  if (columns === undefined) throw new Error('Missing occurrence header');
}

function unzipProcess(args: string[]) {
  // No shell and no extraction. Only an exact, validated root member is piped.
  const child = spawn('unzip', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let failed = false;
  let diagnosticBytes = 0;
  child.on('error', () => { failed = true; });
  child.stdout.on('error', () => { failed = true; });
  child.stderr.on('error', () => { failed = true; });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.byteLength;
    if (diagnosticBytes > maxMemberListBytes) {
      failed = true;
      child.kill('SIGKILL');
    }
  });
  const completed = new Promise<boolean>(resolve => {
    child.on('close', code => { resolve(!failed && code === 0); });
  });
  async function stop() {
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await completed;
  }
  return { child, completed, stop };
}

async function requireOccurrenceMember(archivePath: string): Promise<void> {
  const process = unzipProcess(['-Z1', archivePath]);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of process.child.stdout) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Invalid ZIP member listing');
      length += chunk.byteLength;
      if (length > maxMemberListBytes) throw new Error('ZIP member listing exceeds its limit');
      chunks.push(chunk);
    }
    if (!await process.completed) throw new Error('Could not read ZIP member listing');
    const names = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      .split('\n').filter(name => name !== '');
    if (names.length > 10000 || names.some(name => name.length > 2048 || name.startsWith('/')
      || name.includes('\\') || name.split('/').includes('..') || /[\r\0]/.test(name))) {
      throw new Error('Unsafe ZIP member list');
    }
    if (names.filter(name => name === 'occurrence.txt').length !== 1) {
      throw new Error('ZIP must contain exactly one root occurrence.txt');
    }
  } finally { await process.stop(); }
}

async function saveArchive(response: Response, archivePath: string): Promise<void> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('GBIF archive response is unavailable');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxArchiveBytes))) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('GBIF archive exceeds 2 GiB or has an invalid size');
  }
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let finished = false;
  let totalBytes = 0;
  try {
    file = await open(archivePath, 'wx', 0o600);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxArchiveBytes) throw new Error('GBIF archive exceeds 2 GiB');
      await file.writeFile(chunk.value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close();
  }
}

/** A complete and CRC-checked stream is required before the consumer result returns. */
export async function streamOccurrenceArchive<T>(
  response: Response,
  consume: (rows: AsyncIterable<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'moth-gbif-archive-'));
  try {
    await chmod(directory, 0o700);
    const archivePath = join(directory, 'download.zip');
    await saveArchive(response, archivePath);
    await requireOccurrenceMember(archivePath);
    const process = unzipProcess(['-p', archivePath, 'occurrence.txt']);
    let fullyRead = false;
    async function* rows() {
      // GBIF's DwcArchiveUtils sets fieldsEnclosedBy=null. Quotes are literal
      // data here; quoted CSV-style fixtures explicitly use a separate mode.
      yield* parseTsvRows(process.child.stdout, { fieldsEnclosedBy: '' });
      if (!await process.completed) throw new Error('Occurrence ZIP member failed validation');
      fullyRead = true;
    }
    const iterator = rows();
    try {
      const result = await consume(iterator);
      if (!fullyRead) throw new Error('Occurrence consumer did not read the complete archive');
      return result;
    } finally {
      await process.stop();
      await iterator.return(undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
