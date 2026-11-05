import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const read = (path: string) => readFileSync(path, 'utf8');
const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

function workflowViolations(source: string): string[] {
  const errors: string[] = [];
  if (/\bpull_request_target\s*:/.test(source)) errors.push('unsafe trigger');
  const defaults = source.match(/^permissions:\r?\n((?:[ \t]+[^\n]*\r?\n)*)/m)?.[1]?.trim();
  if (defaults !== 'contents: read') errors.push('default permissions');
  for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
    const action = match[1] ?? '';
    if (!action.startsWith('./') && !/^[^@]+@[a-f0-9]{40}$/.test(action)) errors.push('unpinned action');
  }
  return errors;
}

function manifests(): string[] {
  return ['package.json', ...['apps', 'packages', 'pipelines'].flatMap(group =>
    readdirSync(group, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(item => join(group, item.name, 'package.json')),
  )];
}

describe('CI permissions and supply chain policy', () => {
  it('requires safe events, read-only defaults and immutable remote action versions in every workflow', () => {
    const workflows = readdirSync('.github/workflows').filter(name => /\.ya?ml$/.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) expect(workflowViolations(read(join('.github/workflows', name))), name).toEqual([]);
  });

  it('rejects unsafe workflow mutations rather than only accepting the current file', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(workflowViolations(ci.replace('pull_request:', 'pull_request_target:'))).toContain('unsafe trigger');
    expect(workflowViolations(ci.replace('contents: read', 'contents: write'))).toContain('default permissions');
    expect(workflowViolations(ci.replace('contents: read', 'contents: read\n  actions: write'))).toContain('default permissions');
    expect(workflowViolations(ci.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v4'))).toContain('unpinned action');
  });

  it('runs all required checks without secrets, environments, reusable privilege or persisted checkout credentials', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^  pull_request:/m);
    expect(ci).not.toMatch(/\$\{\{\s*secrets\.|^\s*environment:|secrets:\s*inherit|permissions:\s*write-all/m);
    expect(ci).toContain('persist-credentials: false');
    expect(ci).toMatch(/timeout-minutes:\s*15/);
    for (const command of ['install --frozen-lockfile', 'lint', 'typecheck', 'test', 'build']) {
      expect(ci).toContain(`run: pnpm ${command}`);
    }
  });

  it('keeps weekly dependency updates reviewable until the later automatic merge task', () => {
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot.match(/interval: weekly/g)).toHaveLength(2);
    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    expect(dependabot).toContain('timezone: Asia/Tokyo');
  });

  it('runs every original permission scenario in pgTAP on a disposable real PostgreSQL database', () => {
    const original = [...read('tests/schema_smoke.mjs').matchAll(/await (?:ok|denied)\("([^"]+)"/g)].map(match => match[1]);
    expect(original).toHaveLength(56);
    const tapFiles = readdirSync('supabase/tests').filter(name => name.endsWith('.sql'));
    const tap = tapFiles.map(name => read(join('supabase/tests', name))).join('\n');
    for (const label of original) expect(tap).toContain(`'${label}'`);
    expect(tap).toMatch(/\bplan\(56\)/);
    expect(tap).toMatch(/^begin;/im);
    expect(tap).toMatch(/^rollback;/im);
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('pnpm test:schema-smoke');
    expect(ci).toContain('postgresql-16-pgtap');
    expect(ci).toContain('sudo -u postgres bash scripts/test-pgtap.sh');
    const runner = read('scripts/test-pgtap.sh');
    expect(runner).toContain('pg_prove --verbose');
    expect(runner).toContain('--set ON_ERROR_STOP=1');
    expect(runner).toContain('supabase/migrations/*.sql');
    expect(runner).toContain('scripts/ci-auth-bootstrap.sql');
  });

  it('pins all direct dependency versions and enforces strict typing and install protections', () => {
    for (const path of manifests()) {
      const manifest = manifestSchema.parse(JSON.parse(read(path)) as unknown);
      for (const section of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
        for (const version of Object.values(section ?? {})) expect(version, path).toMatch(/^(?:\d+\.\d+\.\d+(?:-[\w.-]+)?|workspace:\*)$/);
      }
    }
    expect(z.object({ compilerOptions: z.object({ strict: z.literal(true) }) }).safeParse(JSON.parse(read('tsconfig.json')) as unknown).success).toBe(true);
    expect(read('pnpm-workspace.yaml')).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(read('pnpm-workspace.yaml')).toMatch(/^onlyBuiltDependencies:/m);
    expect(read('.npmrc')).toMatch(/^ignore-scripts=true$/m);
  });

  it('keeps the public application independent of Supabase', () => {
    const manifest = manifestSchema.parse(JSON.parse(read('apps/public/package.json')) as unknown);
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies });
    expect(names.filter(name => name.startsWith('@supabase/'))).toEqual([]);
  });
});
