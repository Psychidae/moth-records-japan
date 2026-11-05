# 03 データ取込と公開データ生成

## 1. List-MJ の取込

### 入力

- 取得元: `http://listmj.mothprog.com/dl/ListMJ3-210603DL.xlsx`
- 検証用 SHA-256: `741184a92458724bec03b2e7a5641c31a3bfbfe85a529929ca9b0af70e69a072`
- 大きさ: 522,244 バイト
- ライセンス: CC0 1.0。公開サイトに出典を明示する
- シート: `Sheet1`。1行目が見出し、2行目以降がデータ

`seed/source/` に元ファイルと変換済みの `listmj3_210603_rows.jsonl`（1行1データ行、`{"row": Excel行番号, "cells": {"A": 値}}`）、`SHA256SUMS` を同梱済みである。取込は JSONL を読む。Excel読込の依存を追加しない。実行時にネットワークから取得しない。ハッシュが一致しなければ停止する。

### 列の対応

| 列 | 見出し | 変換先 |
|---|---|---|
| A | 大図鑑カタログNo | `listmj_rows.raw` のみ。`1431a`、`315+316`、`4489+----` があるため文字列で保持 |
| B, C | 科名, 科和名 | family の taxa |
| D, E | 亜科名, 亜科和名 | subfamily の taxa |
| F, G | 族名, 族和名 | tribe の taxa |
| H, I | 亜族名, 亜族和名 | subtribe の taxa |
| J | 属名 | genus の taxa |
| K | 亜属名 | subgenus の taxa |
| L | 種小名 | species の taxa |
| M | 亜種小名 | subspecies の taxa |
| N, O | 著者, 公表年 | `authorship`, `publication_year` |
| P | 類似種 | `raw` のみ。例 `[nr pumira Puplesis]` |
| Q | 和名 | `name_ja` と `taxon_names(ja_standard)` |
| R | 別名 | `taxon_names(ja_alias)` |
| S | その他の和名 | `，` で分割して `taxon_names(ja_other)`。`[ ]` は除去 |
| T | 亜種範囲 | `raw` のみ |
| U | 標準図鑑ステータス | `listmj_status` |
| V | 標準図鑑以後の変更 | `listmj_change` |

### 変換規則

1. 全データ行を `listmj_rows` に `row_number`（Excelの行番号）つきで保存する。
2. 亜種小名が空の行が species、値がある行が subspecies。subspecies の親は同じ属と種小名の species。
3. `taxon_code` は Excel の行順に `M000001` から採番し、上位分類群は全行のあとに採番する。一度付けた番号は変更も再利用もしない。
4. `scientific_name` は `属 種小名 [亜種小名]`。亜属は名前に含めない。
5. 種小名のHTMLタグを除去する。実データ3950行目の `<html>maxim<b>um</b></html>` は `maximum` にする。
6. 著者が `(` で始まる形式、公表年の `[1763]`、`[1796-99]`、`2020 [2021]` はそのまま文字列で保持する。
7. 属名 `Gen.`、`Oecophorinae Gen.`、`Chrysomeleiidae Gen.` は属未定として扱い、genus の taxa を作らず上位分類群へ直接ぶら下げる。
8. 亜種小名 `ssp.` は未確定の亜種として保持する。
9. 同一学名の重複4組は統合しない。行ごとに別の taxon とし `is_name_collision = true` を立て、`import_report.json` に出す。

   | 行 | 学名 | 和名 |
   |---|---|---|
   | 371, 392 | Gen. sp. of Doi, 2005 | ウスバハルノミノガ, ドイミノガ |
   | 2753, 2770 | Cydia sp. of Oku, 2003 | ソトグロヒメハマキ, 和名なし |
   | 2870, 2871 | Gillmeria pallidactyla | カラフトトリバ, ウスイロトリバ |
   | 5961, 5962 | Westermannia elliptica | シロズリンガ, シロズリンガ |

10. `status` の判定は上から順に適用する。

    | 条件 | status |
    |---|---|
    | U が `日本のリストから除外` | `excluded` |
    | U が `正体不明種` | `doubtful` |
    | U または V に `南千島` を含む | `south_kuril` |
    | 種小名が正規表現 `^sp[.,]` に一致 | `unidentified` |
    | それ以外 | `accepted` |

11. 取込は冪等にする。再実行しても `taxon_code` は変わらない。

### 受け入れ数値

実データで確認済みの値。これと異なれば失敗とする。

| 項目 | 期待値 |
|---|---|
| データ行 | 7,465 |
| species の taxa | 6,628 |
| subspecies の taxa | 837 |
| うち基亜種（亜種小名=種小名） | 299 |
| 種小名が `^sp[.,]` に一致する species | 338 |
| 学名重複の組 | 4 |
| 科 | 88 |
| 親 species のない subspecies | 0 |

| status `accepted` | 6,183 |
| status `unidentified` | 335 |
| status `south_kuril` | 59 |
| status `doubtful` | 28 |
| status `excluded` | 23 |

species 6,628 は List-MJ の集計ページの総計（種 6,149、未同定 338、疑問 61、南千島 57、除外 23）の合計と一致する。ただし status の内訳は一致しない。特に疑問種はサイトの61に対してこの規則では28で、残りはExcelの列から判別できない。`import_report.json` に差を出し、オーナーが神保氏への相談時に確認する。

### 注釈と文献の取込

- `http://listmj.mothprog.com/list.html` の `div.note li` は975件。直前の `div.species` に紐づけ、`taxon_changes.note` へ入れる。`change_type` は文面から判定せず `status` とする。
- `http://listmj.mothprog.com/refs.html` の `li` は282件。原文を `references_.title` に仮置きし、著者、年、誌名を正規表現で分解する。分解できないものは `import_report.json` に出す。
- どちらも取得済みHTMLを `seed/source/` へコミットして読む。

## 2. 都道府県と島嶼

- `seed/prefectures.csv` を `regions` に投入する。`code` は `PR` + JIS番号。iNaturalist と GADM のIDは検証済み。
- GBIF の GADM 名は長崎が `Naoasaki` と誤記されているが、ID `JPN.27_1` は正しい。名前ではなくIDで照合する。
- 南千島は `OT01`、`region_type = other`。
- 主要島嶼は T07 で `seed/islands.csv` を作成する。候補は利尻、礼文、奥尻、佐渡、隠岐、壱岐、対馬、五島、甑、種子、屋久、トカラ、奄美大島、徳之島、沖永良部、与論、沖縄島、久米、宮古、石垣、西表、与那国、大東、伊豆諸島の各島、小笠原の各島。JSCの島マスタは複製しない。

## 3. iNaturalist

毎週実行し、県別の種ごとの件数だけを取得する。観察を全件複製しない。

- エンドポイント: `GET https://api.inaturalist.org/v1/observations/species_counts`
- 共通パラメータ: `taxon_id=47157`（鱗翅目）、`without_taxon_id=47224`（Papilionoidea、蝶）、`place_id=<県>`、`per_page=500`、`page=n`
- 証拠別に2回取得する: `quality_grade=research` を `photo_rg`、`quality_grade=needs_id` を `photo_needs_id`
- 応答の `results[].count`, `results[].taxon.id`, `results[].taxon.name` を使う
- 間隔は1リクエスト2秒以上。429 は `Retry-After` または60秒待って3回まで再試行
- User-Agent は `<SITE_NAME_EN>/<version> (<CONTACT_EMAIL>)`
- `taxa.inat_taxon_id` で照合する。未対応の学名は `GET /v1/taxa?q=<学名>&rank=species` で完全一致のみ自動対応し、それ以外は未対応一覧に出す
- 2026-11-06 時点の参考値: 全国の検証可能観察 約16.6万件、Research Grade 約7万件、2,774種

観察データの座標は保存しない。写真は `external_photos` に種ごと最大6枚だけ保存し、写真の `license_code` が `cc0, cc-by, cc-by-nc, cc-by-sa, cc-by-nc-sa` のもののみ採用する。`license_code` が空のものは使わない。

## 4. GBIF

毎月、Occurrence Download API で取得する。ダウンロードには引用DOIが発行されるので `external_snapshots.doi` へ保存し、公開サイトに表示する。

- 条件: `country=JP`、`taxonKey=797`（鱗翅目）、`datasetKey != 50c9509d-22c7-4a22-a47d-8c48425ef4a7`（iNaturalist は重複するため除外）、`basisOfRecord` は `PRESERVED_SPECIMEN` と `MATERIAL_SAMPLE`
- 形式: `DWCA`。SIMPLE_CSVにはlevel1Gidがないため変更した（T09のdecisions.md参照）。ZIP中のoccurrence.txtだけをストリームで処理し全件をメモリへ載せない。一時ZIPは成功・失敗とも削除する
- 県の判定: `level1Gid` が `JPN.` で始まる行のみ採用し、`regions.gadm_gid` と照合する
- 学名の照合: `taxa.gbif_usage_key`、なければ `GET https://api.gbif.org/v1/species/match` の `matchType = EXACT` のみ
- 分類基盤: legacy GBIF Backbone `d7dddbf4-2cf0-4f39-9b2a-bb099caae36c` を出力とTAXON_KEY条件の両方に指定し、整数keyを保持する
- 蝶は `taxa` に一致しないため自然に除外される
- 2026-11-06 時点の参考値: 鱗翅目全体で標本 715,288 件

