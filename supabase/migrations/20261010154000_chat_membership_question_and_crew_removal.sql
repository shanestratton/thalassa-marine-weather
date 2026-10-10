-- Nobody can ask about another person's chat membership, and removing
-- someone from the crew also takes them out of Crew Chat (2026-10-10,
-- build 126, package 126-13).
--
-- Authority
-- ─────────
-- Shane, 2026-10-09 ~11:30, on the chat lockdown: "yes to db changes".
-- Shane, 2026-10-09, starting build 126: "ok,  start on 126?". The roadmap
-- line for 126: narrow who can ask about chat memberships. Standing order:
-- our own recommendation for every call that needs an answer.
-- Never pushed by an agent: Shane runs the push himself, after a --dry-run
-- that lists this file, 20261010154500 and 20261010155000 (in that order).
--
-- Why
-- ───
-- 1. The membership question. can_access_chat_channel(check_channel,
--    check_user), is_chat_moderator(check_user) and is_chat_admin(check_user)
--    run as their owner (20260723090000) and answer for ANY check_user, and
--    every signed-in account may execute them. So any account could call
--    rpc('can_access_chat_channel', { check_channel, check_user }) and learn
--    whether person X is in private crew room Y, or ask who the moderators
--    and admins are. Every policy and function that calls them passes
--    auth.uid() (checked across every migration), and no app or edge
--    function code calls them by RPC, so a guard costs no caller anything.
-- 2. Crew removal. Nothing removes channel_members when a crew membership
--    ends. The three ways one ends are plain deletes on vessel_crew
--    (services/CrewService.ts): removeCrew by the skipper (:624, after the
--    Undo window in components/CrewManagement.tsx), leaveVessel by the crew
--    member (:798) and disbandGroup (:824, all rows or one passage's). A
--    removed crew member kept the channel_members row that
--    join_accepted_crew_channels gave them, so can_access_chat_channel's
--    member branch kept reading, posting and live delivery of the boat's
--    Crew Chat open to them, notifications included.
--
-- What
-- ────
-- 1. The three helpers keep their signatures, LANGUAGE sql, STABLE,
--    SECURITY DEFINER and search_path, and now answer only when:
--      * check_user IS NOT DISTINCT FROM auth.uid() (about yourself; first,
--        because it is the cheap test and the one every policy hits);
--      * the caller is the service role (auth.role() = 'service_role');
--      * the session is a direct database session that has not taken an API
--        role: session_user is not PostgREST's 'authenticator' AND the
--        session has not SET ROLE to anon or authenticated (cron, migrations,
--        the SQL editor). The plan said session_user alone; the role test is
--        added so that services which log in as their own role and then SET
--        ROLE authenticated (Storage, Realtime) stay under the guard, and so
--        the rolled-back rehearsal can prove the guard with SET ROLE;
--      * for can_access_chat_channel only: the caller is a chat moderator.
--    Anyone else gets false. Nothing raises, so a policy can never error.
--    A moderator asking about someone else gets the exact answer: the
--    moderator test of check_user is inline instead of going through the
--    now-guarded is_chat_moderator().
-- 2. forget_crew_chat_membership(), an AFTER UPDATE OF status, crew_user_id,
--    owner_id OR DELETE trigger on vessel_crew, modelled on
--    forget_crew_float_plan_details (20261004120000). When an ACCEPTED
--    membership ends (deleted, declined, or moved by a server write) it
--    deletes that person's channel_members rows in that skipper's private
--    👥 rooms, unless another accepted row for the same skipper and person
--    remains (per-passage rows). It never touches the owner's own row, it
--    runs as its owner (the crew member leaving cannot delete the skipper's
--    room rows, and need not), and it never raises: a chat hiccup must not
--    block a crew removal, so it warns instead. Server-side, so builds
--    102-125 and every client path are covered. Re-inviting puts them back:
--    join_accepted_crew_channels (same rules) adds accepted crew to the
--    owner's active private 👥 rooms at their next Scuttlebutt visit.
--
--    One skipper's crew changes take turns: after its cheap returns and
--    before the "another accepted row remains" test, the trigger takes a
--    transaction-level advisory lock keyed on the skipper. Without it, two of
--    a pair's rows deleted in parallel transactions (a sailor with a
--    boat-wide row and a passage row taps Leave, and the app deletes both at
--    once) would each still see the other's row in its own snapshot, and
--    both would keep the membership. With it the second waits for the first
--    to commit, and its next statement sees that row gone. The lock lasts to
--    the end of that short transaction; a multi-row disband takes the same
--    key again, which is allowed.
--
--    join_accepted_crew_channels takes the same turn first, before its crew
--    test reads vessel_crew; its rules are otherwise as 20260723090000 wrote
--    them. So a join and a removal committing at the same moment cannot
--    cross either. It is replaced only if its body here is the one
--    20260723090000 wrote, or this file's own on a re-run (an md5 of the body
--    with whitespace squashed); anything else stops the push before anything
--    changes, so a live edit is never silently overwritten.
-- 3. A one-off sweep removes any membership that already sits in a crew room
--    with no accepted crew row behind it, with the trigger's own conditions.
--    The re-audit of 2026-10-09 explained every membership (live now holds
--    one crew room with 2 members), so it should remove 0. It counts first
--    and refuses to remove more than 10 (that would mean something else is
--    going on); the count goes out as a NOTICE.
-- 4. The push fails unless the three guards, the trigger and its function
--    are in place, both functions take their turn, EXECUTE is exactly as
--    stated, and no orphan remains.
--
-- Builds: none needs a change. A crew member removed while their phone is
-- posting gets the post refused (42501), which the app already handles.
--
-- Undo
-- ────
--     DROP TRIGGER IF EXISTS trg_vessel_crew_forget_chat_membership ON public.vessel_crew;
--     DROP FUNCTION IF EXISTS public.forget_crew_chat_membership();
-- and recreate the three helpers as 20260723090000 wrote them (the same
-- bodies without the CASE guard), and recreate join_accepted_crew_channels as
-- 20260723090000 wrote it (the same body without the PERFORM
-- pg_advisory_xact_lock line). Rows the sweep removed are not restored;
-- join_accepted_crew_channels re-adds any accepted crew member.
--
-- Not here
-- ────────
-- forget_crew_float_plan_details (20261004120000) has the same "another
-- accepted row remains" race as the trigger above had; it takes no turn yet.
-- A later build.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

-- ── 0. Before anything changes: join_accepted_crew_channels is the one we know ──
-- Section 2 replaces it to add the turn. A body that differs from the one
-- 20260723090000 wrote (or from this file's own, on a re-run) means it was
-- changed on this database; the push stops rather than overwrite that.

DO $join_drift$
DECLARE
    live TEXT;
BEGIN
    SELECT md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) INTO live
      FROM pg_proc AS p
     WHERE p.oid = to_regprocedure('public.join_accepted_crew_channels(uuid)');
    IF live IS NOT NULL AND live NOT IN ('a4ee7163f9f08b692c3b5a9f0575028a', '6e7529bed30955520d9cd5a2f52e0375') THEN
        RAISE EXCEPTION 'crew removal: join_accepted_crew_channels here is not the one 20260723090000 wrote; refusing to replace it, nothing changed';
    END IF;
END;
$join_drift$;

-- ── 1. The membership question: about yourself only ─────────────────────

CREATE OR REPLACE FUNCTION public.is_chat_moderator(check_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE WHEN check_user IS NOT DISTINCT FROM auth.uid()
        OR auth.role() = 'service_role'
        OR (session_user <> 'authenticator' AND COALESCE(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated'))
    THEN EXISTS (
        SELECT 1
        FROM public.chat_roles
        WHERE user_id = check_user
          AND role IN ('admin', 'moderator')
          AND NOT COALESCE(is_blocked, false)
    )
    ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.is_chat_admin(check_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE WHEN check_user IS NOT DISTINCT FROM auth.uid()
        OR auth.role() = 'service_role'
        OR (session_user <> 'authenticator' AND COALESCE(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated'))
    THEN EXISTS (
        SELECT 1
        FROM public.chat_roles
        WHERE user_id = check_user
          AND role = 'admin'
          AND NOT COALESCE(is_blocked, false)
    )
    ELSE false END;
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
    SELECT CASE WHEN check_user IS NOT DISTINCT FROM auth.uid()
        OR auth.role() = 'service_role'
        OR (session_user <> 'authenticator' AND COALESCE(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated'))
        OR public.is_chat_moderator(auth.uid())
    THEN EXISTS (
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
              OR EXISTS (
                  SELECT 1 FROM public.chat_roles r
                  WHERE r.user_id = check_user
                    AND r.role IN ('admin', 'moderator')
                    AND NOT COALESCE(r.is_blocked, false)
              )
          )
    )
    ELSE false END;
$$;

-- CREATE OR REPLACE keeps the grants; stated again so the file says who may call.
REVOKE ALL ON FUNCTION public.is_chat_moderator(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_chat_admin(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_chat_channel(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_chat_moderator(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_chat_admin(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_chat_channel(UUID, UUID) TO authenticated, service_role;

-- ── 2. The end of a crew membership ends its Crew Chat membership ────────
-- Everything is inside one exception block, so nothing here can fail or
-- block a crew change (2026-10-02: one failing vessel_crew trigger made every
-- Accept do nothing); at worst it warns. An Accept (pending to accepted) and
-- an update that keeps the pair accepted return at the first tests, before
-- the turn is taken.

CREATE OR REPLACE FUNCTION public.forget_crew_chat_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        IF OLD.crew_user_id IS NULL OR OLD.owner_id IS NULL OR OLD.status IS DISTINCT FROM 'accepted' THEN
            RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.status = 'accepted' AND NEW.crew_user_id = OLD.crew_user_id AND NEW.owner_id = OLD.owner_id THEN
                RETURN NULL;
            END IF;
        END IF;
        -- One skipper's crew changes take turns, so the test below sees a
        -- parallel removal of the same pair's other row once it commits.
        PERFORM pg_advisory_xact_lock(hashtextextended('crew_chat_membership:' || OLD.owner_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM public.vessel_crew AS m
             WHERE m.owner_id = OLD.owner_id
               AND m.crew_user_id = OLD.crew_user_id
               AND m.status = 'accepted'
        ) THEN
            RETURN NULL;
        END IF;
        DELETE FROM public.channel_members AS cm
         USING public.chat_channels AS c
         WHERE cm.channel_id = c.id
           AND cm.user_id = OLD.crew_user_id
           AND c.owner_id = OLD.owner_id
           AND c.is_private
           AND c.icon = '👥'
           AND cm.user_id IS DISTINCT FROM c.owner_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'forget_crew_chat_membership: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forget_crew_chat_membership() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.forget_crew_chat_membership() IS
    'AFTER UPDATE OF status, crew_user_id, owner_id OR DELETE on vessel_crew: when an accepted crew membership ends and no other accepted row remains for that skipper and person, removes their channel_members rows in the skipper''s private 👥 rooms. Never raises (2026-10-10).';

DROP TRIGGER IF EXISTS trg_vessel_crew_forget_chat_membership ON public.vessel_crew;
CREATE TRIGGER trg_vessel_crew_forget_chat_membership
    AFTER UPDATE OF status, crew_user_id, owner_id OR DELETE ON public.vessel_crew
    FOR EACH ROW EXECUTE FUNCTION public.forget_crew_chat_membership();

-- join_accepted_crew_channels takes the same turn first; everything else is
-- as 20260723090000 wrote it (section 0 checked that is what is here).
CREATE OR REPLACE FUNCTION public.join_accepted_crew_channels(p_owner_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE joined_count INTEGER;
BEGIN
    -- Takes turns with forget_crew_chat_membership for this skipper (20261010154000).
    PERFORM pg_advisory_xact_lock(hashtextextended('crew_chat_membership:' || p_owner_id::text, 0));
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

-- ── 3. One-off sweep: memberships already left behind ────────────────────
-- The trigger's own conditions, applied to what is there today.

DO $sweep$
DECLARE
    orphans INTEGER;
BEGIN
    SELECT count(*) INTO orphans
      FROM public.channel_members AS cm
      JOIN public.chat_channels AS c ON c.id = cm.channel_id
     WHERE c.is_private
       AND c.icon = '👥'
       AND c.owner_id IS NOT NULL
       AND cm.user_id IS DISTINCT FROM c.owner_id
       AND NOT EXISTS (
           SELECT 1 FROM public.vessel_crew AS m
            WHERE m.owner_id = c.owner_id
              AND m.crew_user_id = cm.user_id
              AND m.status = 'accepted'
       );

    IF orphans > 10 THEN
        RAISE EXCEPTION 'chat membership: % crew-room memberships have no accepted crew row (expected 0); refusing to remove that many, nothing changed', orphans;
    END IF;

    DELETE FROM public.channel_members AS cm
     USING public.chat_channels AS c
     WHERE cm.channel_id = c.id
       AND c.is_private
       AND c.icon = '👥'
       AND c.owner_id IS NOT NULL
       AND cm.user_id IS DISTINCT FROM c.owner_id
       AND NOT EXISTS (
           SELECT 1 FROM public.vessel_crew AS m
            WHERE m.owner_id = c.owner_id
              AND m.crew_user_id = cm.user_id
              AND m.status = 'accepted'
       );

    RAISE NOTICE 'chat membership: removed % crew-room membership(s) with no accepted crew row', orphans;
END;
$sweep$;

-- ── 4. Fail the push unless all of it is in place ────────────────────────

DO $check$
DECLARE
    helper TEXT;
    signature REGPROCEDURE;
    fn RECORD;
    trigger_row RECORD;
    join_fn RECORD;
    orphans INTEGER;
BEGIN
    FOREACH helper IN ARRAY ARRAY[
        'public.can_access_chat_channel(uuid,uuid)',
        'public.is_chat_moderator(uuid)',
        'public.is_chat_admin(uuid)'
    ] LOOP
        signature := to_regprocedure(helper);
        IF signature IS NULL THEN
            RAISE EXCEPTION 'chat membership question: % is missing its guard', helper;
        END IF;
        SELECT p.prosecdef, p.proconfig, p.prosrc, p.provolatile INTO fn FROM pg_proc AS p WHERE p.oid = signature;
        IF position('CASE WHEN check_user IS NOT DISTINCT FROM auth.uid()' IN fn.prosrc) = 0
           OR position('auth.role() = ''service_role''' IN fn.prosrc) = 0
           OR position('session_user <> ''authenticator''' IN fn.prosrc) = 0
           OR position('ELSE false END' IN fn.prosrc) = 0 THEN
            RAISE EXCEPTION 'chat membership question: % is missing its guard', helper;
        END IF;
        IF NOT fn.prosecdef OR fn.provolatile <> 's'
           OR NOT COALESCE(fn.proconfig, '{}'::text[]) @> ARRAY['search_path=public'] THEN
            RAISE EXCEPTION 'chat membership question: % lost security definer or its search_path', helper;
        END IF;
        IF has_function_privilege('anon', signature, 'EXECUTE')
           OR NOT has_function_privilege('authenticated', signature, 'EXECUTE')
           OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
            RAISE EXCEPTION 'chat membership question: execute on % is wrong', helper;
        END IF;
    END LOOP;

    signature := to_regprocedure('public.forget_crew_chat_membership()');
    IF signature IS NULL
       OR NOT (SELECT p.prosecdef FROM pg_proc AS p WHERE p.oid = signature)
       OR NOT COALESCE((SELECT p.proconfig FROM pg_proc AS p WHERE p.oid = signature), '{}'::text[])
              @> ARRAY['search_path=pg_catalog, public, pg_temp']
       OR has_function_privilege('anon', signature, 'EXECUTE')
       OR has_function_privilege('authenticated', signature, 'EXECUTE')
       OR has_function_privilege('public', signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'crew removal: forget_crew_chat_membership is missing, not a definer, or callable by clients';
    END IF;
    IF position('pg_advisory_xact_lock(hashtextextended(''crew_chat_membership:'' || OLD.owner_id::text, 0))'
                IN (SELECT p.prosrc FROM pg_proc AS p WHERE p.oid = signature)) = 0 THEN
        RAISE EXCEPTION 'crew removal: forget_crew_chat_membership does not take its turn';
    END IF;

    -- AFTER (no BEFORE bit), FOR EACH ROW (1), DELETE (8) and UPDATE (16), no INSERT (4): tgtype 25.
    SELECT t.tgtype, t.tgenabled, t.tgfoid,
           (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(t.tgattr::int2[]) AS k(attnum)
              JOIN pg_attribute AS a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum) AS columns
      INTO trigger_row
      FROM pg_trigger AS t
     WHERE t.tgrelid = 'public.vessel_crew'::regclass
       AND t.tgname = 'trg_vessel_crew_forget_chat_membership'
       AND NOT t.tgisinternal;
    IF NOT FOUND
       OR trigger_row.tgtype <> 25
       OR trigger_row.tgenabled = 'D'
       OR trigger_row.tgfoid <> signature
       OR trigger_row.columns IS DISTINCT FROM ARRAY['crew_user_id', 'owner_id', 'status'] THEN
        RAISE EXCEPTION 'crew removal: trg_vessel_crew_forget_chat_membership is missing or wrong';
    END IF;

    SELECT p.oid, p.prosecdef, p.proconfig, p.prosrc INTO join_fn
      FROM pg_proc AS p
     WHERE p.oid = to_regprocedure('public.join_accepted_crew_channels(uuid)');
    IF NOT FOUND
       OR NOT join_fn.prosecdef
       OR NOT COALESCE(join_fn.proconfig, '{}'::text[]) @> ARRAY['search_path=public']
       OR position('pg_advisory_xact_lock(hashtextextended(''crew_chat_membership:'' || p_owner_id::text, 0))' IN join_fn.prosrc) = 0
       OR has_function_privilege('anon', join_fn.oid, 'EXECUTE')
       OR has_function_privilege('public', join_fn.oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', join_fn.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'crew removal: join_accepted_crew_channels is missing, does not take its turn, or has the wrong EXECUTE';
    END IF;

    SELECT count(*) INTO orphans
      FROM public.channel_members AS cm
      JOIN public.chat_channels AS c ON c.id = cm.channel_id
     WHERE c.is_private
       AND c.icon = '👥'
       AND c.owner_id IS NOT NULL
       AND cm.user_id IS DISTINCT FROM c.owner_id
       AND NOT EXISTS (
           SELECT 1 FROM public.vessel_crew AS m
            WHERE m.owner_id = c.owner_id
              AND m.crew_user_id = cm.user_id
              AND m.status = 'accepted'
       );
    IF orphans > 0 THEN
        RAISE EXCEPTION 'crew removal: % orphan membership(s) remain', orphans;
    END IF;
END;
$check$;

RESET lock_timeout;
