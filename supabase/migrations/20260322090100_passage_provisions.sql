-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Passage Provisions (The Middleman)                             ║
-- ║  Bridges recipes → ship's stores with shortfall calculations.              ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.passage_provisions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    passage_name        TEXT DEFAULT 'Unnamed Passage',
    recipe_id           UUID REFERENCES public.recipes(id) ON DELETE SET NULL,
    ingredient_name     TEXT NOT NULL,
    required_qty        DECIMAL NOT NULL DEFAULT 0,
    unit                TEXT NOT NULL DEFAULT 'whole',
    scalable            BOOLEAN NOT NULL DEFAULT true,
    store_item_id       UUID,               -- Matched ship's stores item (nullable)
    on_hand_qty         DECIMAL DEFAULT 0,  -- Snapshot from stores at plan time
    shortfall_qty       DECIMAL DEFAULT 0,  -- required - on_hand
    status              TEXT DEFAULT 'needed'
                        CHECK (status IN ('needed', 'have', 'purchased')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provisions_user ON public.passage_provisions(user_id);
CREATE INDEX IF NOT EXISTS idx_provisions_recipe ON public.passage_provisions(recipe_id);

-- RLS
ALTER TABLE public.passage_provisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own provisions"
    ON public.passage_provisions FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
