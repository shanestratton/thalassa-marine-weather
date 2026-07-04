-- Passage linking — voyage ↔ passage-plan ties (2026-07-04).
--
-- A recorded voyage linked to a saved passage plan drives the public
-- Voyage Log's DYNAMIC destination + progress: the edge function overrides
-- the static config destination with the linked plan's endpoint and
-- computes distance-run vs plan-distance while the voyage is fresh.
--
-- plan_voyage_id references the plan's synthetic voyage id in ship_logs
-- ('planned_<ts>_<rand>' rows with source='planned_route') — TEXT by
-- design, no FK (plans live as log entries, not their own table).

CREATE TABLE IF NOT EXISTS voyage_plan_links (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id TEXT NOT NULL,
    plan_voyage_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, voyage_id)
);

ALTER TABLE voyage_plan_links ENABLE ROW LEVEL SECURITY;

-- Owner manages their own links; public reads go through the service-role
-- edge function only.
CREATE POLICY voyage_plan_links_select_own ON voyage_plan_links
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY voyage_plan_links_insert_own ON voyage_plan_links
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY voyage_plan_links_update_own ON voyage_plan_links
    FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY voyage_plan_links_delete_own ON voyage_plan_links
    FOR DELETE USING (auth.uid() = user_id);
