# 引き継ぎレポート

更新日: 2026-11-06。連続実装の途中記録。全タスク終了時に最終結果へ更新する。本番への接続・配信は行っていない。

## 今回の受け入れ保留

T06は実装・検証を進めたが、完了チェックを入れていない。仕様の282文献に対して、指定ハッシュの同梱refs.htmlに実在するのは281文献だった。開始タグ、終了タグ、独立HTMLParserとli外の全文検査で確認し、入れ子や閉じ忘れ、リスト外の文献はなかった。存在しない282件目は作っていない。レポートはexpected=282、actual=281、passed=falseとし、原典と受け入れ基準を保った。

今回の保留一覧は **T06のみ**。同じ受け入れ不一致を3方式で確認したため、連続実行規則の例外として、この保留を除く最上位の未完了タスクへ進む。実装PR #11は最終headのGitHub CI成功後にマージ済みだが、文献282件の受け入れは未達。オーナーは、期待値282か同梱原本のどちらを修正すべきかを確認する。後続のCI成功・PR統合は、この受け入れ保留を解消した意味にはならない。

## 完了と確認済み

1. T01: pnpmワークスペース、型検査、lint、単体テストとビルド。PR #3 はGitHubのCI成功後にマージ済み。GitHubへのブランチ送信・PR作成・マージを実証した。
2. T02: CIの権限とAction固定の検査、週次の依存更新設定、保護設定の追加手順を実装。PR #4 はGitHubのCI成功後にマージ済み。
3. 最初のPR #2 はCI成功したが、同時に別作業で作られた親コミットが含まれたため閉じた。T01だけのPR #3に置き換え、別作業の履歴は変更していない。
4. T03: 正本とバイト同一の初期スキーマ、既定権限・関数・拡張配置の補強、機能フラグ16件・外部資源10件の初期データを実装。ローカルの5コマンドが成功（単体テスト3ファイル・19件）。既存の権限検証56観点も、正本のみと全migrationの両方で成功した。PR #8はGitHubのCI成功後にマージ済み。
5. T04: 元の56観点をすべてpgTAPへ移植し、CIに使い捨てPostgreSQLの実行を追加した。元の観点名の欠落も検査する。ローカル5コマンド（単体テスト20件）と元smoke正本56件・全migration56件が成功。stagingのPostgreSQL 17.11と実pgTAP 1.3.3でも56件成功した。PR #9は最終headのGitHub CI（pg_prove 56件PASS）成功後にマージ済み。
6. T05: 同梱の検証済みList-MJをオフラインで取り込み、受け入れ表の全数値が一致した。staging実DBでもraw7,465行、種6,628、亜種837、科88、基亜種299、未同定種小名338、重複4組、親なし亜種0を確認。上位を含む分類群10,055件、名称18,046件。2回の実投入で全コードとDB内部IDの組合せ・監査件数が変わらず、権限56件も再成功した。必須5コマンドと単体30件が成功。PR #10は最終headのGitHub CI成功後にマージ済み。
7. T07: 47県のiNaturalist/GADM IDをすべて保持し、90島と独立区分の南千島を加えた138地域を実装。県隣接は174方向辺・87組で対称、重複・自己隣接・未知県は0。stagingへの2回投入で地域コード/内部IDが同一だった。必須5コマンドと単体46件が成功し、元smoke全56観点、実pgTAPは元56件と地域権限の追加4件が成功した。

## 未確認・未実施

