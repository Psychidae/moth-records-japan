# 環境の接続情報

ここに書くのは公開してよい値のみ。秘密の鍵は書かない。公開キーで読めるデータは RLS で制御する。

| 環境 | Supabase プロジェクト | ref | URL | 公開キー |
|---|---|---|---|---|
| staging | `moth-records-staging` | `zbbmvrmmxhrytwqrjyyk` | https://zbbmvrmmxhrytwqrjyyk.supabase.co | `sb_publishable_pGmxgkenBudqSU1gnHQDpw_lUYFEznR` |
| production | `moth-records-production` | `cvdidoprdpvcbnncxtie` | https://cvdidoprdpvcbnncxtie.supabase.co | `sb_publishable_yaS-923SlSdSizMRkTfG2w_TCqMsCLQ` |

- リージョンは東京（`ap-northeast-1`）。組織は Free プラン
- スキーマは未適用。T03 で staging に適用する
- production へは承認後の GitHub Actions だけが適用する
- Free プランは1週間アクセスがないと停止する。止まっていたら Supabase の画面から再開する
