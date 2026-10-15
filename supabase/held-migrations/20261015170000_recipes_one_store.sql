-- One recipe store for your own and shared recipes (2026-10-15, build 132,
-- package 132-B18; binder audit GAL-06, GAL-08, GAL-16; Shane, 15 Oct: one
-- store, with community sharing a visibility on it).
--
-- HELD. The push needs Shane's own Supabase sign-in: supabase db push applies
-- every pending file in supabase/migrations, and Shane pushes this one
-- himself. Release it by moving it into supabase/migrations under a stamp
-- newer than the newest applied migration and, in the same commit:
--   * rewrite tests/RecipesOneStoreMigration.test.ts to read the released
--     file and assert the held copy is gone (the b85cd258d vault-limits
--     release);
--   * add 'recipes' to the signed-out tables that
--     tests/AnonPrivilegesLockdownMigration.test.ts recomputes: this file lets
--     a signed-out sailor read shared recipes, as community_recipes does;
-- then push. Builds from 132 find it with a column probe of
-- recipes.rating_avg (services/galley/recipeStoreColumn.ts); builds before
-- 132 keep working after it (see "Older builds").
--
-- Until it runs the app keeps two stores:
--   * the Captain's Table reads community_recipes, plus the recipes shared
--     from the Galley, which show there without ratings;
--   * sharing from the Captain's Table writes community_recipes and its
--     `recipes` twin;
--   * only a recipe's owner changes it: crew in a skipper's galley may add a
--     recipe, not edit one.
-- Once the probe sees the column:
--   * the Captain's Table reads the shared `recipes` rows only, each with its
--     author's name and ratings, signed in or out;
--   * sharing from the Captain's Table writes one `recipes` row;
--   * crew the skipper lets write the Galley may change a personal recipe in
--     it, from the phone, through the outbox.
--
-- What
-- ────
-- * recipes.author_name TEXT, rating_avg DOUBLE PRECISION and rating_count
--   INTEGER, both NOT NULL DEFAULT 0 (a catalogue-only change since
--   Postgres 11). The NOTIFY makes PostgREST see them.
-- * Every community_recipes row with no `recipes` row gets one, same id and
--   owner: a Captain's Table recipe whose twin never reached the server
--   (before 126 the outbox could not push it, PGRST204), and a private one.
--   Visibility maps community -> shared and private -> personal. A private
--   one's photo stays on its community_recipes row only: a personal recipe
--   keeps no photo in this beta (updateCustomRecipe clears it), and nothing
--   is deleted. Steps are copied as JSON text, as the twins hold them.
--   updated_at is now(), so every device pulls the new rows.
-- * A twin (a row in both) takes its author's name from community_recipes.
--   Its visibility stays as `recipes` has it: this never makes public a
--   recipe the Galley holds as personal.
-- * recipe_ratings.recipe_id points at recipes(id) ON DELETE CASCADE (it
--   pointed at community_recipes). Found by what it is, not by its name: the
--   base migration (20260401000100) declared it inline, unnamed. After the
--   copy every rating's recipe is in `recipes`, unless its owner's account is
--   being deleted (those rows are skipped, below); then the key is left NOT
--   VALID (it still checks every new rating) instead of failing the push.
-- * Every recipe's rating_avg and rating_count are counted again from
--   recipe_ratings. update_recipe_rating_avg() now writes them onto recipes,
--   and onto the community_recipes row while one exists (builds before 132
--   read it). It is SECURITY DEFINER now: run as the rater it could not write
--   another sailor's row (RLS), so an average never moved past the owner's
--   own rating. Nobody may call it.
-- * guard_recipe_row(), BEFORE INSERT OR UPDATE on recipes: only the rating
--   trigger writes a rating column (an app write keeps the old values; a new
--   row starts at 0), and only the owner moves a recipe to another owner (RLS
--   checks the NEW owner only, as guard_galley_row_owner says for meal plans).
--   Named to fire after every other BEFORE trigger on the table. Nobody may
--   call it.
-- * Policies on recipes: "Galley crew change recipes" (UPDATE) for crew with
--   Galley write, personal recipes only, before and after, never their own
--   (the owner's recipes_update covers those); "Anyone reads shared recipes"
--   (SELECT, anon), the signed-out Captain's Table, as "Anyone reads
--   community recipes" has it. Signed in, recipes_select already reads them.
-- * community_recipes stays as it is: builds before 132 read and write it.
--
-- Older builds
-- ────────────
-- A build before 132 still shares through community_recipes and its `recipes`
-- twin: the twin reaches the one store through the outbox, without the
-- author's name (the card says "A Fellow Sailor") until that sailor updates.
-- Its Captain's Table shows community_recipes only, so it does not see a
-- recipe shared from a 132 build. A rating it gives lands on the twin's id,
-- and counts in both stores.
--
-- Account deletion: the rows of an account being deleted are write-fenced
-- (account_deletion_write_fence, 20260806120000), so the copy, the twin
-- update and the recount skip them, as 20261010150000 did; one such row
-- cannot fail the push. scrub_account_deletion_survivors deletes recipes by
-- owner, and their ratings go with them (CASCADE).
--
-- Undo
-- ────
--     DROP POLICY IF EXISTS "Anyone reads shared recipes" ON public.recipes;
--     REVOKE SELECT ON public.recipes FROM anon;
--     DROP POLICY IF EXISTS "Galley crew change recipes" ON public.recipes;
--     DROP TRIGGER IF EXISTS trg_zz_guard_recipe_row ON public.recipes;
--     DROP FUNCTION IF EXISTS public.guard_recipe_row();
-- then, ONLY with Shane's yes, because it deletes the ratings of recipes
-- that are only in `recipes`:
--     DELETE FROM public.recipe_ratings AS rating WHERE NOT EXISTS (
--         SELECT 1 FROM public.community_recipes AS c WHERE c.id = rating.recipe_id);
--     ALTER TABLE public.recipe_ratings DROP CONSTRAINT recipe_ratings_recipe_id_fkey;
--     ALTER TABLE public.recipe_ratings ADD CONSTRAINT recipe_ratings_recipe_id_fkey
--         FOREIGN KEY (recipe_id) REFERENCES public.community_recipes(id) ON DELETE CASCADE;
--     (and update_recipe_rating_avg() as 20260401000100 wrote it)
--     ALTER TABLE public.recipes DROP COLUMN author_name, DROP COLUMN rating_avg,
--         DROP COLUMN rating_count;
-- The copied rows stay: they are the sailors' own recipes. The app goes back
-- to two stores once its probe no longer finds rating_avg (after the hour a
-- session remembers an answer for, or on the next launch).
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS; the copy takes only rows still
-- missing; the updates change only what differs; the key is replaced only
-- while it does not point at recipes; CREATE OR REPLACE, DROP ... IF EXISTS.
-- The guard is dropped first and made again last, so it never zeroes what
-- this file writes. Locks are bounded (lock_timeout 5s): a busy table fails
-- the push, retry it. No BEGIN or COMMIT: the pre-push replay runs this file
-- inside a rolled-back transaction.
--
-- Check it after the push, in a rolled-back transaction, printing counts
-- only: no community_recipes row without a recipes row (other than a fenced
-- account's); a second sailor's rating moves the recipe's rating_avg; the
-- owner's UPDATE of rating_avg leaves it as it was; crew with Galley write
-- change a personal recipe of the skipper's, and cannot make it shared.

SET LOCAL lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regclass('public.recipes') IS NULL
       OR to_regclass('public.community_recipes') IS NULL
       OR to_regclass('public.recipe_ratings') IS NULL
       OR to_regclass('public.account_deletion_jobs') IS NULL THEN
        RAISE EXCEPTION 'recipes_one_store: recipes, community_recipes, recipe_ratings or account_deletion_jobs is missing';
    END IF;
    IF to_regprocedure('public.can_access_vessel_register(uuid, text, boolean)') IS NULL THEN
        RAISE EXCEPTION 'recipes_one_store: can_access_vessel_register is missing';
    END IF;
END;
$precheck$;

-- Made again at the end: until then nothing here is rewritten by it.
DROP TRIGGER IF EXISTS trg_zz_guard_recipe_row ON public.recipes;

-- ── The columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.recipes
    ADD COLUMN IF NOT EXISTS author_name TEXT,
    ADD COLUMN IF NOT EXISTS rating_avg DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

-- ── The Captain's Table rows join the one store ─────────────────────────────

INSERT INTO public.recipes (
    id, user_id, title, image_url, ready_in_minutes, servings, ingredients,
    instructions, visibility, tags, is_custom, is_favorite, author_name,
    created_at, updated_at
)
SELECT
    community.id,
    community.user_id,
    community.title,
    CASE WHEN community.visibility = 'community' THEN community.image_url END,
    COALESCE(community.ready_in_minutes, 30),
    COALESCE(community.servings, 1),
    COALESCE(community.ingredients, '[]'::jsonb),
    COALESCE(community.instructions, '[]'::jsonb)::text,
    CASE WHEN community.visibility = 'community' THEN 'shared' ELSE 'personal' END,
    COALESCE(community.tags, '{}'::text[]),
    true,
    false,
    community.author_name,
    COALESCE(community.created_at, now()),
    now()
FROM public.community_recipes AS community
WHERE NOT EXISTS (SELECT 1 FROM public.recipes AS recipe WHERE recipe.id = community.id)
  AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = community.user_id);

UPDATE public.recipes AS recipe
SET author_name = community.author_name,
    updated_at = now()
FROM public.community_recipes AS community
WHERE community.id = recipe.id
  AND community.user_id = recipe.user_id
  AND recipe.author_name IS DISTINCT FROM community.author_name
  AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = recipe.user_id);

