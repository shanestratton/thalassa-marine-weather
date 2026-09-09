-- Keep the caller-owned legacy safety lists private while enforcing either
-- direction of a block on every new generic DM. No historical rows are moved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_chat_dm_block_status(p_other_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    owner_id UUID := auth.uid();
    own_block BOOLEAN;
    reverse_block BOOLEAN;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_other_user_id IS NULL OR p_other_user_id = owner_id THEN
        RAISE EXCEPTION 'Invalid block target' USING ERRCODE = '22023';
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.dm_blocks
                   WHERE blocker_id = owner_id AND blocked_id = p_other_user_id)
        OR EXISTS (SELECT 1 FROM public.sailor_blocks
                   WHERE blocker_id = owner_id::TEXT AND blocked_id = p_other_user_id::TEXT)
      INTO own_block;
    SELECT EXISTS (SELECT 1 FROM public.dm_blocks
                   WHERE blocker_id = p_other_user_id AND blocked_id = owner_id)
        OR EXISTS (SELECT 1 FROM public.sailor_blocks
                   WHERE blocker_id = p_other_user_id::TEXT AND blocked_id = owner_id::TEXT)
      INTO reverse_block;
    RETURN jsonb_build_object('blockedByMe', own_block,
                              'blockedEitherDirection', own_block OR reverse_block);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_chat_user_block(p_other_user_id UUID, p_blocked BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    owner_id UUID := auth.uid();
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_other_user_id IS NULL OR p_other_user_id = owner_id OR p_blocked IS NULL THEN
        RAISE EXCEPTION 'Invalid block target' USING ERRCODE = '22023';
    END IF;
    -- Repeated requests are idempotent; no UPDATE policy or generated-field
    -- grant is needed. Both writes/deletes commit together, or neither does.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'chat-block:' || LEAST(owner_id::TEXT, p_other_user_id::TEXT) || ':' ||
        GREATEST(owner_id::TEXT, p_other_user_id::TEXT), 0));
    IF p_blocked THEN
        INSERT INTO public.dm_blocks (blocker_id, blocked_id)
        VALUES (owner_id, p_other_user_id) ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
        INSERT INTO public.sailor_blocks (blocker_id, blocked_id)
        VALUES (owner_id::TEXT, p_other_user_id::TEXT) ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
    ELSE
        DELETE FROM public.dm_blocks WHERE blocker_id = owner_id AND blocked_id = p_other_user_id;
        DELETE FROM public.sailor_blocks
         WHERE blocker_id = owner_id::TEXT AND blocked_id = p_other_user_id::TEXT;
    END IF;
    RETURN public.get_chat_dm_block_status(p_other_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_chat_dm_block_status(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_chat_user_block(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_chat_dm_block_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_chat_user_block(UUID, BOOLEAN) TO authenticated;

-- Build 108 unblocks through a direct DELETE on one legacy list. Remove only
-- that caller-owned direction from its counterpart so a mirrored block does
-- not become impossible for the older client to remove. The second trigger
-- sees no original row to delete, so there is no recursive loop.
CREATE OR REPLACE FUNCTION public.sync_chat_block_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS NULL OR OLD.blocker_id::TEXT <> auth.uid()::TEXT THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'dm_blocks' THEN
        DELETE FROM public.sailor_blocks
         WHERE blocker_id = OLD.blocker_id::TEXT AND blocked_id = OLD.blocked_id::TEXT;
    ELSIF TG_TABLE_NAME = 'sailor_blocks' THEN
        DELETE FROM public.dm_blocks
         WHERE blocker_id::TEXT = OLD.blocker_id AND blocked_id::TEXT = OLD.blocked_id;
    END IF;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_chat_block_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sync_chat_block_delete ON public.dm_blocks;
CREATE TRIGGER sync_chat_block_delete AFTER DELETE ON public.dm_blocks
FOR EACH ROW EXECUTE FUNCTION public.sync_chat_block_delete();
DROP TRIGGER IF EXISTS sync_chat_block_delete ON public.sailor_blocks;
CREATE TRIGGER sync_chat_block_delete AFTER DELETE ON public.sailor_blocks
FOR EACH ROW EXECUTE FUNCTION public.sync_chat_block_delete();

-- Restrictive AND gate: even a separate permissive INSERT policy cannot
-- bypass the bilateral check. Existing consent, payload and role gates stay.
DROP POLICY IF EXISTS chat_direct_messages_bilateral_block_guard ON public.chat_direct_messages;
CREATE POLICY chat_direct_messages_bilateral_block_guard
ON public.chat_direct_messages AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
    sender_id = (SELECT auth.uid())
    AND NOT COALESCE((public.get_chat_dm_block_status(recipient_id)->>'blockedEitherDirection')::BOOLEAN, TRUE)
);

COMMIT;
