-- Fix storage bucket RLS policies
-- The chat-avatars bucket needs to allow uploads to crew/ subfolder too
-- Run this in Supabase SQL Editor

-- Drop existing storage policies and recreate with crew/ path support
DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view avatars" ON storage.objects;

-- Allow authenticated users to upload to their own folder
-- Supports: {user_id}/*, dating/{user_id}/*, crew/{user_id}/*
CREATE POLICY "Users can upload own avatar"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR ((storage.foldername(name))[1] = 'dating' AND (storage.foldername(name))[2] = auth.uid()::text)
            OR ((storage.foldername(name))[1] = 'crew' AND (storage.foldername(name))[2] = auth.uid()::text)
        )
    );

-- Allow users to update/overwrite their own files
CREATE POLICY "Users can update own avatar"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR ((storage.foldername(name))[1] = 'dating' AND (storage.foldername(name))[2] = auth.uid()::text)
            OR ((storage.foldername(name))[1] = 'crew' AND (storage.foldername(name))[2] = auth.uid()::text)
        )
    );

-- Allow users to delete their own files
CREATE POLICY "Users can delete own avatar"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR ((storage.foldername(name))[1] = 'dating' AND (storage.foldername(name))[2] = auth.uid()::text)
            OR ((storage.foldername(name))[1] = 'crew' AND (storage.foldername(name))[2] = auth.uid()::text)
        )
    );

-- Public read access (avatars are public)
CREATE POLICY "Anyone can view avatars"
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'chat-avatars');
