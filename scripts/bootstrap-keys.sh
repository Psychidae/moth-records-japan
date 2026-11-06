#!/usr/bin/env bash
# 発行できる鍵をAPIで発行し、値を画面に出さず格納する。手順は docs/11_accounts_and_keys.md。
#   bash scripts/bootstrap-keys.sh                     staging と production の両方
#   bash scripts/bootstrap-keys.sh --env staging       片方だけ
#   bash scripts/bootstrap-keys.sh --only cloudflare   対象を限定（cloudflare,healthchecks,supabase,age）
#   bash scripts/bootstrap-keys.sh --dry-run           実行内容の表示だけ
#   bash scripts/bootstrap-keys.sh --rotate            登録済みの鍵も発行し直す
# 登録済みの鍵は飛ばすので、途中で失敗しても再実行できる。
set -uo pipefail
set +x
cd "$(dirname "$0")/.."

REPO="Psychidae/moth-records-japan"
CF_API="https://api.cloudflare.com/client/v4"
SB_API="https://api.supabase.com/v1"
HC_API="https://healthchecks.io/api/v3"
AGE_KEY_FILE="${AGE_KEY_FILE:-$HOME/moth-backup.key}"
BACKUP_RETENTION_DAYS=35
QUARANTINE_DAYS=7

ENVS="staging production"
ONLY="cloudflare,healthchecks,supabase,age"
ROTATE=0
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENVS="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --rotate) ROTATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "不明な指定です: $1"; exit 2 ;;
  esac
done

for e in $ENVS; do
  case "$e" in staging|production) ;; *) echo "環境は staging か production を指定してください。"; exit 2 ;; esac
done
for need in gh jq curl supabase shasum openssl; do
  command -v "$need" >/dev/null || { echo "$need が見つかりません。"; exit 2; }
done

project_ref() { case "$1" in staging) echo zbbmvrmmxhrytwqrjyyk ;; production) echo cvdidoprdpvcbnncxtie ;; esac; }
wants() { case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

FAILED=""
CHANGED_ENVS=""
note_fail() { echo "  失敗: $1"; FAILED="$FAILED
  - $1"; }

CF_BOOT=""
CF_ADMIN=""
CF_ADMIN_ID=""
CF_ACCOUNT=""
SB_TOKEN=""
HC_KEY=""
HTTP=""
BODY=""

cleanup() {
  if [ -n "$CF_ADMIN_ID" ] && [ -n "$CF_BOOT" ]; then
    call DELETE "$CF_API/user/tokens/$CF_ADMIN_ID" "Authorization: Bearer $CF_BOOT"
  fi
  CF_BOOT=""; CF_ADMIN=""; SB_TOKEN=""; HC_KEY=""; BODY=""
}
trap cleanup EXIT

# 鍵は引数に載せない。認証ヘッダは curl の設定として標準入力から、本文は別の記述子から渡す。
call() { # 方法 URL 認証ヘッダ [本文]。結果は HTTP と BODY に入る
  local resp
  if [ -n "${4:-}" ]; then
    resp=$(printf 'header = "%s"\nheader = "Content-Type: application/json"\n' "$3" |
      curl -sS --max-time 60 -X "$1" --config - --data-binary @/dev/fd/3 -w '\n%{http_code}' "$2" 3<<<"$4" 2>/dev/null)
  else
    resp=$(printf 'header = "%s"\n' "$3" |
      curl -sS --max-time 60 -X "$1" --config - -w '\n%{http_code}' "$2" 2>/dev/null)
  fi
  HTTP="${resp##*$'\n'}"
  BODY="${resp%$'\n'*}"
}
ok_http() { case "$HTTP" in 2??) return 0 ;; *) return 1 ;; esac; }
reason() { printf '%s' "$BODY" | jq -r '(.errors[0].message // .message // .error // "応答なし")' 2>/dev/null || echo "応答なし"; }

