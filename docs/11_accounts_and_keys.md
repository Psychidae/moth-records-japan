# 11 事前に必要な登録と鍵

Codex を全タスクまで止めずに動かすための準備表。鍵の値を Codex やチャットへ貼らない。

## 登録が不要なもの

iNaturalist API、J-STAGE WebAPI、doi.org、GBIF の検索API、NDLサーチ（非営利）。

## A. サイトを動かすのに必須

| 状況 | サービス | やること | URL | 控える値 |
|---|---|---|---|---|
| 済 | GitHub（`Psychidae`） | 2段階認証を確認 | https://github.com/settings/security | - |
| 実行待ち | GitHub | `scripts/setup-github.sh` を実行。公開リポジトリと保護設定を作る | https://github.com/Psychidae/moth-records-japan | - |
| 新規 | Cloudflare | アカウント作成 | https://dash.cloudflare.com/sign-up | Account ID |
| | Cloudflare | Workers 配信用トークンを作成 | https://dash.cloudflare.com/profile/api-tokens | `CLOUDFLARE_API_TOKEN` |
| | Cloudflare | R2 を有効化し、バケットとAPI鍵を作成 | https://developers.cloudflare.com/r2/get-started/ | `R2_BACKUP_*`, `R2_LIT_*` |
| 済 | Supabase（`Psychidae's Org`） | staging と production を東京に作成済み。接続値は `environment.md` | https://supabase.com/dashboard/project/zbbmvrmmxhrytwqrjyyk | `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` は未登録 |
| | Supabase | CI用トークンを作成 | https://supabase.com/dashboard/account/tokens | `SUPABASE_ACCESS_TOKEN` |
| 新規 | GBIF | アカウント作成 | https://www.gbif.org/user/profile | `GBIF_USERNAME`, `GBIF_PASSWORD` |
| 新規 | Healthchecks.io | アカウント作成、通知先の確認 | https://healthchecks.io/ | `HEALTHCHECKS_PING_*` |
| 新規 | パスワードマネージャ | 鍵の保管場所を用意 | https://bitwarden.com/ | - |

Supabase の組織は Free プランで、月額は0ドルと確認済み。既存の3プロジェクトは停止中である。

バックアップ用の鍵は手元で作る。秘密鍵はパスワードマネージャへ保管し、公開鍵だけを `BACKUP_AGE_PUBLIC_KEY` に登録する。

```bash
brew install age
```

```bash
age-keygen -o moth-backup.key
```

## B. 全タスクの実環境確認に必要

| サービス | やること | URL | 控える値 | 使う段階 |
|---|---|---|---|---|
| Cloudflare Turnstile | サイトキーを作成 | https://dash.cloudflare.com/?to=/:account/turnstile | `VITE_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | P2 |
| Resend | アカウント作成 | https://resend.com/signup | - | P2 |
| Resend | 送信ドメインを登録 | https://resend.com/domains | - | P2。独自ドメインが必要 |
| Resend | APIキーを作成 | https://resend.com/api-keys | `RESEND_API_KEY` | P2 |
| CiNii | appid を申請 | https://support.nii.ac.jp/ja/cinii/api/developer | `CINII_APPID` | P2L |
| NDLサーチ | 継続利用の連絡 | https://ndlsearch.ndl.go.jp/help/api | - | P2L |
| OpenAlex | 無料APIキーを取得 | https://openalex.org/settings/api | `OPENALEX_API_KEY` | P2L |
| Zenodo | アカウント作成 | https://zenodo.org/signup/ | - | P2A |
| Zenodo | トークンを作成 | https://zenodo.org/account/settings/applications/tokens/new/ | `ZENODO_TOKEN` | P2A |
| Anthropic | Console で支払いを設定 | https://platform.claude.com/settings/billing | - | P3 |
| Anthropic | 月額上限を設定 | https://platform.claude.com/settings/limits | - | P3 |
| Anthropic | APIキーを作成 | https://platform.claude.com/settings/keys | `ANTHROPIC_API_KEY` | P3 |
| Cloudflare Access | 管理サイトの許可リスト | https://one.dash.cloudflare.com/ | - | P3 |

## C. 後回しでよいもの

| もの | URL | 必要になる時 |
|---|---|---|
| 独自ドメイン | https://www.cloudflare.com/products/registrar/ | 一般公開、メール送信 |
| Supabase Pro | https://supabase.com/dashboard/org/_/billing | 投稿の一般公開 |
| BHL APIキー | https://www.biodiversitylibrary.org/getapikey.aspx | BHL の探索を有効にする時 |
| Googleログイン | https://console.cloud.google.com/auth/clients | 希望する場合のみ |

## 開発環境

| もの | 状況 | URL |
|---|---|---|
| Node.js 24 | 確認済み | - |
| Supabase CLI | 確認済み | - |
| GitHub CLI | 確認済み | - |
| Docker 互換環境 | 未導入。ローカルでDBを動かす場合に必要 | https://orbstack.dev/ |
| Codex | 設定フォルダは確認。実行コマンドは未確認 | https://developers.openai.com/codex/ |

## 鍵の入れ方

鍵はすべて空のままで Codex を進められる。未登録の処理は待機し、登録すると動く。鍵を取得したら次を実行する。

```bash
bash ~/moth-records-japan/moth-db-plan/scripts/set-secrets.sh
```

未登録の鍵が順に表示される。値を貼り付けてEnterを押す。まだ持っていない鍵は空Enterで飛ばす。入力中の値は画面に表示されない。次回は残りだけが表示される。

登録状況の確認:

```bash
bash ~/moth-records-japan/moth-db-plan/scripts/set-secrets.sh status
```

1つだけ登録する:

```bash
bash ~/moth-records-japan/moth-db-plan/scripts/set-secrets.sh GBIF_PASSWORD
```

本番の鍵を登録する:

```bash
bash ~/moth-records-japan/moth-db-plan/scripts/set-secrets.sh --env production
```

Supabase に格納する鍵（Resend、Turnstile、Anthropic など）を扱う前に1回だけ実行する:

```bash
supabase login
```

鍵の一覧は `scripts/secrets-manifest.tsv` にある。格納先は GitHub Environments と Supabase の Edge Function Secrets である。

Resend を Supabase Auth のメール送信に使う設定は、Supabase の Authentication → SMTP Settings で行う。

`production` Environment には必須レビュアーとしてオーナーを設定する。

## 費用が発生する可能性のある登録

- Cloudflare R2: 開始時に決済の手続きが必要な場合がある。無料枠内なら請求は発生しない
- Anthropic: 前払いまたは従量課金。上限を必ず設定する
- 独自ドメイン: 年額
- Supabase Pro: 月25ドル〜

## Codex へ渡すもの

| 渡す | 渡さない |
|---|---|
| GitHub リポジトリへの書き込み権限 | 本番の鍵すべて |
| `AGENTS.md` と本仕様 | バックアップの秘密鍵 |
| 公開可能な値（Supabase URL、公開キー） | Cloudflare、Anthropic の鍵 |

鍵は GitHub Environments に登録すれば、Codex が値を見なくても CI が使える。
