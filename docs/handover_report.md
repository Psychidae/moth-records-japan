# 引き継ぎレポート

更新日: 2026-11-06。連続実装の途中記録。全タスク終了時に最終結果へ更新する。本番への接続・配信は行っていない。

## 完了と確認済み

1. T01: pnpmワークスペース、型検査、lint、単体テストとビルド。PR #3 はGitHubのCI成功後にマージ済み。GitHubへのブランチ送信・PR作成・マージを実証した。
2. T02: CIの権限とAction固定の検査、週次の依存更新設定、保護設定の追加手順を実装。PR #4 はGitHubのCI成功後にマージ済み。
3. 最初のPR #2 はCI成功したが、同時に別作業で作られた親コミットが含まれたため閉じた。T01だけのPR #3に置き換え、別作業の履歴は変更していない。
4. T03: 正本とバイト同一の初期スキーマ、既定権限・関数・拡張配置の補強、機能フラグ16件・外部資源10件の初期データを実装。ローカルの5コマンドが成功（単体テスト3ファイル・19件）。既存の権限検証56観点も、正本のみと全migrationの両方で成功した。

## 未確認・未実施

1. T04以降は順次実装する。stagingへ0000〜0003とseedの適用、件数・権限・診断の最終確認は成功した。配信、メールなどは今後確認する。T03のローカル検証はPostgreSQLエンジンPGlite上でSupabaseの認証部分を模したもの。
2. 本番DBへの接続・秘密情報参照は行っていない。ゲートG1〜G9は未確認。Supabase stagingは接続ツールで権限拒否されたが、既存認証を使うCLIで空DB・既定権限を確認し、migrationとseedを適用して権限を検証できた。
3. 依存更新は週1回PRを作る設定。開発用パッチ更新の自動マージはA05で実装するまで有効化しない。
4. RLS・E2EのCI検証は対象実装のタスクで追加する。現在のCI成功はその機能の検証を意味しない。
5. 別作業のPR #1にある未登録鍵の待機・再実行の仕様は、このT02のmain仕様には未統合。require-envとrecheck-envは、その変更が統合され、DB適用・配信等の実処理を実装する段階で整合させる。

## T03のDB初期化

1. migrationは `0000_restrict_defaults.sql` → `0001_init.sql` → `0002_harden_privileges.sql` → `0003_harden_functions.sql` の順に適用し、その後 `supabase/seed.sql` を投入する。初期スキーマだけを直接適用すると、Supabaseが最初から持つ広い権限が残るため、この順序を保つ。
2. `pnpm seed:generate` は2つの正本CSVを検証して初期データ用SQLを生成する。SQLに入力CSVのSHA-256を記録する。同じ入力から同じSQLを生成し、同じキーの再投入で管理者の変更を上書きしない。
3. 初期に有効なのはiNaturalistとGBIFの表示層のみ。投稿、修正提案、スキャン受付、AI、自動公開はすべて無効。外部資源の許諾・有効状態もCSVの正本を保つ。
4. publicの表・シーケンスはmigration実行者postgresの既定権限を補強し、明示的に許可した操作だけをログイン利用者へ与える。Supabase内部管理者supabase_adminが将来作るオブジェクトの既定権限は変更していない。新しい表はRLSと明示的権限のテストを付ける。
5. `pnpm test:schema-smoke` は既存56観点を削らず、正本と全migrationに対してそれぞれ実行する。pgTAPへの移植とCIへの追加はT04で行う。
6. Supabase CLIの同じプロジェクトへの処理は並列に実行しない。CLIが使う一時ログインの認証が競合するため、適用・件数確認・診断を1つずつ実行する。秘密情報の入力を求める操作には進まない。

## オーナーの作業: 必須CIの追加

「必須チェック」は、検査に失敗した変更をmainへ取り込めなくするGitHubの設定。既存のmain保護は解除しない。

1. GitHubでリポジトリの **Settings → Branches → main の保護設定（Edit）** を開く。Rulesetsで管理している場合は該当するmainルールを開く。
2. **Require status checks to pass before merging** を有効にする。
3. チェック一覧で、GitHub Actionsの **checks**（ワークフロー名 **CI**、画面によって **CI / checks** と表示）を選ぶ。PR #3で成功した実績がある。表示されない場合は直近のCI成功を確認してから再度検索する。
4. **Require branches to be up to date before merging** を有効にする。PR必須、管理者にも適用、force push禁止、削除禁止の既存設定を維持して保存する。
5. 設定を開き直し、選んだチェックが保存されたことを確認する。読み取り確認のコマンドは `gh api repos/Psychidae/moth-records-japan/branches/main/protection/required_status_checks`。`contexts`または`checks`に`checks`があり、`strict`が`true`なら設定されている。
6. 将来CIのジョブ名を変更・分割した場合は、成功実績のある新しい名前を必須へ追加してから古い名前を外す。存在しない名前を必須にするとマージ待ちのままになる。

2026-11-06の読み取り確認では、mainはPR必須（承認0名）、管理者にも適用、force push・削除禁止で、必須チェックは未設定だった。本番Environmentにはオーナーの承認者と保護ブランチ限定が設定済み。本番ジョブは起動していない。上記の必須チェック追加の保存は未実施。秘密情報を使わない設定であり、CIのログには鍵を出力しない。

## 依存の既知の注意点（T02で確認）

1. `pnpm audit --json` とGitHubの警告で、開発用ESLint配下のminimatch 10.2.6に中程度のサービス妨害の警告（GHSA-g3hv-75wg-m249）が1件ある。高・重大は0件。公開サイトの実行時依存ではない。
2. 修正は11.0.1以降のメジャー変更となるため、仕様の依存制限と更新方針に従い、無関係な依存の強制差し替えは行わなかった。CIのlintにはリポジトリの固定パスのみを渡す。互換性を確認した更新を別途検討する。警告は解消済みとは扱わない。

## T03のstaging実検証（2026-11-06）

1. 対象はstaging `zbbmvrmmxhrytwqrjyyk` のみ。CLIから4本のmigrationとseedを適用した。PostgreSQL 17.11、migration実行者postgres。
2. 表34件、RLS無効の表0件、機能フラグ16件、外部資源10件。有効なフラグはinat_layerとgbif_layerの2件のみ。
3. authenticatedのTRUNCATE許可表0件、profilesのtrust_level/statusのUPDATE許可なし、display_nameのUPDATE許可あり、anonのtaxa読取許可なし。
4. security advisorsを補強前後で確認し、4関数のsearch_pathとpg_trgmの配置を補強後、WARN以上0件（No issues found）になった。公開サイトや投稿メールの実動作検証を意味しない。
5. T03のローカル検証: 必須5コマンド成功、単体テスト19件、正本56観点と全migration56観点が成功。T03のPR/CI結果はマージ後に追記する。
