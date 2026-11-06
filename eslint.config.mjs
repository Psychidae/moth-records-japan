import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.astro/**', '**/.wrangler/**', 'seed/**', 'docs/**', 'tests/schema_smoke.mjs', 'tests/photos_schema_smoke.mjs'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
