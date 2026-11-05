import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

/** The CLI prepares seed statements before TEMP tables exist. Defer one batch. */
export function asSupabaseSeedSql(input: string): string {
  const sql = z.string().min(1).parse(input);
  if ((sql.match(/^begin;$/gm) ?? []).length !== 1 || (sql.match(/^commit;$/gm) ?? []).length !== 1 || !/\ncommit;\s*$/.test(sql)) {
    throw new Error('Expected one generated BEGIN/COMMIT import transaction');
  }
  if (sql.includes('$supabase_seed_body$') || sql.includes('$supabase_seed$')) throw new Error('SQL delimiter conflict');
  const body = sql.replace(/^begin;\r?\n/m, '').replace(/^commit;\s*$/m, '');
  return `do $supabase_seed$ begin execute $supabase_seed_body$\n${body}\n$supabase_seed_body$; end $supabase_seed$;\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, outputPath] = z.tuple([z.string().min(1), z.string().min(1)]).parse(process.argv.slice(2));
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('Keep canonical import SQL separate from the seed adapter');
  writeFileSync(outputPath, asSupabaseSeedSql(readFileSync(inputPath, 'utf8')));
}
