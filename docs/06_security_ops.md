# 06 防御と運用

## 基本方針

オーナーは運用の初心者である。防ぐ対象はランサムウェア、改ざん、マルウェア混入、アカウント乗っ取り、スパムなどの一般的な攻撃とする。人の注意力に頼らず、構成と自動化で守る。

- 自前のサーバーを持たない。OSの更新やウイルス対策が不要な構成にする
- 公開サイトは静的ファイルのみ。実行されるサーバープログラムがない
- 壊されても戻せることを最優先にする

有償の外部診断は行わない。

## 脅威と対策

| 脅威 | 対策 |
|---|---|
| ランサムウェア | 暗号化される自前サーバーを持たない。バックアップは保持ロックつきの別サービスに保管し、書き込み権限しか持たない鍵で送る |
| サイト改ざん | 公開サイトは承認済みビルドのみ。問題があれば前の版へ戻す |
| マルウェア混入 | 依存パッケージの待機期間とロックファイルで混入を防ぐ。外部スクリプトを読み込まない |
| 悪意あるスキャンファイル | ログイン利用者のみ投稿可。隔離領域に受け、検査後に画像から再生成したファイルだけを保管する。元ファイルは残さない。詳細は `09_literature_repository.md` |
| 著作権の問題 | 権利の根拠の申告がないファイルは受け付けない。公開停止の申し出で即時停止する |
| 悪意あるリンク | `https` のみ、審査必須、短縮URL拒否 |
| アカウント乗っ取り | パスワードを持たない。編集者以上はMFA。管理サイトは Cloudflare Access でさらに保護 |
| スパム、大量投稿 | Turnstile、回数制限、全件審査 |
| AIへの攻撃文 | AIにツールと権限を与えない。出力形式を固定し、変更は人が承認 |
| 希少種の産地漏えい | 公開データ生成時に除外し、自動検査する |
| 費用の暴走 | Anthropic Console の利用上限、`AI_MONTHLY_BUDGET_USD`、Supabase の Spend Cap |

## 実装の必須項目

### HTTPヘッダ（全サイト）

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data: https://static.inaturalist.org https://inaturalist-open-data.s3.amazonaws.com;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

投稿、管理サイトは `connect-src` に Supabase のURLと Turnstile を追加する。インラインスクリプトは使わない。

### データベース

- `docs/02_schema.sql` の権限モデルを維持する。`tests/schema_smoke.mjs` の全項目を pgTAP へ移植する
- 判定に `set_config` など利用者が変更できる値を使わない
- 新しいテーブルは RLS を有効にし、テストを同じPRに含める
- 表全体へ UPDATE を付与しない。必要な列だけ付与する

### 依存関係と CI

`pnpm-workspace.yaml` に次を設定する。

```yaml
minimumReleaseAge: 10080
```

- `pnpm install --frozen-lockfile` のみ使う
- インストール時スクリプトは既定で無効。許可は `onlyBuiltDependencies` に明記する
- Dependabot は週1回。開発用依存のパッチ更新のみ、CI通過で自動マージする。本番に影響する依存はオーナーが承認する
- GitHub Actions はコミットSHAで固定する
- `pull_request_target` を使わない
- 全ワークフローに `permissions: contents: read` を既定で書き、必要なジョブだけ広げる
- 外部からのPRに秘密情報を渡さない。本番の秘密は GitHub Environment `production` に置き、承認者を必須にする
- `main` はブランチ保護する。PR必須、CI必須、force push禁止
- GitHub の Secret scanning と Push protection を有効にする
- ZAP Baseline を staging に対して週1回実行する

### 認証

- Supabase Auth のメール確認を有効にする
- Turnstile を Auth の CAPTCHA として設定する
- 編集者以上は TOTP のMFAを登録するまで管理サイトを使えない。判定はJWTの `aal` クレームで行う
- 管理サイトは Cloudflare Access の許可リストで保護する

## バックアップ

| 種類 | 頻度 | 保管先 | 保持 |
|---|---|---|---|
| DB全体（`pg_dump`） | 毎日 | Cloudflare R2、保持ロックつき | 35日 |
| 月次の固定保存 | 毎月1日 | 同上 | 12か月 |
| 公開データの版 | 公開時 | GitHub Releases | 無期限 |
| 四半期スナップショット | 四半期に自動 | Zenodo | 無期限 |
| 文献保管庫のスキャン | 毎週複製 | Supabase Storage へ暗号化して複製 | 無期限 |
| 公開可能なスキャン | 巻号の完了時 | Zenodo | 無期限 |
| Supabase 標準の日次バックアップ | 毎日 | Supabase | プランに従う |

- `backup.yml` は `pg_dump` を `age` の公開鍵で暗号化して送る
- 送信用の鍵は書き込み専用とし、削除権限を持たせない
- R2 の Bucket lock はバケット設定の権限を持つ管理者なら解除できる。Cloudflare アカウントの乗っ取りには無力なので、公開データは GitHub Releases と Zenodo にも置き、提供元を分散する
- 復号鍵はオーナーがパスワードマネージャに保管する。紙の控えも別の場所に残す
- `restore-test.yml` は毎月、staging 用の検証鍵で作った検証バックアップを一時DBへ復元し、件数を比較する。本番の復号鍵は使わない
- 本番の復号鍵による復元手順は、公開前に1回オーナーが手順書どおり実施する

