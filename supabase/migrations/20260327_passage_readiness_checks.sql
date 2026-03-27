-- ============================================================
-- Passage Readiness Checks — Audit Trail
-- ============================================================
-- Run this in the Supabase SQL Editor (Dashboard > SQL > New Query)
--
-- Records every tick/untick of a pre-departure checklist item,
-- creating a legally defensible audit trail with timestamps and
-- user attribution.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.passage_readiness_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    card_key TEXT NOT NULL,
    item_key TEXT NOT NULL,
    checked BOOLEAN NOT NULL DEFAULT false,
    checked_at TIMESTAMPTZ,
    checked_by_name TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(voyage_id, card_key, item_key)
);

-- Row Level Security
ALTER TABLE public.passage_readiness_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own readiness checks"
    ON public.passage_readiness_checks
    FOR ALL USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_readiness_voyage
    ON public.passage_readiness_checks(voyage_id, card_key);

CREATE INDEX IF NOT EXISTS idx_readiness_user
    ON public.passage_readiness_checks(user_id, voyage_id);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON public.passage_readiness_checks;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.passage_readiness_checks
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();
