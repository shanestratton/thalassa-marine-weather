-- Chat messages publish only after server-side moderation. Fail closed.
--
-- Audit item 5 (2026-09-05), second half; Shane: "go". Until now a message was
-- INSERTed visible to everyone and the SENDER's phone then asked Gemini about
-- it, soft-deleting on a bad verdict ~1–2 s later. Everyone saw everything
-- first; a phone with no network, or a modified client, moderated nothing.
--
-- Now a new row starts 'pending'. The SELECT policy shows pending rows only to
-- their author (who needs to see their own message) and to moderators. An
-- AFTER INSERT trigger POSTs the id to the moderate-chat-message Function,
-- which classifies the text and sets 'approved' — at which point Realtime
-- delivers the row to every other subscriber as an UPDATE their client already
-- merges as a new message — or 'rejected' (soft-deleted, with a reason the
-- author sees). A classifier failure NEVER approves: the row stays pending, a
-- once-a-minute sweep re-dispatches it, and after five attempts it is 'held'
-- and the author is told. Nothing unreviewed is ever published.
--
-- Cost, stated: every message waits ~1–2 s before others see it, and a Gemini
-- outage stalls new chat for everyone but the author. Accepted.
--
-- Existing rows were published under the old model; they stay 'approved'.
-- Deploy the moderate-chat-message Function BEFORE this migration.

ALTER TABLE public.chat_messages
    ADD COLUMN IF NOT EXISTS moderation_status text NOT NULL DEFAULT 'approved'
        CHECK (moderation_status IN ('pending', 'approved', 'rejected', 'held')),
    ADD COLUMN IF NOT EXISTS moderation_reason text CHECK (char_length(moderation_reason) <= 300),
    ADD COLUMN IF NOT EXISTS moderation_attempts smallint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

-- History stays visible; from here on a NEW row starts pending.
ALTER TABLE public.chat_messages ALTER COLUMN moderation_status SET DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_chat_messages_pending
    ON public.chat_messages (created_at)
    WHERE moderation_status = 'pending';

-- ── Visibility: approved to all channel members; own and moderators see everything ──
DROP POLICY IF EXISTS "chat_messages_visible" ON public.chat_messages;
CREATE POLICY "chat_messages_visible" ON public.chat_messages FOR SELECT TO authenticated
USING (
    public.can_access_chat_channel(channel_id, auth.uid())
    AND (
        moderation_status = 'approved'
        OR user_id = auth.uid()
        OR public.is_chat_moderator(auth.uid())
    )
);

-- ── Insert: 20260724091000 restated verbatim, plus: a client inserts pending, untouched ──
DROP POLICY IF EXISTS "chat_messages_create" ON public.chat_messages;
CREATE POLICY "chat_messages_create" ON public.chat_messages FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND char_length(message) BETWEEN 1 AND 4000
    AND char_length(display_name) BETWEEN 1 AND 120
    AND public.can_access_chat_channel(channel_id, auth.uid())
    AND NOT EXISTS (
        SELECT 1 FROM public.chat_roles r
        WHERE r.user_id = auth.uid()
          AND (COALESCE(r.is_blocked, false) OR r.muted_until > now())
    )
    AND moderation_status = 'pending'
    AND moderation_attempts = 0
    AND moderated_at IS NULL
    AND moderation_reason IS NULL
);

-- ── Update guard: the live 20260905104000 body, with moderation fields owned by the service ──
CREATE OR REPLACE FUNCTION public.protect_chat_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
BEGIN
    -- Moderation state belongs to the moderation service. A client request
    -- always carries a JWT (auth.uid() set, role authenticated); the service
    -- key carries role service_role; the retry sweep runs inside the database
    -- with no JWT at all (auth.uid() NULL). anon has no UPDATE privilege here,
    -- so "no uid" can only be an internal context.
    IF NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
       OR NEW.moderation_reason IS DISTINCT FROM OLD.moderation_reason
       OR NEW.moderation_attempts IS DISTINCT FROM OLD.moderation_attempts
       OR NEW.moderated_at IS DISTINCT FROM OLD.moderated_at THEN
        IF COALESCE(auth.role(), '') = 'service_role' OR auth.uid() IS NULL THEN
            -- A rejection soft-deletes; the body leaves the row as it always has.
            IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
                NEW.message := '[removed]';
            END IF;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Moderation state is set by the moderation service';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        NEW.message := '[removed]';
    ELSIF NEW.message IS DISTINCT FROM OLD.message THEN
        RAISE EXCEPTION 'Message identity and content are immutable';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.display_name IS DISTINCT FROM OLD.display_name
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
$function$;
REVOKE ALL ON FUNCTION public.protect_chat_message_update() FROM PUBLIC, anon, authenticated;

-- ── Dispatch: every new pending row is handed to the moderation Function ──
CREATE OR REPLACE FUNCTION public.dispatch_chat_moderation()
RETURNS trigger
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
        -- Fail CLOSED: the row stays pending (visible to its author only) and
        -- the sweep will hold it. Loud in the logs, silent to no one.
        RAISE WARNING 'Chat moderation dispatch skipped: Supabase URL/service key not configured';
        RETURN NEW;
    END IF;

    PERFORM net.http_post(
        url := supabase_url || '/functions/v1/moderate-chat-message',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || service_key,
            'Content-Type', 'application/json'
        ),
        body := jsonb_build_object('record', jsonb_build_object('id', NEW.id))
    );
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_chat_moderation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_chat_message_insert_moderate ON public.chat_messages;
CREATE TRIGGER on_chat_message_insert_moderate
    AFTER INSERT ON public.chat_messages
    FOR EACH ROW
    WHEN (NEW.moderation_status = 'pending')
    EXECUTE FUNCTION public.dispatch_chat_moderation();

-- ── Sweep: re-dispatch what the trigger's POST lost; hold what will not classify ──
CREATE OR REPLACE FUNCTION public.retry_pending_chat_moderation()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    supabase_url TEXT;
    service_key TEXT;
    stuck RECORD;
BEGIN
    -- Five attempts or ten minutes, whichever first: held, and the author told.
    UPDATE public.chat_messages
       SET moderation_status = 'held',
           moderation_reason = 'Moderation unavailable',
           moderated_at = now()
     WHERE moderation_status = 'pending'
       AND (moderation_attempts >= 5 OR created_at < now() - interval '10 minutes');

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
        RAISE WARNING 'Chat moderation retry skipped: Supabase URL/service key not configured';
        RETURN;
    END IF;

    FOR stuck IN
        SELECT id FROM public.chat_messages
         WHERE moderation_status = 'pending'
           AND created_at < now() - interval '20 seconds'
         ORDER BY created_at
         LIMIT 50
    LOOP
        PERFORM net.http_post(
            url := supabase_url || '/functions/v1/moderate-chat-message',
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || service_key,
                'Content-Type', 'application/json'
            ),
            body := jsonb_build_object('record', jsonb_build_object('id', stuck.id))
        );
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_pending_chat_moderation() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    PERFORM cron.unschedule('chat-moderation-retry');
EXCEPTION WHEN OTHERS THEN
    NULL; -- not scheduled yet
END $$;
SELECT cron.schedule(
    'chat-moderation-retry',
    '* * * * *',
    $$SELECT public.retry_pending_chat_moderation()$$
);

COMMENT ON COLUMN public.chat_messages.moderation_status IS
    'pending → approved | rejected | held. Set only by the moderate-chat-message service. Others see approved rows only; the author and moderators see all.';
