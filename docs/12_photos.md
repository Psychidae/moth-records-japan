# 12 写真の投稿と iNaturalist 連携

誰でも写真を投稿でき、種に登録し、別の種へ移動できるようにする。希望者は iNaturalist へ同時に投稿できる。

テーブルと権限は `docs/12_photos_schema.sql`、検証は `tests/photos_schema_smoke.mjs` に定義する。

## 基本の考え方

1. 写真に種を直接持たせない。同定の履歴を持ち、移動は履歴の追加とする
2. 写真は文献の記録に混ぜない。地図では別の層とし、県別の証拠区分を変えない
3. 本サイトと iNaturalist の種の不一致は自動で解消しない。検知して人へ回す
4. iNaturalist への書き込みは、本人が画面で操作したものだけとする。AIや定期処理から書き込まない
5. 本サイトに座標、iNaturalist のトークン、元の画像ファイルを保存しない
6. iNaturalist の承認がなくても、段階1と段階2は動く

## 3つの段階

| 段階 | 内容 | 機能フラグ | 前提 |
|---|---|---|---|
| 1 | iNaturalist の観察URLから写真を取り込む | `photo_import_open`, `photo_layer` | なし |
| 2 | 本サイトへ写真を投稿し、種へ登録、移動する | `photo_uploads_open` | G10 |
| 3 | iNaturalist へ同時に投稿し、同定を追加する | `inat_cross_post` | G11 |

機能フラグの初期値はすべて偽とする。ゲートは実装を止めない。

## データ構造

| 表 | 内容 |
|---|---|
| `photo_observations` | 1回の観察。永久ID `PH0000001`、状態、現在の種、県、日付、iNaturalist の連携状態 |
| `photos` | 観察に属する画像。最大4枚。保管先、検査状態、ライセンス、撮影者名 |
| `photo_identifications` | 同定の履歴。追記のみ |

`profiles.photo_trust_level` は写真専用の信頼度である。記録の `trust_level` と分ける。

| 状態 | 意味 |
|---|---|
| `draft` | 下書き |
| `pending` | 審査待ち |
| `published` | 公開中 |
| `rejected` | 却下 |
| `withdrawn` | 投稿者が取り下げた |
| `takedown` | 公開停止 |

## 種の登録と移動

種を変える経路は `app.move_photo_observation` だけとする。

| 場面 | 権限 | 動き | 履歴の `kind` |
|---|---|---|---|
| 最初の登録 | 投稿者本人 | 種を設定する | `initial` |
| 本人が移動、`photo_trust_level` 0 | 投稿者本人 | 公開中なら `pending` へ戻す | `owner_move` |
| 本人が移動、`photo_trust_level` 1 | 投稿者本人 | 公開のまま反映する | `owner_move` |
| 審査者が直接移動 | 審査者以上。理由が必須 | 反映する | `reviewer_move` |
| 修正提案の適用 | 審査者以上。自分の提案は不可 | 反映し、提案を `accepted` にする | `suggestion` |
| 学名の変更、異名化 | `app.apply_taxon_change` | 新しい分類群へ追随する | `taxon_change` |
| URL取込の初期値 | 自動 | iNaturalist の種を対応づける | `inat_import` |

- 取込の登録者は本人とみなさない。取り込んだ写真の移動は審査者か修正提案で行う
- 他の人の指摘は修正提案（`target_type='photo'`, `kind='misidentification'`）で受ける。写真の表示欄に「別の種では？」を置き、ログインなしでも使える
- AIの提案は `suggestions` に入れるだけで、種を変えない
- T33 の `app.apply_taxon_change` に、`photo_observations` の追随と履歴の書き込みを含める

## 段階1 URL取込

画面は投稿サイトの `/photos/import` とする。

