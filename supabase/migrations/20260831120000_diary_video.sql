-- Diary video clips — one short clip per entry.
--
-- Sized for reality: a minute of 4K HEVC off an iPhone is ~200MB, H.264 ~350MB.
-- The bucket cap is 500MB so a single legitimate clip always fits and anything
-- bigger is refused at the door rather than half-uploaded over a boat uplink.
-- NOTE: the PROJECT-wide upload limit (Dashboard → Storage → Settings) must be
-- at least this large or the bucket cap never comes into play.

ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS video_url TEXT;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'diary-video',
    'diary-video',
    true,                              -- public read, same policy as diary-photos
    524288000,                         -- 500MB
    ARRAY['video/mp4', 'video/quicktime']::text[]
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload diary video"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'diary-video'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Public read diary video"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'diary-video');

CREATE POLICY "Users can delete own diary video"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'diary-video'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );
