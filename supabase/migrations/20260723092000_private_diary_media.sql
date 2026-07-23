-- Diary media contains personal photos and voice notes. Keep both buckets
-- private and issue short-lived signed URLs only after owner authorization.

UPDATE storage.buckets SET public = false WHERE id IN ('diary-photos', 'diary-audio');

DROP POLICY IF EXISTS "Public read diary photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read diary audio" ON storage.objects;

CREATE POLICY "Users can read own diary photos"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'diary-photos'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Users can read own diary audio"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'diary-audio'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );
