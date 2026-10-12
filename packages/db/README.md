# @groundgraph/db

Postgres 16 access for the services: drizzle schema (`src/schema.ts`), a `postgres.js` client (`createDb`), typed read/write helpers, and the SQL migrations.

- `migrations/0001_init.sql` is the canonical schema and is **never edited**. Every change is a new numbered file that is idempotent (`IF NOT EXISTS`) and additive.
- `migrations/0002_services.sql`: market state mirrored from the account (EMA, settle exponent, LP claim, `last_slot`), `finalized` and `slot` tracking on trades, redemptions and merges, the `merges` and `user_activity` tables, query indexes.
- `migrations/0002_services_indexer.sql`: `liquidity_events`, `markets.created_slot`, `markets.created_finalized`, extra indexes. Migrations apply in **lexical order** (a file that depends on another must sort after it).
- `runMigrations(sql)` applies files once each (checksum recorded in `schema_migrations`) inside a transaction under an advisory lock, so the API, indexer and keeper may all call it on boot.
- Client settings: `int8` columns become JavaScript numbers, `numeric` stays a string (use `BigInt`), column names are camel-cased on read.

```bash
pnpm --filter @groundgraph/db migrate        # DATABASE_URL=postgres://... applies pending migrations
scripts/dev-db.sh svc_scratch                # drop and recreate a throwaway database from the migrations
pnpm --filter @groundgraph/db test           # recreates svc_db and checks the schema, the helpers and idempotent re-application
```
