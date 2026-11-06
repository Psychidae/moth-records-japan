#!/usr/bin/env bash
# Run without an Environment or secrets. Never create an Environment from input.
set -euo pipefail
case "${REQUESTED_ENVIRONMENT:-}" in staging|production) ;; *) echo '環境はstagingかproductionを指定してください。' >&2; exit 2 ;; esac
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo '再開はmainだけで実行できます。' >&2; exit 2; }
[ -n "${GITHUB_OUTPUT:-}" ] || exit 2
printf 'environment=%s\n' "$REQUESTED_ENVIRONMENT" >> "$GITHUB_OUTPUT"