cf_admin() { call "$1" "$CF_API$2" "Authorization: Bearer $CF_ADMIN" "${3:-}"; }
cf_boot() { call "$1" "$CF_API$2" "Authorization: Bearer $CF_BOOT" "${3:-}"; }

ask_secret() { # 説明 → 変数 VALUE
  VALUE=""
  printf '%s: ' "$1"
  if [ -t 0 ]; then IFS= read -rs VALUE || true; echo; else IFS= read -r VALUE || true; fi
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local a
  printf '%s [y/N]: ' "$1"
  IFS= read -r a || true
  case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

is_set() { # 環境 名前 種類 格納先
  [ "$ROTATE" = 1 ] && return 1
  local names
  if [ "$4" = "supabase" ]; then
    supabase secrets list --project-ref "$(project_ref "$1")" 2>/dev/null | grep -q "$2"
    return
  fi
  if [ "$3" = "secret" ]; then
    names=$(gh secret list --repo "$REPO" --env "$1" --json name --jq '.[].name' 2>/dev/null)
  else
    names=$(gh variable list --repo "$REPO" --env "$1" --json name --jq '.[].name' 2>/dev/null)
  fi
  printf '%s\n' "$names" | grep -qx "$2"
}

manifest_field() { awk -F'\t' -v n="$1" -v c="$2" '$1==n {print $c}' scripts/secrets-manifest.tsv; }
needs() { is_set "$1" "$2" "$(manifest_field "$2" 2)" "$(manifest_field "$2" 3)" && return 1; return 0; }

put() { # 環境 名前 値。保存は set-secrets.sh に任せる
  if printf '%s\n' "$3" | SET_SECRETS_NO_RECHECK=1 bash scripts/set-secrets.sh --env "$1" "$2" >/dev/null 2>&1; then
    echo "  格納: ${2}（${1}）"
    case " $CHANGED_ENVS " in *" $1 "*) ;; *) CHANGED_ENVS="$CHANGED_ENVS $1" ;; esac
    return 0
  fi
  note_fail "${2}（${1}）を格納できませんでした"
  return 1
}

# ---------------------------------------------------------------- Cloudflare
PERMISSIONS=""
perm_id() { # 権限名。Write と Edit の表記の両方を探す
  printf '%s' "$PERMISSIONS" | jq -r --arg a "$1 Write" --arg b "$1 Edit" --arg c "$1" \
    '[.result[] | select(.name == $a or .name == $b or .name == $c)][0].id // empty'
}

cf_login() {
  [ -n "$CF_BOOT" ] && return 0
  cat <<'MSG'

Cloudflare の発行用トークンを作ります。
  1. https://dash.cloudflare.com/profile/api-tokens を開く
  2. Create Token → Custom token
  3. Permissions に User / API Tokens / Edit と Account / Account Settings / Read を追加
  4. 作成した値を下へ貼る。このトークンは最後に自動で失効させる
MSG
  ask_secret "発行用トークン（空Enterで飛ばす）"
  CF_BOOT="$VALUE"; VALUE=""
  [ -n "$CF_BOOT" ] || { echo "  Cloudflare を飛ばしました"; return 1; }

  cf_boot GET /user/tokens/verify
  ok_http || { note_fail "発行用トークンを確認できません: $(reason)"; CF_BOOT=""; return 1; }
  CF_BOOT_ID=$(printf '%s' "$BODY" | jq -r '.result.id')

  cf_boot GET /user/tokens/permission_groups
  ok_http || { note_fail "権限の一覧を読めません。API Tokens の権限を確認してください: $(reason)"; CF_BOOT=""; return 1; }
  PERMISSIONS="$BODY"

  cf_boot GET '/accounts?per_page=5'
  if ok_http && [ "$(printf '%s' "$BODY" | jq '.result | length')" = 1 ]; then
    CF_ACCOUNT=$(printf '%s' "$BODY" | jq -r '.result[0].id')
  else
    printf 'Account ID を入力（ダッシュボードのURLにある32文字）: '
    IFS= read -r CF_ACCOUNT || true
  fi
  printf '%s' "$CF_ACCOUNT" | grep -qE '^[0-9a-f]{32}$' || { note_fail "Account ID の形式が違います"; CF_BOOT=""; return 1; }

  local r2 ts ws expires policy
  r2=$(perm_id "Workers R2 Storage"); ts=$(perm_id "Turnstile"); ws=$(perm_id "Workers Scripts")
  [ -n "$ts" ] || ts=$(perm_id "Turnstile Sites")
  [ -n "$r2" ] && [ -n "$ts" ] && [ -n "$ws" ] || { note_fail "必要な権限が一覧にありません"; CF_BOOT=""; return 1; }
  expires=$(date -u -v+1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
  policy=$(jq -cn --arg a "com.cloudflare.api.account.$CF_ACCOUNT" --arg r "$r2" --arg t "$ts" --arg w "$ws" --arg e "$expires" \
    '{name:"moth-records-bootstrap-temp",expires_on:$e,policies:[{effect:"allow",resources:{($a):"*"},permission_groups:[{id:$r},{id:$t},{id:$w}]}]}')
  cf_boot POST /user/tokens "$policy"
  ok_http || { note_fail "作業用トークンを作れません: $(reason)"; CF_BOOT=""; return 1; }
  CF_ADMIN=$(printf '%s' "$BODY" | jq -r '.result.value')
  CF_ADMIN_ID=$(printf '%s' "$BODY" | jq -r '.result.id')
  sleep 3
}

create_token() { # 名前 policies。結果は TOK_ID と TOK_VALUE に入る
  local body
  body=$(jq -cn --arg n "$1" --argjson p "$2" '{name:$n,policies:$p}')
  cf_boot POST /user/tokens "$body"
  ok_http || { note_fail "トークン $1 を作れません: $(reason)"; return 1; }
  TOK_ID=$(printf '%s' "$BODY" | jq -r '.result.id')
  TOK_VALUE=$(printf '%s' "$BODY" | jq -r '.result.value')
}

remove_old_tokens() { # 名前 残すID
  local id
  cf_boot GET '/user/tokens?per_page=50'
  ok_http || return 0
  for id in $(printf '%s' "$BODY" | jq -r --arg n "$1" --arg k "$2" '.result[] | select(.name == $n and .id != $k) | .id'); do
    cf_boot DELETE "/user/tokens/$id"
  done
}

ensure_bucket() {
  cf_admin POST "/accounts/$CF_ACCOUNT/r2/buckets" "$(jq -cn --arg n "$1" '{name:$n,locationHint:"apac"}')"
  ok_http && { echo "  作成: バケット $1"; return 0; }
  case "$HTTP:$(reason)" in
    409:*|*already*exist*) return 0 ;;
    *enable*R2*|*10042*)
      note_fail "R2 が未有効です。https://dash.cloudflare.com/?to=/:account/r2/overview で有効にして再実行してください"; return 1 ;;
  esac
  note_fail "バケット $1 を作れません: $(reason)"
  return 1
}

set_lifecycle() { # バケット 日数
  cf_admin PUT "/accounts/$CF_ACCOUNT/r2/buckets/$1/lifecycle" \
    "$(jq -cn --argjson s "$(($2 * 86400))" '{rules:[{id:"expire",enabled:true,conditions:{prefix:""},deleteObjectsTransition:{condition:{type:"Age",maxAge:$s}}}]}')"
  ok_http || note_fail "$1 の自動削除を設定できません: $(reason)"
}

set_lock() { # バケット 日数
  cf_admin PUT "/accounts/$CF_ACCOUNT/r2/buckets/$1/lock" \
    "$(jq -cn --argjson s "$(($2 * 86400))" '{rules:[{id:"retain",enabled:true,prefix:"",condition:{type:"Age",maxAgeSeconds:$s}}]}')"
  ok_http && echo "  設定: $1 の保持ロック $2 日" || note_fail "$1 の保持ロックを設定できません: $(reason)"
}

r2_pair() { # 環境 トークン名 鍵の接頭辞 バケット...
  local env="$1" name="$2" prefix="$3"; shift 3
  needs "$env" "${prefix}_ACCESS_KEY_ID" || needs "$env" "${prefix}_SECRET_ACCESS_KEY" || return 0
  local perm policies resources="{}" b secret
  perm=$(perm_id "Workers R2 Storage Bucket Item")
  [ -n "$perm" ] || { note_fail "バケット単位の権限が一覧にありません"; return 1; }
  for b in "$@"; do
    resources=$(printf '%s' "$resources" | jq -c --arg k "com.cloudflare.edge.r2.bucket.${CF_ACCOUNT}_default_$b" '. + {($k):"*"}')
  done
  policies=$(jq -cn --argjson r "$resources" --arg p "$perm" '[{effect:"allow",resources:$r,permission_groups:[{id:$p}]}]')
  create_token "$name" "$policies" || return 1
  secret=$(printf '%s' "$TOK_VALUE" | shasum -a 256 | cut -d' ' -f1)
  TOK_VALUE=""
  if put "$env" "${prefix}_ACCESS_KEY_ID" "$TOK_ID" && put "$env" "${prefix}_SECRET_ACCESS_KEY" "$secret"; then
    remove_old_tokens "$name" "$TOK_ID"
  else
    cf_boot DELETE "/user/tokens/$TOK_ID"
  fi
  secret=""
}

turnstile() { # 環境
  local env="$1" name="moth-records-$1" domains sitekey secret
  needs "$env" VITE_TURNSTILE_SITE_KEY || needs "$env" TURNSTILE_SECRET_KEY || return 0
  domains="${TURNSTILE_DOMAINS:-}"
  if [ -z "$domains" ]; then
    cf_admin GET "/accounts/$CF_ACCOUNT/workers/subdomain"
    ok_http && domains="$(printf '%s' "$BODY" | jq -r '.result.subdomain // empty')"
    [ -n "$domains" ] && domains="$domains.workers.dev"
  fi
  if [ -z "$domains" ]; then
    echo "  保留: Turnstile（${env}）。配信先が未定です。TURNSTILE_DOMAINS=example.org を付けて再実行してください"
    return 0
  fi
  cf_admin GET "/accounts/$CF_ACCOUNT/challenges/widgets?per_page=50"
  sitekey=$(printf '%s' "$BODY" | jq -r --arg n "$name" '[.result[]? | select(.name == $n)][0].sitekey // empty')
  if [ -n "$sitekey" ]; then
    cf_admin GET "/accounts/$CF_ACCOUNT/challenges/widgets/$sitekey"
  else
    cf_admin POST "/accounts/$CF_ACCOUNT/challenges/widgets" \
      "$(jq -cn --arg n "$name" --arg d "$domains" '{name:$n,domains:($d|split(",")),mode:"managed"}')"
  fi
  ok_http || { note_fail "Turnstile（${env}）を作れません: $(reason)"; return 1; }
  sitekey=$(printf '%s' "$BODY" | jq -r '.result.sitekey')
  secret=$(printf '%s' "$BODY" | jq -r '.result.secret // empty')
  [ -n "$secret" ] || { note_fail "Turnstile（${env}）の秘密鍵を取得できません"; return 1; }
  put "$env" VITE_TURNSTILE_SITE_KEY "$sitekey"
  put "$env" TURNSTILE_SECRET_KEY "$secret"
  secret=""
}

do_cloudflare() { # 環境
  local env="$1" base="moth-records-$1" name perm_scripts perm_settings policies
  echo
  echo "Cloudflare（${env}）"
  local missing=0 key
  for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID R2_ACCOUNT_ENDPOINT R2_BACKUP_ACCESS_KEY_ID \
    R2_BACKUP_SECRET_ACCESS_KEY R2_LIT_ACCESS_KEY_ID R2_LIT_SECRET_ACCESS_KEY VITE_TURNSTILE_SITE_KEY TURNSTILE_SECRET_KEY; do
    needs "$env" "$key" && { missing=1; break; }
  done
  [ "$missing" = 1 ] || { echo "  登録済み"; return 0; }
  cf_login || return 0

  needs "$env" CLOUDFLARE_ACCOUNT_ID && put "$env" CLOUDFLARE_ACCOUNT_ID "$CF_ACCOUNT"
  needs "$env" R2_ACCOUNT_ENDPOINT && put "$env" R2_ACCOUNT_ENDPOINT "https://$CF_ACCOUNT.r2.cloudflarestorage.com"

  if needs "$env" CLOUDFLARE_API_TOKEN; then
    name="$base-deploy"
    perm_scripts=$(perm_id "Workers Scripts"); perm_settings=$(printf '%s' "$PERMISSIONS" | jq -r '[.result[] | select(.name == "Account Settings Read")][0].id // empty')
    policies=$(jq -cn --arg a "com.cloudflare.api.account.$CF_ACCOUNT" --arg s "$perm_scripts" --arg t "$perm_settings" \
      '[{effect:"allow",resources:{($a):"*"},permission_groups:[{id:$s},{id:$t}]}]')
    if create_token "$name" "$policies"; then
      if put "$env" CLOUDFLARE_API_TOKEN "$TOK_VALUE"; then remove_old_tokens "$name" "$TOK_ID"
      else cf_boot DELETE "/user/tokens/$TOK_ID"; fi
      TOK_VALUE=""
    fi
  fi

  local backup="$base-backup" quarantine="$base-lit-quarantine" private="$base-lit-private" public="$base-lit-public"
  if ensure_bucket "$backup"; then
    set_lock "$backup" "$BACKUP_RETENTION_DAYS"
    set_lifecycle "$backup" "$((BACKUP_RETENTION_DAYS + 1))"
    r2_pair "$env" "$base-r2-backup" R2_BACKUP "$backup"
  fi
  if ensure_bucket "$quarantine" && ensure_bucket "$private" && ensure_bucket "$public"; then
    set_lifecycle "$quarantine" "$QUARANTINE_DAYS"
    r2_pair "$env" "$base-r2-lit" R2_LIT "$quarantine" "$private" "$public"
  fi
  turnstile "$env"
}

# ---------------------------------------------------------------- Healthchecks.io
do_healthchecks() { # 環境
  local env="$1" item key label timeout grace url
  echo
  echo "Healthchecks.io（${env}）"
  needs "$env" HEALTHCHECKS_PING_BACKUP || needs "$env" HEALTHCHECKS_PING_SYNC || needs "$env" HEALTHCHECKS_PING_HEALTH || { echo "  登録済み"; return 0; }
  if [ -z "$HC_KEY" ]; then
    echo "  Project Settings の API Access で読み書き用のキーを作る: https://healthchecks.io/"
    ask_secret "APIキー（空Enterで飛ばす）"
    HC_KEY="$VALUE"; VALUE=""
    [ -n "$HC_KEY" ] || { echo "  飛ばしました"; return 0; }
  fi
  for item in "BACKUP backup 86400 21600" "SYNC sync 604800 86400" "HEALTH health 604800 86400"; do
    # shellcheck disable=SC2086
    set -- $item
    key="HEALTHCHECKS_PING_$1"; label="$2"; timeout="$3"; grace="$4"
    needs "$env" "$key" || continue
    call POST "$HC_API/checks/" "X-Api-Key: $HC_KEY" \
      "$(jq -cn --arg n "moth-records-$env-$label" --arg t "moth-records $env" --argjson o "$timeout" --argjson g "$grace" \
        '{name:$n,tags:$t,timeout:$o,grace:$g,channels:"*",unique:["name"]}')"
    ok_http || { note_fail "$key を作れません: $(reason)"; continue; }
    url=$(printf '%s' "$BODY" | jq -r '.ping_url // empty')
    [ -n "$url" ] && put "$env" "$key" "$url" || note_fail "$key のURLを取得できません"
    url=""
  done
}

# ---------------------------------------------------------------- Supabase
do_supabase() { # 環境
  local env="$1" ref value password pooler user host name
  ref=$(project_ref "$env")
  echo
  echo "Supabase（${env}）"

  if needs "$env" SUPABASE_SERVICE_ROLE_KEY; then
    value=$(supabase projects api-keys --project-ref "$ref" -o json 2>/dev/null | jq -r '[.[] | select(.name == "service_role")][0].api_key // empty')
    if [ -n "$value" ]; then put "$env" SUPABASE_SERVICE_ROLE_KEY "$value"
    else note_fail "service_role キーを取得できません。supabase login を確認してください"; fi
    value=""
  fi

  needs "$env" SUPABASE_ACCESS_TOKEN || needs "$env" SUPABASE_DB_URL || { echo "  登録済み"; return 0; }
  if [ -z "$SB_TOKEN" ]; then
    echo "  トークンを作る: https://supabase.com/dashboard/account/tokens"
    ask_secret "Supabase のアクセストークン（空Enterで飛ばす）"
    SB_TOKEN="$VALUE"; VALUE=""
    [ -n "$SB_TOKEN" ] || { echo "  飛ばしました"; return 0; }
  fi
  needs "$env" SUPABASE_ACCESS_TOKEN && put "$env" SUPABASE_ACCESS_TOKEN "$SB_TOKEN"

  needs "$env" SUPABASE_DB_URL || return 0
  confirm "  $env のDBパスワードを新しい値へ再設定します。よろしいですか" || { echo "  飛ばしました"; return 0; }

  call GET "$SB_API/projects/$ref/config/database/pooler" "Authorization: Bearer $SB_TOKEN"
  ok_http || { note_fail "接続先を取得できません: $(reason)"; return 0; }
  pooler=$(printf '%s' "$BODY" | jq -c '(if type == "array" then . else [.] end) | ([.[] | select(.database_type == "PRIMARY")][0] // .[0])')
  user=$(printf '%s' "$pooler" | jq -r '.db_user // empty')
  host=$(printf '%s' "$pooler" | jq -r '.db_host // empty')
  name=$(printf '%s' "$pooler" | jq -r '.db_name // "postgres"')
  [ -n "$user" ] && [ -n "$host" ] || { note_fail "接続先の形式が想定と違います"; return 0; }

  password=$(openssl rand -hex 24)
  # 値は16進数だけなので、外部コマンドの引数に載せず文字列で組み立てる
  call PATCH "$SB_API/projects/$ref/database/password" "Authorization: Bearer $SB_TOKEN" "{\"password\":\"$password\"}"
  if ok_http; then
    # pg_dump を使うので、セッションモードの 5432 に接続する
    put "$env" SUPABASE_DB_URL "postgresql://$user:$password@$host:5432/$name"
  else
    note_fail "DBパスワードを再設定できません（$(reason)）。画面で再設定し set-secrets.sh SUPABASE_DB_URL で入れてください: https://supabase.com/dashboard/project/$ref/database/settings"
  fi
  password=""
}

