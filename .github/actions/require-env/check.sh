#!/usr/bin/env bash
# Values remain inside the process; outputs contain only registered names.
set -euo pipefail
set -f
fail() { echo '設定名またはmanifestが不正です。値は表示しません。' >&2; exit 2; }
manifest="${GITHUB_WORKSPACE:?}/scripts/secrets-manifest.tsv"
[ -f "$manifest" ] || fail
[ -n "${GITHUB_OUTPUT:-}" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ] || fail
known=('')
while IFS=$'\t' read -r name kind target phase description source extra; do
  case "$name" in ''|\#*) continue ;; esac
  [[ "$name" =~ ^[A-Z][A-Z0-9_]{0,79}$ ]] || fail
  [[ "$kind" == secret || "$kind" == variable || "$kind" == ci_only ]] || fail
  [[ "$target" == github || "$target" == supabase || "$target" == both ]] || fail
  [[ "$phase" == A || "$phase" == B ]] || fail
  [ -n "$description" ] && [ -n "$source" ] && [ -z "$extra" ] || fail
  for item in "${known[@]}"; do [[ "${item%%:*}" != "$name" ]] || fail; done
  if [[ "$kind" == ci_only ]]; then known+=("$name:ci_only"); else known+=("$name:$target"); fi
done < "$manifest"
[ "${#known[@]}" -gt 1 ] || fail
required=('')
while IFS= read -r name; do
  [ -n "$name" ] || continue
  [[ "$name" =~ ^[A-Z][A-Z0-9_]{0,79}$ ]] || fail
  for item in "${required[@]}"; do [[ "$item" != "$name" ]] || fail; done
  found=false
  for item in "${known[@]}"; do
    if [[ "${item%%:*}" == "$name" && "${item#*:}" != supabase && "${item#*:}" != ci_only ]]; then found=true; fi
  done
  [[ "$found" == true ]] || fail
  required+=("$name")
done < <(printf '%s\n' "${REQUIRED_ENV_NAMES:-}" | tr '[:space:]' '\n')
[ "${#required[@]}" -gt 1 ] || fail
missing=('')
for name in "${required[@]}"; do
  [ -n "$name" ] || continue
  value="${!name-}"
  if [[ ! "$value" =~ [^[:space:]] ]]; then missing+=("$name"); fi
  unset value
done
joined=""
for name in "${missing[@]}"; do if [ -n "$name" ]; then joined="${joined:+$joined,}$name"; fi; done
if [ "${#missing[@]}" -eq 1 ]; then
  printf 'ready=true\nmissing=\n' >> "$GITHUB_OUTPUT"
  echo '設定確認: 必要な項目が揃っています。' >> "$GITHUB_STEP_SUMMARY"
else
  printf 'ready=false\nmissing=%s\n' "$joined" >> "$GITHUB_OUTPUT"
  printf '待機: %s\n' "$joined"
  printf '待機: %s\n' "$joined" >> "$GITHUB_STEP_SUMMARY"
fi
