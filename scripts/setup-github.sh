#!/usr/bin/env bash
# GitHub の公開リポジトリを作り、仕様を登録して保護設定を行う。オーナーが1回だけ実行する。
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER=Psychidae
REPO=moth-records-japan
R="$OWNER/$REPO"
OWNER_ID=207066782

echo "公開リポジトリ https://github.com/$R を作成します。"
gh repo create "$R" --public \
  --description "日本産蛾類の記録を文献の根拠つきで都道府県ごとに閲覧できるデータベース" \
  --source . --remote origin --push

echo "リポジトリの設定"
gh api -X PATCH "repos/$R" -F delete_branch_on_merge=true -F allow_auto_merge=true -F has_wiki=false --silent
gh api -X PATCH "repos/$R" --silent --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api -X PUT "repos/$R/vulnerability-alerts" --silent
gh api -X PUT "repos/$R/automated-security-fixes" --silent
gh api -X PUT "repos/$R/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false --silent

echo "main ブランチの保護"
gh api -X PUT "repos/$R/branches/main/protection" --silent --input - <<'JSON'
{"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON

echo "環境の作成"
gh api -X PUT "repos/$R/environments/staging" --silent
gh api -X PUT "repos/$R/environments/production" --silent --input - <<JSON
{"reviewers":[{"type":"User","id":$OWNER_ID}],"prevent_self_review":false,"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}
JSON

echo "公開可能な接続値の登録"
gh variable set VITE_SUPABASE_URL --repo "$R" --env staging --body "https://zbbmvrmmxhrytwqrjyyk.supabase.co"
gh variable set VITE_SUPABASE_PUBLISHABLE_KEY --repo "$R" --env staging --body "sb_publishable_pGmxgkenBudqSU1gnHQDpw_lUYFEznR"
gh variable set SUPABASE_PROJECT_REF --repo "$R" --env staging --body "zbbmvrmmxhrytwqrjyyk"
gh variable set VITE_SUPABASE_URL --repo "$R" --env production --body "https://cvdidoprdpvcbnncxtie.supabase.co"
gh variable set VITE_SUPABASE_PUBLISHABLE_KEY --repo "$R" --env production --body "sb_publishable_yaS-923SlSdSizMRkTfG2w_TCqMsCLQ"
gh variable set SUPABASE_PROJECT_REF --repo "$R" --env production --body "cvdidoprdpvcbnncxtie"

echo "完了: https://github.com/$R"