# ---------------------------------------------------------------- age
do_age() { # 環境
  local env="$1" public
  echo
  echo "バックアップの暗号鍵（${env}）"
  needs "$env" BACKUP_AGE_PUBLIC_KEY || { echo "  登録済み"; return 0; }
  if ! command -v age-keygen >/dev/null; then
    confirm "  age が未導入です。brew install age を実行しますか" || { echo "  飛ばしました"; return 0; }
    brew install age >/dev/null || { note_fail "age を導入できません"; return 0; }
  fi
  if [ ! -f "$AGE_KEY_FILE" ]; then
    (umask 077; age-keygen -o "$AGE_KEY_FILE" >/dev/null 2>&1) || { note_fail "暗号鍵を作れません"; return 0; }
    AGE_CREATED=1
  fi
  public=$(age-keygen -y "$AGE_KEY_FILE" 2>/dev/null)
  [ -n "$public" ] || { note_fail "公開鍵を読めません"; return 0; }
  put "$env" BACKUP_AGE_PUBLIC_KEY "$public"
}

# ---------------------------------------------------------------- 実行
echo "対象の環境: $ENVS"
echo "対象: $ONLY"
[ "$ROTATE" = 1 ] && echo "登録済みの鍵も発行し直します。"

if [ "$DRY_RUN" = 1 ]; then
  for env in $ENVS; do
    echo
    echo "$env で発行する鍵"
    while IFS=$'\t' read -r n k t s h u <&3; do
      case "$n" in
        CLOUDFLARE_*|R2_*|*TURNSTILE*) wants cloudflare || continue ;;
        HEALTHCHECKS_*) wants healthchecks || continue ;;
        SUPABASE_*) wants supabase || continue ;;
        BACKUP_AGE_PUBLIC_KEY) wants age || continue ;;
        *) continue ;;
      esac
      if needs "$env" "$n"; then echo "  発行: $n"; else echo "  登録済み: $n"; fi
    done 3< scripts/secrets-manifest.tsv
  done
  exit 0
fi

confirm "鍵を発行して格納します。続けますか" || exit 0

AGE_CREATED=0
CF_BOOT_ID=""
for env in $ENVS; do
  wants supabase && do_supabase "$env"
  wants age && do_age "$env"
  wants healthchecks && do_healthchecks "$env"
  wants cloudflare && do_cloudflare "$env"
done

if [ -n "$CF_BOOT" ]; then
  # 作業用トークンを先に消してから、発行用トークンを失効させる
  [ -n "$CF_ADMIN_ID" ] && { cf_boot DELETE "/user/tokens/$CF_ADMIN_ID"; CF_ADMIN_ID=""; }
  if [ -z "$FAILED" ] && [ -n "$CF_BOOT_ID" ]; then
    cf_boot DELETE "/user/tokens/$CF_BOOT_ID"
    if ok_http; then echo; echo "Cloudflare の発行用トークンを失効させました。"
    else echo; echo "発行用トークンを失効させられませんでした。画面で削除してください: https://dash.cloudflare.com/profile/api-tokens"; fi
  else
    echo
    echo "失敗があったので発行用トークンを残しました。再実行で使えます。不要なら画面で削除してください: https://dash.cloudflare.com/profile/api-tokens"
  fi
fi

if [ "$AGE_CREATED" = 1 ]; then
  echo
  echo "重要: バックアップの復号鍵を $AGE_KEY_FILE に作りました。"
  echo "  パスワードマネージャへ保管し、確認後にこのファイルを削除してください。失うとバックアップを復元できません。"
fi

for env in $CHANGED_ENVS; do
  if gh workflow view recheck-env.yml --repo "$REPO" >/dev/null 2>&1; then
    gh workflow run recheck-env.yml --repo "$REPO" -f environment="$env" >/dev/null && echo "待機していた処理を再開しました（${env}）。"
  fi
done

for env in $ENVS; do
  echo
  bash scripts/set-secrets.sh --env "$env" status
done

if [ -n "$FAILED" ]; then
  echo
  echo "失敗した項目:$FAILED"
  echo "原因を直して再実行してください。登録済みの鍵は飛ばします。"
  exit 1
fi
