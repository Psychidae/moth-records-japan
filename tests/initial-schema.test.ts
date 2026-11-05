import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from './helpers/database.js';
import { generateSeedSql, parseCsv, parseSeedData } from '../supabase/seed.js';

const sourceSchema = readFileSync('docs/02_schema.sql');
const migration = readFileSync('supabase/migrations/0001_init.sql');
const prelude = readFileSync('supabase/migrations/0000_restrict_defaults.sql', 'utf8');
const hardening = readFileSync('supabase/migrations/0002_harden_privileges.sql', 'utf8');
const functionHardening = readFileSync('supabase/migrations/0003_harden_functions.sql', 'utf8');
const featureCsv = readFileSync('seed/feature_flags.csv', 'utf8');
const resourceCsv = readFileSync('seed/external_resources.csv', 'utf8');
const seed = readFileSync('supabase/seed.sql', 'utf8');
const expected = parseSeedData(featureCsv, resourceCsv);

it('keeps the canonical schema byte-for-byte, without local Auth scaffolding', () => {
  expect(migration.equals(sourceSchema)).toBe(true);
  expect(migration.toString()).not.toMatch(/create (?:role anon|schema auth|table auth\.users)/);
});

it('generates deterministic seed SQL exactly from the validated source CSVs', () => {
  expect(generateSeedSql(featureCsv, resourceCsv)).toBe(seed);
  expect(generateSeedSql(featureCsv, resourceCsv)).toBe(seed);
  expect(expected.flags).toHaveLength(16);
  expect(expected.resources).toHaveLength(10);
});

it('rejects malformed, duplicate and unknown seed input and escapes quoted data', () => {
  expect(parseCsv('a,b\r\n"with,comma","a""quote"\r\n')).toEqual([{ a: 'with,comma', b: 'a"quote' }]);
  expect(parseCsv('a,b\n"two\nlines",ok\n')).toEqual([{ a: 'two\nlines', b: 'ok' }]);
  expect(() => parseCsv('a,a\nx,y\n')).toThrow('Invalid CSV headers');
  expect(() => parseCsv('a,b\nx\n')).toThrow('wrong column count');
  expect(() => parseCsv('a\n"unclosed')).toThrow('Unclosed');
  expect(() => parseSeedData(featureCsv.replace('false', 'yes'), resourceCsv)).toThrow();
  expect(() => parseSeedData(featureCsv + 'submissions_open,false,duplicate\n', resourceCsv)).toThrow('Duplicate seed keys');
  expect(() => parseSeedData(featureCsv.replace('key,enabled,description', 'key,enabled,unexpected'), resourceCsv)).toThrow();
  expect(generateSeedSql(featureCsv.replace('訪問者からの修正提案を受け付ける', "author's description"), resourceCsv)).toContain("author''s description");
});

it('repairs hosted inherited privileges even on an existing 0001 install', async () => {
  const db = await createTestDatabase();
  try {
    await db.exec(migration.toString());
    const inherited = await db.query("select has_table_privilege('authenticated', 'public.profiles', 'UPDATE') as profile_update, has_table_privilege('authenticated', 'public.audit_log', 'TRUNCATE') as audit_truncate");
    expect(inherited.rows).toEqual([{profile_update:true,audit_truncate:true}]);
    await db.exec(hardening);
    const fixed = await db.query("select has_column_privilege('authenticated', 'public.profiles', 'trust_level', 'UPDATE') as trust_update, has_table_privilege('authenticated', 'public.audit_log', 'TRUNCATE') as audit_truncate");
    expect(fixed.rows).toEqual([{trust_update:false,audit_truncate:false}]);
  } finally { await db.close(); }
}, 30000);