1. T06は上記の受け入れ保留。以後はT08から順次実装する。stagingへのmigrationとseedの適用、件数・権限・診断は確認した。配信、メールなどは今後確認する。T03のローカル検証はPostgreSQLエンジンPGlite上でSupabaseの認証部分を模したもの。
2. 本番DBへの接続・秘密情報参照は行っていない。ゲートG1〜G9は未確認。Supabase stagingは接続ツールで権限拒否されたが、既存認証を使うCLIで空DB・既定権限を確認し、migrationとseedを適用して権限を検証できた。
3. 依存更新は週1回PRを作る設定。開発用パッチ更新の自動マージはA05で実装するまで有効化しない。
4. RLSのCI検証をT04で追加した。CIのPostgreSQL 16では認証部分を模し、アプリの全migrationとseedを適用して権限を実検査する。Supabase固有の認証はstaging 17.11の実行で補った。E2Eは対象実装のタスクで追加する。
5. PR #1の未登録鍵の待機・再実行仕様はmainへ統合済み。新設T02aでrequire-env、recheck-envと既存取込ジョブの整合を実装する。鍵入力scriptはオーナー用として保持し、Codexは実行・値の取得を行わない。

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

## T06の実装・実検証（受け入れ保留、2026-11-06）

1. `pnpm import:listmj-annotations` は検証済みHTMLを読み、`generated/listmj/annotations.sql`、`annotations_report.json`、T05の情報と統合した `import_report.json` を生成する。原文と部分分解の一覧を保持し、レポートで文献の受け入れ未達を明示する。
2. 注釈975件はすべて元HTMLの直前speciesブロックと一致し、未解決0件。科、学名全体、和名、原順序を照合する。speciesブロック6,626件とExcel6,628種の差は行2871/5962として報告する。同一表示のWestermanniaの2行は順序上の便宜的対応で、分類学的判断ではない。重複4組の8行には注釈が0件なので、注釈を推測して付けていない。
3. 原典281文献の著者と年を保持。構造を分解できた文献250、partial31、unparsed0で計281。不足一覧はpartialを含む31件を収録する。parsedは正規表現で構造を読めた意味で、外部の書誌との照合済みを意味しない。全281件をpending・auto_published=falseとし、公開していない。
4. 追記migration `20261105223812_listmj_annotation_provenance.sql` で、注釈・文献のHTMLハッシュ、出典項目番号、原HTML、文献の原著者列を保持する。同文の別項目をまとめず、再投入で項目が増えない。一般利用者は出典列を書き込めず、従来の文献投稿項目とRLSは維持する。編集済み表示本文・分類群との対応は上書きしない。
5. stagingの実DBへmigrationと注釈・文献を適用し、2回投入した。注釈975、文献281、未解決注釈0、pending文献281、著者年281、誌名250を確認。前後のID集約ハッシュは注釈 `6fc5ed8e51a1a0af224846379bc9077c`、文献 `8139fcc08d89548ebb923e8667dc9ab0` で一致し、監査29,383件も不変。新出典列の書込不可・従来titleの書込可、実pgTAP56件成功、security advisors WARN以上0件を確認した。
6. 必須5コマンドと単体38件が成功。CIも同じSQLを使い捨てPostgreSQLへ2回適用する。CIはデータ保全・解析・権限を確認するものであり、仕様の282件一致は未達のまま。

## T07の地域と再実行（2026-11-06）

1. `pnpm import:regions` で4つの正本CSVを検証し、`generated/regions/regions.sql`、`regions.json`、`adjacency.json`、`regions_report.json` を出す。各入力のSHA-256を記録し、ネットワーク取得を行わない。既存prefectures.csvは変更せず、SHA-256は `50915fe153d5c10f98209314d227330b66ec9ab8bbf3bd97fa2fb2c30e915b93` のまま。
2. 都道府県47、島90、otherの南千島1、計138地域。すべての県に外部IDがあり、島は正しい親県を持つ。島の外部ID・座標は未設定。南千島OT01は親県なし。隣接はCSVとJSONで管理し、島コード・OT01を県の隣接へ混ぜない。
3. 隣接は共有する陸域県境を対象とし、川・湖上の県境と島内境界を含む。岡山−香川、広島−愛媛の共有島上の例外も含める。海峡・橋・トンネルだけでは追加しない。境界データの精密ポリゴン検証や地図公開は行っていない。採用範囲と公的出典はdecisions.mdと各島CSVのsource_urlを参照する。
4. 追記migration `20261105225355_region_seed_provenance.sql` で出典識別用の2列と制約を追加した。一般利用者の地域表の権限は読取のみのまま。コードの誤再利用を全体停止し、正当な再投入で管理者の表示名や並び順を上書きしないことをテストした。
5. stagingへmigrationとSQLを適用して2回投入した。138地域のコード/内部ID集約ハッシュは前後とも `6114c8a692cea6277f9780e14f4637c6`。県IDの欠落0、島の親誤り・推測座標0、seed_keyのauthenticated更新許可falseを確認した。実pgTAPは元56件と地域出典権限の追加4件が成功し、security advisors WARN以上0件。新しい公開・課金・投稿機能は有効にしていない。

