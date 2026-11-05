# 日本産蛾類記録データベース 実装計画

Codex へ渡すための仕様書一式です。

仕様 v1.3（2026-11-06 改訂）。未決事項は `docs/00_overview.md` のゲート G1〜G9 として管理します。

## 渡し方

1. `docs/11_accounts_and_keys.md` の準備を済ませる
2. このフォルダの中身を新しい GitHub リポジトリの最上位に置く
3. Codex に次の文を渡す

```text
AGENTS.md の連続実行モードに従い、docs/07_tasks.md を上から最後まで実施してください。
1タスクごとにPRを作り、CI成功後にマージしてください。本番への反映は行わないでください。
終了時に docs/handover_report.md を完成させてください。
```

## 読む順序

| ファイル | 内容 |
|---|---|
| `docs/blueprint.html` | 全体の見取り図 |
| `docs/00_overview.md` | 決定事項と未決事項 |
| `docs/08_tool_decisions.md` | ツールの選定と運用耐性 |
| `docs/09_literature_repository.md` | 文献リポジトリ |
| `docs/10_automation.md` | 人の工程を減らす規則 |
| `docs/11_accounts_and_keys.md` | 事前に必要な登録と鍵 |
| `docs/06_security_ops.md` | 防御と運用の手順 |
| `docs/07_tasks.md` | 実装の順序 |

## 検証済みのもの

- `seed/prefectures.csv`: iNaturalist と GADM のIDを47都道府県で照合済み
- `seed/source/`: List-MJ の原本と変換済みデータ。`SHA256SUMS` で検証できる
- `docs/02_schema.sql`: `tests/schema_smoke.mjs` で権限を検証済み
- `docs/03_data_pipeline.md` の受け入れ数値: 実データから算出

## 実行していないもの

サイト本体は未実装です。Supabase、Cloudflare、Claude API の実環境での動作は未確認です。権限の検証は PGlite 上で Supabase の認証を模した環境で行ったものです。
