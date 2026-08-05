-- Crew List verification photos moved to the private crew-list-photos bucket
-- in 20260727131000. Retire the old public chat-avatars/crew/{user_id}
-- write path while preserving the still-supported chat avatar and dating
-- profile paths. The public read policy is intentionally left untouched:
-- current chat avatars remain public product content.

DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;

CREATE POLICY "Users can upload own avatar"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR (
                (storage.foldername(name))[1] = 'dating'
                AND (storage.foldername(name))[2] = auth.uid()::TEXT
            )
        )
    );

CREATE POLICY "Users can update own avatar"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR (
                (storage.foldername(name))[1] = 'dating'
                AND (storage.foldername(name))[2] = auth.uid()::TEXT
            )
        )
    )
    WITH CHECK (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR (
                (storage.foldername(name))[1] = 'dating'
                AND (storage.foldername(name))[2] = auth.uid()::TEXT
            )
        )
    );

CREATE POLICY "Users can delete own avatar"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::TEXT
            OR (
                (storage.foldername(name))[1] = 'dating'
                AND (storage.foldername(name))[2] = auth.uid()::TEXT
            )
        )
    );
