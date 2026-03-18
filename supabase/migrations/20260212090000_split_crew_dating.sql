-- Split Crew & Dating into separate tables
-- Migration: 20260212_split_crew_dating.sql
-- Creates dedicated sailor_crew_profiles for Find Crew feature

-- ═══════════════════════════════════════════════════
-- 1. CREATE NEW CREW PROFILES TABLE
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sailor_crew_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Listing mode
    listing_type TEXT CHECK (listing_type IN ('seeking_crew', 'seeking_berth')),
    -- Personal
    first_name TEXT,
    gender TEXT,
    age_range TEXT,
    has_partner BOOLEAN DEFAULT false,
    partner_details TEXT,
    -- Skills & Experience
    skills TEXT[] DEFAULT '{}',
    sailing_experience TEXT,
    -- Location & Availability
    sailing_region TEXT,
    available_from TEXT,
    available_to TEXT,
    -- Bio
    bio TEXT,
    -- Photo (single crew photo URL)
    photo_url TEXT,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sailor_crew_profiles_listing_type ON sailor_crew_profiles(listing_type);

-- ═══════════════════════════════════════════════════
-- 2. RLS POLICIES FOR CREW PROFILES
-- ═══════════════════════════════════════════════════

ALTER TABLE sailor_crew_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view crew profiles"
    ON sailor_crew_profiles FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can insert own crew profile"
    ON sailor_crew_profiles FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own crew profile"
    ON sailor_crew_profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own crew profile"
    ON sailor_crew_profiles FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- No data migration needed — the crew-specific columns (listing_type, skills, 
-- sailing_experience, etc.) were never present in the live sailor_dating_profiles 
-- table. New crew profiles will be created fresh in sailor_crew_profiles.

-- ═══════════════════════════════════════════════════
-- 4. CLEAN UP DATING PROFILES TABLE
-- Rename columns for clarity, remove crew-specific fields
-- (Keep columns for now to avoid breaking anything,
--  just add new clean columns)
-- ═══════════════════════════════════════════════════

-- Add clean column names to dating table if missing
ALTER TABLE sailor_dating_profiles ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE sailor_dating_profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE sailor_dating_profiles ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT '{}';
ALTER TABLE sailor_dating_profiles ADD COLUMN IF NOT EXISTS sailing_experience TEXT;
ALTER TABLE sailor_dating_profiles ADD COLUMN IF NOT EXISTS sailing_region TEXT;

-- Copy data from legacy columns to new columns (if legacy columns exist)
DO $$
BEGIN
    -- Only run if old column names exist
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'sailor_dating_profiles' AND column_name = 'dating_first_name') THEN
        UPDATE sailor_dating_profiles SET first_name = COALESCE(first_name, dating_first_name);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'sailor_dating_profiles' AND column_name = 'bio_dating') THEN
        UPDATE sailor_dating_profiles SET bio = COALESCE(bio, bio_dating);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'sailor_dating_profiles' AND column_name = 'dating_photos') THEN
        UPDATE sailor_dating_profiles SET photos = COALESCE(photos, dating_photos, '{}');
    END IF;
END $$;
