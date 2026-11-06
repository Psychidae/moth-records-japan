# 技術上の判断

## 2026-11-06 T01: 待機期間と開発用の道具

1. npm registry の公開日時を照合。指定 Vitest 5.1.0（11月2日公開）は7日の待機期間内なので5.0.5へ固定。AstroはT11で同様に選定する。
2. T01に必須のESLintを動かすため、ESLint 10.13.0、typescript-eslint 8.72.1とNode 24型定義24.19.2を開発用に限定して追加。仕様に必要な検証道具として採用し、実行時依存は増やさない。
3. 最初のPRもCI成功後にマージするため、T01に最小のci.ymlを含める。T02で保護の検査とDependabotを追加する。
4. インストール用スクリプトは既定で無効。ワークスペースの依存公開後待機期間は10080分。

## 2026-11-06 T01: TypeScript互換性

TypeScript 7.0.2でESLintを実行するとtypescript-eslintが未対応として停止した。仕様の互換性例外に従い、待機期間を満たすTypeScript 6.0.3へ下げる。strict設定を維持する。

## 2026-11-06 T02: CIの保護

1. CIは外部サービスの秘密情報を受け取らず、forkからのPRでも同じ5コマンドを実行する。checkoutは資格情報をGit設定へ残さない。
2. Actionの不変SHA、最小の既定権限、禁止トリガー、依存の完全固定と公開アプリのDB依存禁止を回帰検査する。YAML解析用の依存は増やさず、検査対象を明確にしたテキスト検査と不正変更のテストを使う。
3. DependabotはnpmとGitHub Actionsを週次で提案する。自動マージの判定はA05の範囲なので、T02では有効化しない。必須チェック名はchecks、オーナー向けの追加・再確認手順はhandover_report.mdへ記載した。

4. Vitestの対象をtests配下の単体テスト（.test.ts）に限定し、ビルド出力distのテストを二重実行しない。E2Eは後続タスクの専用実行へ分離する。Supabase CLIの一時メタデータはGit管理から除外する。

## 2026-11-06 T03: 初期DBとseed

1. 仕様の指示どおりdocs/02_schema.sqlをバイト単位で変更せず0001_init.sqlへ複製する。authとロールの模倣はローカル検証用だけに置き、migrationには含めない。
2. 指定PGlite 0.5.15（11月3日公開）は7日の待機期間内なので、待機期間を満たす0.5.13（10月28日公開）を検証用依存へ固定する。
3. 2つのCSVをZodで検証して決定的なsupabase/seed.sqlへ変換する。再投入は既存キーを更新せず、管理者が変更したフラグや外部資源の権限を上書きしない。初期値自体はseedの正本を保つ。
4. 空DB適用と権限のローカル検証はPGliteを使用する。Supabase stagingへの実適用・接続は別の確認事項として記録する。

## 2026-11-06 T03: Supabaseの既定権限を明示的に除去

stagingの読み取り調査で、postgresがpublicに作る表・シーケンスはanon/authenticated/service_roleへ既定で全権限が付くことを確認した。正本の0001はanonだけを取り消すため、authenticatedの表全体UPDATEがprofilesの列制限を無効化する。

0001のバイト同一性を保ち、0000_restrict_defaults.sqlで新規オブジェクトへの既定公開権限を先に取り消す。これで0001と0002を別トランザクションで適用しても、途中で過剰な表権限が発生しない。0002_harden_privileges.sqlは既存環境への防御としてpublic表・シーケンスのPUBLIC/anon/authenticated権限を取り消し、正本で許した権限だけを再付与する。profilesの列ACLも明示的に初期化する。RLSポリシーとservice_role権限は変更しない。

以後のmigration実行者postgresによるpublic表・シーケンスの作成も既定で非公開にする。Supabase内部管理者supabase_adminの既定ACL、auth/storageスキーマや既存拡張関数は変更しない。今後のmigrationも明示的な権限付与とRLSテストが必要。検証はSupabaseと同じ既定ACLをローカルで先に与えてから全migrationを適用する。

## 2026-11-06 T03: staging診断に基づく関数・拡張の補強

stagingへの0000〜0002とseedの適用後、Supabaseの診断で4関数の可変search_pathとpublic内のpg_trgmが警告された。適用済みmigrationと正本は変更せず、0003_harden_functions.sqlを追加する。参照が既にスキーマで修飾されているapp.is_mfa、app.require_mfa_role、app.block_audit_change、app.guard_submissionのsearch_pathを空に固定する。

