import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { StagingStore } from '../../external/src/http.ts';
import { syncGbif } from './sync.ts';

const args = z.array(z.enum(['--run'])).max(1).parse(process.argv.slice(2));
const summary = (message: string) => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`, { flag: 'a' });
};
if (!args.includes('--run') || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GBIF_USERNAME || !process.env.GBIF_PASSWORD) {
  summary('待機: stagingとGBIFの接続設定後、--runで集計します。未収集を0件とは扱いません。');
} else {
  const store = new StagingStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { taxa, regions } = await store.catalog();
  const result = await syncGbif(taxa, regions, { username: process.env.GBIF_USERNAME, password: process.env.GBIF_PASSWORD });
  mkdirSync('generated/gbif', { recursive: true });
  writeFileSync('generated/gbif/unmatched.json', `${JSON.stringify(result.report, null, 2)}\n`);
  await store.publish(result.snapshot);
  summary(`完了: GBIF標本${result.report.matchedRows}件の集計とDOIを保存。座標・raw行・ZIPは保持していません。`);
}
