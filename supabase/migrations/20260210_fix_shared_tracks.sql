-- Fix shared_tracks table for community track upload
-- Migration: 20260210_fix_shared_tracks.sql
--
-- Issues fixed:
-- 1. Category CHECK constraint missing 'bar_crossing' and 'driving'
-- 2. Missing columns: vessel_draft_m (vessel draft depth) and tide_info

-- Drop and recreate CHECK constraint with all categories
ALTER TABLE shared_tracks DROP CONSTRAINT IF EXISTS shared_tracks_category_check;
ALTER TABLE shared_tracks ADD CONSTRAINT shared_tracks_category_check
    CHECK (category IN ('anchorage', 'port_entry', 'walking', 'reef_passage', 'coastal', 'offshore', 'bar_crossing', 'driving'));

-- Add missing columns (IF NOT EXISTS prevents errors if already added)
ALTER TABLE shared_tracks ADD COLUMN IF NOT EXISTS vessel_draft_m DOUBLE PRECISION;
ALTER TABLE shared_tracks ADD COLUMN IF NOT EXISTS tide_info TEXT;
