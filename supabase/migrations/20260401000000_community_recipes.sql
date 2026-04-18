-- ============================================================
-- Thalassa: community_recipes table migration
-- Run this in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.community_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    image_url TEXT,
    ready_in_minutes INT DEFAULT 30,
    servings INT DEFAULT 1,           -- Always stored as per-person
    ingredients JSONB DEFAULT '[]',   -- RecipeIngredient[]
    instructions JSONB DEFAULT '[]',  -- RecipeStep[]
    visibility TEXT NOT NULL DEFAULT 'private' 
        CHECK (visibility IN ('private', 'community')),
    tags TEXT[] DEFAULT '{}',
    author_name TEXT,
    like_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_community_recipes_user ON public.community_recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_community_recipes_visibility ON public.community_recipes(visibility);
CREATE INDEX IF NOT EXISTS idx_community_recipes_title ON public.community_recipes USING GIN (to_tsvector('english', title));

-- RLS
ALTER TABLE public.community_recipes ENABLE ROW LEVEL SECURITY;

-- Users can read their own recipes (private or community)
CREATE POLICY "Users read own recipes" ON public.community_recipes
    FOR SELECT USING (auth.uid() = user_id);

-- Anyone can read community recipes
CREATE POLICY "Anyone reads community recipes" ON public.community_recipes
    FOR SELECT USING (visibility = 'community');

-- Users can insert their own recipes
CREATE POLICY "Users insert own recipes" ON public.community_recipes
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own recipes
CREATE POLICY "Users update own recipes" ON public.community_recipes
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own recipes
CREATE POLICY "Users delete own recipes" ON public.community_recipes
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- Storage bucket: recipe-photos
-- Create via Supabase Dashboard: Storage → New Bucket
--   Name: recipe-photos
--   Public: ON
--   File size limit: 5MB
--   Allowed MIME types: image/jpeg, image/png, image/webp
-- ============================================================