1. ログイン利用者が iNaturalist の観察URLを貼る
2. Edge Function `photo-import-inat` がURLから観察IDだけを取り出す。許可する形は `^https://(www\.)?inaturalist\.org/observations/(\d+)$` とする。利用者のURLへ接続しない
3. `GET https://api.inaturalist.org/v1/observations/<id>` を読み、次をすべて確認する
   - `place_ids` に `regions.inat_place_id` の都道府県が含まれる
   - 種が `taxa.inat_taxon_id` に完全一致する。種または亜種のみ
   - 写真の `license_code` が `cc0, cc-by, cc-by-nc, cc-by-sa, cc-by-nc-sa` のいずれか
   - 画像のホストが `static.inaturalist.org` か `inaturalist-open-data.s3.amazonaws.com`
   - 同じ `inat_observation_id` が未登録
4. `source='inat_import'` の観察と、`storage='inat'` の写真を作る。条件を満たす写真を最大4枚とする
5. `photo_trust_level` 0 なら `pending`、1 なら公開判定へ進む

観察の座標は保存しない。画像ファイルは複製せず、iNaturalist の画像URLを表示する。撮影者名は API の `attribution` をそのまま保持する。

**制限**: 1利用者1日20件。全体で1分30件。超過は `429` を返す。

## 段階2 本サイトへの投稿

画面は投稿サイトの `/photos/new` とする。

1. 写真を最大4枚選ぶ
2. ブラウザが撮影日と座標を EXIF から読み、長辺2048pxの JPEG へ縮小する。これで元の EXIF は消える。EXIF の読み取りは依存を増やさず `packages/` に小さな処理を書く
3. 種、県、撮影日、成長段階、産地、ライセンスを入力する
4. 本人撮影の申告（`declared_own_work`）を確認する。他人の写真は受け付けない
5. 下書きを作り、`app.move_photo_observation` で種を登録する
6. Edge Function `photo-start` が検証し、隔離領域への署名URLを発行する
7. ブラウザから R2 へ直接アップロードし、`pending` へ変える

| 項目 | 値 |
|---|---|
| 受付形式 | JPEG のみ。ブラウザが変換する |
| 1ファイル | 10MB まで |
| 1観察 | 4枚まで |
| 1日の上限 | `photo_trust_level` 0: 10観察、1: 100観察 |
| 署名URLの有効期限 | 15分 |
| ライセンス | `cc0, cc-by, cc-by-nc, cc-by-sa, cc-by-nc-sa` から選ぶ。既定は `cc-by-nc` |
| 撮影者名 | 既定は `display_name`。公開後の表示に使う |

種が分からない写真は提出できない。科や属の分類群は登録できる。

座標は投稿画面の中でだけ扱い、本サイトへ送らない。段階3の同時投稿でのみ、ブラウザから iNaturalist へ直接送る。

### 検査と再生成

`process-photo.yml` は `09_literature_repository.md` の6節と同じ2段階とする。アップロード時と1時間ごとに動く。

**段階1 隔離処理（信頼しない）**: 使い捨て環境で `--network none` のコンテナを使う。持たせる鍵は隔離領域の読み取りのみとする。

1. 実サイズと先頭バイトを確認する
2. 元ファイルの SHA-256 を計算する
3. ClamAV で検査する。検出時は `malware_result='infected'` とし、削除する
4. `vips` で画像を読み直し、全メタデータを除いて JPEG を作る。長辺2048、1024、500、240px の4種類とする
5. 出力に EXIF、XMP、IPTC が残っていないことを確認する

**段階2 登録（信頼する）**:

1. `stored_sha256` で重複を確認する。重複なら審査画面に表示する
2. 非公開領域へ保存し、`state='ready'` にする。元ファイルを削除する
3. `10_automation.md` の条件を満たせば公開し、それ以外は審査へ回す

R2 のバケットと鍵は文献保管庫のものを使い、鍵の先頭に `photos/` を付ける。新しい鍵は増やさない。

## 審査

`/review` に写真の欄を加える。

- 一覧で写真、種、県、撮影日、ライセンス、重複の疑いを見る
- 非公開領域の画像は Edge Function `photo-view-url` の5分の署名URLで表示する
- 承認は最大50件をまとめて選べる。処理は1件ずつ `app.review_photo_observation` を呼ぶ
- 却下には理由が要る
- 自分の投稿は承認できない

確認する点は、蛾の写真であること、個人情報や無関係な内容が写っていないこと、明らかな誤同定でないことの3つとする。種の断定は審査の条件にしない。