-- ── Ratings point at the one store ──────────────────────────────────────────

DO $ratings_key$
DECLARE
    recipe_column SMALLINT;
    fk RECORD;
BEGIN
    SELECT attribute.attnum
    INTO recipe_column
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.recipe_ratings'::regclass
      AND attribute.attname = 'recipe_id'
      AND NOT attribute.attisdropped;

    -- Every key from recipe_id to a table that is not recipes.
    FOR fk IN
        SELECT constraint_row.conname
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.recipe_ratings'::regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.conkey = ARRAY[recipe_column]
          AND constraint_row.confrelid <> 'public.recipes'::regclass
    LOOP
        EXECUTE format('ALTER TABLE public.recipe_ratings DROP CONSTRAINT %I', fk.conname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.recipe_ratings'::regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'public.recipes'::regclass
          AND constraint_row.conkey = ARRAY[recipe_column]
    ) THEN
        ALTER TABLE public.recipe_ratings
            ADD CONSTRAINT recipe_ratings_recipe_id_fkey
            FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE NOT VALID;
    END IF;

    -- Checked now, unless a rating's recipe is a fenced account's.
    IF NOT EXISTS (
        SELECT 1
        FROM public.recipe_ratings AS rating
        WHERE NOT EXISTS (SELECT 1 FROM public.recipes AS recipe WHERE recipe.id = rating.recipe_id)
    ) THEN
        ALTER TABLE public.recipe_ratings VALIDATE CONSTRAINT recipe_ratings_recipe_id_fkey;
    END IF;
