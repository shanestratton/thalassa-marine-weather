-- Diary VIDEO was public. Photos and audio were not.
--
-- 20260723092000_private_diary_media.sql closed diary-photos and diary-audio
-- and switched them to short-lived signed URLs. Five weeks later
-- 20260831120000_diary_video.sql created diary-video with `public = true` and
-- a blanket read policy, carrying the comment "public read, same policy as
-- diary-photos" — a comment that had been false since July. The privacy fix
-- was silently reverted for the newest and most personal medium, and a diary
-- entry that was never published still handed out its clip to anyone holding
-- the URL. Unpublishing could not revoke it, because nothing was checking.
--
-- The app never needed the public read: DiaryService.resolveVideoUrl already
-- signs video for playback exactly as it does photos and audio. Only the
-- bucket policy was open.

UPDATE storage.buckets SET public = false WHERE id = 'diary-video';

DROP POLICY IF EXISTS "Public read diary video" ON storage.objects;

CREATE POLICY "Users can read own diary video"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'diary-video'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );
