-- The account-deletion write fence fails CLOSED when scrub mode is unset.
--
-- Found 2026-10-05 by the Sightings rolled-back replay (step 10b) and then
-- reproduced on a live table (boats, rolled back): with an account
-- tombstoned in account_deletion_jobs, a service-role write and a direct
-- (no JWT) write to that account's rows both went through.
--
-- Cause: block_tombstoned_account_write (20260806120000) computed
--     scrub_mode := auth.role() = 'service_role'
--                   AND current_setting('thalassa.account_deletion_scrub', true) = 'true'
-- current_setting(..., true) is NULL in any backend that has never set the
-- setting, so for the service role the expression is TRUE AND NULL = NULL,
-- and with no JWT it is NULL AND NULL = NULL. `IF NOT scrub_mode AND ...`
-- is then NULL, which IF treats as false, so the fence never raised.
-- Signed-in clients were fenced as intended (FALSE AND NULL = FALSE).
-- 20260806120000's own comment says "Ordinary service writers and every
-- client remain fenced by the triggers below": this restores that.
--
-- The fix is the COALESCE. Scrub mode is still exactly the service role inside
-- scrub_account_deletion_survivors, which sets the setting to 'true' for its
-- own transaction (20260806120000, 20260905101000); nothing else sets it.
-- The body is otherwise the live one (pg_get_functiondef, 2026-10-05).
-- Written, NOT pushed: Shane says "yes, push it" first.

CREATE OR REPLACE FUNCTION public.block_tombstoned_account_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    candidate UUID;
    candidates UUID[];
    scrub_mode BOOLEAN := COALESCE(
        auth.role() = 'service_role'
            AND current_setting('thalassa.account_deletion_scrub', true) = 'true',
        false
    );
BEGIN
    SELECT array_agg(DISTINCT value::UUID ORDER BY value::UUID)
    INTO candidates
    FROM jsonb_each_text(to_jsonb(NEW)) AS field(key, value)
    WHERE field.key = ANY(TG_ARGV)
      AND field.value IS NOT NULL
      AND field.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

    FOREACH candidate IN ARRAY COALESCE(candidates, ARRAY[]::UUID[]) LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate::TEXT, 20260806));
        IF NOT scrub_mode AND EXISTS (
            SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate
        ) THEN
            RAISE EXCEPTION 'Account is permanently write-fenced' USING ERRCODE = '55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.block_tombstoned_account_write() FROM PUBLIC, anon, authenticated;
