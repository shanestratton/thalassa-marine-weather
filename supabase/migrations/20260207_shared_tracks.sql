-- Shared Tracks table for community track sharing
-- Migration: 20260207_shared_tracks.sql

-- Create shared_tracks table
CREATE TABLE IF NOT EXISTS shared_tracks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT[] DEFAULT '{}',
    category TEXT NOT NULL CHECK (category IN ('anchorage', 'port_entry', 'walking', 'reef_passage', 'coastal', 'offshore', 'bar_crossing', 'driving')),
    region TEXT NOT NULL DEFAULT '',
    center_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
    center_lon DOUBLE PRECISION NOT NULL DEFAULT 0,
    distance_nm DOUBLE PRECISION NOT NULL DEFAULT 0,
    point_count INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    vessel_draft_m DOUBLE PRECISION,  -- Draft depth of sharing vessel (meters)
    tide_info TEXT,                     -- Tide conditions at time of recording
    created_at TIMESTAMPTZ DEFAULT NOW(),
    gpx_data TEXT -- Full GPX XML (typically 10-100KB per track)
);

-- Indexes for browsing/filtering
CREATE INDEX IF NOT EXISTS idx_shared_tracks_category ON shared_tracks(category);
CREATE INDEX IF NOT EXISTS idx_shared_tracks_region ON shared_tracks(region);
CREATE INDEX IF NOT EXISTS idx_shared_tracks_created_at ON shared_tracks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_tracks_user_id ON shared_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_tracks_download_count ON shared_tracks(download_count DESC);

-- Full-text search on title and description
CREATE INDEX IF NOT EXISTS idx_shared_tracks_search ON shared_tracks USING gin(to_tsvector('english', title || ' ' || description));

-- RLS Policies
ALTER TABLE shared_tracks ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can browse tracks (metadata only)
CREATE POLICY "Anyone can view shared tracks"
    ON shared_tracks FOR SELECT
    TO authenticated
    USING (true);

-- Authenticated users can share their own tracks
CREATE POLICY "Users can insert own tracks"
    ON shared_tracks FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Only the owner can delete their tracks
CREATE POLICY "Users can delete own tracks"
    ON shared_tracks FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- Owner can update their own tracks (title, description, tags)
CREATE POLICY "Users can update own tracks"
    ON shared_tracks FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to increment download counter (called via RPC)
CREATE OR REPLACE FUNCTION increment_download_count(track_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE shared_tracks
    SET download_count = download_count + 1
    WHERE id = track_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
