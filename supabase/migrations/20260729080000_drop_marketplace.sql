-- Retire the marketplace schema.
--
-- The feature is gone from the app (see the Chandlery/Marketplace removal),
-- and all four tables were verified EMPTY against production before this was
-- written — exact counts, not pg_stat estimates, because n_live_tup goes
-- stale and "approximately zero" is not a basis for a DROP:
--
--     marketplace_listings  0 | marketplace_escrow   0
--     marketplace_messages  0 | marketplace_ratings  0
--
-- THIS MIGRATION IS DESTRUCTIVE AND IRREVERSIBLE. It is written but NOT
-- applied; run it deliberately.
--
-- Order matters: unschedule the cron jobs first, then drop the functions they
-- call, then the tables those functions read. Reversing that leaves a
-- scheduled job invoking a missing function every tick.

-- ── 1. Cron ────────────────────────────────────────────────────────────
-- Both of these outlived the feature. `sweep-expired-escrows` calls an edge
-- function that no longer exists, so it has been failing on every schedule
-- since the function was deleted.
DO $$
BEGIN
    PERFORM cron.unschedule('sweep-expired-escrows');
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cron job sweep-expired-escrows was not scheduled';
END;
$$;

DO $$
BEGIN
    PERFORM cron.unschedule('sweep-expired-marketplace-escrows');
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cron job sweep-expired-marketplace-escrows was not scheduled';
END;
$$;

-- ── 2. Functions ───────────────────────────────────────────────────────
-- Signatures are omitted deliberately: none of these are overloaded, so the
-- bare name resolves, and spelling out argument lists that only exist in the
-- retired schema would make this migration fail if any drifted.
DROP FUNCTION IF EXISTS public.claim_marketplace_escrow_reconciliation CASCADE;
DROP FUNCTION IF EXISTS public.complete_marketplace_escrow_cancellation CASCADE;
DROP FUNCTION IF EXISTS public.finalize_marketplace_escrow_release CASCADE;
DROP FUNCTION IF EXISTS public.release_marketplace_escrow_capture CASCADE;
DROP FUNCTION IF EXISTS public.sweep_expired_escrows CASCADE;
DROP FUNCTION IF EXISTS public.verify_escrow_pin CASCADE;
-- hash_marketplace_escrow_pin was one of the SECURITY DEFINER functions still
-- carrying an EXECUTE grant to PUBLIC (see 20260728150000, which left it
-- because it is a trigger body). Deleting the feature deletes the exposure.
DROP FUNCTION IF EXISTS public.hash_marketplace_escrow_pin CASCADE;
DROP FUNCTION IF EXISTS public.update_marketplace_timestamp CASCADE;
DROP FUNCTION IF EXISTS public.get_listings_within_radius CASCADE;

-- ── 3. Tables ──────────────────────────────────────────────────────────
-- CASCADE takes the RLS policies, indexes, triggers and foreign keys with
-- them. Escrow first: it references listings.
DROP TABLE IF EXISTS public.marketplace_escrow CASCADE;
DROP TABLE IF EXISTS public.marketplace_ratings CASCADE;
DROP TABLE IF EXISTS public.marketplace_messages CASCADE;
DROP TABLE IF EXISTS public.marketplace_listings CASCADE;
