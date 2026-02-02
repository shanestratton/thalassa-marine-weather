-- Ship's Log Table Migration
-- Creates table for maritime voyage tracking with RLS policies

-- Create ship_log table
CREATE TABLE IF NOT EXISTS ship_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id UUID, -- Optional: Group entries by voyage
    
    -- Timestamp
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Position
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    position_formatted TEXT, -- DMS format for display
    
    -- Navigation
    distance_nm DECIMAL(10, 2), -- Distance from last entry
    cumulative_distance_nm DECIMAL(10, 2), -- Total voyage distance
    speed_kts DECIMAL(5, 1), -- Speed over ground
    course_deg INTEGER, -- Heading/course in degrees
    
    -- Weather snapshot
    wind_speed DECIMAL(5, 1),
    wind_direction VARCHAR(3), -- E, NE, etc.
    wave_height DECIMAL(4, 1),
    pressure INTEGER, -- Barometric pressure in hPa
    air_temp INTEGER, -- Air temperature in °C
    water_temp INTEGER, -- Sea surface temperature in °C
    
    -- Entry metadata
    entry_type VARCHAR(10) NOT NULL DEFAULT 'auto', -- auto, manual, waypoint
    notes TEXT,
    waypoint_name VARCHAR(100),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ship_log_user_id ON ship_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ship_log_timestamp ON ship_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ship_log_voyage_id ON ship_log(voyage_id) WHERE voyage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ship_log_entry_type ON ship_log(entry_type);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_ship_log_updated_at
    BEFORE UPDATE ON ship_log
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security
ALTER TABLE ship_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Policy: Users can view their own entries
CREATE POLICY "Users can view own log entries"
    ON ship_log
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can insert their own entries
CREATE POLICY "Users can insert own log entries"
    ON ship_log
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own entries
CREATE POLICY "Users can update own log entries"
    ON ship_log
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can delete their own entries
CREATE POLICY "Users can delete own log entries"
    ON ship_log
    FOR DELETE
    USING (auth.uid() = user_id);

-- Create voyage summary view (optional, for statistics)
CREATE OR REPLACE VIEW voyage_summaries AS
SELECT 
    user_id,
    voyage_id,
    MIN(timestamp) AS start_time,
    MAX(timestamp) AS end_time,
    MAX(cumulative_distance_nm) AS total_distance_nm,
    COUNT(*) AS entry_count,
    COUNT(*) FILTER (WHERE entry_type = 'waypoint') AS waypoint_count,
    AVG(speed_kts) FILTER (WHERE speed_kts > 0) AS avg_speed_kts,
    MAX(speed_kts) AS max_speed_kts,
    AVG(wind_speed) FILTER (WHERE wind_speed IS NOT NULL) AS avg_wind_speed,
    AVG(wave_height) FILTER (WHERE wave_height IS NOT NULL) AS avg_wave_height
FROM ship_log
WHERE voyage_id IS NOT NULL
GROUP BY user_id, voyage_id;

-- Grant access to view
GRANT SELECT ON voyage_summaries TO authenticated;

-- Comments for documentation
COMMENT ON TABLE ship_log IS 'Maritime voyage tracking log with 15-minute GPS intervals';
COMMENT ON COLUMN ship_log.voyage_id IS 'Optional UUID to group entries by voyage for multi-day passages';
COMMENT ON COLUMN ship_log.position_formatted IS 'Human-readable DMS format (e.g., 27°12.5''S 153°5.2''E)';
COMMENT ON COLUMN ship_log.entry_type IS 'Type of entry: auto (scheduled), manual (user-initiated), waypoint (position marker)';
