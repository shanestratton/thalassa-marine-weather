-- ============================================================
-- Thalassa: recipe_ratings table migration
-- A junction table for community recipe ratings
-- Run this in Supabase SQL Editor AFTER the community_recipes migration
-- ============================================================

-- Add average rating column to community_recipes
ALTER TABLE public.community_recipes
    ADD COLUMN IF NOT EXISTS rating_avg FLOAT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rating_count INT DEFAULT 0;

-- Ratings junction table
CREATE TABLE IF NOT EXISTS public.recipe_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID REFERENCES public.community_recipes(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    created_at TIMESTAMPTZ DEFAULT now(),
    -- Each user can rate a recipe only once
    UNIQUE(recipe_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recipe_ratings_recipe ON public.recipe_ratings(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ratings_user ON public.recipe_ratings(user_id);

-- RLS
ALTER TABLE public.recipe_ratings ENABLE ROW LEVEL SECURITY;

-- Anyone can read ratings
CREATE POLICY "Anyone reads ratings" ON public.recipe_ratings
    FOR SELECT USING (true);

-- Authenticated users can insert their own ratings
CREATE POLICY "Users insert own ratings" ON public.recipe_ratings
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own ratings
CREATE POLICY "Users update own ratings" ON public.recipe_ratings
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own ratings
CREATE POLICY "Users delete own ratings" ON public.recipe_ratings
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- Function: update_recipe_rating_avg
-- Automatically recalculates rating_avg and rating_count
-- when ratings are inserted/updated/deleted
-- ============================================================
CREATE OR REPLACE FUNCTION update_recipe_rating_avg()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.community_recipes
    SET
        rating_avg = COALESCE((
            SELECT AVG(rating)::FLOAT
            FROM public.recipe_ratings
            WHERE recipe_id = COALESCE(NEW.recipe_id, OLD.recipe_id)
        ), 0),
        rating_count = COALESCE((
            SELECT COUNT(*)::INT
            FROM public.recipe_ratings
            WHERE recipe_id = COALESCE(NEW.recipe_id, OLD.recipe_id)
        ), 0)
    WHERE id = COALESCE(NEW.recipe_id, OLD.recipe_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recipe_rating_update
    AFTER INSERT OR UPDATE OR DELETE ON public.recipe_ratings
    FOR EACH ROW EXECUTE FUNCTION update_recipe_rating_avg();
