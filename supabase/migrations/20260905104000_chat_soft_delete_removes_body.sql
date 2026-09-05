-- A "deleted" chat message kept its body, and any channel member could read it.
--
-- deleteMessage() and the moderation auto-remove both set deleted_at and
-- nothing else. chat_messages_visible reads every row a channel member can
-- reach — deleted or not — so a removed message stayed SELECTable through the
-- API with its text intact; only the UI chose not to show it (external audit,
-- 2026-09-05: "deleted message bodies remain selectable").
--
-- Hiding the whole row would be the obvious fix and is the wrong one: Realtime
-- delivers an UPDATE only when the subscriber can see the NEW row, so a hidden
-- row means other phones never learn of the deletion and keep showing the
-- message until they reload. Instead the BODY leaves the row at the moment of
-- deletion, server-side, whatever the client sent — the row stays, tombstoned,
-- so every subscriber still receives the change the UI already knows how to
-- render.
--
-- protect_chat_message_update() already makes `message` immutable and already
-- decides who may set deleted_at (the author, once, forward only; moderators,
-- freely). Soft delete becomes the one transition in which the body changes,
-- and the trigger makes that change itself. '[removed]' satisfies the
-- chat_messages_message_length CHECK (1..4000).
--
-- Live body pulled via pg_get_functiondef on 2026-09-05; only the first block
-- is new. The trigger binding is unchanged, so no CREATE TRIGGER is needed.

CREATE OR REPLACE FUNCTION public.protect_chat_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        -- The body leaves the row here. Not in the client, which may be old,
        -- and not optionally.
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
