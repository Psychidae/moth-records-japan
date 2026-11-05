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