## T07終了時点のstaging状態

- 適用済み: 0000〜0003、20261105223812の注釈出典migration、20261105225355の地域出典migration。
- public表34、RLS無効0、分類群10,055（species6,628を含む）、全raw7,465行、名称18,046、注釈975、文献281（全pending）、地域138。
- 文献上の主張であるrecordsは0件。文献や注釈を、生物の観察・標本・産地記録へ変換していない。
- 機能フラグ16・外部資源10。初期状態から有効なのはinat_layerとgbif_layerだけ。機能の一般公開・本番接続・本番反映は行っていない。

## T08の集計処理と未確認事項（2026-11-06）

1. `pnpm sync:inat` は設定を要求せず待機する。stagingの接続・問い合わせ先が設定された環境で `pnpm sync:inat --run` を実行する。週次ジョブは月曜03:00 JST、stagingだけを対象とする。秘密情報を取得・表示していない。
2. 47県×2品質区分の全ページを検証し、完全一致で一意な学名/階級だけを対応づける。未対応は `generated/inaturalist/unmatched.json`。座標・応答原文は出力しない。写真は観察URL・許諾・帰属が揃う各種最大6枚。全APIは2秒以上の間隔、429はRetry-Afterまたは60秒、再試行3回で停止する。
3. 追記migration `20261105230719_external_snapshot_ingest.sql` のRPCはsecurity invoker・固定search_pathで、service_roleだけが実行できる。全検証と保存を1つの処理にまとめ、異常時には対応づけを含めて戻す。同一payload再投入はIDと監査を増やさない。公開権限・RLSは弱めていない。
4. stagingへmigrationを適用し、実pgTAP追加12件が成功した。anon/authenticated実行不可、service_role実行可を別クエリでも確認。テストはROLLBACKされ、外部snapshot・集計・写真は各0件のまま。security advisors WARN以上0件。
5. 必須5コマンド成功、単体62件、元の権限smoke56×2件成功。2秒間隔・429・未対応・写真許諾・ページ欠落・原子的保存はモック/ローカルDBと実pgTAPで確認した。
6. GitHub stagingの秘密情報と問い合わせ先が未登録のため、全国API実収集・定期ジョブの実データ保存は未確認。待機は収集成功や0観察を意味しない。既存分類基盤・文献・記録・機能フラグを変更していない。

## T09のGBIF集計と未確認事項（2026-11-06）

