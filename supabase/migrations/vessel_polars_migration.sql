-- ============================================================
-- VESSEL POLARS — Polar performance data for weather routing
-- ============================================================

CREATE TABLE IF NOT EXISTS vessel_polars (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_model TEXT,                -- e.g. "Tayana 55"
    source TEXT DEFAULT 'manual' CHECK (source IN ('database', 'file_import', 'manual')),
    polar_data JSONB NOT NULL,     -- { windSpeeds: [...], angles: [...], matrix: [[...], ...] }
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)                -- One polar set per user
);

ALTER TABLE vessel_polars ENABLE ROW LEVEL SECURITY;

-- Users can only see their own polars
DROP POLICY IF EXISTS "Users can view own polars" ON vessel_polars;
CREATE POLICY "Users can view own polars"
ON vessel_polars FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own polars
DROP POLICY IF EXISTS "Users can insert own polars" ON vessel_polars;
CREATE POLICY "Users can insert own polars"
ON vessel_polars FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own polars
DROP POLICY IF EXISTS "Users can update own polars" ON vessel_polars;
CREATE POLICY "Users can update own polars"
ON vessel_polars FOR UPDATE
USING (auth.uid() = user_id);

-- Users can delete their own polars
DROP POLICY IF EXISTS "Users can delete own polars" ON vessel_polars;
CREATE POLICY "Users can delete own polars"
ON vessel_polars FOR DELETE
USING (auth.uid() = user_id);

-- Auto-update trigger
DROP TRIGGER IF EXISTS vessel_polars_updated ON vessel_polars;
CREATE TRIGGER vessel_polars_updated
    BEFORE UPDATE ON vessel_polars
    FOR EACH ROW
    EXECUTE FUNCTION update_marketplace_timestamp();
