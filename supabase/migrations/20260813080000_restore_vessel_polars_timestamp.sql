-- ═══════════════════════════════════════════════════════════════════════
-- Restore vessel_polars_updated — the CASCADE casualty
-- ═══════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-13, live, in production. This is the repair for a bug that
-- had ALREADY FIRED, not a precaution.
--
-- Earlier today 20260729080000_drop_marketplace.sql was amended because it
-- dropped public.update_marketplace_timestamp() with CASCADE, and
-- vessel_polars reused that generic `NEW.updated_at = now()` body
-- (20260723095000_vessel_polars.sql:34-37). The amendment was written on
-- the belief — taken from that file's own header, and from an audit that
-- trusted it — that the migration had never been applied.
--
-- That belief was wrong. Checked against production immediately after the
-- push:
--
--     select tgname from pg_trigger
--     where tgrelid = 'public.vessel_polars'::regclass and not tgisinternal;
--     -> account_deletion_write_fence          (vessel_polars_updated ABSENT)
--
-- The original migration had already run at some earlier date — which also
-- explains why the marketplace tables 404 and both escrow cron jobs were
-- already gone before today's push. So the CASCADE fired long ago and
-- vessel_polars.updated_at has been frozen ever since: every UPDATE has
-- landed without advancing it, silently, exactly as predicted.
--
-- Editing an already-applied migration does not re-run it, so the fix has
-- to arrive as a new one. 20260729080000 keeps its amended form regardless
-- — that version is what a FRESH environment replays, and it must not
-- reintroduce the bug on the next person's database.
--
-- BLAST RADIUS: exactly one trigger. Three used update_marketplace_timestamp
-- — marketplace_listings_updated and marketplace_escrow_updated went down
-- with their own tables and are moot; vessel_polars was the only survivor
-- and therefore the only casualty.
--
-- SEVERITY: bookkeeping, not behaviour. Nothing reads the column —
-- services/weatherRouter.ts:249 is the sole consumer of vessel_polars and
-- selects boat performance data, never updated_at. Repaired anyway: a column
-- that claims to track modification time and does not is a trap for whoever
-- next writes sync or cache-invalidation logic against it.
--
-- NOT BACKFILLED. Existing updated_at values are wrong — they hold the
-- creation time, or whenever the trigger last worked — and there is no
-- record of the real edit times, so any backfill would be invention. From
-- here forward the values are true; before this line they are not.

CREATE OR REPLACE FUNCTION public.vessel_polars_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Dedicated to vessel_polars, so no future feature-retirement can take it
-- out as a side effect of dropping something it merely shared a body with.
DO $$
BEGIN
    IF to_regclass('public.vessel_polars') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS vessel_polars_updated ON public.vessel_polars;
        CREATE TRIGGER vessel_polars_updated
            BEFORE UPDATE ON public.vessel_polars
            FOR EACH ROW EXECUTE FUNCTION public.vessel_polars_set_updated_at();
    END IF;
END;
$$;
