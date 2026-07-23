-- Extend the canonical recipes table for user-authored and shared recipes
-- without destroying cached Spoonacular rows.

ALTER TABLE public.recipes
    ADD COLUMN IF NOT EXISTS instructions TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal';

ALTER TABLE public.recipes
    DROP CONSTRAINT IF EXISTS recipes_visibility_check;
ALTER TABLE public.recipes
    ADD CONSTRAINT recipes_visibility_check
    CHECK (visibility IN ('personal', 'shared'));

CREATE INDEX IF NOT EXISTS idx_recipes_visibility
    ON public.recipes(visibility, updated_at DESC)
    WHERE visibility = 'shared';

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own recipes" ON public.recipes;
DROP POLICY IF EXISTS "recipes_select" ON public.recipes;
DROP POLICY IF EXISTS "recipes_insert" ON public.recipes;
DROP POLICY IF EXISTS "recipes_update" ON public.recipes;
DROP POLICY IF EXISTS "recipes_delete" ON public.recipes;

CREATE POLICY "recipes_select"
    ON public.recipes FOR SELECT TO authenticated
    USING (visibility = 'shared' OR user_id = auth.uid());
CREATE POLICY "recipes_insert"
    ON public.recipes FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "recipes_update"
    ON public.recipes FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "recipes_delete"
    ON public.recipes FOR DELETE TO authenticated
    USING (user_id = auth.uid());
