-- ═══════════════════════════════════════════════════════════════
-- Captain's Diary — Supabase Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Create diary_entries table ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.diary_entries (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    mood            TEXT NOT NULL DEFAULT 'neutral'
                        CHECK (mood IN ('epic', 'good', 'neutral', 'rough', 'storm')),
    photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
    audio_url       TEXT,                              -- Voice memo URL
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    location_name   TEXT NOT NULL DEFAULT '',
    weather_summary TEXT NOT NULL DEFAULT '',
    voyage_id       TEXT,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_diary_user_created
    ON public.diary_entries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diary_voyage
    ON public.diary_entries (voyage_id)
    WHERE voyage_id IS NOT NULL;

-- ── 2. Row Level Security ──────────────────────────────────────
-- Users can only see/edit their own entries

ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;

-- SELECT: own entries only
CREATE POLICY "Users can read own diary entries"
    ON public.diary_entries FOR SELECT
    USING (auth.uid() = user_id);

-- INSERT: can only insert as yourself
CREATE POLICY "Users can create own diary entries"
    ON public.diary_entries FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- UPDATE: own entries only
CREATE POLICY "Users can update own diary entries"
    ON public.diary_entries FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- DELETE: own entries only
CREATE POLICY "Users can delete own diary entries"
    ON public.diary_entries FOR DELETE
    USING (auth.uid() = user_id);

-- ── 3. Create diary-photos storage bucket ──────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'diary-photos',
    'diary-photos',
    true,                              -- Public read (photos served via public URL)
    5242880,                           -- 5MB max per photo
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: users can upload to their own folder

-- Upload: users can upload to their own user_id/ folder
CREATE POLICY "Users can upload diary photos"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'diary-photos'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- Read: anyone can read (public bucket for photo display)
CREATE POLICY "Public read diary photos"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'diary-photos');

-- Delete: users can delete their own photos
CREATE POLICY "Users can delete own diary photos"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'diary-photos'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- ── 4. Auto-update updated_at trigger ──────────────────────────

CREATE OR REPLACE FUNCTION public.diary_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diary_entries_updated_at
    BEFORE UPDATE ON public.diary_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.diary_updated_at();

-- ── 5. Create diary-audio storage bucket ───────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'diary-audio',
    'diary-audio',
    true,
    20971520,                          -- 20MB max per recording
    ARRAY['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']::text[]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload diary audio"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'diary-audio'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Public read diary audio"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'diary-audio');

CREATE POLICY "Users can delete own diary audio"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'diary-audio'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- ═══════════════════════════════════════════════════════════════
-- Done! The diary is ready to use.
-- ═══════════════════════════════════════════════════════════════
