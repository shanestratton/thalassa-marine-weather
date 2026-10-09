-- A skipper sees the Crew Chat they just created (2026-10-09).
--
-- SHIPS TOGETHER WITH BUILD 125's CREW CHAT FIX: one room per skipper, found
-- by owner, not by name. Do not push this while builds 102-124 are the
-- builds in use. On those builds a skipper who is not a chat moderator
-- would make a duplicate room per tap (see "Why it waits").
--
-- Why
-- ───
-- createVoyageChannel (services/ChatService.ts) inserts the skipper's crew
-- channel with .insert(...).select(), which is INSERT ... RETURNING. Postgres
-- checks the SELECT policy against the returned row, and
-- chat_channels_visible's first branch asks can_access_chat_channel(), which
-- looks the channel up by id and cannot see a row inserted by the same
-- statement. So unless the skipper is a chat moderator the insert fails with
-- 42501 and no Crew Chat exists. On 2026-10-09 all 29 live crew channels
-- belonged to the one moderator.
--
-- This file adds one branch: an owner sees their own ACTIVE channel. For a
-- stored row that changes nothing, because can_access_chat_channel() already
-- says yes to the owner; only the row being inserted becomes visible to its
-- owner. Pending proposals stay visible to their proposer and to moderators
-- only, as before.
--
-- Why it waits
-- ────────────
-- Before it creates a room, createVoyageChannel in builds 102-124 looks for
-- an existing one by name: .or('name.eq.<voyage>,name.eq.⛵ <voyage>'). That
-- is a PostgREST filter string, and a voyage name with a comma or a
-- parenthesis breaks it, so the lookup finds nothing and the app creates
-- another room. Today the create fails for non-moderators, so that never
-- shows. With this file live, every tap on Crew Chat by such a skipper on
-- an older build would add another room. Build 125 finds the room by owner
-- instead; ship this with it, not before.
--
-- If other migrations have been applied after 20261009171000 by the time
-- build 125 ships, rename this file to a fresh timestamp first: db push
-- refuses a file older than the newest applied migration unless run with
-- --include-all.
--
-- Depends on 20261009170000_drift_policy_lockdown.sql (crew-chat membership
-- is owner- or moderator-only again).
--
-- Undo
-- ────
-- Recreate chat_channels_visible as 20260723090000 wrote it (the same policy
-- without the owner branch).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back replay runs
-- it twice to prove a re-run is a no-op. lock_timeout is set for the session
-- and reset at the end.

SET lock_timeout = '5s';

DROP POLICY IF EXISTS "chat_channels_visible" ON public.chat_channels;
CREATE POLICY "chat_channels_visible" ON public.chat_channels FOR SELECT TO authenticated
USING (
    (status = 'active' AND public.can_access_chat_channel(id, auth.uid()))
    OR (status = 'active' AND owner_id = auth.uid())
    OR proposed_by = auth.uid()
    OR public.is_chat_moderator(auth.uid())
);

-- Fail the push unless chat_channels has exactly its four policies, the
-- owner branch is in place, and none of them is open.
DO $check$
DECLARE
    actual JSONB;
    visible TEXT;
    open_policies TEXT;
BEGIN
    SELECT COALESCE(jsonb_agg(policyname::text ORDER BY policyname::text COLLATE "C"), '[]'::jsonb)
    INTO actual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'chat_channels';
    IF actual IS DISTINCT FROM
       '["chat_channels_create", "chat_channels_delete", "chat_channels_manage", "chat_channels_visible"]'::jsonb THEN
        RAISE EXCEPTION 'crew channel owner visible: chat_channels has policies %', actual;
    END IF;

    SELECT qual INTO visible
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'chat_channels' AND policyname = 'chat_channels_visible';
    IF visible NOT LIKE '%((status = ''active''::text) AND (owner_id = auth.uid()))%' THEN
        RAISE EXCEPTION 'crew channel owner visible: owner branch missing from chat_channels_visible';
    END IF;

    SELECT string_agg(policyname, ', ')
    INTO open_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chat_channels'
      AND (
          cmd = 'ALL'
          OR qual = 'true'
          OR with_check = 'true'
          OR roles && ARRAY['public', 'anon']::name[]
      );
    IF open_policies IS NOT NULL THEN
        RAISE EXCEPTION 'crew channel owner visible: open policies on chat_channels: %', open_policies;
    END IF;
END;
$check$;

RESET lock_timeout;
