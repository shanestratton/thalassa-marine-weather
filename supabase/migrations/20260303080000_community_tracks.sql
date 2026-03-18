-- community_tracks: Crowdsourced marina exit/entry pilotage tracks
-- Sailors save their GPS tracks after navigating a harbour,
-- creating a library of verified tracks for other users.

CREATE TABLE IF NOT EXISTS community_tracks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    
    -- Port identification
    start_port TEXT NOT NULL,                    -- e.g. "Newport, QLD"
    start_coordinates JSONB NOT NULL,            -- { lat, lon }
    end_port TEXT,                                -- e.g. "Moreton Bay Leads" or null for exit-only
    end_coordinates JSONB,                       -- { lat, lon }
    
    -- Track geometry
    track JSONB NOT NULL,                        -- GeoJSON LineString coordinates [[lon,lat], ...]
    distance_nm NUMERIC(8,2),                    -- Track distance in nautical miles
    
    -- Metadata
    vessel_draft_m NUMERIC(4,1),                 -- Draft of vessel that recorded this track
    direction TEXT CHECK (direction IN ('exit', 'entry', 'both')) DEFAULT 'exit',
    notes TEXT,                                   -- Optional sailor notes
    
    -- Verification
    verified BOOLEAN DEFAULT FALSE,              -- Community verified flag
    upvotes INTEGER DEFAULT 0,                   -- Community confidence score
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups by port
CREATE INDEX IF NOT EXISTS idx_community_tracks_start_port 
    ON community_tracks(start_port);
CREATE INDEX IF NOT EXISTS idx_community_tracks_end_port 
    ON community_tracks(end_port);
CREATE INDEX IF NOT EXISTS idx_community_tracks_user 
    ON community_tracks(user_id);

-- RLS: Anyone can read, authenticated users can insert their own
ALTER TABLE community_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read community tracks"
    ON community_tracks FOR SELECT
    USING (true);

CREATE POLICY "Users can insert their own tracks"
    ON community_tracks FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tracks"
    ON community_tracks FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tracks"
    ON community_tracks FOR DELETE
    USING (auth.uid() = user_id);
