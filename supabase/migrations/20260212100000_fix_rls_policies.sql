-- Fix RLS policies on BOTH tables
-- Run this in Supabase SQL Editor

-- ═══════════════════════════════════════════════════
-- 1. SAILOR_DATING_PROFILES — ensure all policies exist
-- ═══════════════════════════════════════════════════

ALTER TABLE sailor_dating_profiles ENABLE ROW LEVEL SECURITY;

-- Drop and recreate all policies to be safe
DROP POLICY IF EXISTS "Anyone can view dating profiles" ON sailor_dating_profiles;
DROP POLICY IF EXISTS "Users can insert own dating profile" ON sailor_dating_profiles;
DROP POLICY IF EXISTS "Users can update own dating profile" ON sailor_dating_profiles;
DROP POLICY IF EXISTS "Users can delete own dating profile" ON sailor_dating_profiles;

CREATE POLICY "Anyone can view dating profiles"
    ON sailor_dating_profiles FOR SELECT
    TO authenticated
    USING (true);

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

-- ═══════════════════════════════════════════════════
-- 2. SAILOR_CREW_PROFILES — ensure all policies exist
-- ═══════════════════════════════════════════════════

ALTER TABLE sailor_crew_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view crew profiles" ON sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can insert own crew profile" ON sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can update own crew profile" ON sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can delete own crew profile" ON sailor_crew_profiles;

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

-- ═══════════════════════════════════════════════════
-- 3. SAILOR_LIKES — ensure policies exist too
-- ═══════════════════════════════════════════════════

ALTER TABLE sailor_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own likes" ON sailor_likes;
DROP POLICY IF EXISTS "Users can insert own likes" ON sailor_likes;
DROP POLICY IF EXISTS "Users can update own likes" ON sailor_likes;

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
