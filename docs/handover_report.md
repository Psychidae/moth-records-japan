# 引き継ぎレポート

更新日: 2026-11-06。連続実装の途中記録。全タスク終了時に最終結果へ更新する。本番への接続・配信は行っていない。

## 完了と確認済み

1. T01: pnpmワークスペース、型検査、lint、単体テストとビルド。PR #3 はGitHubのCI成功後にマージ済み。GitHubへのブランチ送信・PR作成・マージを実証した。
2. T02: CIの権限とAction固定の検査、週次の依存更新設定、保護設定の追加手順を実装。PR #4 はGitHubのCI成功後にマージ済み。
3. 最初のPR #2 はCI成功したが、同時に別作業で作られた親コミットが含まれたため閉じた。T01だけのPR #3に置き換え、別作業の履歴は変更していない。
4. T03: 正本とバイト同一の初期スキーマ、既定権限・関数・拡張配置の補強、機能フラグ16件・外部資源10件の初期データを実装。ローカルの5コマンドが成功（単体テスト3ファイル・19件）。既存の権限検証56観点も、正本のみと全migrationの両方で成功した。PR #8はGitHubのCI成功後にマージ済み。
5. T04: 元の56観点をすべてpgTAPへ移植し、CIに使い捨てPostgreSQLの実行を追加した。元の観点名の欠落も検査する。ローカル5コマンド（単体テスト20件）と元smoke正本56件・全migration56件が成功。stagingのPostgreSQL 17.11と実pgTAP 1.3.3でも56件成功した。PR #9は最終headのGitHub CI（pg_prove 56件PASS）成功後にマージ済み。
6. T05: 同梱の検証済みList-MJをオフラインで取り込み、受け入れ表の全数値が一致した。staging実DBでもraw7,465行、種6,628、亜種837、科88、基亜種299、未同定種小名338、重複4組、親なし亜種0を確認。上位を含む分類群10,055件、名称18,046件。2回の実投入で全コードとDB内部IDの組合せ・監査件数が変わらず、権限56件も再成功した。必須5コマンドと単体30件が成功。

## 未確認・未実施

1. T06以降は順次実装する。stagingへ0000〜0003とseedの適用、件数・権限・診断の最終確認は成功した。配信、メールなどは今後確認する。T03のローカル検証はPostgreSQLエンジンPGlite上でSupabaseの認証部分を模したもの。
2. 本番DBへの接続・秘密情報参照は行っていない。ゲートG1〜G9は未確認。Supabase stagingは接続ツールで権限拒否されたが、既存認証を使うCLIで空DB・既定権限を確認し、migrationとseedを適用して権限を検証できた。
3. 依存更新は週1回PRを作る設定。開発用パッチ更新の自動マージはA05で実装するまで有効化しない。
4. RLSのCI検証をT04で追加した。CIのPostgreSQL 16では認証部分を模し、アプリの全migrationとseedを適用して権限を実検査する。Supabase固有の認証はstaging 17.11の実行で補った。E2Eは対象実装のタスクで追加する。
5. 別作業のPR #1にある未登録鍵の待機・再実行の仕様は、このT02のmain仕様には未統合。require-envとrecheck-envは、その変更が統合され、DB適用・配信等の実処理を実装する段階で整合させる。

## T03のDB初期化

1. migrationは `0000_restrict_defaults.sql` → `0001_init.sql` → `0002_harden_privileges.sql` → `0003_harden_functions.sql` の順に適用し、その後 `supabase/seed.sql` を投入する。初期スキーマだけを直接適用すると、Supabaseが最初から持つ広い権限が残るため、この順序を保つ。
2. `pnpm seed:generate` は2つの正本CSVを検証して初期データ用SQLを生成する。SQLに入力CSVのSHA-256を記録する。同じ入力から同じSQLを生成し、同じキーの再投入で管理者の変更を上書きしない。
3. 初期に有効なのはiNaturalistとGBIFの表示層のみ。投稿、修正提案、スキャン受付、AI、自動公開はすべて無効。外部資源の許諾・有効状態もCSVの正本を保つ。
4. publicの表・シーケンスはmigration実行者postgresの既定権限を補強し、明示的に許可した操作だけをログイン利用者へ与える。Supabase内部管理者supabase_adminが将来作るオブジェクトの既定権限は変更していない。新しい表はRLSと明示的権限のテストを付ける。
5. `pnpm test:schema-smoke` は既存56観点を削らず、正本と全migrationに対してそれぞれ実行する。同じ56観点をT04でpgTAPへ移植し、両方式をCIで実行する。
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
5. T03のローカル検証: 必須5コマンド成功、単体テスト19件、正本56観点と全migration56観点が成功。PR #8はGitHubのCI成功後にマージ済み。

