-- Crew chats are members-only again (2026-10-09).
--
-- Why
-- ───
-- The live database carries a policy that no migration ever created:
--
--     channel_members_all   PERMISSIVE  FOR ALL  TO public
--                           USING (true)  WITH CHECK (true)
--
-- Permissive policies are OR'd, so it overrode the three scoped policies that
-- 20260723090000 wrote (channel_members_read / _add / _remove), and anon and
-- authenticated also held every table privilege. can_access_chat_channel(),
-- the gate behind chat_channels_visible, chat_messages_visible and
-- chat_messages_create, says yes as soon as a channel_members row exists for
-- the caller. So, until this file:
--   * any signed-in account could insert its own row into any private crew
--     chat, then read it, post in it and receive it live over realtime;
--   * anyone holding the public (anon) key could list every membership (which
--     account sits in which private channel) and delete them all.
-- channel_join_requests carries the same drift policy,
-- channel_join_requests_all: anyone could read every request, write one
-- already 'approved', or delete anyone's. It held 0 rows on 2026-10-09.
--
-- A read-only audit on 2026-10-09 found no sign either hole was used: 40
-- memberships = 27 owner rows + 13 rows of the one accepted crew member in
-- the owner's channels; 0 unexplained, 0 orphaned, 0 private-channel messages
-- from anyone without access. Snooping leaves no trace in the database; only
-- the API request logs could show it.
--
-- What changes
-- ────────────
-- 1. channel_members: channel_members_all is dropped. The three scoped
--    policies are re-pinned exactly as 20260723090000 wrote them (live
--    matches), so this file states the table's whole policy set. anon and
--    PUBLIC lose every privilege; authenticated loses TRUNCATE, REFERENCES
--    and TRIGGER and keeps SELECT, INSERT, UPDATE, DELETE.
--      UPDATE stays on purpose. approveJoinRequest upserts with
--      onConflict 'channel_id,user_id', which is INSERT ... ON CONFLICT DO
--      UPDATE, and Postgres requires the UPDATE privilege for that statement
--      even when nothing conflicts. Without it every approval would mark the
--      request approved, add nobody, and still report success (the client
--      ignores the upsert's error). There is no UPDATE policy, so no row can
--      actually be updated.
-- 2. channel_join_requests: channel_join_requests_all is dropped, with the
--    same grant clean-up. join_requests_read / _create / _review / _delete
--    (20260723090000, live matches) already cover every app path.
-- 3. chat_channels_visible gains one branch: an owner sees their own ACTIVE
--    channel. For a stored row this changes nothing, because
--    can_access_chat_channel() already says yes to the owner. It matters for
--    the row being inserted: createVoyageChannel inserts with .select(), and
--    Postgres checks the SELECT policy against the new row, which
--    can_access_chat_channel() looks up by id and cannot see yet. So every
--    skipper who is not a chat moderator got 42501 and no Crew Chat was
--    created (all 29 live crew channels belong to the one moderator). That
--    bug predates the drift policy; it is fixed here, server-side, so builds
--    102-124 start working without an app update.
--
-- Builds: none needs a change. Each path builds 102-124 use was replayed on
-- live inside a rolled-back transaction with this file applied: an owner
-- creates a channel and adds members; crew accept an invite and join through
-- join_accepted_crew_channels (SECURITY DEFINER, bypasses RLS), also used by
-- the 121+ reconcile; membership reads (useChatProposals, the 121+ Crew Chat
-- gate); leaving; an admin approving a proposal; join-request
-- approve/reject; DMs and public channels, which never touch
-- channel_members. One harmless difference: approving a join request for
-- someone who is already a member now fails on the conflict branch instead
-- of updating nothing. The client discards that error and the person is a
-- member either way.
--
-- Not here: audit_log_all on admin_audit_log and guardian_alerts
-- "Authenticated users create alerts" are the same kind of drift in other
-- areas and get their own migration.
--
-- Undo
-- ────
-- Never recreate channel_members_all or channel_join_requests_all. To revert
-- only part 3, recreate chat_channels_visible as 20260723090000 wrote it.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back replay runs
-- it twice to prove a re-run is a no-op. lock_timeout is set for the session
-- (SET LOCAL is a no-op outside a transaction block) and reset at the end.

SET lock_timeout = '5s';

-- ── 1. channel_members ────────────────────────────────────────────────────

ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_members_all" ON public.channel_members;

DROP POLICY IF EXISTS "channel_members_read" ON public.channel_members;
CREATE POLICY "channel_members_read" ON public.channel_members FOR SELECT TO authenticated
USING (public.can_access_chat_channel(channel_id, auth.uid()));

DROP POLICY IF EXISTS "channel_members_add" ON public.channel_members;
CREATE POLICY "channel_members_add" ON public.channel_members FOR INSERT TO authenticated
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);

DROP POLICY IF EXISTS "channel_members_remove" ON public.channel_members;
CREATE POLICY "channel_members_remove" ON public.channel_members FOR DELETE TO authenticated
USING (
    user_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.chat_channels c
        WHERE c.id = channel_id AND c.owner_id = auth.uid()
    )
    OR public.is_chat_moderator(auth.uid())
);

REVOKE ALL ON TABLE public.channel_members FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.channel_members FROM authenticated;
-- UPDATE is required by approveJoinRequest's upsert (see the header).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_members TO authenticated;

-- ── 2. channel_join_requests ──────────────────────────────────────────────

ALTER TABLE public.channel_join_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_join_requests_all" ON public.channel_join_requests;

REVOKE ALL ON TABLE public.channel_join_requests FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.channel_join_requests FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_join_requests TO authenticated;

-- ── 3. An owner sees the active channel they just created ─────────────────

DROP POLICY IF EXISTS "chat_channels_visible" ON public.chat_channels;
CREATE POLICY "chat_channels_visible" ON public.chat_channels FOR SELECT TO authenticated
USING (
    (status = 'active' AND public.can_access_chat_channel(id, auth.uid()))
    OR (status = 'active' AND owner_id = auth.uid())
    OR proposed_by = auth.uid()
    OR public.is_chat_moderator(auth.uid())
);

-- ── 4. Fail the push if anything open is left on the two tables ───────────
-- Catches a drift policy under a name this file does not know.

DO $check$
DECLARE
    open_policies TEXT;
    privilege TEXT;
BEGIN
    SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO open_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('channel_members', 'channel_join_requests')
      AND (
          cmd = 'ALL'
          OR qual = 'true'
          OR with_check = 'true'
          OR roles && ARRAY['public', 'anon']::name[]
      );
    IF open_policies IS NOT NULL THEN
        RAISE EXCEPTION 'channel lockdown: open policies remain: %', open_policies;
    END IF;

    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege('anon', 'public.channel_members', privilege)
           OR has_table_privilege('anon', 'public.channel_join_requests', privilege) THEN
            RAISE EXCEPTION 'channel lockdown: anon still holds % on a membership table', privilege;
        END IF;
    END LOOP;

    IF NOT has_table_privilege('authenticated', 'public.channel_members', 'UPDATE') THEN
        RAISE EXCEPTION 'channel lockdown: authenticated must keep UPDATE on channel_members';
    END IF;
END;
$check$;

RESET lock_timeout;