1. `pnpm sync:gbif` は待機。staging・GBIF username/passwordが設定されたジョブで `pnpm sync:gbif --run` を実行する。月初04:00 JSTの判定をUTC月末28〜31日のジョブ内で行う。未設定の秘密情報を要求・取得・表示していない。
2. 実装前のdecisionsに従いDWCAとlegacy GBIF Backboneを明示する。iNaturalist datasetをAPI predicateと行の再検査で除外する。GADM IDだけで県を判定し、学名・科・階級の一意なEXACT対応だけを保存する。COL英数字keyの整数化や地名からの推測は行わない。
3. Basic認証は固定のrequest endpointだけに送信し、リダイレクトを拒否する。ダウンロードは別の認証なしリクエストで許可HTTPSホストだけを追う。SUCCEEDEDとDOIを確認してからZIPをprivate一時領域へstream保存し、occurrence.txtだけをstream処理する。raw表全体をメモリへ載せず、archive/展開サイズ・1行の上限を持つ。CRCと全行の検証完了後にだけ集計を保存し、ZIPは例外・途中停止でも削除する。
4. DOI、正確なrequest JSON（認証情報なし）、取得日時はprivate snapshotへ原子的に保存する。モックAPI/小型実ZIPで成功・失敗・除外・座標不保持・chunk境界・cleanupを検証する。stagingの追加pgTAP4件でモックDOIの保存とDOI欠落拒否が成功し、ROLLBACK後はsnapshot/集計0、分類群10,055、records0のまま。
5. GBIF接続情報が未登録のため、実際のDownload API POST、全国ZIP取得、実データ由来DOI・定期保存は未確認。モックDOIを実取得の成果として扱わない。公開/課金/投稿のフラグ、本番環境は変更していない。
6. 必須5コマンドと単体81件が成功。実ZIPのCRC失敗・未消費・consumer例外・経路逸脱・欠落GADM列・UTF-8/列幅の不正を拒否し、全経路で一時領域の削除を確認した。公式DWCAの囲みなし形式と実GADM term URIをテストし、quoteを含む無関係なlocality列でも誤って失敗させない。

## T10の公開データ生成（2026-11-06）

1. `pnpm build:public-data --run` はstaging設定があればservice_role専用の単一SQL snapshotを読み、許可列から生成する。設定がなければ待機。公開サイトはDBへ接続しない。`--seed --output generated/public-ci` は同梱正本だけから作る開発用baselineで、実DBの審査・機微設定を反映した版とは区別する。
2. 鍵なしの既存CLI認証でstagingの実sourceを `generated/private/public-source-envelope.json` へ保存し、`pnpm build:public-data --source generated/private/public-source-envelope.json` を実行した。公開版は `apps/public/public/data/2026.11.2/`。分類群10,055、species6,628、subspecies837、地域138、公開文献0、公開記録0。281文献はpendingのため公開しない。注釈を記録へ変換していない。
3. 283ファイル、最大886,339バイト。辞書式JSON、地域別CSV.gz、全SHA-256のmanifestを生成し、`pnpm verify:public-data generated/private/public-source-envelope.json apps/public/public/data/2026.11.2` でも全件再検査した。manifestのSHA-256は `0b2dbfa2b4933370a312041ea9846dfbb2481eac5388107d4c996e84df578a28`。staging releasesに同hash・counts・status=building・published_at=nullで登録し、再読取でも確認した。配信・live化は行っていない。
4. 機微度1の自由文noteを含む詳細はnull、機微度2は記録行なし・地域有無だけ（wire6=presence_only、discovery=false）。由来別national集計にも元の証拠区分を含めない。機微島はprivate親子mapから親県/otherへ粗くし、機微種の写真も省く。原記録は変更しない。生JSON・未使用辞書・展開CSVをprivate機微map/地域mapと照合し、メール、全UUID、未公開status、未知列/ファイル、機微詳細や島の混入で失敗する。CSVの式候補は中和する。
5. 公開root外の一時領域で生成・全検査してからatomic renameする。失敗時には版を置かず、既存版は上書きしない。地域→科、属→種、必要時は番号付きshardで8MiB以下に分け、18,000ファイル上限を検査する。10版保持・配信先切替の実運用はT17へ引き継ぐ。
6. 追記migration `20261105233617_public_source_export.sql` はinvoker・固定search_path、anon/authenticated実行不可、service_roleだけ実行可。staging実pgTAP追加6件とsecurity advisors WARN以上0件が成功。実REST経由の定期生成はstaging秘密情報未登録のため未確認。直接SQLによる実source生成、ローカル公開版検査、building登録とは区別する。
7. 必須5コマンドと単体102件が成功。機微詳細・非公開記録・メール・UUID・辞書・CSV改ざん（hash更新込み）・島・写真・非公開文献への参照・atomic失敗・size sharding・JST月境界を検証した。CIは同梱baseline生成と全migrationの実PostgreSQL権限検証も実行する。

