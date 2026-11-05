import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { site } from '../../../packages/config/site.ts';
import { StagingStore } from '../../external/src/http.ts';
import { syncInat } from './sync.ts';

const args = z.array(z.enum(['--run'])).max(1).parse(process.argv.slice(2));
const summary = (message: string) => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`, { flag: 'a' });
};
if (!args.includes('--run') || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !site.contactEmail) {
  summary('待機: staging接続と問い合わせ先の設定後、--runで集計します。未収集を0件とは扱いません。');
} else {
  const store = new StagingStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { taxa, regions } = await store.catalog();
  const result = await syncInat(taxa, regions, `${site.nameEn}/0.1.0 (${site.contactEmail})`);
  await store.publish(result.snapshot);
  mkdirSync('generated/inaturalist', { recursive: true });
  writeFileSync('generated/inaturalist/unmatched.json', `${JSON.stringify({ fetchedAt: result.snapshot.fetchedAt, unmatched: result.unmatched }, null, 2)}\n`);
  summary(`完了: ${result.snapshot.summaries.length}集計、未対応${result.unmatched.length}分類群。観察の座標と応答原文は保存していません。`);
}
