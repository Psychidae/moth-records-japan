#!/usr/bin/env bash
# 鍵を取得したら実行する。値を画面に出さず、GitHub と Supabase の保管場所へ格納する。
#   bash scripts/set-secrets.sh                 未登録の鍵を順に入力（空Enterで飛ばす）
#   bash scripts/set-secrets.sh status          登録状況を表示
#   bash scripts/set-secrets.sh GBIF_PASSWORD   指定した鍵だけ入力
#   --env production を付けると本番の鍵を扱う。既定は staging
set -uo pipefail
cd "$(dirname "$0")/.."

REPO="Psychidae/moth-records-japan"
MANIFEST="scripts/secrets-manifest.tsv"
ENV_NAME="staging"
TARGET_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    *) TARGET_ARG="$1"; shift ;;
  esac
done

case "$ENV_NAME" in
  staging) REF="zbbmvrmmxhrytwqrjyyk" ;;
  production) REF="cvdidoprdpvcbnncxtie" ;;
  *) echo "環境は staging か production を指定してください。"; exit 2 ;;
esac

TMP_FILE=""
cleanup() { [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"; }
trap cleanup EXIT

GH_SECRETS=$(gh secret list --repo "$REPO" --env "$ENV_NAME" --json name --jq '.[].name' 2>/dev/null || true)
GH_VARS=$(gh variable list --repo "$REPO" --env "$ENV_NAME" --json name --jq '.[].name' 2>/dev/null || true)
SB_SECRETS=$(supabase secrets list --project-ref "$REF" 2>/dev/null || true)
SB_READY=1
[ -n "$SB_SECRETS" ] || SB_READY=0

has_line() { printf '%s\n' "$2" | grep -qx "$1"; }

is_set() { # 名前 種類 格納先
  local ok=1
  if [ "$3" != "supabase" ]; then
    if [ "$2" = "secret" ]; then has_line "$1" "$GH_SECRETS" || ok=0
    else has_line "$1" "$GH_VARS" || ok=0; fi
  fi
  if [ "$3" != "github" ]; then
    printf '%s\n' "$SB_SECRETS" | grep -q "$1" || ok=0
  fi
  [ "$ok" = 1 ]
}

read_value() { # 種類。値は変数 VALUE に入る
  VALUE=""
  if [ -t 0 ]; then
    if [ "$1" = "secret" ]; then
      IFS= read -rs VALUE || true
      echo
    else
      IFS= read -r VALUE || true
    fi
  else
    IFS= read -r VALUE || true
  fi
}

store_supabase() { # 名前 値
  TMP_FILE=$(umask 077; mktemp)
  printf '%s="%s"\n' "$1" "$2" > "$TMP_FILE"
  supabase secrets set --env-file "$TMP_FILE" --project-ref "$REF" >/dev/null
  local rc=$?
  rm -f "$TMP_FILE"; TMP_FILE=""
  return $rc
}

store() { # 名前 種類 格納先 値
  local rc=0
  if [ "$3" != "supabase" ]; then
    if [ "$2" = "secret" ]; then
      printf '%s' "$4" | gh secret set "$1" --repo "$REPO" --env "$ENV_NAME" >/dev/null || rc=1
    else
      gh variable set "$1" --repo "$REPO" --env "$ENV_NAME" --body "$4" >/dev/null || rc=1
    fi
  fi
  if [ "$3" != "github" ]; then
    store_supabase "$1" "$4" || rc=1
  fi
  return $rc
}

CHANGED=0
FAILED=0
FOUND=0

show_status() {
  local n k t s h u mark
  echo "登録状況（${ENV_NAME}）"
  while IFS=$'\t' read -r n k t s h u <&3; do
    case "$n" in \#*|"") continue ;; esac
    if is_set "$n" "$k" "$t"; then mark="登録済み"; else mark="未登録  "; fi
    printf '  %s  [%s] %s\n' "$mark" "$s" "$n"
  done 3< "$MANIFEST"
  [ "$SB_READY" = 1 ] || echo "  注意: Supabase の鍵は確認できませんでした。先に supabase login を実行してください。"
}

ask_one() { # 名前 種類 格納先 説明 取得先
  local url="${5//\{ref\}/$REF}"
  echo
  echo "$1"
  echo "  $4"
  echo "  取得先: $url"
  printf '  値を入力（空Enterで飛ばす）: '
  read_value "$2"
  if [ -z "$VALUE" ]; then echo "  飛ばしました"; return; fi
  case "$VALUE" in
    *\"*|*$'\n'*) echo "  使えない文字が含まれています。飛ばしました"; FAILED=1; return ;;
  esac
  if store "$1" "$2" "$3" "$VALUE"; then
    echo "  格納しました"
    CHANGED=1
  else
    echo "  格納に失敗しました"
    FAILED=1
  fi
  VALUE=""
}

if [ "$TARGET_ARG" = "status" ]; then
  show_status
  exit 0
fi

if [ "$ENV_NAME" = "production" ]; then
  echo "本番の鍵を扱います。"
fi

while IFS=$'\t' read -r n k t s h u <&3; do
  case "$n" in \#*|"") continue ;; esac
  if [ -n "$TARGET_ARG" ]; then
    [ "$n" = "$TARGET_ARG" ] || continue
    FOUND=1
    ask_one "$n" "$k" "$t" "$h" "$u"
  elif ! is_set "$n" "$k" "$t"; then
    FOUND=1
    ask_one "$n" "$k" "$t" "$h" "$u"
  fi
done 3< "$MANIFEST"

if [ "$FOUND" = 0 ]; then
  if [ -n "$TARGET_ARG" ]; then echo "$TARGET_ARG は一覧にありません。"; exit 2; fi
  echo "すべて登録済みです。"
fi

if [ "$CHANGED" = 1 ] && [ -z "${SET_SECRETS_NO_RECHECK:-}" ]; then
  if gh workflow view recheck-env.yml --repo "$REPO" >/dev/null 2>&1; then
    gh workflow run recheck-env.yml --repo "$REPO" -f environment="$ENV_NAME" >/dev/null \
      && echo "待機していた処理を再開しました。"
  else
    echo "鍵を格納しました。再開用の処理はまだ作られていないので、完成後に自動で使われます。"
  fi
fi
[ "$FAILED" = 0 ]
