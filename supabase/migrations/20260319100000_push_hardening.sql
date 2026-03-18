-- ============================================================
-- Push Notification Hardening — Cron Jobs + Badge Management
-- ============================================================

-- 1. Enable the cleanup cron (purge sent notifications older than 7 days)
SELECT cron.schedule(
    'cleanup-sent-push',
    '0 3 * * *',
    $$DELETE FROM push_notification_queue WHERE sent_at IS NOT NULL AND created_at < now() - interval '7 days'$$
);

-- 2. Purge stale device tokens (not updated in 90 days)
SELECT cron.schedule(
    'cleanup-stale-push-tokens',
    '0 4 * * 0',  -- Weekly on Sunday at 4 AM
    $$DELETE FROM push_device_tokens WHERE updated_at < now() - interval '90 days'$$
);

-- 3. RPC: Clear badge count (called by client when app enters foreground)
CREATE OR REPLACE FUNCTION public.clear_push_badge()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Mark all pending notifications as "read" for this user
    UPDATE push_notification_queue
    SET sent_at = COALESCE(sent_at, NOW())
    WHERE recipient_user_id = auth.uid()
      AND sent_at IS NULL;
END;
$$;

-- 4. RPC: Get unread notification count (for badge display in-app)
CREATE OR REPLACE FUNCTION public.get_push_badge_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COALESCE(COUNT(*)::integer, 0)
    FROM push_notification_queue
    WHERE recipient_user_id = auth.uid()
      AND sent_at IS NOT NULL
      AND created_at > NOW() - INTERVAL '24 hours';
$$;
