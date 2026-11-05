# 01 アーキテクチャ

## 全体構成

```text
[訪問者] ──> 公開サイト (静的HTML/JSON, Cloudflare)         DB接続なし
                 │ 「修正を提案」リンク
                 ▼
[投稿者・審査者] ─> 投稿サイト (静的SPA, Cloudflare) ─┐
[編集者・管理者] ─> 管理サイト (静的SPA + Cloudflare Access) ─┤
                                                     ▼
                                     Supabase 東京リージョン
                                     PostgreSQL / Auth / Edge Functions
                                                     │
GitHub Actions ── 定期取込 (iNaturalist, GBIF) ───────┤
              ── 公開データ生成 ── 公開サイトへ配信 <─┘
              ── 暗号化バックアップ ──> Cloudflare R2 (保持ロック)
              ── スキャンの検査と再生成 ──> R2 文献保管庫 (files. で配信)
```

投稿サイトが停止または侵害されても、公開サイトは直前の版を配信し続ける。

## 技術スタック

以下の版を基準に `package.json` へ完全一致で固定する（2026-11-06 時点で確認）。公開から7日未満の版が `minimumReleaseAge` に抵触する場合は、7日以上経過した最新版を使い `docs/decisions.md` に記録する。

| 用途 | パッケージ | 版 |
|---|---|---|
| ランタイム | Node.js | 24 LTS 系 |
| パッケージ管理 | pnpm | 12.16.1 |
| 言語 | typescript | 7.0.2 |
| 公開サイト | astro | 7.4.7 |
| 公開サイトの対話部品 | @astrojs/react, react, react-dom | 7.1.4, 19.3.1, 19.3.1 |
| サイトマップ | @astrojs/sitemap | 3.7.4 |
| 投稿、管理サイト | vite, react-router, @tanstack/react-query | 8.3.6, 8.5.1, 5.106.1 |
| 検証 | zod | 4.6.7 |
| DB接続 | @supabase/supabase-js | 2.119.0 |
| AI | @anthropic-ai/sdk | 1.6.0 |
| 配信 | wrangler | 4.158.0 |
| 地図データ変換 | mapshaper | 0.7.101 |
| テスト | vitest, @playwright/test, @electric-sql/pglite | 5.1.0, 1.64.1, 0.5.15 |

選定理由、上限、撤退方法は `08_tool_decisions.md` に記載する。一覧にない依存を追加しない。地図は自前のSVG部品で描き、地図ライブラリを入れない。Excel読込の依存も入れず、変換済みの `seed/source/listmj3_210603_rows.jsonl` を読む。

TypeScript 7 がツールと非互換の場合のみ、動作する最新の版へ下げて `docs/decisions.md` に記録する。CSSは素のCSS（CSS変数）とし、CSSフレームワークは導入しない。

## リポジトリ構成

```text
moth-db/
├─ AGENTS.md
├─ docs/
├─ seed/
├─ apps/
│  ├─ public/        Astro。公開サイト
│  ├─ portal/        Vite + React。投稿サイト
│  └─ admin/         Vite + React。管理サイト
├─ packages/
│  ├─ config/        サイト設定、定数
│  ├─ schema/        Zod スキーマと型
│  ├─ ui/            共通UI部品
│  └─ public-data/   公開JSONの型と読込
├─ pipelines/
│  ├─ import-listmj/
│  ├─ sync-inat/
│  ├─ sync-gbif/
│  ├─ check-links/
│  ├─ harvest-literature/
│  ├─ harvest-archives/
│  ├─ find-copies/
│  ├─ process-scan/
│  └─ build-public-data/
├─ supabase/
│  ├─ migrations/
│  ├─ functions/     Edge Functions
│  └─ tests/         pgTAP
├─ tests/e2e/
└─ .github/workflows/
```

## 環境

| 環境 | 用途 | DB | 配信 |
|---|---|---|---|
| local | 開発 | Supabase CLI（Docker系ランタイムが必要） | `pnpm dev` |
| staging | 確認 | Supabase staging プロジェクト | `staging.*` |
| production | 本番 | Supabase production プロジェクト | 独自ドメイン |

Docker を使えない開発環境では staging を開発用DBに使う。production へは接続しない。staging は Supabase Free、production は P1 まで Free、P2 の投稿公開前に Pro へ上げる。

リポジトリは GitHub の公開リポジトリとする。秘密情報は GitHub Environments にのみ置く。

