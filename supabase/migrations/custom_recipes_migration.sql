-- ========================
-- Custom Recipes Migration
-- ========================
-- Allows users to create, store, and share custom recipes.
-- Shared recipes are visible to all authenticated users.
-- Personal recipes are visible only to the owner.
--
-- IDEMPOTENT: Safe to run multiple times.

-- Step 1: Drop the old table if it exists without the visibility column
-- (handles partial previous runs)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'recipes'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'recipes' AND column_name = 'visibility'
    ) THEN
        -- Old table exists without visibility — drop it and recreate
        DROP TABLE public.recipes CASCADE;
    END IF;
END $$;

-- Step 2: Create the table (only if it doesn't exist)
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

-- Step 3: Indexes
CREATE INDEX IF NOT EXISTS idx_recipes_user_id ON public.recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_visibility ON public.recipes(visibility);

-- Step 4: Row Level Security
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

-- Step 5: Drop existing policies (idempotent re-run safety)
DROP POLICY IF EXISTS "recipes_select" ON public.recipes;
DROP POLICY IF EXISTS "recipes_insert" ON public.recipes;
DROP POLICY IF EXISTS "recipes_update" ON public.recipes;
DROP POLICY IF EXISTS "recipes_delete" ON public.recipes;

-- Step 6: Create policies
CREATE POLICY "recipes_select"
    ON public.recipes FOR SELECT
    USING (visibility = 'shared' OR auth.uid() = user_id);

CREATE POLICY "recipes_insert"
    ON public.recipes FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "recipes_update"
    ON public.recipes FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "recipes_delete"
    ON public.recipes FOR DELETE
    USING (auth.uid() = user_id);