END;
$ratings_key$;

UPDATE public.recipes AS recipe
SET rating_avg = tally.average,
    rating_count = tally.total,
    updated_at = now()
FROM (
    SELECT rating.recipe_id,
           AVG(rating.rating)::DOUBLE PRECISION AS average,
           COUNT(*)::INTEGER AS total
    FROM public.recipe_ratings AS rating
    GROUP BY rating.recipe_id
) AS tally
WHERE tally.recipe_id = recipe.id
  AND (recipe.rating_avg IS DISTINCT FROM tally.average OR recipe.rating_count IS DISTINCT FROM tally.total)
  AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = recipe.user_id);

CREATE OR REPLACE FUNCTION public.update_recipe_rating_avg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target UUID := COALESCE(NEW.recipe_id, OLD.recipe_id);
    average DOUBLE PRECISION;
    total INTEGER;
BEGIN
    SELECT COALESCE(AVG(rating)::DOUBLE PRECISION, 0), COUNT(*)::INTEGER
    INTO average, total
    FROM public.recipe_ratings
    WHERE recipe_id = target;

    UPDATE public.recipes
    SET rating_avg = average, rating_count = total
    WHERE id = target
      AND (rating_avg IS DISTINCT FROM average OR rating_count IS DISTINCT FROM total);

    UPDATE public.community_recipes
    SET rating_avg = average, rating_count = total
    WHERE id = target
      AND (rating_avg IS DISTINCT FROM average OR rating_count IS DISTINCT FROM total);

    RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.update_recipe_rating_avg() FROM PUBLIC, anon, authenticated;

-- ── Who changes a recipe, and who reads one ─────────────────────────────────

DROP POLICY IF EXISTS "Galley crew change recipes" ON public.recipes;
CREATE POLICY "Galley crew change recipes"
    ON public.recipes FOR UPDATE TO authenticated
    USING (
        user_id <> auth.uid()
        AND visibility = 'personal'
        AND public.can_access_vessel_register(user_id, 'galley', true)
    )
    WITH CHECK (
        user_id <> auth.uid()
        AND visibility = 'personal'
        AND public.can_access_vessel_register(user_id, 'galley', true)
    );

GRANT SELECT ON public.recipes TO anon;
DROP POLICY IF EXISTS "Anyone reads shared recipes" ON public.recipes;
CREATE POLICY "Anyone reads shared recipes"
    ON public.recipes FOR SELECT TO anon
    USING (visibility = 'shared');

CREATE OR REPLACE FUNCTION public.guard_recipe_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- The rating trigger's own UPDATE runs one level down (depth 2).
    IF pg_trigger_depth() < 2 THEN
        IF TG_OP = 'INSERT' THEN
            NEW.rating_avg := 0;
            NEW.rating_count := 0;
        ELSE
            NEW.rating_avg := OLD.rating_avg;
            NEW.rating_count := OLD.rating_count;
        END IF;
    END IF;
    IF TG_OP = 'UPDATE'
       AND auth.uid() IS NOT NULL
       AND NEW.user_id IS DISTINCT FROM OLD.user_id
       AND OLD.user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Only the owner can move a recipe to another owner'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_recipe_row() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_zz_guard_recipe_row
    BEFORE INSERT OR UPDATE ON public.recipes
    FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_row();

COMMENT ON COLUMN public.recipes.author_name IS
    'The name a shared recipe shows on the Captain''s Table (2026-10-15, 132-B18).';
COMMENT ON COLUMN public.recipes.rating_avg IS
    'Average Captain''s Table rating, written only by update_recipe_rating_avg (2026-10-15, 132-B18).';
COMMENT ON COLUMN public.recipes.rating_count IS
    'Number of Captain''s Table ratings, written only by update_recipe_rating_avg (2026-10-15, 132-B18).';

NOTIFY pgrst, 'reload schema';