## 環境変数

`.env.example` に次のキーを置く。値は書かない。

| 変数 | 置き場所 | 用途 |
|---|---|---|
| `VITE_SUPABASE_URL` | portal, admin のビルド | 公開可能 |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | portal, admin のビルド | 公開可能。RLSで保護 |
| `VITE_TURNSTILE_SITE_KEY` | portal | 公開可能 |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Environments, Edge Functions | 秘密 |
| `SUPABASE_DB_URL` | GitHub Environments | 秘密 |
| `ANTHROPIC_API_KEY` | Supabase Edge Function secrets, GitHub Environments | 秘密 |
| `TURNSTILE_SECRET_KEY` | Edge Function secrets | 秘密 |
| `CLOUDFLARE_API_TOKEN` | GitHub Environments | 秘密。配信権限のみ |
| `R2_BACKUP_*` | GitHub Environments | 秘密。書き込みのみ |
| `BACKUP_AGE_PUBLIC_KEY` | GitHub Environments | 公開鍵 |
| `GBIF_USERNAME`, `GBIF_PASSWORD` | GitHub Environments | 秘密 |
| `RESEND_API_KEY` | Edge Function secrets, Supabase Auth SMTP | 秘密。メール送信 |
| `HEALTHCHECKS_PING_*` | GitHub Environments | 秘密。自動処理の生存通知 |
| `R2_LIT_*` | Edge Function secrets, GitHub Environments | 秘密。文献保管庫。バケットごとに別の鍵 |
| `ZENODO_TOKEN` | GitHub Environments | 秘密。公開データの自動登録 |
| `CINII_APPID` | GitHub Environments | 秘密 |
| `OPENALEX_API_KEY` | GitHub Environments | 秘密 |
| `SUPABASE_ACCESS_TOKEN` | GitHub Environments | 秘密。migration の適用 |
| `AI_MODEL` | Edge Function secrets | 既定 `claude-opus-5-5` |
| `AI_MONTHLY_BUDGET_USD` | Edge Function secrets | 既定 `20` |

バックアップの復号鍵はどの環境にも置かない。オーナーがパスワードマネージャで保管する。

## ファイル数の上限

Cloudflare Workers の静的配信は Free で1版あたり20,000ファイル、Paid で100,000ファイル、1ファイル25MiBが上限である。ビルド時に `apps/public/dist` のファイル数と最大ファイルサイズを数え、18,000ファイルまたは8MiBを超えたらCIを失敗させる。ファイル数を超えた場合はオーナーへ Workers Paid への変更を確認する。

## GitHub Actions

| ワークフロー | 契機 | 内容 |
|---|---|---|
| `ci.yml` | PR | lint, typecheck, unit, RLS, build, e2e |
| `deploy-staging.yml` | main へのマージ | staging へ反映 |
| `deploy-production.yml` | 手動 | GitHub Environment の承認後に本番へ反映 |
| `publish-data.yml` | 毎週月曜 05:00 JST、手動 | 公開データ生成と配信 |
| `harvest-literature.yml` | 毎月3日 04:00 JST | 書誌の自動収集 |
| `harvest-archives.yml` | 毎月4日 04:00 JST | 発行元の公開PDF一覧の取込 |
| `find-copies.yml` | 毎週水曜 04:00 JST | 公開コピーの探索 |
| `process-scan.yml` | アップロード時、1時間ごと | スキャンの検査と再生成 |
| `replicate-archive.yml` | 毎週日曜 03:00 JST | 文献保管庫の複製 |
| `sync-inat.yml` | 毎週月曜 03:00 JST | iNaturalist 集計 |
| `sync-gbif.yml` | 毎月1日 04:00 JST | GBIF 集計 |
| `check-links.yml` | 毎月15日 04:00 JST | リンク確認 |
| `backup.yml` | 毎日 02:00 JST | 暗号化バックアップ |
| `restore-test.yml` | 毎月2日 05:00 JST | 復元の自動確認 |
| `health-report.yml` | 毎週月曜 08:00 JST | 週次の健康診断 |
| `uptime.yml` | 1時間ごと | 公開サイトの死活確認 |
| `ai-sweep.yml` | 1時間ごと | 未処理の修正提案の再処理 |
| `ai-extract.yml` | 手動、審査画面から起動 | PDFからの記録候補抽出 |

全ワークフローの共通規則は `06_security_ops.md` に従う。
