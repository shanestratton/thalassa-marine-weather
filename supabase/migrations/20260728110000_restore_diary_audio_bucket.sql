-- Restore the missing `diary-audio` storage bucket.
--
-- DiaryService uploads voice memos to AUDIO_BUCKET = 'diary-audio'
-- (services/DiaryService.ts:124), but that bucket does not exist in the
-- project: the live bucket list is chat-avatars, gebco-tiles, nav-graphs,
-- regions, enc-cells, assets, weather, crew-list-photos, vessel_vault,
-- diary-photos, marketplace-images. Any diary entry carrying a voice memo
-- therefore fails its upload and is parked in the pending queue forever —
-- the same shape as the diary-relay outage, and equally silent.
--
-- 20260223_diary.sql DOES create it, and that migration is recorded as
-- applied, so the row was removed afterwards (or its INSERT was a no-op
-- against a pre-existing row that has since been deleted). Recreating it
-- from a migration rather than the dashboard keeps the bucket in source
-- control, so a future project rebuild does not lose it again.
--
-- PRIVATE, deliberately. 20260223 created both diary buckets public and
-- 20260723092000_private_diary_media.sql then flipped them to `public =
-- false`; diary media is served through signed URLs
-- (DiaryService.createSignedUrl). Creating it private here means there is no
-- window, however brief, where a voice memo is world-readable.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'diary-audio',
    'diary-audio',
    false,
    20971520, -- 20 MB per recording, matching the original definition
    ARRAY['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']::text[]
)
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- The owner-scoped policies were created by 20260223_diary.sql and hardened by
-- 20260723092000_private_diary_media.sql, and policies live on storage.objects
-- rather than on the bucket row — so deleting the bucket left them in place.
-- Recreate ONLY what is genuinely absent: Postgres has no
-- CREATE POLICY IF NOT EXISTS, and unconditionally dropping live storage
-- policies to re-add them would open a real (if short) window on every deploy.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'Users can upload diary audio'
    ) THEN
        EXECUTE $policy$
            CREATE POLICY "Users can upload diary audio"
                ON storage.objects FOR INSERT
                WITH CHECK (
                    bucket_id = 'diary-audio'
                    AND auth.uid()::text = (storage.foldername(name))[1]
                )
        $policy$;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'Owners read diary audio'
    ) THEN
        EXECUTE $policy$
            CREATE POLICY "Owners read diary audio"
                ON storage.objects FOR SELECT
                USING (
                    bucket_id = 'diary-audio'
                    AND auth.uid()::text = (storage.foldername(name))[1]
                )
        $policy$;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'Users can delete own diary audio'
    ) THEN
        EXECUTE $policy$
            CREATE POLICY "Users can delete own diary audio"
                ON storage.objects FOR DELETE
                USING (
                    bucket_id = 'diary-audio'
                    AND auth.uid()::text = (storage.foldername(name))[1]
                )
        $policy$;
    END IF;
END;
$$;
