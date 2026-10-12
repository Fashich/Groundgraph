#!/usr/bin/env bash
# Create (or recreate) a throwaway database from the canonical migrations. Usage: scripts/dev-db.sh <dbname>
set -euo pipefail
DB="${1:?db name}"
HOST="${PGHOST:-127.0.0.1}"; USER_="${PGUSER:-groundgraph}"; export PGPASSWORD="${PGPASSWORD:-groundgraph}"
psql -h "$HOST" -U "$USER_" -d postgres -q -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\""
for f in "$(dirname "$0")"/../packages/db/migrations/*.sql; do psql -h "$HOST" -U "$USER_" -d "$DB" -q -v ON_ERROR_STOP=1 -f "$f"; done
echo "postgres://$USER_:$PGPASSWORD@$HOST:5432/$DB"
