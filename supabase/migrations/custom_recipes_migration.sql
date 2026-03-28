-- ========================
-- Custom Recipes Migration
-- ========================
-- Allows users to create, store, and share custom recipes.
-- Shared recipes are visible to all authenticated users.
-- Personal recipes are visible only to the owner.

CREATE TABLE IF NOT EXISTS public.recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT DEFAULT '',
    image_url TEXT,
    ready_in_minutes INT DEFAULT 30,
    servings INT DEFAULT 4,
    ingredients JSONB DEFAULT '[]'::jsonb,
    tags TEXT[] DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'personal'
        CHECK (visibility IN ('personal', 'shared')),
    is_favorite BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recipes_user_id ON public.recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_visibility ON public.recipes(visibility);

-- Row Level Security
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

-- Users can read shared recipes + their own personal recipes
CREATE POLICY "recipes_select"
    ON public.recipes FOR SELECT
    USING (visibility = 'shared' OR auth.uid() = user_id);

-- Users can only insert their own recipes
CREATE POLICY "recipes_insert"
    ON public.recipes FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can only update their own recipes
CREATE POLICY "recipes_update"
    ON public.recipes FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can only delete their own recipes
CREATE POLICY "recipes_delete"
    ON public.recipes FOR DELETE
    USING (auth.uid() = user_id);
