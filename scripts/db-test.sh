#!/usr/bin/env bash
# Esegue migrazioni + test su un Postgres locale usa-e-getta.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
if [ "$(id -u)" = "0" ]; then RUN="runuser -u postgres --"; chown postgres "$DATA"; else RUN=""; fi
cleanup() { $RUN "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT
$RUN "$PGBIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log" -w start >/dev/null || { cat "$DATA/log"; exit 1; }
PSQL="psql -h /tmp -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -c "create database ordivia_test" >/dev/null
$PSQL -d ordivia_test -f "$ROOT/supabase/tests/00_supabase_stub.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ $(basename "$f")"
  $PSQL -d ordivia_test -f "$f" >/dev/null
done
for f in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "→ $(basename "$f")"
  $PSQL -d ordivia_test -f "$f" 2>&1 >/dev/null | sed -E 's/^psql:[^ ]+ NOTICE:  /  /'
done
