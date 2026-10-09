-- Recipes keep a server timestamp (2026-10-10, build 126, package 126-19,
-- live drift finding B-03 = C1).
--
-- Not pushed with this commit: it goes in the 126 release push, in the same
-- push as 20261010145000_recipes_live_schema_alignment.sql, and after it.
--
-- Why
-- ───
-- Every synced binder has a BEFORE UPDATE trigger that sets updated_at to the
-- server's now(), except recipes. 20260322090000_recipes.sql declared
-- trg_recipes_updated, and live records it as applied, but live's recipes
-- table was built by hand first, so that file's trigger never landed. The
-- read-only drift scan of 2026-10-10 found update_recipes_ts() present and
-- unused, and only account_deletion_write_fence on the table.
--
-- Recipes do not sync on live today (20261010145000 fixes that). Once they
-- do, an edit pushed late from a phone that was offline, or whose clock is
-- off, would keep the phone's time. A device whose pull cursor has already
-- passed that time misses the edit until its 6-hourly full reconcile, unless
-- it is online for realtime. With the trigger, recipes behave like the other
-- twelve binders.
--
-- What
-- ────
-- update_recipes_ts() again, with its search_path pinned (not SECURITY
-- DEFINER; it only stamps NEW), and trg_recipes_updated exactly as
-- 20260322090000 named it. On a database built from the migrations this
-- replaces the same trigger with the same body. No row is touched: the
-- trigger only fires on later UPDATEs.
--
-- Undo
-- ────
--     DROP TRIGGER IF EXISTS trg_recipes_updated ON public.recipes;
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.update_recipes_ts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recipes_updated ON public.recipes;
CREATE TRIGGER trg_recipes_updated
    BEFORE UPDATE ON public.recipes
    FOR EACH ROW EXECUTE FUNCTION public.update_recipes_ts();

DO $check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_trigger AS t
         WHERE t.tgrelid = 'public.recipes'::regclass
           AND t.tgname = 'trg_recipes_updated'
           AND t.tgfoid = 'public.update_recipes_ts()'::regprocedure
           AND NOT t.tgisinternal
           AND t.tgenabled <> 'D'
    ) THEN
        RAISE EXCEPTION 'recipes_updated_at_trigger: trg_recipes_updated is missing or disabled';
    END IF;
END;
$check$;

RESET lock_timeout;
