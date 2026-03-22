-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Recipes Table (SupaSpoon)                                      ║
-- ║  Persists Spoonacular recipes locally + syncs to Supabase for offline use. ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.recipes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    spoonacular_id      INTEGER,            -- Original API ID (nullable for custom recipes)
    title               TEXT NOT NULL,
    image_url           TEXT,
    ready_in_minutes    INTEGER DEFAULT 30,
    servings            INTEGER DEFAULT 2,  -- BASE servings (what the recipe is written for)
    source_url          TEXT,
    ingredients         JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{"name":"beef brisket","amount":2.5,"unit":"kg","scalable":true,"aisle":"Meat"}]
    is_favorite         BOOLEAN DEFAULT false,
    tags                TEXT[] DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recipes_user ON public.recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_spoon ON public.recipes(spoonacular_id) WHERE spoonacular_id IS NOT NULL;

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_recipes_ts()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recipes_updated
    BEFORE UPDATE ON public.recipes
    FOR EACH ROW EXECUTE FUNCTION update_recipes_ts();

-- RLS
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own recipes"
    ON public.recipes FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
