-- Chat System tables for Crew Talk
-- Migration: 20260212_chat_tables.sql
-- Required by ChatService.ts, ContentModerationService.ts, ProfilePhotoService.ts

-- ══════════════════════════════════════════
-- 1. CHAT PROFILES (user identity in chat)
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_url TEXT,
    bio TEXT,
    vessel_name TEXT,
    vessel_type TEXT,
    home_port TEXT,
    looking_for_love BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view chat profiles"
    ON chat_profiles FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Users can insert own chat profile"
    ON chat_profiles FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat profile"
    ON chat_profiles FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);


-- ══════════════════════════════════════════
-- 2. CHAT CHANNELS
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_channels (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    region TEXT,
    icon TEXT NOT NULL DEFAULT '🌊',
    is_global BOOLEAN DEFAULT true,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending')),
    proposed_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view active channels"
    ON chat_channels FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated can insert channels"
    ON chat_channels FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Authenticated can update channels"
    ON chat_channels FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Authenticated can delete channels"
    ON chat_channels FOR DELETE
    TO authenticated
    USING (true);


-- ══════════════════════════════════════════
-- 3. CHAT MESSAGES
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT 'Sailor',
    message TEXT NOT NULL,
    is_question BOOLEAN DEFAULT false,
    helpful_count INTEGER DEFAULT 0,
    is_pinned BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view messages"
    ON chat_messages FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated can insert messages"
    ON chat_messages FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authenticated can update messages"
    ON chat_messages FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- RPC for helpful count increment
CREATE OR REPLACE FUNCTION increment_helpful_count(msg_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE chat_messages
    SET helpful_count = helpful_count + 1
    WHERE id = msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ══════════════════════════════════════════
-- 4. DIRECT MESSAGES
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_direct_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL DEFAULT 'Sailor',
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_dm_sender ON chat_direct_messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_dm_recipient ON chat_direct_messages(recipient_id, created_at DESC);

ALTER TABLE chat_direct_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own DMs"
    ON chat_direct_messages FOR SELECT
    TO authenticated
    USING (auth.uid() = sender_id OR auth.uid() = recipient_id);

CREATE POLICY "Users can send DMs"
    ON chat_direct_messages FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Users can mark DMs as read"
    ON chat_direct_messages FOR UPDATE
    TO authenticated
    USING (auth.uid() = recipient_id)
    WITH CHECK (auth.uid() = recipient_id);


-- ══════════════════════════════════════════
-- 5. CHAT ROLES (moderation)
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_roles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
    muted_until TIMESTAMPTZ
);

ALTER TABLE chat_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view roles"
    ON chat_roles FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Roles can be managed"
    ON chat_roles FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);


-- ══════════════════════════════════════════
-- 6. DM BLOCKS
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dm_blocks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(blocker_id, blocked_id)
);

ALTER TABLE dm_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own blocks"
    ON dm_blocks FOR SELECT
    TO authenticated
    USING (auth.uid() = blocker_id);

CREATE POLICY "Users can insert own blocks"
    ON dm_blocks FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "Users can delete own blocks"
    ON dm_blocks FOR DELETE
    TO authenticated
    USING (auth.uid() = blocker_id);


-- ══════════════════════════════════════════
-- 7. CHAT REPORTS (user reports for mod review)
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_reports (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate_speech', 'inappropriate', 'other')),
    details TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert reports"
    ON chat_reports FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = reporter_id);

CREATE POLICY "Admins can view reports"
    ON chat_reports FOR SELECT
    TO authenticated
    USING (true);


-- ══════════════════════════════════════════
-- 8. MODERATION LOG (AI moderation audit trail)
-- ══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chat_moderation_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    message_id UUID NOT NULL,
    user_id UUID NOT NULL,
    channel_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    reason TEXT,
    category TEXT,
    confidence DOUBLE PRECISION DEFAULT 0,
    processing_time_ms INTEGER DEFAULT 0,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chat_moderation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can insert moderation logs"
    ON chat_moderation_log FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Admins can view moderation logs"
    ON chat_moderation_log FOR SELECT
    TO authenticated
    USING (true);


-- ══════════════════════════════════════════
-- 9. SEED DEFAULT CHANNELS
-- ══════════════════════════════════════════
INSERT INTO chat_channels (name, description, icon, is_global, status) VALUES
    ('Lonely Hearts', 'For sailors seeking sailors ❤️', '💕', true, 'active'),
    ('Find Crew', 'Looking for crew or a berth? Connect here', '🧭', true, 'active'),
    ('General', 'Open chat for all sailors', '🌊', true, 'active'),
    ('Anchorages', 'Share and discover anchorage spots', '⚓', true, 'active'),
    ('Repairs & Gear', 'Maintenance tips, gear reviews, workshop recs', '🔧', true, 'active'),
    ('Fishing', 'Catches, spots, and techniques', '🐟', true, 'active'),
    ('Weather Talk', 'Conditions, forecasts, and sea state discussion', '🌤', true, 'active')
ON CONFLICT DO NOTHING;


-- ══════════════════════════════════════════
-- 10. ENABLE REALTIME for channels + messages + DMs
-- ══════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_direct_messages;


-- ══════════════════════════════════════════
-- 11. STORAGE BUCKET for profile avatars
-- ══════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'chat-avatars',
    'chat-avatars',
    true,
    2097152,  -- 2MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to their own folder (direct or dating/ subfolder)
CREATE POLICY "Users can upload own avatar"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'chat-avatars'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR ((storage.foldername(name))[1] = 'dating' AND (storage.foldername(name))[2] = auth.uid()::text)
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
        )
    );

-- Public read access (avatars are public)
CREATE POLICY "Anyone can view avatars"
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'chat-avatars');