## 公開

公開サイトの生成とは別に `publish-photos.yml` が毎日動く。1枚ごとのページを作らず、R2 の JSON を更新する。Workers のファイル数の上限に影響させないためである。

| 公開先 | 内容 |
|---|---|
| `files.<domain>/photos/index/<taxon_code>.json` | 種ごとの写真一覧 |
| `files.<domain>/photos/item/<observation_code>.json` | 写真1件の詳細。同定の履歴の件数を含む |
| `files.<domain>/photos/summary.json` | 種と県ごとの件数。地図の写真層に使う |
| `files.<domain>/photos/<observation_code>/<n>-<size>.jpg` | 公開用の画像 |

- 公開時に非公開領域から公開領域へ移す。`withdrawn`, `takedown` は公開領域から消し、JSON も更新する
- 変更があった種と写真のファイルだけを書き換える
- 書き込む前に `verify.ts` と同じ検査を行う。メール、UUID、未公開の投稿、機微種の詳細が混ざれば停止する
- `files.` に公開サイトからの CORS を設定する
- 公開サイトは Supabase へ接続しない。この規則は変えない

種ページは、本サイトの写真を先に、`external_photos` を後に表示する。同じ iNaturalist 観察は1回だけ表示する。写真の取得に失敗しても種ページは表示する。

写真1件のURLは `/photo/?code=PH0000001` とする。静的なページ1つが JSON を読む。種が移動してもURLは変わらない。

### 機微種の出力

| `sensitivity` | 写真 | 県 | 撮影日 | 産地 | 地図の写真層 |
|---|---|---|---|---|---|
| 0 | 表示 | 表示 | 表示 | `locality_public` が真のときのみ | 表示 |
| 1 | 表示 | 表示 | 非表示 | 非表示 | 表示 |
| 2 | 表示 | 非表示 | 非表示 | 非表示 | 非表示 |

### ライセンス

写真は投稿者が選んだライセンスで個別に公開する。記録データの CC BY 4.0 に含めない。CSV と Zenodo の登録に画像を含めない。全画面で撮影者名とライセンスを表示する。

## 段階3 iNaturalist への同時投稿

連携は `/photos/new` の最初に行う。OAuth の遷移でブラウザの画像が失われないよう、写真を選ぶ前に連携する。

### 連携

1. 投稿者が「iNaturalist へも投稿する」を選ぶ
2. 認可コードと PKCE で `https://www.inaturalist.org/oauth/authorize` へ移動する。`code_verifier` と `state` だけを `sessionStorage` に置く
3. `/inat/callback` で `POST /oauth/token`、`GET /users/api_token` を実行し、24時間有効の JWT を受け取る
4. 直後に `POST /oauth/revoke` で OAuth トークンを失効させる
5. JWT はメモリにだけ置く。`localStorage`、`sessionStorage`、本サイトのDBに置かない

OAuth のトークンには有効期限がない。漏えいの影響が大きいため、サーバーへ送らず、保存もしない。

### 投稿

1. 先に本サイトへ投稿する。iNaturalist への送信が失敗しても本サイトの投稿は残る
2. 投稿者が送信内容を確認し、送信ボタンを押す
3. `app.request_inat_post` が観察の `inat_uuid` を返す
4. ブラウザが `POST https://api.inaturalist.org/v1/observations` を呼ぶ
5. ブラウザが `POST https://api.inaturalist.org/v1/observation_photos` で写真を送る。`observation_photo[uuid]` に同じ UUID を使う
6. 送信に失敗したら、投稿者が再送できるようにする

| iNaturalist の項目 | 値 |
|---|---|
| `uuid` | `inat_uuid` |
| `taxon_id` | `taxa.inat_taxon_id`。未対応なら `species_guess` に学名を入れ、送信前に警告する |
| `observed_on_string` | 撮影日 |
| `latitude`, `longitude`, `positional_accuracy` | 投稿画面の値。本サイトへ保存しない |
| `geoprivacy` | 下の表 |
| `license` | 投稿者が選んだライセンス |
| `description` | 備考。投稿者が許可した場合は本サイトの写真URLを加える |

