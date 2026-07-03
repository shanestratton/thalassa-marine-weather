-- Live position trickle for the public Voyage Log (2026-07-04).
--
-- Ephemeral shadow of the on-device track: while a voyage is recording, the
-- device upserts a decimated point every couple of minutes; the voyage-log
-- edge function merges these as the "live tail" on top of the durable
-- ship_logs track (which still arrives whole at voyage stop — the local-first
-- capture contract is untouched). Rows are pruned by the device (>7 days) and
-- ignored by the edge function outside the config's track window.
--
-- source: 'device' today; 'ais' reserved for the phase-2 AIS fallback feed.

CREATE TABLE IF NOT EXISTS live_track (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id TEXT,
    timestamp TIMESTAMPTZ NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    speed_kts REAL,
    course_deg REAL,
    source TEXT NOT NULL DEFAULT 'device',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT live_track_user_ts_unique UNIQUE (user_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_live_track_user_ts ON live_track (user_id, timestamp DESC);

ALTER TABLE live_track ENABLE ROW LEVEL SECURITY;

-- The device writes and prunes its own rows. Public reads go exclusively
-- through the service-role voyage-log edge function (which enforces the
-- owner's enabled/track_days config) — no anon select policy on purpose.
CREATE POLICY live_track_insert_own ON live_track
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY live_track_update_own ON live_track
    FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY live_track_delete_own ON live_track
    FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY live_track_select_own ON live_track
    FOR SELECT USING (auth.uid() = user_id);
