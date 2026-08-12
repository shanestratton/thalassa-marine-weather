-- ═══════════════════════════════════════════════════════════════════════
-- The push drain gets the age fence the anchor drain always had
-- ═══════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-13 by an audit of what fires the moment pg_net is enabled.
--
-- Whoever wrote these two drains fenced one and not the other:
--
--   retry_pending_anchor_alarms  ...  AND created_at > now() - interval '1 hour'
--   retry_pending_push_notifications  ...  (no such clause)
--
-- The anchor path is fenced TWICE — once in the drain and again inside
-- claim_anchor_alarm_event, so the bound is re-applied in the claiming
-- transaction and a slow edge function cannot smuggle a stale row through.
-- The push path has neither. Its only guards are `sent_at IS NULL`,
-- `delivery_attempts < 5` and a 5-minute processing_at staleness check.
--
-- Why that matters right now: pg_net was never installed on this project,
-- so net.http_post has failed for months and push_notification_queue has
-- been accumulating undelivered rows the whole time. retry-pending-push
-- runs EVERY MINUTE and drains 50 rows a tick, oldest first — 3,000/hour.
-- send-push stamps a fresh apns-expiration at send time, so APNs will not
-- discard them as old either. The instant pg_net resolves, the entire
-- backlog starts landing on real phones, and the types 'drag_warning',
-- 'geofence_alert', 'sos', 'bolo_alert', 'suspicious_alert' and
-- 'severe_weather_alert' are emitted as APNs CRITICAL ALERTS — they pierce
-- silent mode and Do Not Disturb.
--
-- A months-old "your boat is dragging" alert at full volume, on a phone in
-- a pocket, is worse than no alert at all: it teaches the skipper that the
-- alarm lies. One hour mirrors the anchor drain and is the right bound for
-- a marine app — nothing here is still true three hours later.
--
-- APPLYING THIS BEFORE ENABLING pg_net makes the backlog a non-event.
-- The fence is structural, so no manual retirement of queued rows is
-- needed; anything older than the window simply never becomes eligible.
--
-- KNOWN TRADE-OFF, accepted knowingly: fenced-out rows are abandoned
-- silently. There is no dead-letter path and nobody is told those
-- notifications went undelivered. That is already true of anchor alarms
-- today; making the two consistent is the point. A dead-letter table is
-- worth having and is deliberately NOT smuggled into this migration.

-- ── The drain: only reach for work that is still true ──────────────────
CREATE OR REPLACE FUNCTION public.retry_pending_push_notifications()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    supabase_url TEXT;
    service_key TEXT;
    queued RECORD;
BEGIN
    SELECT decrypted_secret INTO supabase_url
    FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF supabase_url IS NULL THEN
        supabase_url := current_setting('app.settings.supabase_url', true);
    END IF;
    IF service_key IS NULL THEN
        service_key := current_setting('app.settings.service_role_key', true);
    END IF;
    IF supabase_url IS NULL OR service_key IS NULL THEN RETURN; END IF;

    FOR queued IN
        SELECT id FROM public.push_notification_queue
        WHERE sent_at IS NULL
          -- THE FENCE. Mirrors retry_pending_anchor_alarms.
          AND created_at > now() - interval '1 hour'
          AND delivery_attempts < 5
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        ORDER BY created_at
        LIMIT 50
    LOOP
        PERFORM net.http_post(
            -- rtrim: a supabase_url stored with a trailing slash otherwise
            -- builds '//functions/v1/send-push'.
            url := rtrim(supabase_url, '/') || '/functions/v1/send-push',
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || service_key,
                'Content-Type', 'application/json'
            ),
            body := jsonb_build_object('record', jsonb_build_object('id', queued.id))
        );
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_pending_push_notifications() FROM PUBLIC, anon, authenticated;

-- ── The claim: re-apply the bound inside the claiming transaction ──────
-- Fencing only the drain would leave the window open: send-push is invoked
-- asynchronously, and a row selected while fresh could be claimed long
-- after it went stale. claim_anchor_alarm_event already re-checks for this
-- reason; this brings the push claim into line.
CREATE OR REPLACE FUNCTION public.claim_push_notification(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE claimed JSONB;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;
    WITH claimed_row AS (
        UPDATE public.push_notification_queue
        SET processing_at = now(),
            delivery_attempts = delivery_attempts + 1,
            last_error = NULL
        WHERE id = p_id
          AND sent_at IS NULL
          AND created_at > now() - interval '1 hour'
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        RETURNING *
    )
    SELECT to_jsonb(claimed_row) INTO claimed FROM claimed_row;
    RETURN claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_push_notification(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_notification(UUID) TO service_role;