| `sensitivity` | `geoprivacy` |
|---|---|
| 0 | 投稿者が選ぶ。既定は `open` |
| 1 | `obscured` に固定する |
| 2 | 同時投稿を禁止する |

### 実在の確認

投稿者が申告した観察IDを信用しない。`sync-inat-photos.yml` が本サイトの発行した UUID で iNaturalist を照会する。

- 照会は `GET https://api.inaturalist.org/v2/observations/<uuid,uuid,...>` を使う。1回200件まで
- 見つかれば `inat_state='confirmed'` とし、`inat_observation_id` を保存する
- 7日たっても見つからなければ `inat_state='failed'` とし、投稿者へ通知する
- 間隔は2秒以上とし、T08 の直列スケジューラを使う
- `sensitivity` 1 以上で `geoprivacy` が `open` のものは審査者へ通知する。移動で機微種になった場合も同じ

### 同定の追加

連携済みの観察を本人が移動したら、「iNaturalist にも同定を追加しますか」と確認する。承認すると、ブラウザが本人の JWT で `POST https://api.inaturalist.org/v1/identifications` を呼ぶ。

審査者の移動は、審査者本人が連携していれば本人名義で同定を追加できる。連携していなければ iNaturalist の観察へのリンクを表示する。

iNaturalist の種はコミュニティの同定で決まる。本サイトから種を確定させることはできない。

### 不一致と変更の検知

`sync-inat-photos.yml` は毎日、`inat_observation_id` のある観察を確認する。

| 検知 | 動き |
|---|---|
| コミュニティの種が本サイトと違う | `inat_taxon_mismatch` を真にし、`source='automated_check'` の修正提案を作る。同じ種の提案は重複させない。自動で移動しない |
| 取込の観察が削除された | 写真を `removed`、観察を `withdrawn` にする |
| 取込の写真のライセンスが許可外になった | 写真を `removed` にする。全写真が外れたら観察を `withdrawn` にする |
| 取込の写真のURLが変わった | `image_url` を更新する |
| 同時投稿の観察が削除された | `inat_state='none'` に戻す。本サイトの写真は残す |

### 実装の前に試すこと

PH08 の最初に staging の連携で次を確かめ、結果を `docs/decisions.md` に書く。確かめるまで `inat_cross_post` を偽のままにする。

- ブラウザから `api.inaturalist.org` へ写真を送信できること
- OAuth トークンの失効後も JWT が使えること
- 必要なスコープ
- 同じ UUID で再送したときの動作
- 写真のライセンスが観察の `license` に従うか

ブラウザからのトークン取得が動かない場合に限り、Edge Function で中継する案を `docs/questions.md` に書く。トークンを保存しない規則は変えない。

## 公開停止と取り下げ

- 投稿者は `/me` から `app.withdraw_photo_observation` で取り下げられる。公開領域から24時間以内に消す
- `/takedown/` は写真も受け付ける。申し出を受けると `takedown` にし、公開領域からすぐ消す。流れは `09_literature_repository.md` の9節と同じとする
- 本サイトの取り下げは iNaturalist の観察を消さない。画面に明記し、iNaturalist の観察へのリンクを表示する

## 保全

`replicate-archive.yml` の複製に `photos/` の2048px版を加える。他の大きさは再生成できる。複製先の容量が80GBを超えたらオーナーへ通知する。

## 費用の見積もり

1枚あたり0.5〜1MBと仮定すると、10万枚で50〜100GBになる。R2 は月0.75〜1.5ドル程度で、転送料は無料である。実際の平均サイズは PH06 で測り、`docs/decisions.md` に書く。

## 未確認の点

- iNaturalist の利用規約と推奨利用ページは、自動確認で読めなかった。オーナーが G11 で確認する
- 第三者サイトを経由した投稿を iNaturalist が認めるかは、アプリ所有者の申請で確かめる
- 投稿と OAuth の条件は `inaturalist/inaturalist` と `inaturalist/iNaturalistAPI` の公開ソースで確認した。実環境では未検証である