## 自動の見守り

`health-report.yml` が毎週月曜の朝にGitHub Issueを更新し、オーナーへメールが届く。

| 項目 | 正常の基準 |
|---|---|
| 公開サイトの応答 | 過去7日で失敗なし |
| 最終バックアップ | 26時間以内 |
| 復元テスト | 直近が成功 |
| データ取込 | 直近が成功 |
| 依存関係の脆弱性 | 高以上が0件 |
| 未処理の修正提案 | 優先度1が0件 |
| AI費用 | 上限の80%未満 |
| 証明書、ドメイン期限 | 30日以上 |

GitHub Actions 自体が止まると健康診断も届かない。公開リポジトリのスケジュール実行は、60日間リポジトリに活動がないと自動で無効化される。次の2点で防ぐ。

- `health-report.yml` は結果を `status/health.json` へコミットし、リポジトリの活動を維持する
- `backup.yml`, `sync-inat.yml`, `health-report.yml` は成功時に Healthchecks.io へ通知する。期限までに通知がなければ、外部からオーナーへメールが届く

本文の先頭に「対応不要」または「要対応」と、何をすべきかを平易な日本語で書く。専門用語には短い説明を添える。

## オーナーの定期作業

| 頻度 | 作業 | 目安 |
|---|---|---|
| 毎週 | 健康診断メールの先頭を読む | 1分 |
| 毎月 | 本番に影響する依存更新のPRを承認する | 5分 |
| 毎年 | 管理者一覧の見直し、APIキーの更新、ドメイン自動更新の確認 | 30分 |

開発用の依存更新の自動マージ、公開データの週次公開、Zenodo登録は自動で行う。条件は `10_automation.md`。

## 開設時にオーナーが行う設定

1. GitHub, Cloudflare, Supabase, Anthropic Console のアカウントで2段階認証を有効にする
2. パスワードマネージャを用意する
3. ドメインを取得し、自動更新と支払い方法を確認する
4. Anthropic Console で月額の利用上限を設定する
5. Supabase の Spend Cap を有効のままにする
6. 2人目のオーナーを決める
7. Healthchecks.io に登録し、通知先メールを確認する
8. 秘密情報を GitHub Environments と Supabase へ登録する。Codex に渡さない

Codex は設定箇所をまとめた `docs/owner_setup.md` を T20 で作成する。画面操作を番号付きで書く。

## 困ったときの手順

`docs/runbook.md` に次の手順を T20 で書き起こす。各手順は操作を番号付きで書く。

### サイトの内容がおかしい、改ざんされた

1. 管理サイトの「版の公開」で、問題のない前の版へ戻す
2. 「機能」で `submissions_open` と `suggestions_open` を切る
3. 監査ログで原因の操作を確認する
4. 開発支援のAIか技術協力者へ、健康診断と監査ログを見せて相談する

### 管理者のアカウントが乗っ取られた

1. 別のオーナーが該当アカウントの役割を取り消す
2. Supabase で全セッションを失効させる
3. 監査ログから変更を確認し、問題の版より前へ戻す
4. 本人のメールとパスワードマネージャを確認する

### データが壊れた、消えた

1. 投稿受付を止める
2. Supabase の日次バックアップから戻す
3. 足りなければ R2 の暗号化バックアップから戻す。`docs/runbook.md` の手順に従う
4. 最後の手段として GitHub Releases の公開データから再構築する

### 秘密鍵が漏れた

1. 該当サービスでキーを失効させる
2. 新しいキーを作り GitHub Environments へ登録する
3. 利用履歴と請求を確認する

### 健康診断のメールが来ない、停止の警告が来た

1. GitHub の Actions タブで無効化されたワークフローを開く
2. 「Enable workflow」を押す
3. 手動で実行して成功を確認する

### 費用が急に増えた

1. `ai_triage` を切る
2. Anthropic Console と Supabase の利用状況を確認する
3. スパムの増加なら Turnstile と回数制限を確認する

### 個人情報の削除依頼、法的な連絡

1. 投稿者本人の依頼は `/me` のアカウント削除を案内する
2. 公開記録に含まれる氏名は文献の書誌情報である。判断に迷う場合は公開を一時停止して確認する
3. 法的な連絡には個人で判断せず、学会や専門家へ相談する

## プライバシー

- 収集する個人情報は、メール、表示名、任意の所属とORCID、提案時の任意の連絡先のみ
- 連絡先は決定から90日で削除する
- 修正提案の本文は外部のAI APIへ送られることをフォームと `/privacy` に明記する。本文に個人情報を書かないよう注意書きを置く
- IPアドレスはハッシュのみ保存し、日替わりソルトを7日で破棄する
- 文献に載った採集者名は書誌情報として扱う