pg_trgmはextensionsスキーマへ移す。拡張の再作成や既存GIN索引の作り直しは行わず、索引・演算子クラスの参照を保持する。ログイン利用者とservice_roleにはextensionsのUSAGEだけを許可する。移動後の名前空間、索引の有効性、関数設定と元の56権限観点をローカルで再検証する。

## 2026-11-06 T04: 秘密情報なしの実DB権限検証

CIはUbuntu 24.04のOSパッケージからPostgreSQL 16、pgTAP、pg_proveを導入し、使い捨てのローカルDBへ全migrationとseedを適用する。npmの実行時依存は増やさない。Supabaseが提供するauth.uid/auth.jwtと3ロールだけをCI用SQLで模し、ホスト側の広い既定ACLも再現する。アプリの権限・トリガー・関数は実際のmigrationを検証する。

既存PGliteの56観点は正本と全migrationに対して維持し、CIでも実行する。同じ56観点をpgTAPへ移植し、原文の観点名の欠落をCIで検出する。pgTAPはBEGIN/ROLLBACKで囲み、stagingでもfixture行や機能フラグ変更を残さない。IDシーケンスの通常の欠番は許容する。stagingのPostgreSQL 17でも別途実行し、CIのauth模倣との差を確認する。本番接続は行わない。

## 2026-11-06 T05: 検証済みのオフライン分類基盤

List-MJの同梱XLSXとJSONLのハッシュ・XLSXサイズを検査してから、Zodで行を検証する。実行時のネットワーク取得やExcel読込依存は追加しない。データ行の7,465個の永久コードを元の行順で先に割り当て、上位階級はその後に初出順で採番する。SQLの挿入順は親が先となるよう調整し、コード順と挿入順を分ける。

重複4組は異なるコードで保持し、未定属は上位へ直結する。statusの受け入れ内訳はspeciesのみの6,628件で計算する。全raw行と著者・年・原文名称の出典を保持し、集計ページとの差もレポートへ残す。

取込SQLは単一トランザクションとし、既存コードが異なる由来・行・階級に使われていたら停止する。正当な再投入はコード・DB内部IDを保ち、管理者の和名・機微設定などの編集を上書きしない。新しい版への再割当を自動で推測せず、今回の固定版を再現する。

Node 24の型除去で複数のTypeScriptファイルを直接実行できるよう、相対.ts importを使い、TypeScriptのrewriteRelativeImportExtensionsでビルド時の.js参照へ変換する。実行時依存は増やさない。生成SQLとimport_report.jsonはgenerated/listmjへ置き、入力正本と分けてGit管理対象外にする。

stagingではManagement APIのSQLサイズ制限とCLI seedの事前prepareの制約があった。正本SQLを保ち、専用adapterで単一DO/EXECUTEへ包む。Supabase CLIの直接DB接続で実行し、通常のpsql/CIでは元のSQLを使う。adapterも実DBエンジンで検証し、同じ原文からの取込と再投入を実証する。

## 2026-11-06 T06: 原典の文献件数不一致と受け入れ保留

固定SHA-256 `8db7b2532194d617367f769ae426c937ae7fedd41bf27088ea39a7e75e6d928b` の同梱refs.htmlは51,860バイト、文献のliが281件である。開始タグ数、終了タグ数、独立のPython HTMLParserで反復確認した。入れ子・未閉鎖・空項目は0件。liの外側はtitleとh1の見出しだけで、文献項目はない。本文は12行目のAhn 2014から292行目のZilli 2009まで281件で完結する。

仕様の282件と一致する282件目を入力から回収できない。原典・仕様の282という受け入れ基準は変更せず、実在281件をすべて保持し、レポートにexpected=282、actual=281、passed=falseを記録する。T06の実装を検証してPRを統合しても、T06の完了チェックは入れない。オーナーが原典と期待件数を確認するまで受け入れ保留とする。

今回の保留タスクはT06のみ。連続実行規則の「同じ失敗を3回繰り返したら引き継ぎへ記録して次へ進む」に従い、上記3方式の受け入れ不一致を記録し、以後はこの保留を除く最上位の未完了タスクへ進む。CIは実在データの保全・冪等性・権限を検証し、282件の受け入れ成功を意味しない。

