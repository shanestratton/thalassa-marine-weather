-- Bound persistent chat payloads at the database boundary. Existing rows are
-- not scanned during deployment; NOT VALID constraints still protect every
-- new or updated row and can be validated separately after an audit.

ALTER TABLE public.chat_messages
    ADD CONSTRAINT chat_messages_message_length
    CHECK (char_length(message) BETWEEN 1 AND 4000) NOT VALID;

ALTER TABLE public.chat_messages
    ADD CONSTRAINT chat_messages_display_name_length
    CHECK (char_length(display_name) BETWEEN 1 AND 120) NOT VALID;

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
);

ALTER TABLE public.chat_direct_messages
    ADD CONSTRAINT chat_direct_messages_message_length
    CHECK (char_length(message) BETWEEN 1 AND 4000) NOT VALID;

ALTER TABLE public.chat_direct_messages
    ADD CONSTRAINT chat_direct_messages_sender_name_length
    CHECK (char_length(sender_name) BETWEEN 1 AND 120) NOT VALID;

DROP POLICY IF EXISTS "Users can send unblocked DMs" ON public.chat_direct_messages;
CREATE POLICY "Users can send unblocked DMs" ON public.chat_direct_messages FOR INSERT TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    AND sender_id <> recipient_id
    AND char_length(message) BETWEEN 1 AND 4000
    AND char_length(sender_name) BETWEEN 1 AND 120
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
