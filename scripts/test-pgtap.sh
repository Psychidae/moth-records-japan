#!/usr/bin/env bash
set -euo pipefail

# A fixed, disposable local database. Never accepts a remote URL or production key.
if [[ -n "${PGHOST:-}" && "${PGHOST}" != /var/run/postgresql && "${PGHOST}" != localhost && "${PGHOST}" != 127.0.0.1 ]]; then
  echo 'pgTAP CI must use a local PostgreSQL server' >&2
  exit 1
fi
database=moth_records_ci_test
createdb "$database"
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file scripts/ci-auth-bootstrap.sql
for migration in supabase/migrations/*.sql; do
  psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --single-transaction --file "$migration"
done
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --single-transaction --file supabase/seed.sql
# The same source import must be safe to replay before permissions are exercised.
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/listmj/import.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/listmj/import.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/listmj/annotations.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/listmj/annotations.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/regions/regions.sql
psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$database" --file generated/regions/regions.sql
pg_prove --verbose --dbname "$database" supabase/tests/*.sql