list.htmlのspeciesブロックも6,626件で、XLSXのspecies6,628件より2件少ない。全ブロックを原文・和名・順序で照合し、Excel2871行目（ウスイロトリバ）の表示がないことを確認した。Westermanniaの5961/5962行目は表示テキストが同一でHTMLが1ブロックなので、前の行を対応させる順序規則を明示する。これは分類学的な同一性の判断ではない。欠けた2行をレポートに残す。4重複組の8行には原典注釈がないため、この曖昧さから注釈を推定して作らない。

注釈の本文とは別にHTMLハッシュ・項目番号・原HTMLを保持する列を追記migrationで追加する。一意の出典項目で再投入を判定し、同じ本文の複数項目を統合しない。文献のauthorは原文文字列で分解結果を保持し、姓名の推測分割は行わない。文献はpendingで取り込み、自動公開しない。一般利用者は出典用の新列を書き込めず、従来の投稿項目とRLSは維持する。

## 2026-11-06 T07: 地域の出典と隣接の定義

既存prefectures.csvの47県のID・原文は変更しない。GADMは名前ではなくIDで照合し、長崎のNaoasakiという入力表記を警告へ残す。主要島嶼の初期範囲は90島（伊豆11、小笠原22を含む）として、公的資料の島名・所属を参照し自作する。島嶼の外部ID・座標は推測せず未設定にする。南千島OT01はotherとし、都道府県の子へ混ぜない。英語名は識別用のローマ字表記を含み、公式英語地名の完全な統一表ではない。全国の微小島・岩礁を網羅した島台帳ではない。

島名・所属の参照先（各島のCSVにもURLを残す）:

