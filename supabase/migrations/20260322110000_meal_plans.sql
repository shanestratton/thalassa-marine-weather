-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Meal Plans (Passage Calendar)                                  ║
-- ║  Links recipes to voyages + specific dates for galley execution.           ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.meal_plans (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id           UUID REFERENCES public.voyages(id) ON DELETE CASCADE,
    recipe_id           UUID,                              -- References local recipe
    spoonacular_id      INTEGER,                           -- Backup Spoonacular ref
    title               TEXT NOT NULL,
    planned_date        DATE NOT NULL,                     -- UTC date (timezone-safe)
    meal_slot           TEXT NOT NULL DEFAULT 'dinner'
                        CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
    servings_planned    INTEGER DEFAULT 2,
    ingredients         JSONB NOT NULL DEFAULT '[]'::jsonb, -- Snapshot for offline
    status              TEXT DEFAULT 'planned'
                        CHECK (status IN ('planned', 'reserved', 'cooking', 'completed', 'skipped')),
    cook_started_at     TIMESTAMPTZ,                       -- For cooking mode
    completed_at        TIMESTAMPTZ,
    leftovers_saved     BOOLEAN DEFAULT false,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mealplan_user ON public.meal_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_mealplan_voyage ON public.meal_plans(voyage_id);
CREATE INDEX IF NOT EXISTS idx_mealplan_date ON public.meal_plans(planned_date);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_mealplan_ts()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mealplan_updated
    BEFORE UPDATE ON public.meal_plans
    FOR EACH ROW EXECUTE FUNCTION update_mealplan_ts();

-- RLS
ALTER TABLE public.meal_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own meal plans"
    ON public.meal_plans FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
