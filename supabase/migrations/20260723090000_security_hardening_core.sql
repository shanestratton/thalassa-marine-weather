-- First security hardening sweep.
-- Closes permissive chat/push/Guardian/Anchor Watch policies while keeping
-- client capabilities behind narrowly-scoped, server-validated RPCs.

-- ─────────────────────────────────────────────────────────────────────────────
-- Chat schema drift + authorization
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.chat_channels
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.chat_channels(id) ON DELETE SET NULL;

ALTER TABLE public.chat_roles
    ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.channel_members (
    channel_id UUID NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.channel_join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_join_requests_one_pending
    ON public.channel_join_requests(channel_id, user_id)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    target_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_message_helpful (
    message_id UUID NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_helpful ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_chat_moderator(check_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.chat_roles
        WHERE user_id = check_user
          AND role IN ('admin', 'moderator')
          AND NOT COALESCE(is_blocked, false)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_chat_admin(check_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.chat_roles
        WHERE user_id = check_user
          AND role = 'admin'
          AND NOT COALESCE(is_blocked, false)
    );
$$;

CREATE OR REPLACE FUNCTION public.can_access_chat_channel(
    check_channel UUID,
    check_user UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.chat_channels c
        WHERE c.id = check_channel
          AND (
              NOT COALESCE(c.is_private, false)
              OR c.owner_id = check_user
              OR EXISTS (
                  SELECT 1 FROM public.channel_members cm
                  WHERE cm.channel_id = c.id AND cm.user_id = check_user
              )
              OR public.is_chat_moderator(check_user)
          )
    );
$$;

REVOKE ALL ON FUNCTION public.is_chat_moderator(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_chat_admin(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_chat_channel(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_chat_moderator(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_chat_admin(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_chat_channel(UUID, UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS "Anyone can view active channels" ON public.chat_channels;
DROP POLICY IF EXISTS "Authenticated can insert channels" ON public.chat_channels;
DROP POLICY IF EXISTS "Authenticated can update channels" ON public.chat_channels;
DROP POLICY IF EXISTS "Authenticated can delete channels" ON public.chat_channels;

CREATE POLICY "chat_channels_visible" ON public.chat_channels FOR SELECT TO authenticated
USING (
    (status = 'active' AND public.can_access_chat_channel(id, auth.uid()))
    OR proposed_by = auth.uid()
    OR public.is_chat_moderator(auth.uid())
);

CREATE POLICY "chat_channels_create" ON public.chat_channels FOR INSERT TO authenticated
WITH CHECK (
    public.is_chat_moderator(auth.uid())
    OR (owner_id = auth.uid() AND COALESCE(is_private, false) AND status = 'active')
    OR (proposed_by = auth.uid() AND status = 'pending')
);

CREATE POLICY "chat_channels_manage" ON public.chat_channels FOR UPDATE TO authenticated
USING (
    public.is_chat_moderator(auth.uid())
    OR (owner_id = auth.uid() AND COALESCE(is_private, false) AND status = 'active')
)
WITH CHECK (
    public.is_chat_moderator(auth.uid())
    OR (owner_id = auth.uid() AND COALESCE(is_private, false) AND status = 'active')
);

CREATE POLICY "chat_channels_delete" ON public.chat_channels FOR DELETE TO authenticated
USING (owner_id = auth.uid() OR public.is_chat_moderator(auth.uid()));

DROP POLICY IF EXISTS "Anyone can view messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Authenticated can insert messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Authenticated can update messages" ON public.chat_messages;

CREATE POLICY "chat_messages_visible" ON public.chat_messages FOR SELECT TO authenticated
USING (public.can_access_chat_channel(channel_id, auth.uid()));

CREATE POLICY "chat_messages_create" ON public.chat_messages FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND public.can_access_chat_channel(channel_id, auth.uid())
    AND NOT EXISTS (
        SELECT 1 FROM public.chat_roles r
        WHERE r.user_id = auth.uid()
          AND (COALESCE(r.is_blocked, false) OR r.muted_until > now())
    )
);

CREATE POLICY "chat_messages_manage" ON public.chat_messages FOR UPDATE TO authenticated
USING (user_id = auth.uid() OR public.is_chat_moderator(auth.uid()))
WITH CHECK (user_id = auth.uid() OR public.is_chat_moderator(auth.uid()));

CREATE OR REPLACE FUNCTION public.protect_chat_message_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.display_name IS DISTINCT FROM OLD.display_name
       OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.is_question IS DISTINCT FROM OLD.is_question
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Message identity and content are immutable';
    END IF;

    IF NEW.helpful_count IS DISTINCT FROM OLD.helpful_count THEN
        IF NEW.helpful_count = OLD.helpful_count + 1
           AND NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned
           AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
           AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Invalid helpful-count update';
    END IF;

    IF public.is_chat_moderator(auth.uid()) THEN RETURN NEW; END IF;
    IF OLD.user_id = auth.uid()
       AND OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NOT NULL
       AND NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only moderators may change message state';
END;
$$;
DROP TRIGGER IF EXISTS protect_chat_message_update ON public.chat_messages;
CREATE TRIGGER protect_chat_message_update
BEFORE UPDATE ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION public.protect_chat_message_update();

DROP POLICY IF EXISTS "Roles can be managed" ON public.chat_roles;
CREATE POLICY "chat_roles_bootstrap_self" ON public.chat_roles FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND role = 'member' AND muted_until IS NULL AND NOT is_blocked);
CREATE POLICY "chat_roles_admin_insert" ON public.chat_roles FOR INSERT TO authenticated
WITH CHECK (public.is_chat_admin(auth.uid()));
CREATE POLICY "chat_roles_admin_update" ON public.chat_roles FOR UPDATE TO authenticated
USING (public.is_chat_admin(auth.uid()))
WITH CHECK (public.is_chat_admin(auth.uid()));
CREATE POLICY "chat_roles_admin_delete" ON public.chat_roles FOR DELETE TO authenticated
USING (public.is_chat_admin(auth.uid()));

DROP POLICY IF EXISTS "Users can insert reports" ON public.chat_reports;
DROP POLICY IF EXISTS "Admins can view reports" ON public.chat_reports;
DELETE FROM public.chat_reports newer
USING public.chat_reports older
WHERE newer.message_id = older.message_id
  AND newer.reporter_id = older.reporter_id
  AND (newer.created_at, newer.id) > (older.created_at, older.id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_reports_one_per_user_message
    ON public.chat_reports(message_id, reporter_id);
CREATE POLICY "chat_reports_create" ON public.chat_reports FOR INSERT TO authenticated
WITH CHECK (
    reporter_id = auth.uid()
    AND char_length(COALESCE(details, '')) <= 2000
    AND EXISTS (
        SELECT 1 FROM public.chat_messages m
        WHERE m.id = message_id
          AND public.can_access_chat_channel(m.channel_id, auth.uid())
    )
);
CREATE POLICY "chat_reports_moderator_read" ON public.chat_reports FOR SELECT TO authenticated
USING (public.is_chat_moderator(auth.uid()));

DROP POLICY IF EXISTS "Authenticated can insert moderation logs" ON public.chat_moderation_log;
DROP POLICY IF EXISTS "Admins can view moderation logs" ON public.chat_moderation_log;
CREATE POLICY "chat_moderation_log_own_insert" ON public.chat_moderation_log FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());
CREATE POLICY "chat_moderation_log_moderator_read" ON public.chat_moderation_log FOR SELECT TO authenticated
USING (public.is_chat_moderator(auth.uid()));

CREATE POLICY "channel_members_read" ON public.channel_members FOR SELECT TO authenticated
USING (public.can_access_chat_channel(channel_id, auth.uid()));
CREATE POLICY "channel_members_add" ON public.channel_members FOR INSERT TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);
CREATE POLICY "channel_members_remove" ON public.channel_members FOR DELETE TO authenticated
USING (
    user_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);

CREATE OR REPLACE FUNCTION public.join_accepted_crew_channels(p_owner_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE joined_count INTEGER;
BEGIN
    IF auth.uid() IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.vessel_crew vc
        WHERE vc.owner_id = p_owner_id
          AND vc.crew_user_id = auth.uid()
          AND vc.status = 'accepted'
    ) THEN
        RAISE EXCEPTION 'Accepted crew relationship required';
    END IF;

    WITH inserted AS (
        INSERT INTO public.channel_members(channel_id, user_id)
        SELECT c.id, auth.uid()
        FROM public.chat_channels c
        WHERE c.owner_id = p_owner_id
          AND c.is_private
          AND c.status = 'active'
          AND c.icon = '👥'
        ON CONFLICT DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO joined_count FROM inserted;
    RETURN joined_count;
END;
$$;
REVOKE ALL ON FUNCTION public.join_accepted_crew_channels(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_accepted_crew_channels(UUID) TO authenticated;

CREATE POLICY "join_requests_read" ON public.channel_join_requests FOR SELECT TO authenticated
USING (
    user_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);
CREATE POLICY "join_requests_create" ON public.channel_join_requests FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending'
    AND char_length(message) BETWEEN 0 AND 1000
    AND EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.is_private AND c.status = 'active'
    )
);
CREATE POLICY "join_requests_review" ON public.channel_join_requests FOR UPDATE TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);
CREATE POLICY "join_requests_delete" ON public.channel_join_requests FOR DELETE TO authenticated
USING (user_id = auth.uid() OR public.is_chat_moderator(auth.uid()));

CREATE OR REPLACE FUNCTION public.protect_channel_join_request_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.status <> 'pending'
       OR NEW.status NOT IN ('approved', 'rejected')
       OR NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Only a pending request decision may be updated';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_channel_join_request_update ON public.channel_join_requests;
CREATE TRIGGER protect_channel_join_request_update
BEFORE UPDATE ON public.channel_join_requests
FOR EACH ROW EXECUTE FUNCTION public.protect_channel_join_request_update();

CREATE POLICY "admin_audit_insert" ON public.admin_audit_log FOR INSERT TO authenticated
WITH CHECK (actor_id = auth.uid() AND public.is_chat_moderator(auth.uid()));
CREATE POLICY "admin_audit_read" ON public.admin_audit_log FOR SELECT TO authenticated
USING (public.is_chat_admin(auth.uid()));

-- A DM recipient may only change unread -> read. All message identity/content is immutable.
CREATE OR REPLACE FUNCTION public.protect_direct_message_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.sender_name IS DISTINCT FROM OLD.sender_name
       OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR OLD.read = true
       OR NEW.read IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Only unread messages may be marked as read';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_direct_message_update ON public.chat_direct_messages;
CREATE TRIGGER protect_direct_message_update
BEFORE UPDATE ON public.chat_direct_messages
FOR EACH ROW EXECUTE FUNCTION public.protect_direct_message_update();

DROP POLICY IF EXISTS "Users can send DMs" ON public.chat_direct_messages;
CREATE POLICY "Users can send unblocked DMs" ON public.chat_direct_messages FOR INSERT TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    AND sender_id <> recipient_id
    AND char_length(message) BETWEEN 1 AND 4000
    AND NOT EXISTS (
        SELECT 1 FROM public.dm_blocks b
        WHERE (b.blocker_id = sender_id AND b.blocked_id = recipient_id)
           OR (b.blocker_id = recipient_id AND b.blocked_id = sender_id)
    )
    AND NOT EXISTS (
        SELECT 1 FROM public.chat_roles r
        WHERE r.user_id = auth.uid()
          AND (COALESCE(r.is_blocked, false) OR r.muted_until > now())
    )
);

CREATE OR REPLACE FUNCTION public.increment_helpful_count(msg_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_channel UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT channel_id INTO target_channel
    FROM public.chat_messages
    WHERE id = msg_id AND deleted_at IS NULL AND user_id <> auth.uid();

    IF target_channel IS NULL OR NOT public.can_access_chat_channel(target_channel, auth.uid()) THEN
        RAISE EXCEPTION 'Message is not accessible';
    END IF;

    INSERT INTO public.chat_message_helpful(message_id, user_id)
    VALUES (msg_id, auth.uid())
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
        UPDATE public.chat_messages
        SET helpful_count = helpful_count + 1
        WHERE id = msg_id;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.increment_helpful_count(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_helpful_count(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Push queue: clients can request only notifications proven by server-side data
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated insert notifications" ON public.push_notification_queue;

ALTER TABLE public.push_notification_queue
    ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Claim a pending row atomically so duplicate webhooks cannot double-send it.
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
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        RETURNING *
    )
    SELECT to_jsonb(claimed_row) INTO claimed FROM claimed_row;
    RETURN claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_push_notification(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_notification(UUID) TO service_role;

-- Delivery and read state are separate: clearing an app badge must never
-- cancel a notification that has not reached APNs yet.
CREATE OR REPLACE FUNCTION public.clear_push_badge()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.push_notification_queue
    SET read_at = now()
    WHERE recipient_user_id = auth.uid()
      AND sent_at IS NOT NULL
      AND read_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_push_badge_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(count(*)::integer, 0)
    FROM public.push_notification_queue
    WHERE recipient_user_id = auth.uid()
      AND sent_at IS NOT NULL
      AND read_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.clear_push_badge() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_push_badge_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_push_badge() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_push_badge_count() TO authenticated;

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
          AND delivery_attempts < 5
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        ORDER BY created_at
        LIMIT 50
    LOOP
        PERFORM net.http_post(
            url := supabase_url || '/functions/v1/send-push',
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

DO $$
DECLARE existing_job BIGINT;
BEGIN
    SELECT jobid INTO existing_job FROM cron.job WHERE jobname = 'retry-pending-push' LIMIT 1;
    IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;
END;
$$;
SELECT cron.schedule('retry-pending-push', '* * * * *', 'SELECT public.retry_pending_push_notifications()');

CREATE OR REPLACE FUNCTION public.queue_self_push(
    p_notification_type TEXT,
    p_title TEXT,
    p_body TEXT,
    p_data JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE queued_id UUID;
BEGIN
    IF auth.uid() IS NULL OR p_notification_type <> 'weather_alert' THEN
        RAISE EXCEPTION 'Unsupported notification request';
    END IF;
    IF char_length(p_title) NOT BETWEEN 1 AND 120 OR char_length(p_body) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Invalid notification content';
    END IF;
    IF (SELECT count(*) FROM public.push_notification_queue
        WHERE recipient_user_id = auth.uid()
          AND notification_type = 'weather_alert'
          AND created_at > now() - interval '1 hour') >= 10 THEN
        RAISE EXCEPTION 'Notification rate limit exceeded';
    END IF;

    INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
    VALUES (auth.uid(), p_notification_type, p_title, p_body, COALESCE(p_data, '{}'::jsonb))
    RETURNING id INTO queued_id;
    RETURN queued_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_dm_push(p_message_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE dm public.chat_direct_messages%ROWTYPE;
DECLARE queued_id UUID;
DECLARE push_type TEXT;
BEGIN
    SELECT * INTO dm FROM public.chat_direct_messages
    WHERE id = p_message_id AND sender_id = auth.uid()
      AND created_at > now() - interval '5 minutes';
    IF NOT FOUND THEN RAISE EXCEPTION 'Message not eligible for push'; END IF;

    push_type := CASE WHEN dm.message LIKE '🏴‍☠️ %' THEN 'hail' ELSE 'dm' END;
    INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
    VALUES (
        dm.recipient_id,
        push_type,
        CASE WHEN push_type = 'hail' THEN '🏴‍☠️ Hail from ' || left(dm.sender_name, 60)
             ELSE '💬 ' || left(dm.sender_name, 60) END,
        left(dm.message, 100),
        jsonb_build_object('sender_id', dm.sender_id, 'message_id', dm.id)
    ) RETURNING id INTO queued_id;
    RETURN queued_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_sos_push(p_message_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE msg public.chat_messages%ROWTYPE;
DECLARE queued_count INTEGER;
BEGIN
    SELECT * INTO msg FROM public.chat_messages
    WHERE id = p_message_id AND user_id = auth.uid() AND is_question
      AND created_at > now() - interval '5 minutes';
    IF NOT FOUND OR NOT public.can_access_chat_channel(msg.channel_id, auth.uid()) THEN
        RAISE EXCEPTION 'SOS message not eligible for push';
    END IF;

    WITH recipients AS (
        SELECT DISTINCT m.user_id
        FROM public.chat_messages m
        WHERE m.channel_id = msg.channel_id
          AND m.user_id <> auth.uid()
          AND m.created_at > now() - interval '30 days'
        ORDER BY m.user_id
        LIMIT 20
    ), inserted AS (
        INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
        SELECT r.user_id, 'sos', '🆘 ' || left(msg.display_name, 60) || ' needs help',
               left(msg.message, 80),
               jsonb_build_object('channel_id', msg.channel_id, 'message_id', msg.id, 'sender_id', msg.user_id)
        FROM recipients r
        RETURNING 1
    )
    SELECT count(*) INTO queued_count FROM inserted;
    RETURN queued_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_watch_schedule_push(
    p_voyage_id TEXT,
    p_recipient_user_id UUID,
    p_title TEXT,
    p_body TEXT,
    p_data JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE queued_id UUID;
BEGIN
    IF auth.uid() IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = auth.uid()
              AND vc.crew_user_id = p_recipient_user_id
              AND vc.voyage_id = p_voyage_id
              AND vc.status = 'accepted'
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.watch_assignments wa
            WHERE wa.voyage_id = p_voyage_id
              AND wa.assigned_by = auth.uid()
       ) THEN
        RAISE EXCEPTION 'Watch schedule recipient is not eligible';
    END IF;

    INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
    VALUES (p_recipient_user_id, 'watch_schedule_published', left(p_title, 120), left(p_body, 500), p_data)
    RETURNING id INTO queued_id;
    RETURN queued_id;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_self_push(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.queue_dm_push(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.queue_sos_push(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.queue_watch_schedule_push(TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_self_push(TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_dm_push(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_sos_push(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_watch_schedule_push(TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Guardian: exact locations stay private; discovery and broadcasts are bounded
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Guardian profiles are readable by authenticated users" ON public.guardian_profiles;
CREATE POLICY "Users read own guardian profile" ON public.guardian_profiles FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated can view alerts" ON public.guardian_alerts;
DROP POLICY IF EXISTS "Authenticated can insert alerts" ON public.guardian_alerts;
CREATE POLICY "Users read related guardian alerts" ON public.guardian_alerts FOR SELECT TO authenticated
USING (source_user_id = auth.uid() OR target_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.thalassa_users_nearby(
    query_lat DOUBLE PRECISION,
    query_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 5
)
RETURNS TABLE (
    user_id UUID, vessel_name TEXT, owner_name TEXT, dog_name TEXT, mmsi BIGINT,
    armed BOOLEAN, distance_nm DOUBLE PRECISION, last_known_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR query_lat NOT BETWEEN -90 AND 90 OR query_lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    RETURN QUERY
    SELECT gp.user_id, gp.vessel_name, gp.owner_name, gp.dog_name, gp.mmsi, gp.armed,
           (round((ST_Distance(
               ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
               ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography
           ) / 1852.0)::numeric * 2) / 2.0)::double precision AS distance_nm,
           gp.last_known_at
    FROM public.guardian_profiles gp
    WHERE gp.user_id <> auth.uid()
      AND gp.last_known_lat IS NOT NULL AND gp.last_known_lon IS NOT NULL
      AND gp.last_known_at > now() - interval '2 hours'
      AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
          LEAST(GREATEST(radius_nm, 0.1), 5) * 1852
      )
    ORDER BY distance_nm ASC
    LIMIT 50;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_guardian_alert(
    sender_user_id UUID,
    p_alert_type TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 5,
    p_title TEXT DEFAULT '',
    p_body TEXT DEFAULT '',
    alert_data JSONB DEFAULT '{}'::jsonb
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE alert_id UUID;
DECLARE recipient RECORD;
DECLARE notify_count INTEGER := 0;
DECLARE bounded_radius DOUBLE PRECISION := LEAST(GREATEST(radius_nm, 0.1), 5);
DECLARE notification_type TEXT;
DECLARE caller_is_service BOOLEAN := auth.role() = 'service_role';
BEGIN
    IF NOT caller_is_service AND (auth.uid() IS NULL OR sender_user_id <> auth.uid()) THEN
        RAISE EXCEPTION 'Authentication mismatch';
    END IF;
    IF NOT caller_is_service AND p_alert_type NOT IN ('suspicious', 'weather_spike') THEN
        RAISE EXCEPTION 'This alert type may only be generated by the watchdog service';
    END IF;
    IF caller_is_service AND p_alert_type NOT IN ('bolo', 'drag_warning', 'geofence_breach') THEN
        RAISE EXCEPTION 'Unsupported watchdog alert type';
    END IF;
    IF lat NOT BETWEEN -90 AND 90 OR lon NOT BETWEEN -180 AND 180
       OR char_length(p_title) NOT BETWEEN 1 AND 120
       OR char_length(p_body) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Invalid alert content';
    END IF;
    IF NOT caller_is_service AND (SELECT count(*) FROM public.guardian_alerts
        WHERE source_user_id = auth.uid() AND created_at > now() - interval '1 hour') >= 3 THEN
        RAISE EXCEPTION 'Guardian broadcast rate limit exceeded';
    END IF;

    INSERT INTO public.guardian_alerts(alert_type, source_user_id, source_vessel_name, title, body, location, radius_nm, data)
    SELECT p_alert_type, sender_user_id, gp.vessel_name, left(p_title, 120), left(p_body, 500),
           ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography, bounded_radius, COALESCE(alert_data, '{}'::jsonb)
    FROM public.guardian_profiles gp WHERE gp.user_id = sender_user_id
    RETURNING id INTO alert_id;
    IF alert_id IS NULL THEN RAISE EXCEPTION 'Guardian profile required'; END IF;

    notification_type := CASE p_alert_type
        WHEN 'weather_spike' THEN 'weather_alert'
        WHEN 'bolo' THEN 'bolo_alert'
        WHEN 'drag_warning' THEN 'drag_warning'
        WHEN 'geofence_breach' THEN 'geofence_alert'
        ELSE 'suspicious_alert'
    END;
    FOR recipient IN
        SELECT gp.user_id FROM public.guardian_profiles gp
        WHERE gp.user_id <> sender_user_id AND gp.last_known_at > now() - interval '2 hours'
          AND gp.last_known_lat IS NOT NULL AND gp.last_known_lon IS NOT NULL
          AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(gp.last_known_lon, gp.last_known_lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
              bounded_radius * 1852
          )
        LIMIT 50
    LOOP
        INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
        VALUES (recipient.user_id, notification_type, left(p_title, 120), left(p_body, 500),
                jsonb_build_object('alert_id', alert_id, 'alert_type', p_alert_type));
        notify_count := notify_count + 1;
    END LOOP;
    RETURN notify_count;
END;
$$;

DROP FUNCTION IF EXISTS public.guardian_alerts_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER);
CREATE FUNCTION public.guardian_alerts_nearby(
    query_lat DOUBLE PRECISION,
    query_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 10,
    max_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
    id UUID, alert_type TEXT, source_vessel_name TEXT, title TEXT, body TEXT,
    lat DOUBLE PRECISION, lon DOUBLE PRECISION, data JSONB, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR query_lat NOT BETWEEN -90 AND 90 OR query_lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    RETURN QUERY
    SELECT ga.id, ga.alert_type, ga.source_vessel_name, ga.title, ga.body,
           round(ST_Y(ga.location::geometry)::numeric, 3)::double precision,
           round(ST_X(ga.location::geometry)::numeric, 3)::double precision,
           ga.data - 'exact_location', ga.created_at
    FROM public.guardian_alerts ga
    WHERE ga.created_at > now() - make_interval(hours => LEAST(GREATEST(max_hours, 1), 24))
      AND ga.location IS NOT NULL
      AND ST_DWithin(ga.location,
          ST_SetSRID(ST_MakePoint(query_lon, query_lat), 4326)::geography,
          LEAST(GREATEST(radius_nm, 0.1), 10) * 1852)
    ORDER BY ga.created_at DESC
    LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.thalassa_users_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broadcast_guardian_alert(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.thalassa_users_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_guardian_alert(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.guardian_alerts_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) TO authenticated;

-- Validate position-bearing Guardian RPCs instead of accepting malformed/spoofed shapes.
CREATE OR REPLACE FUNCTION public.guardian_heartbeat(lat DOUBLE PRECISION, lon DOUBLE PRECISION)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL OR lat NOT BETWEEN -90 AND 90 OR lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    INSERT INTO public.guardian_profiles(user_id, last_known_lat, last_known_lon, last_known_at)
    VALUES (auth.uid(), lat, lon, now())
    ON CONFLICT (user_id) DO UPDATE SET last_known_lat = EXCLUDED.last_known_lat,
        last_known_lon = EXCLUDED.last_known_lon, last_known_at = now(), updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardian_heartbeat(DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Anchor Watch: authenticated, expiring, high-entropy pairing sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.anchor_watch_sessions (
    session_code TEXT PRIMARY KEY CHECK (session_code ~ '^[A-HJ-NP-Z2-9]{12}$'),
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.anchor_watch_members (
    session_code TEXT NOT NULL REFERENCES public.anchor_watch_sessions(session_code) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('vessel', 'shore')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_code, user_id)
);
ALTER TABLE public.anchor_alarm_tokens ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.anchor_alarm_events
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE public.anchor_watch_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anchor_watch_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_anchor_watch_member(code TEXT, check_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.anchor_watch_members m
        JOIN public.anchor_watch_sessions s USING (session_code)
        WHERE m.session_code = code AND m.user_id = check_user AND s.expires_at > now()
    );
$$;

CREATE OR REPLACE FUNCTION public.create_anchor_watch_session(p_session_code TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL OR p_session_code !~ '^[A-HJ-NP-Z2-9]{12}$' THEN
        RAISE EXCEPTION 'Authentication and a valid session code are required';
    END IF;
    INSERT INTO public.anchor_watch_sessions(session_code, owner_user_id)
    VALUES (p_session_code, auth.uid());
    INSERT INTO public.anchor_watch_members(session_code, user_id, role)
    VALUES (p_session_code, auth.uid(), 'vessel');
END;
$$;

CREATE OR REPLACE FUNCTION public.join_anchor_watch_session(p_session_code TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.anchor_watch_sessions WHERE session_code = p_session_code AND expires_at > now()) THEN
        RETURN false;
    END IF;
    INSERT INTO public.anchor_watch_members(session_code, user_id, role)
    VALUES (p_session_code, auth.uid(), 'shore')
    ON CONFLICT (session_code, user_id) DO UPDATE SET role = 'shore';
    RETURN true;
END;
$$;

CREATE POLICY "anchor_sessions_member_read" ON public.anchor_watch_sessions FOR SELECT TO authenticated
USING (public.is_anchor_watch_member(session_code, auth.uid()));
CREATE POLICY "anchor_members_member_read" ON public.anchor_watch_members FOR SELECT TO authenticated
USING (public.is_anchor_watch_member(session_code, auth.uid()));

DROP POLICY IF EXISTS "Allow anon insert tokens" ON public.anchor_alarm_tokens;
DROP POLICY IF EXISTS "Allow anon delete own tokens" ON public.anchor_alarm_tokens;
DROP POLICY IF EXISTS "Allow anon select tokens" ON public.anchor_alarm_tokens;
DROP POLICY IF EXISTS "Allow anon insert alarms" ON public.anchor_alarm_events;
DROP POLICY IF EXISTS "Allow anon select alarms" ON public.anchor_alarm_events;

CREATE POLICY "anchor_token_member_insert" ON public.anchor_alarm_tokens FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND public.is_anchor_watch_member(session_code, auth.uid()));
CREATE POLICY "anchor_token_owner_delete" ON public.anchor_alarm_tokens FOR DELETE TO authenticated
USING (user_id = auth.uid());
CREATE POLICY "anchor_token_owner_read" ON public.anchor_alarm_tokens FOR SELECT TO authenticated
USING (user_id = auth.uid());
CREATE POLICY "anchor_event_vessel_insert" ON public.anchor_alarm_events FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.anchor_watch_members m
        JOIN public.anchor_watch_sessions s USING (session_code)
        WHERE m.session_code = anchor_alarm_events.session_code
          AND m.user_id = auth.uid() AND m.role = 'vessel' AND s.expires_at > now()
    )
);
CREATE POLICY "anchor_event_member_read" ON public.anchor_alarm_events FOR SELECT TO authenticated
USING (public.is_anchor_watch_member(session_code, auth.uid()));

CREATE OR REPLACE FUNCTION public.claim_anchor_alarm_event(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE claimed JSONB;
BEGIN
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
    WITH claimed_row AS (
        UPDATE public.anchor_alarm_events
        SET processing_at = now(), delivery_attempts = delivery_attempts + 1, last_error = NULL
        WHERE id = p_id
          AND notified_at IS NULL
          AND created_at > now() - interval '1 hour'
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        RETURNING *
    )
    SELECT to_jsonb(claimed_row) INTO claimed FROM claimed_row;
    RETURN claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_anchor_alarm_event(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_anchor_alarm_event(UUID) TO service_role;

-- Alarm inserts must actually wake the delivery function. The legacy schema
-- documented a Dashboard webhook but never created one in source control.
CREATE OR REPLACE FUNCTION public.notify_anchor_alarm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    supabase_url TEXT;
    service_key TEXT;
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
    IF supabase_url IS NULL OR service_key IS NULL THEN
        RAISE WARNING 'Anchor alarm delivery skipped: Supabase URL/service key not configured';
        RETURN NEW;
    END IF;

    PERFORM net.http_post(
        url := supabase_url || '/functions/v1/send-anchor-alarm',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || service_key,
            'Content-Type', 'application/json'
        ),
        body := jsonb_build_object('record', jsonb_build_object('id', NEW.id))
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_anchor_alarm_insert ON public.anchor_alarm_events;
CREATE TRIGGER on_anchor_alarm_insert
AFTER INSERT ON public.anchor_alarm_events
FOR EACH ROW EXECUTE FUNCTION public.notify_anchor_alarm();
REVOKE ALL ON FUNCTION public.notify_anchor_alarm() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retry_pending_anchor_alarms()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    supabase_url TEXT;
    service_key TEXT;
    alarm RECORD;
BEGIN
    SELECT decrypted_secret INTO supabase_url
    FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF supabase_url IS NULL THEN supabase_url := current_setting('app.settings.supabase_url', true); END IF;
    IF service_key IS NULL THEN service_key := current_setting('app.settings.service_role_key', true); END IF;
    IF supabase_url IS NULL OR service_key IS NULL THEN RETURN; END IF;

    FOR alarm IN
        SELECT id FROM public.anchor_alarm_events
        WHERE notified_at IS NULL
          AND created_at > now() - interval '1 hour'
          AND delivery_attempts < 5
          AND (processing_at IS NULL OR processing_at < now() - interval '5 minutes')
        ORDER BY created_at
        LIMIT 20
    LOOP
        PERFORM net.http_post(
            url := supabase_url || '/functions/v1/send-anchor-alarm',
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || service_key,
                'Content-Type', 'application/json'
            ),
            body := jsonb_build_object('record', jsonb_build_object('id', alarm.id))
        );
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_pending_anchor_alarms() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE existing_job BIGINT;
BEGIN
    SELECT jobid INTO existing_job FROM cron.job WHERE jobname = 'retry-pending-anchor-alarm' LIMIT 1;
    IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;
END;
$$;
SELECT cron.schedule('retry-pending-anchor-alarm', '* * * * *', 'SELECT public.retry_pending_anchor_alarms()');

REVOKE ALL ON FUNCTION public.is_anchor_watch_member(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_anchor_watch_session(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_anchor_watch_session(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_anchor_watch_member(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_anchor_watch_session(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_anchor_watch_session(TEXT) TO authenticated;

-- Realtime private-channel authorization. Topic is anchor-watch-<session code>.
CREATE OR REPLACE FUNCTION public.can_access_anchor_realtime_topic(topic_name TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT topic_name LIKE 'anchor-watch-%'
       AND public.is_anchor_watch_member(substring(topic_name FROM 14), auth.uid());
$$;
REVOKE ALL ON FUNCTION public.can_access_anchor_realtime_topic(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_anchor_realtime_topic(TEXT) TO authenticated;

DROP POLICY IF EXISTS "anchor_watch_realtime_receive" ON realtime.messages;
DROP POLICY IF EXISTS "anchor_watch_realtime_send" ON realtime.messages;
CREATE POLICY "anchor_watch_realtime_receive" ON realtime.messages FOR SELECT TO authenticated
USING (public.can_access_anchor_realtime_topic(realtime.topic()));
CREATE POLICY "anchor_watch_realtime_send" ON realtime.messages FOR INSERT TO authenticated
WITH CHECK (public.can_access_anchor_realtime_topic(realtime.topic()));

-- Service-role clients bypass RLS. Explicit service-role policies are misleading
-- and can accidentally authorize forged JWT role claims, so remove them.
DROP POLICY IF EXISTS "Service role full access on alerts" ON public.guardian_alerts;
DROP POLICY IF EXISTS "Service role can manage all guardian profiles" ON public.guardian_profiles;
DROP POLICY IF EXISTS "Service role full access" ON public.weather_alerts_log;
