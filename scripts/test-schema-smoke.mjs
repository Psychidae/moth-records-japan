import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'moth-schema-smoke-'));
try {
  const combined = join(directory, 'migrations.sql');
  const migrations = readdirSync('supabase/migrations').filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  writeFileSync(combined, migrations.map(name => readFileSync(join('supabase/migrations', name), 'utf8')).join('\n'));
  for (const schema of ['docs/02_schema.sql', combined]) {
    console.log(schema === combined ? 'Checking all application migrations' : 'Checking the canonical schema');
    const result = spawnSync(process.execPath, ['tests/schema_smoke.mjs', schema], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