## 5. 文献メタデータ

DOIの解決は `doi.org` のコンテントネゴシエーションを使う。JaLC のDOIは Crossref API では404になるため、Crossref を直接使わない。

```http
GET https://doi.org/<DOI>
Accept: application/vnd.citationstyles.csl+json
```

- テスト用DOI: `10.20848/kontyu.13.1_13`。著者 神保宇嗣、年 2010、頁 13-16 が返ること
- リダイレクトは許可リストのホストのみ追う（`doi.org`, `data.crosscite.org`, `api.crossref.org`, `api.datacite.org`, `api.japanlinkcenter.org`）
- J-STAGE 検索: `https://api.jstage.jst.go.jp/searchapi/do?service=3&text=<語>&count=<件数>`。Atom XML。応答の `status` が `WARN_` で始まる場合は記録して処理を続ける
- 利用者が入力したURLをサーバーから取得しない

## 6. 県ごとの証拠区分

種 × 地域の区分を次の順で判定する。上位が優先。

| 順 | 区分 | 条件 |
|---|---|---|
| 1 | `original` | 公開済み、`category=original`、`accuracy=normal` |
| 2 | `citation` | 公開済み、`category=citation`、`accuracy=normal` |
| 3 | `specimen` | GBIF 標本あり |
| 4 | `photo_rg` | iNaturalist Research Grade あり |
| 5 | `needs_review` | `unconfirmed`、`needs_review`、`photo_needs_id` のみ |
| 6 | `none` | 記録なし |

`misidentification` と `board` は区分の判定に使わない。記録としては表示する。

**発見候補**は、区分が3または4で、かつ文献の記録（区分1、2）がない種 × 県の組とする。

## 7. 公開データの生成

`pipelines/build-public-data` が service role で読み出し、`apps/public/public/data/<version>/` へ出力する。

| ファイル | 内容 |
|---|---|
| `manifest.json` | 版、生成日時、件数、各ファイルの SHA-256 |
| `names.json` | 検索用。taxon_code、学名、和名、別名、異名 |
| `taxon-tree.json` | 分類ツリー |
| `summary/national.json` | 全国の集計 |
| `summary/matrix.json` | 種 × 地域の証拠区分。値は区分番号の疎行列 |
| `records/genus/<genus>.json` | 属ごとの公開記録 |
| `records/region/<code>.json` | 地域ごとの公開記録 |
| `references/index.json` | 文献一覧 |
| `downloads/*.csv.gz` | ダウンロード用 |

JSONは値を辞書化した列形式とする。

```json
{ "format": "records-v1", "columns": ["record_code", "taxon", "region"],
  "dictionaries": { "taxon": ["M000001"], "region": ["PR01"] },
  "rows": [["D0000001", 0, 0]] }
```

JSONの1ファイルが展開後8MiBを超える場合は、地域の記録を科ごと、属の記録を種ごとに分割する。

初回読込は `summary/national.json` のみとし、`names.json` は検索窓に触れた時点で読み込む。記録の詳細は画面の操作に応じて属または地域の単位で取得する。全記録を1ファイルで配信しない。

### 公開フィルタ

ビルド時に適用する。画面で隠すのではなく、出力に含めない。

- `status = published` のみ
- `submitted_by`、`reviewed_by`、メール、IPハッシュは出力しない。投稿者名は `public_credit = true` のときだけ表示名を出す
- `taxa.sensitivity = 1`: `locality_verbatim`, `locality_modern`, `lat`, `lon`, `event_date_verbatim`, `date_start`, `date_end`, `collector_verbatim`, `specimen_ref` を出力しない
- `taxa.sensitivity = 2`: 上に加えて `page` と `reference` を出力せず、地域の有無だけを出す

`pipelines/build-public-data/verify.ts` が出力全体を検査し、次を見つけたらビルドを失敗させる。

- 機微種の詳細項目
- メールアドレスの形式
- UUID 形式の文字列
- `pending`, `draft`, `rejected` の記録

### 版と配信

- 版番号は `YYYY.MM.n`。`releases` に記録する
- 直近10版を保持する。前の版へ戻す操作は再ビルドせず配信先の切替で行う
- 四半期に1回、全データのスナップショットをオーナーが Zenodo に登録し、DOIを `releases.doi` へ入れる。手順は `06_security_ops.md`
