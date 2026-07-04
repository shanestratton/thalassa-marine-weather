-- Public Voyage Log — per-voyage visibility (2026-07-04).
--
-- The public page draws every voyage in the track window as one line, so
-- repeated day-sails over the same water render as spaghetti. This table is
-- the owner's exclusion list: a voyage listed here is filtered out of the
-- public track AND the live tail by the voyage-log edge function, while the
-- owner's own in-app log keeps the voyage untouched (the Bin remains the
-- tool for actually deleting data).

CREATE TABLE IF NOT EXISTS voyage_log_hidden_voyages (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, voyage_id)
);

ALTER TABLE voyage_log_hidden_voyages ENABLE ROW LEVEL SECURITY;

-- Owner manages their own list; public reads go through the service-role
-- edge function only.
CREATE POLICY voyage_log_hidden_select_own ON voyage_log_hidden_voyages
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY voyage_log_hidden_insert_own ON voyage_log_hidden_voyages
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY voyage_log_hidden_delete_own ON voyage_log_hidden_voyages
    FOR DELETE USING (auth.uid() = user_id);
