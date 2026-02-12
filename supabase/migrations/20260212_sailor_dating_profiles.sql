-- Sailor Dating/Crew Profiles table
-- Migration: 20260212_sailor_dating_profiles.sql
-- Required by LonelyHeartsService.ts (Find Crew + Lonely Hearts)

CREATE TABLE IF NOT EXISTS sailor_dating_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Listing mode
    listing_type TEXT CHECK (listing_type IN ('seeking_crew', 'seeking_berth')),
    -- Personal
    dating_first_name TEXT,
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
    bio_crew TEXT,
    -- Photo (single crew photo, stored as array for compat)
    dating_photos TEXT[] DEFAULT '{}',
    -- Legacy dating fields
    bio_dating TEXT,
    interests TEXT[] DEFAULT '{}',
    seeking TEXT,
    location_text TEXT,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sailor_dating_profiles_listing_type ON sailor_dating_profiles(listing_type);

-- RLS Policies
ALTER TABLE sailor_dating_profiles ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can browse profiles
CREATE POLICY "Anyone can view dating profiles"
    ON sailor_dating_profiles FOR SELECT
    TO authenticated
    USING (true);

-- Users can create/update their own profile
CREATE POLICY "Users can insert own dating profile"
    ON sailor_dating_profiles FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own dating profile"
    ON sailor_dating_profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own dating profile"
    ON sailor_dating_profiles FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- Also create the sailor_likes table if it doesn't exist
CREATE TABLE IF NOT EXISTS sailor_likes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    liker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    liked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    is_like BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(liker_id, liked_id)
);

-- RLS for likes
ALTER TABLE sailor_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own likes"
    ON sailor_likes FOR SELECT
    TO authenticated
    USING (auth.uid() = liker_id OR auth.uid() = liked_id);

CREATE POLICY "Users can insert own likes"
    ON sailor_likes FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = liker_id);

CREATE POLICY "Users can update own likes"
    ON sailor_likes FOR UPDATE
    TO authenticated
    USING (auth.uid() = liker_id)
    WITH CHECK (auth.uid() = liker_id);
