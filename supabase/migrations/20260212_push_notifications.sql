-- ============================================================
-- Push Notifications — General Infrastructure Migration
-- ============================================================
-- Run this SQL in your Supabase SQL Editor
-- ============================================================

-- 1. User-scoped device tokens for push notifications
CREATE TABLE IF NOT EXISTS push_device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'ios',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, device_token)
);

-- 2. Push notification queue — Edge Function reads and sends
CREATE TABLE IF NOT EXISTS push_notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,  -- 'dm', 'sos', 'anchor_alarm', 'pin_drop', 'weather_alert'
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}',          -- Extra payload (channel_id, message_id, etc.)
    sent_at TIMESTAMPTZ,              -- NULL = pending, set by Edge Function after delivery
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_queue_pending ON push_notification_queue(recipient_user_id) WHERE sent_at IS NULL;

-- Enable RLS
ALTER TABLE push_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_notification_queue ENABLE ROW LEVEL SECURITY;

-- RLS: Users can manage their own tokens
CREATE POLICY "Users manage own tokens"
    ON push_device_tokens FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- RLS: Any authenticated user can insert notifications (for DMs, etc.)
CREATE POLICY "Authenticated insert notifications"
    ON push_notification_queue FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

-- RLS: Users can read their own notifications
CREATE POLICY "Users read own notifications"
    ON push_notification_queue FOR SELECT
    USING (auth.uid() = recipient_user_id);

-- Auto-cleanup: purge sent notifications older than 7 days
-- Set up via Supabase pg_cron:
-- SELECT cron.schedule('cleanup-sent-push', '0 3 * * *', $$
--     DELETE FROM push_notification_queue WHERE sent_at IS NOT NULL AND created_at < now() - interval '7 days';
-- $$);
