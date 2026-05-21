-- Vessel Knowledge Table Migration
-- Per-user knowledge base that Calypso (the AI assistant) draws on to
-- "know your boat" — vessel specs, recipes, basic medical notes,
-- maintenance history, crew preferences. Top-tier feature. Each row is
-- a titled note in a category; the client fetches a user's rows (under
-- RLS) and folds them into Calypso's system prompt.
--
-- Design notes:
--   - user_id scoped (one knowledge base per paying user). A boat_id
--     column is reserved for a future crew-shared model but not used yet.
--   - category drives how Calypso treats the note (assert specs as fact,
--     recall recipes freely, RECALL-not-advise on medical — see the
--     orchestrator/edge-function prompt guardrail).
--   - body is plain text (MVP). PDF/photo extraction is a later phase.

CREATE TABLE IF NOT EXISTS vessel_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Reserved for future crew-shared knowledge; nullable, unused in MVP.
    boat_id UUID,
    -- vessel_spec | medical | recipe | maintenance | crew_pref | general
    category TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The edge function / orchestrator fetch is always "all rows for this user".
CREATE INDEX IF NOT EXISTS vessel_knowledge_user_id_idx ON vessel_knowledge (user_id);

-- Keep updated_at honest on edits.
CREATE OR REPLACE FUNCTION vessel_knowledge_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vessel_knowledge_set_updated_at ON vessel_knowledge;
CREATE TRIGGER vessel_knowledge_set_updated_at
    BEFORE UPDATE ON vessel_knowledge
    FOR EACH ROW
    EXECUTE FUNCTION vessel_knowledge_touch_updated_at();

-- ── Row-level security ───────────────────────────────────────────────
-- A user may only ever see and mutate their own knowledge rows.
ALTER TABLE vessel_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own knowledge"
    ON vessel_knowledge
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own knowledge"
    ON vessel_knowledge
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own knowledge"
    ON vessel_knowledge
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own knowledge"
    ON vessel_knowledge
    FOR DELETE
    USING (auth.uid() = user_id);
