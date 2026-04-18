# DEPRECATED — migrated to Supabase edge function

**As of 2026-04-18** this worker has been replaced by the
`scrape-vessel-metadata` Supabase edge function.

- New code: [supabase/functions/scrape-vessel-metadata/](../supabase/functions/scrape-vessel-metadata/)
- New schedule: [supabase/migrations/20260418120000_scrape_vessel_metadata_cron.sql](../supabase/migrations/20260418120000_scrape_vessel_metadata_cron.sql)
- Rationale: see [INFRASTRUCTURE.md](../INFRASTRUCTURE.md) — we don't need a
  long-lived container for a 15-minute cron.

## Cutover

1. Apply the migration so `pg_cron` starts firing the edge function every
   15 minutes.
2. Confirm at least one successful run — `vessel_metadata.last_scraped_at`
   should update, and the function logs in Supabase should show the
   `[DONE] Xs — seeded=N attempted=N enriched=N` line.
3. Stop the `vessel-scraper` service on Railway (do **not** delete it
   immediately — keep it paused for a week in case we need to roll back).
4. After one week of clean cron runs, delete the Railway service and
   remove this directory entirely.

## Do not deploy

`railway.toml` is still present for reference, but this directory should
**not** be redeployed. If you're reading this because a cron looks broken,
check the Supabase function logs first — the old worker is no longer the
source of truth.