## T04の権限検証（2026-11-06）

1. `supabase/tests/001_permissions.test.sql` は実際のanon/authenticatedロールへ切り替えて56観点を実行する。RLSによる0行更新、自己承認、偽装set_config、MFA、別オーナーの承認、スキャンの権利・ウイルス・頒布制限を含む。元の検査を削っていない。
2. テストのextension、関数、fixture行、機能フラグ変更はBEGIN/ROLLBACKの中だけ。stagingの成功後と意図的な失敗後に、public表34件、flags16件、resources10件、テスト利用者0件、pgTAPの永続インストール0件を確認した。
3. `finish(true)` が失敗を例外に変える。1件だけ意図的に誤らせた一時SQLは「1 test failed of 57」でCLIが終了コード1となり、成功と誤判定しないことも確認した。一時SQLは成果物に含めない。
4. CIは秘密情報・Environmentを使用せず、forkのPRでも同じ検証を実行する。GitHub上の成功を確認してからPRをマージする。
5. このpgTAP一式は使い捨てDB、または既存オーナーがいない開発用stagingを対象とする。「2名未満にできない」は全体のオーナー数で判定するため、既存オーナーがいるDBで同じfixtureを加えると前提が変わる。実データのある環境へそのまま流さない。

## T05の分類基盤と再実行（2026-11-06）

1. リポジトリ直下で `pnpm import:listmj` を実行する。検証済みの2入力を読み、`generated/listmj/import.sql` と `generated/listmj/import_report.json` を生成する。ネットワーク取得は行わない。生成物はGit管理外なので、同じ入力とコードで再生成する。
2. レポートは全受け入れ数値、衝突4組の元行とコード、speciesのstatus内訳を含む。集計ページとの差はaccepted +34、unidentified -3、south_kuril +2、doubtful -33、excluded 0。分類学的な理由は推測せず、G1で確認する。
3. 通常のPostgreSQL接続では生成SQLをそのまま実行する。CIでは使い捨てDBに2回適用し、その後に実pgTAPを実行する。既存コードが無関係の分類群に使われていた場合は全体を停止し、rawや名称を誤接続しない。単体テストではこの衝突時の全体ROLLBACKと、正当な再投入時の編集値保持も確認した。
4. stagingへは既存認証のSupabase CLIを利用した。Management APIのqueryは4.2MBに対して413、CLIのseedはTEMP表ができる前に各文をprepareするため、そのままでは実行できなかった。`scripts/prepare-supabase-seed.ts` で最外のBEGIN/COMMITだけを除き単一DO/EXECUTEに包み、ひとつのトランザクションで実行する。正本の生成SQL・migrationは変更しない。
5. 再現例: `node --experimental-strip-types scripts/prepare-supabase-seed.ts generated/listmj/import.sql /absolute/staging-scratch/supabase/t05_listmj.sql`。staging専用scratchの `config.toml` の `[db.seed].sql_paths` へそのファイルを加え、`supabase --workdir /absolute/staging-scratch db push --linked --include-seed --yes` を実行する。接続先がstaging `zbbmvrmmxhrytwqrjyyk` であることを先に確認する。鍵の取得・表示やmigration番号の追加は不要。
6. CLI 2.90.0は適用済みseedのパスとハッシュを記録する。再実行の実証では同じSQLを別のscratch seed名にして投入し、スキップを成功と数えなかった。全分類コード/内部IDの集約ハッシュは前後とも `8fa8d8f4bc835df0e06f99bdb4fb6570`、監査28,127件で同一だった。原文の記録は0件のまま。公開・投稿機能の有効化は行っていない。