8. 独立レビュー前の未公開2026.11.1は、新契約へ上書きせず generated/unpublished-builds/2026.11.1 へ移した。staging release1はfailed（公開前にsupersededの注記）、最終2だけがbuilding。過去版の物理削除・live切替はしていない。


## T02aの鍵待機と再開（2026-11-06）

1. PR #1の仕様を統合し、require-envを既存のiNaturalist/GBIF/公開生成jobへ適用した。未登録なら不足名だけをlog/summaryへ表示し、ready=falseで正常終了する。setup/install/実処理を飛ばす。GBIF_USERNAMEはvars、CONTACT_EMAILもvars/manifestへ揃えた。値の取得・登録は行っていない。
2. recheck-envはmain上のstaging/production選択だけを受け付ける。Environmentも秘密もないvalidate jobで確認した後、選択Environmentの保護を受けるdispatch jobへ進む。本番承認前の鍵注入・dispatchを行わない。actions:writeはこのjobだけ。現在の3処理はstaging専用なのでproductionでは未実装として表示し、stagingへ流用しない。
3. DB定義反映と配信workflowは未実装として記録し、起動しない。実装済みのiNaturalist→GBIF→公開生成を、設定が揃ったものだけ順に実行する。GitHub APIが返すrun IDとイベント/main/run-nameを検査し、実処理step成功まで待つ。子が待機なら完了と扱わず、失敗なら後続を止める。最新runを推測しない。
4. 合計監視は5時間。正常な子が長時間継続している場合も親だけ時間切れになる可能性がある。この場合は表示された子runをActionsで先に確認し、同じ子を重複起動せず、未実行の処理だけを個別workflowから再開する。自動の再dispatchはしない。各処理別の監視job分割は運用時間を見て見直す。
5. stagingのSecret名一覧が0件であることを値なしで確認した。readiness_only=trueで実iNaturalist workflowを起動し、run42134497898はsuccess。require-env成功、setup/install/実処理はskippedを実際のjob結果で確認した。診断入力は、途中で鍵が揃っても実処理を起動しない。
6. 必須5コマンドと単体115件が成功。未登録/登録済み、値の非表示、未知名/manifest欠落、不正環境、production→staging拒否、子の失敗/待機/時間切れ、正確なrun ID照合、vars/secret整合を検証した。登録済みの再開はモック確認で、実キー登録後の外部収集/DB保存/配信・本番起動は未確認。set-secrets.shは読取のみで実行していない。

## T11 公開サイトの骨格（2026-11-06）

- Astro静的サイトの共通レイアウトとトップ・about/data/changes/privacy/terms、次の検索工程の入口を実装した。サイト名は仮称、問い合わせ先は未設定のまま。本文は日本語で、公開文献・記録0件と外部集計未取得を明示している。
- 実stagingの公開用成果物2026.11.2を使用。apps/publicはDBへ接続せず、Supabase依存もない。提供ファイルの全SHA-256をbuild前に再照合する。機微判定の元データは公開buildへ取り込まない。
- 全7ページと公開manifestのローカル実HTTP応答で200と5指定ヘッダ・補助X-Frame-Optionsを確認した。Wrangler Static Assetsが_headersを処理している。全生成HTMLのinline script/style/style属性なしをbuildの必須検査にした。
- 通常・release buildは公開成果物の欠落や開発seedの代用を拒否する。明示CI/dev opt-inだけT10のoffline generatorを再利用し、起源を画面に示す。ci_onlyメタデータは鍵setter・再開・require-env対象から除外する。鍵スクリプト・本番接続・新hosting登録・配信は実行していない。
- ローカル確認URLは http://127.0.0.1:8787/ 。公開・stagingへの配信結果を意味しない。検索の実処理はT12、種/地域/CSVと性能の検証は続くT13〜T16で実施する。