describe('initial schema on an empty local PostgreSQL engine', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.exec(prelude);
    await db.exec(migration.toString());
    const intermediate = await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated', 'public.audit_log', 'TRUNCATE') as allowed");
    expect(intermediate.rows[0]?.allowed).toBe(false);
    await db.exec(hardening);
    await db.exec(functionHardening);
    await db.exec(seed);
  }, 30000);
  afterAll(async () => { if (db) await db.close(); });

  it('creates the schema and loads every validated flag and external resource', async () => {
    const flags = await db.query('select key, enabled, description from public.feature_flags order by key');
    expect(flags.rows).toEqual([...expected.flags].sort((a, b) => a.key.localeCompare(b.key)));
    const resources = await db.query('select key, name, kind, home_url, taxon_url_template, owner_note, license_note, permission, enabled from public.external_resources order by key');
    expect(resources.rows).toEqual([...expected.resources].sort((a, b) => a.key.localeCompare(b.key)));
    expect(expected.flags.filter(flag => flag.enabled).map(flag => flag.key).sort()).toEqual(['gbif_layer', 'inat_layer']);
  });

  it('makes repeated seed application idempotent and preserves administrator settings', async () => {
    const first = await db.query('select key, id from public.external_resources order by key');
    const beforeAudit = await db.query<{ count: number }>('select count(*)::int as count from public.audit_log');
    await db.exec(seed);
    const second = await db.query('select key, id from public.external_resources order by key');
    expect(second.rows).toEqual(first.rows);
    const afterAudit = await db.query<{ count: number }>('select count(*)::int as count from public.audit_log');
    expect(afterAudit.rows).toEqual(beforeAudit.rows);
    await db.exec("update public.feature_flags set enabled=true where key='suggestions_open'; update public.external_resources set permission='declined', enabled=false where key='listmj'");
    await db.exec(seed);
    expect((await db.query<{ enabled: boolean }>("select enabled from public.feature_flags where key='suggestions_open'")).rows[0]?.enabled).toBe(true);
    expect((await db.query("select permission, enabled from public.external_resources where key='listmj'")).rows).toEqual([{ permission: 'declined', enabled: false }]);
  });

  it('keeps RLS on every public table and denies anonymous direct data access', async () => {
    const unprotected = await db.query("select tablename from pg_tables where schemaname='public' and not rowsecurity");
    expect(unprotected.rows).toEqual([]);
    const tables = await db.query<{ name: string }>("select tablename as name from pg_tables where schemaname='public'");
    expect(tables.rows.length).toBeGreaterThan(30);
    for (const table of ['taxa', 'records', 'feature_flags', 'external_resources', 'audit_log']) {
      await db.exec('begin; set local role anon');
      try {
        await expect(db.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      } finally { await db.exec('rollback'); }
    }
  });

  it('removes broad inherited grants while retaining permitted profile columns', async () => {
    const checks = await db.query(`
      select has_table_privilege('authenticated','public.profiles','UPDATE') as table_update,
        has_column_privilege('authenticated','public.profiles','trust_level','UPDATE') as trust_update,
        has_column_privilege('authenticated','public.profiles','status','UPDATE') as status_update,
        has_column_privilege('authenticated','public.profiles','display_name','UPDATE') as name_update,
        has_table_privilege('authenticated','public.profiles','DELETE') as table_delete,
        has_table_privilege('authenticated','public.audit_log','TRUNCATE') as audit_truncate
    `);
    expect(checks.rows).toEqual([{ table_update:false, trust_update:false, status_update:false, name_update:true, table_delete:false, audit_truncate:false }]);
    const uid = '00000000-0000-0000-0000-000000000055';
    await db.exec(`insert into auth.users(id) values ('${uid}'); insert into public.profiles(id,display_name) values ('${uid}','テスト');`);
    for (const field of ['trust_level=2', "status='suspended'"]) {
      await db.exec('begin');
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:uid,aal:'aal1'})]);
      await db.exec('set local role authenticated');
      try { await expect(db.exec(`update public.profiles set ${field} where id='${uid}'`)).rejects.toThrow(/permission denied/); }
      finally { await db.exec('rollback'); }
    }
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:uid,aal:'aal1'})]);
    await db.exec('set local role authenticated');
    try {
      expect((await db.query(`update public.profiles set display_name='変更済み' where id='${uid}' returning display_name`)).rows).toEqual([{display_name:'変更済み'}]);
    } finally { await db.exec('rollback'); }
  });

  it('does not grant future public tables or sequences to API roles by default', async () => {
    await db.exec('begin; create table public.future_private_test(id bigint generated always as identity);');
    try {
      const inherited = await db.query(`select
        has_table_privilege('anon','public.future_private_test','SELECT') as anon_read,
        has_table_privilege('authenticated','public.future_private_test','SELECT') as user_read,
        has_sequence_privilege('authenticated','public.future_private_test_id_seq','USAGE') as user_sequence,
        has_table_privilege('service_role','public.future_private_test','SELECT') as service_read`);
      expect(inherited.rows).toEqual([{anon_read:false,user_read:false,user_sequence:false,service_read:true}]);
    } finally { await db.exec('rollback'); }
  });

  it('fixes search_path for the four advisor-identified functions', async () => {
    const functions = await db.query(`
      select p.proname as name, p.proconfig @> array['search_path=""']::text[] as fixed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname in ('is_mfa','require_mfa_role','block_audit_change','guard_submission')
      order by p.proname`);
    expect(functions.rows).toEqual([
      {name:'block_audit_change',fixed:true}, {name:'guard_submission',fixed:true},
      {name:'is_mfa',fixed:true}, {name:'require_mfa_role',fixed:true},
    ]);
  });

  it('relocates pg_trgm while preserving the valid GIN index and queryable operators', async () => {
    const extension = await db.query("select n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm'");
    expect(extension.rows).toEqual([{schema:'extensions'}]);
    const indexes = await db.query(`
      select i.indisvalid as valid, n.nspname as opclass_schema
      from pg_index i join pg_opclass o on o.oid=i.indclass[0]
      join pg_namespace n on n.oid=o.opcnamespace
      where i.indrelid='public.taxa'::regclass and o.opcname='gin_trgm_ops'`);
    expect(indexes.rows).toEqual([{valid:true,opclass_schema:'extensions'}]);
    const similarity = await db.query('select extensions.similarity($1,$2) as score', ['moth','moth']);
    expect(similarity.rows).toEqual([{score:1}]);
    const permissions = await db.query("select has_schema_privilege('authenticated','extensions','USAGE') as user_usage, has_schema_privilege('service_role','extensions','USAGE') as service_usage");
    expect(permissions.rows).toEqual([{user_usage:true,service_usage:true}]);
  });
});