- [国土交通省の対象離島一覧](https://smartisland.mlit.go.jp/field/)と[離島の概要](https://www.mlit.go.jp/kokudoseisaku/chirit/kokudoseisaku_chirit_tk_000264.html)
- [西ノ島町の隠岐4島の説明](https://www.town.nishinoshima.shimane.jp/profile/gaiyou)、[長崎県の有人国境離島一覧](https://www.pref.nagasaki.lg.jp/bunrui/kurashi-kankyo/chiikidukuri/rito-hanto-kaso/kokkyoritou/kokkyo-law/)
- [鹿児島県の離島一覧](https://www.pref.kagoshima.jp/af08/syukuhakuwari/documents/127490_20260402141842-1.pdf)、[十島村の概要](https://www.tokara.jp/profile/gaiyou/)、[鹿児島県大島支庁](https://www.pref.kagoshima.jp/aq01/chiiki/oshima/)
- [沖縄県の離島関係資料](https://www.pref.okinawa.lg.jp/kensei/tokei/1016451/1038825.html)、[大東の沿岸域区分](https://www.pref.okinawa.jp/okinawa_kankyo/shizen_hogo/hozen_chiiki/shishin/syuuhen_umi_karte/index.html)
- [東京都の島一覧](https://www.islandaccess.metro.tokyo.lg.jp/)、[八丈小島の自然保護](https://www.soumu.metro.tokyo.lg.jp/09hatijou/kakuka_top/c-doboku/naturalparkprotection)、[東京都の火山](https://www.bousai.metro.tokyo.lg.jp/taisaku/torikumi/1023240/1023241/index.html)
- [小笠原のルールブック](https://www.vill.ogasawara.tokyo.jp/wp-content/uploads/sites/2/files1/27rulebook.pdf)、[小笠原支庁の管内概要](https://www.soumu.metro.tokyo.lg.jp/07ogasawara/guidance/summary)

隣接は都府県間の陸域境界（河川・湖沼上の県境と、島内の共有陸境界を含む）を手入力した174方向辺・87組とする。県コードPR間だけを扱い、IS島コード・OT01は県の隣接へ加えない。海峡や海上境界、橋・トンネルだけを理由に隣接とはしない。[玉野市の石島の説明](https://www.city.tamano.lg.jp/soshiki/1/1367.html)で岡山−香川、[愛媛県の瓢箪島の説明](https://www.pref.ehime.jp/ehimenotakara/780.html)で広島−愛媛の島内県境を確認して含める。一般の境界図の参照先は[国土地理院の日本全図](https://www.gsi.go.jp/chizuhensyu/chizuhensyu41009.html)。精密な行政区ポリゴンの取込・計算は行わず、G3の未確認状態を保つ。

regionsへseed_source/seed_keyを追記し、元のコード・種類・和名・親・外部IDのハッシュで出典上の識別を保つ。既存コードが無関係の地域や異なる入力の識別に使われていたら全体を停止する。正当な再投入ではDB内部IDと管理者の表示編集を保持する。隣接は新しい公開DB表へ入れず、正本CSVと生成JSONで後続の公開データ生成へ渡す。各入力のSHA-256と件数をレポートへ出す。

## 2026-11-06 T08: iNaturalistの集計と安全な実行

[公式Swagger](https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/views/swagger_v1.yml.ejs)のspecies_countsは末端分類群を返し、speciesだけを保証しない。既存IDを優先し、未対応は学名・階級が完全一致するローカル分類群1件とactiveな外部分類群1件のときだけ対応する。重複4組を先頭一致で解消しない。taxa検索は通常上限200件以内の完全な応答だけを採用し、切れた一覧から一意性を推定しない。外側のcountを使い、taxon.observations_countと混同しない。ページ総数の変化・重複・欠落は全処理を失敗させ、前のsnapshotを維持する。

県・quality_grade別の集計、学名検索、写真の取得と429再試行を単一の直列スケジューラへ通す。[推奨利用方法](https://www.inaturalist.org/pages/api+recommended+practices)より厳しい2秒間隔と9,500リクエスト上限を設ける。429は秒数/HTTP-dateのRetry-After、なければ60秒で3回まで再試行する。User-Agentにサイト英語名・版・連絡先を入れる。

応答はZodで必要列だけへ変換し、観察の座標、raw応答、taxon.default_photoは保存しない。写真は別の観察検索から、許諾コード、帰属表記、観察URL、許可ホストの画像URLがそろうものを各分類群最大6枚に限る。全取得・検証後にservice_role専用の原子的RPCを呼ぶ。未登録の連絡先・staging秘密情報は要求せず、定期ジョブを「待機」で正常終了させる。未収集は生物学的不在や0観察の主張ではない。

Supabase changelogの2026-11-04 CLI v3破壊的変更を確認し、既存2.90.0を維持した。実行前にCLI helpを確認し、stagingだけを対象とする。公開サイトへDB接続を追加しない。

## 2026-11-06 T09: GBIFの形式と分類基盤の固定

仕様のSIMPLE_CSVには県判定に必要なlevel1Gid列がない。[公式形式説明](https://techdocs.gbif.org/en/data-use/download-formats)と[実APIの列定義](https://api.gbif.org/v1/occurrence/download/describe/simpleCsv)を確認し、同列を含むDWCAへ変更する。ZIPのoccurrence.txtだけを列名でストリーム処理する。住所やstateProvinceから県を推測しない。level1Gidがなければ失敗させる。一時ZIPは成功・失敗とも削除し、座標・raw行を保存しない。

taxonKey=797とbigintの既存gbif_usage_keyを保つため、[分類基盤移行の公式説明](https://techdocs.gbif.org/en/data-processing/taxonomy-interpretation)に従いlegacy GBIF Backbone `d7dddbf4-2cf0-4f39-9b2a-bb099caae36c` をrequest本体とTAXON_KEY条件に明示する。新しいCOL XRの英数字keyを整数へ変換しない。学名照合は仕様のv1/species/matchを使い、完全一致・階級・科・一意なローカル学名を検証し、推測一致を保存しない。legacy backboneが更新されないことは公開時の出典説明へ引き継ぐ。

GBIFの[公式DWCA writer](https://github.com/gbif/occurrence/blob/dev/occurrence-download/src/main/java/org/gbif/occurrence/download/file/dwca/archive/DwcArchiveUtils.java)はfieldsEnclosedByをnull、区切りをタブ/改行に設定する。実archiveではquoteを通常文字として読み、CSV風の囲みを仮定しない。任意のquoted TSV用の別モードは、タブ・改行・chunk境界・二重quoteのテストを持つ。

[公式Download API](https://techdocs.gbif.org/en/data-use/api-downloads)のAND条件で日本・鱗翅目・2標本区分を指定し、NOTのpredicateでiNaturalist datasetを除外する。通知メールを無効にし、usernameによるBasic認証を環境だけから使う。SUCCEEDED以外の終了状態・不正行・途中失敗では全体を保存せず、前のsnapshotを残す。DOI、資格情報を含まない正確なrequest JSON、取得日時をprivateなsnapshotへ保存する。秘密情報が未登録ならジョブは待機し、実ダウンロード成功とは扱わない。


## 2026-11-06 T10: 公開列・機微情報・版の生成

service_role専用の単一SQL projectionを読み、許可した列だけから公開JSONを新しく組み立てる。原典raw、審査・投稿者ID、private provenanceは公開へ複製しない。公開済み記録が非公開文献・未解決分類/地域を参照していたら生成を失敗させる。機微度1では自由文note、標本情報、数量なども含め詳細を一律nullへし、機微度2では記録行を出さず地域存在だけにする。公開wire値6をpresence_only専用とし、0=noneは疎行列から省略する。既存の優先順位表の6（none）とwire値を区別する。機微度2の証拠由来とdiscoveryは伏せ、national集計にも元の由来を残さない。機微度2だけに使われた文献は一覧からも外す。外部写真は機微度1/2とも出力せず、詳細観察へのリンク経由の漏えいを防ぐ。

島の存在そのものが詳細産地になり得るため、機微度1/2のIS地域はprivateの地域親子関係を使って親都道府県まで粗くし、island欄もnullにする。otherのOT01はその区分のまま扱う。安全な県/otherの祖先がなければ失敗させる。これは「地域有無」の精度が未指定であることに対する保守的な既定で、private原記録は変更しない。検査ではprivateの機微map・地域mapと照合し、公開JSONの機微タグを消しても通過できない。

全JSONの生構造・辞書と展開後CSVを再検査し、UUID（GBIF dataset UUIDも含む）、メール、非公開記録、機微詳細を拒否する。CSVの式に見える文字列はアポストロフィで中和し、原文はprivateに保持する。8MiBを超える記録は地域→科、属→種の順に分割し、それでも大きければ番号付きshardへ分ける。全ファイル18,000以下・各JSON/展開CSV8MiB以下を検査する。

一時出力の全検査後に新しい版ディレクトリへatomic renameし、既存の版は上書きしない。版の年月はAsia/Tokyo。releasesのbuildingは生成済みを示すだけで配信・本番反映を意味しない。公開データはGit管理外の生成物で、同梱seedからの再生成は実DBの審査・機微設定を含まない開発用baselineと明示する。


## 2026-11-06 T02a: 鍵の待機と安全な再開

require-envはcheckout後の最初の確認に置き、manifestに登録されたGitHub用の設定名だけを調べる。未登録はready=falseと不足名だけをsummaryへ出して正常終了し、installと実処理を飛ばす。未知名・重複・不正なmanifestは設定ミスとして拒否する。値はstdout/output/summaryへ書かない。GBIF_USERNAMEはvariable、CONTACT_EMAILもvariableとしてmetadataに追加し、取得・登録は行わない。GitHub組込tokenやready等の内部出力は利用者が登録する設定ではない。

recheckはmain・staging/productionだけを許可する事前jobを置く。このjobにはEnvironmentも秘密情報も付けない。検証後のdispatch jobだけが選択Environmentの保護を受け、actions:writeを持つ。[GitHubのEnvironment仕様](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)に従い、本番承認前に鍵を注入・処理を開始しない。現在の取込3本はstaging専用なので、productionからは呼ばず未実装と表示する。DB定義反映・配信workflowも未実装として記録し、存在しない処理を起動済みと扱わない。

[GITHUB_TOKENによるworkflow_dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)と[REST API 2026-03-10](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)を確認した。APIの返すworkflow_run_idを追い、main・dispatchイベント・照合用run-nameも検査する。最新runの先頭を推測して使わない。子の実処理stepがskippedなら待機、失敗なら後続停止とし、単なるsuccess終了を実処理完了と誤認しない。

監視は合計5時間で停止する。各子の上限360分より短く、初回収集や合計時間によって後続へ進めない可能性がある。この場合は子が継続中かもしれないことを明記し、重複起動せず該当runを確認する。長時間処理ごとの独立した監視jobへの分割は、運用時間が分かった段階で見直す。readiness_onlyは設定確認だけの診断用入力で、鍵が後から揃っても実処理を開始しない。

## 2026-11-06 T11: 静的公開サイトと厳格なCSP

Astro 7.4.7は7日待機に抵触するため、npm registryで2026-10-28公開を確認した7.4.4を完全固定する。Wranglerも同条件で4.156.0（10月29日公開）をローカル静的配信検証に限り採用する。Astroはstatic出力、inlineStylesheets=never、assetsInlineLimit=0とし、hydration islandやClientRouterを使わない。スタイル・対話処理は同一originの外部ファイルへ置く。構造化データは後続タスクで可視HTMLのmicrodataとし、inline JSON-LDを入れない。Cloudflare Web Analyticsは外部script/connectが現CSPと矛盾するため無効のままにする。CSPを緩めず、導入判断をquestionsへ残す。

Cloudflare Static Assets用_headersは単一の/*規則へ5指定ヘッダと補助のX-Frame-Options: DENYを書く。Astro devにも同一ヘッダを設定するが、受入はWranglerの実HTTP応答で確認する。本番配信や新しいホスティング登録は行わない。

通常buildは検査済み公開成果物の欠落・ハッシュ不一致で停止する。実DB由来の提供版を優先し、公開済み版を書き換えない。明示MOTH_PUBLIC_BOOTSTRAP=1のdev/CIチェックだけ、既存T10の--seed生成処理を再利用できる。開発生成は由来markerを付け、画面に実DBの審査・機微設定を含まないことを表示する。CI=trueやNODE_ENVで自動的に代用しない。marker付き成果物は明示opt-inなしのbuildで拒否する。

pnpm 12では旧onlyBuiltDependencies/ignoredBuiltDependenciesは廃止されていた。公式[設定資料](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/build.md)に従いallowBuildsでesbuild/workerdを明示falseにする。postinstallは実行せず、配布済みplatform binaryでbuild/previewを検証する。minimumReleaseAge=10080とignore-scripts=trueを維持する。

一次資料: [AstroのCSS設定](https://docs.astro.build/en/reference/configuration-reference/#buildinlinestylesheets)、[client scripts](https://docs.astro.build/en/guides/client-side-scripts/)、[Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)、[Web Analytics CSP](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy)。

T11のデザインはオーナーの追加指示（2026-11-06）に従い、英語主タイトルJapanese Moth Distribution Records Database／日本語副題「日本産蛾類分布記録データベース」に変更した。いずれもconfigで差し替え可能とし、ドメイン・問い合わせ先は未設定のまま。提供パレットのcharcoal #232021 / light gray #D9D8D6 / navy #314465を基調とし、目録型の配置へ変更した。旧SVGと大見出しの宣伝文・反復する不在説明は削除し、未取得・未登録はデータ欄の簡潔な状態表示にした。PNGアイコンはオーナーが選んだ方法の承認後に追加し、それまではテキストだけのヘッダとする。

公開inputは選択した最新版だけでなく配信対象の全版を検査する。manifest未被覆ファイル、不明root項目、重複、symlinkを拒否する。開発seedが旧版に残っていても通常/release buildを停止し、public外へ移すよう案内する。現成果物に混入はなく、独立レビューで指摘された経路を回帰テストで閉じた。

## 2026-11-06 T12: 公開名称検索

全ページの検索focusまたは検索操作後にだけnames.jsonを読み、Zodでwire形式と各名称行を検証してから正規化indexを作る。NFKC・ひらがな→カタカナ・英字大小・空白を正規化し、複数コードの同学名を保持する。名称の種類を推測せずother_namesを別名/異名候補として扱い、該当時は採用中のscientific_nameへ案内する。検索語/ページはURLへ保存し、描画はtextContentとDOM作成だけで行う。

Zod4の既定JITは厳格CSP下で動的実行の可否probeを試み得る。公開DTO moduleでschema構築前にjitless=trueへ固定し、Function constructorを使用不能にした別Node processでもschema作成・読込・検索が成功する回帰テストを加えた。CSPへunsafe-eval等は追加しない。依存は追加していない。

## 2026-11-06 B01: 承認済み透過PNGのブランドアイコン

オーナーがCodex内の実生成を明示承認したオオミズアオActias alienaのAIイラストを、独立したB01変更として採用する。ヘッダは96/192px、faviconは32/64pxのPNGを同一originから配信する。SVGや他サイトの写真は使用しない。原本1254pxと生成・余白調整プロンプトはdocs/brandingへ保持し、公開distへ含めない。標本/観察写真や分布記録の証拠としては扱わない。

公開rootはdata/_headers/robots.txt/assetsだけを許可する。assetsは上記4ファイルの完全一致に限定し、PNG signature・8bit RGBA・寸法・小さい容量上限・固定SHA-256を検査する。不明なroot/asset項目、symlink、PNG payloadの変更を拒否する。CSPは変更しない。
