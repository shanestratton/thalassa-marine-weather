-- Galley recipes get their Edit button back (2026-10-10, build 126, plan
-- 126-B2b, binder audit GAL-03).
--
-- Not pushed with this commit: it waits for Shane's yes. Data only: no schema,
-- policy, grant or function change. A one-off, but re-running it is harmless
-- (it only ever sets is_custom to true on the rows below). It can be pushed
-- before or after build 126 reaches the phones (see "Older builds").
--
-- Why
-- ───
-- Before 126, createCustomRecipe saved a new Galley recipe twice: through the
-- outbox, with is_custom true, and first through a direct upsert that left
-- is_custom out, so the column default (false, 20260723103000) won. The outbox
-- INSERT is ON CONFLICT DO NOTHING and never corrected it. The next pull
-- brought the false back, and the recipe lost its Edit button on every device.
-- 126-B2a removed the direct upsert; this repairs the rows it left behind.
--
-- Which rows
-- ──────────
-- Before 126 the only writers of a recipes row with no Spoonacular id were
-- createCustomRecipe (the upsert above, and its outbox INSERT with is_custom
-- true), the Captain's Table twin (true) and the local inserts of getMyRecipes
-- and getRecipeById (true). So is_custom = false with no Spoonacular id is
-- exactly those Galley-made recipes, except:
-- * build 126's copies of another sailor's recipe (126-B2a), which are
--   legitimately not custom. Their ids are RFC 9562 version 8 (the 15th
--   character of the text form is '8'); a recipe written in the Galley has a
--   version 4 id. They are skipped.
-- * the recipe of an account being deleted. account_deletion_write_fence
--   (20260806120000, fail-closed since 20261005160000) refuses any write to
--   it and would abort the whole migration. They are skipped.
-- A copy of a searched recipe that an older build saved is version 4 and not
-- custom too. It can reach live only once a 126 phone's outbox repair has
-- nulled its fake id AND 20261010145000_recipes_live_schema_alignment.sql has
-- added the columns its payload names (PostgREST refuses it until then). One
-- push runs both migrations before any such copy lands; if one is on the
-- server when this runs, it gets is_custom true, which only gives its owner
-- an Edit button on their own row.
--
-- Live is not the migrations' shape (read-only probe, 2026-10-10)
-- ───────────────────────────────────────────────────────────────
-- The live recipes table predates 20260322090000, whose CREATE TABLE IF NOT
-- EXISTS never ran there: it has no spoonacular_id (and no source_url)
-- column, and no trg_recipes_updated trigger (only account_deletion_write_fence).
-- 20261010145000 adds the two columns, but this must not depend on it: the
-- "no Spoonacular id" term reads the column through to_jsonb, which is NULL
-- where the column does not exist and the column itself where it does (a
-- database built from these migrations, or live after 20261010145000). And
-- updated_at is set here, not left to a trigger: a newer updated_at is what
-- makes every device's next pull (and realtime, recipes is in
-- supabase_realtime) bring the fixed row back, with its Edit button.
--
-- Older builds
-- ────────────
-- Builds before 126 still make the upsert on a phone that has not updated.
-- A row it writes after this runs stays is_custom false; if a later probe
-- finds new ones, re-run the same UPDATE as a dated follow-up migration.
--
-- Self-check
-- ──────────
-- The repair and its check are one statement. Writes to recipes wait for
-- those milliseconds (reads do not), so no upsert can slip in between, and
-- the migration fails, changing nothing, if a matching row is left.

DO $recipes_is_custom_repair$
DECLARE
    repaired BIGINT;
BEGIN
    LOCK TABLE public.recipes IN SHARE ROW EXCLUSIVE MODE;

    UPDATE public.recipes AS r
       SET is_custom = true,
           updated_at = now()
     WHERE r.is_custom = false
       AND (to_jsonb(r) ->> 'spoonacular_id') IS NULL
       AND substr(r.id::text, 15, 1) <> '8'
       AND NOT EXISTS (
           SELECT 1 FROM public.account_deletion_jobs AS j WHERE j.user_id = r.user_id
       );
    GET DIAGNOSTICS repaired = ROW_COUNT;

    IF EXISTS (
        SELECT 1
          FROM public.recipes AS r
         WHERE r.is_custom = false
           AND (to_jsonb(r) ->> 'spoonacular_id') IS NULL
           AND substr(r.id::text, 15, 1) <> '8'
           AND NOT EXISTS (
               SELECT 1 FROM public.account_deletion_jobs AS j WHERE j.user_id = r.user_id
           )
    ) THEN
        RAISE EXCEPTION 'recipes_is_custom_repair: a Galley-made recipe still has is_custom false';
    END IF;

    RAISE NOTICE 'recipes_is_custom_repair: % recipe(s) given is_custom', repaired;
END;
$recipes_is_custom_repair$;
