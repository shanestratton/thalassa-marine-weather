-- Four drift policies closed: crew chats, join requests, the admin audit log
-- and Guardian alerts (2026-10-09).
--
-- Why
-- ───
-- A sweep of the live database on 2026-10-09 found four policies that no
-- migration ever created. Permissive policies are OR'd, so each one overrode
-- the scoped policies the migrations wrote, and anon and authenticated also
-- held every table privilege on all four tables:
--
--   channel_members_all        channel_members        FOR ALL TO public
--                                                     USING (true) WITH CHECK (true)
--   channel_join_requests_all  channel_join_requests  FOR ALL TO public
--                                                     USING (true) WITH CHECK (true)
--   audit_log_all              admin_audit_log        FOR ALL TO public
--                                                     USING (true) WITH CHECK (true)
--   "Authenticated users       guardian_alerts        FOR INSERT TO public
--    create alerts"                                   WITH CHECK (auth.role() = 'authenticated')
--
-- What each one allowed, until this file:
--   * channel_members: can_access_chat_channel(), the gate behind
--     chat_channels_visible, chat_messages_visible and chat_messages_create,
--     says yes as soon as a channel_members row exists for the caller. Any
--     signed-in account could insert its own row into any private crew chat,
--     then read it, post in it and receive it live. Anyone holding the public
--     (anon) key could list every membership and delete them all.
--   * channel_join_requests: anyone could read every request, write one
--     already 'approved', or delete anyone's.
--   * admin_audit_log: anyone holding the public key could read the whole
--     moderation trail (who was blocked, muted, promoted, which channels were
--     deleted), write entries under any actor, and rewrite or erase it.
--   * guardian_alerts: any signed-in account could insert an alert directly,
--     with any source_user_id, source_vessel_name, target, type, text and
--     position, skipping every check in broadcast_guardian_alert_with_receipt
--     (sender is the caller, armed with a position under 5 minutes old, 3 an
--     hour, only 'suspicious' and 'weather_spike' from a user). The armed-user
--     trigger only covers those two types, so a forged 'bolo', 'drag_warning',
--     'geofence_breach' or 'hail' aimed at someone shows up in that account's
--     Guardian feed when its position is near them.
--
-- A read-only audit on 2026-10-09 found no sign any of it was used: 40
-- memberships = 27 owner rows + 13 rows of the one accepted crew member in the
-- owner's channels, 0 unexplained; 0 join requests; 11 audit rows, all by the
-- one admin, all 'approve_channel' or 'delete_channel', March to July 2026;
-- 0 Guardian alerts (a 7-day cron clears older ones). Reads, erasures and
-- alerts older than 7 days leave no trace in the database; only the API
-- request logs could show them.
--
-- Who uses these tables (checked against the code, builds 102-124 included)
-- ──────────────────────────────────────────────────────────────────────────
-- channel_members / channel_join_requests: services/ChatService.ts, signed in
--   only. The scoped policies from 20260723090000 cover every path; crew join
--   through join_accepted_crew_channels (SECURITY DEFINER).
-- admin_audit_log:
--   write  ChatService.logAuditForOperation, a plain insert (no RETURNING) with
--          actor_id = the caller, after a moderator or admin action (unmute,
--          set role, block, unblock, approve/reject/delete channel)
--          -> admin_audit_insert (actor_id = auth.uid() AND is_chat_moderator)
--   read   ChatService.getAuditLog, the Admin Panel -> admin_audit_read
--          (is_chat_admin)
--   server scrub_account_deletion_survivors (SECURITY DEFINER, service_role)
--          nulls actor_id when an account is deleted; RLS does not apply.
--   Nothing updates or deletes a row as a signed-in user, and nothing uses
--   the anon key.
-- guardian_alerts:
--   write  only SECURITY DEFINER functions owned by postgres:
--          broadcast_guardian_alert_with_receipt (builds 113+),
--          broadcast_guardian_alert (builds 102-112, delegates to it),
--          queue_guardian_watchdog_alert (service_role, the ais-ingest
--          watchdog) and scrub_account_deletion_survivors (service_role).
--   read   guardian_alerts_nearby (SECURITY DEFINER). No build reads the
--          table directly or subscribes to it over realtime.
--   So no client writes this table and nothing uses the anon key.
--
-- What changes
-- ────────────
-- 1. channel_members: channel_members_all is dropped and the three scoped
--    policies are re-pinned exactly as 20260723090000 wrote them (live
--    matches). anon and PUBLIC lose every privilege; authenticated keeps
--    SELECT, INSERT, UPDATE, DELETE.
--      UPDATE stays on purpose. approveJoinRequest upserts with onConflict
--      'channel_id,user_id', which is INSERT ... ON CONFLICT DO UPDATE, and
--      Postgres requires the UPDATE privilege for that statement even when
--      nothing conflicts. Without it every approval would mark the request
--      approved, add nobody, and still report success (the client ignores
--      the upsert's error). There is no UPDATE policy, so no row can actually
--      be updated.
-- 2. channel_join_requests: channel_join_requests_all is dropped.
--    join_requests_read / _create / _review / _delete (20260723090000, live
--    matches) stay as they are and cover every app path. anon and PUBLIC lose
--    every privilege; authenticated keeps SELECT, INSERT, UPDATE, DELETE.
-- 3. admin_audit_log: audit_log_all is dropped; admin_audit_insert and
--    admin_audit_read are re-pinned as 20260723090000 wrote them (live
--    matches). anon and PUBLIC lose every privilege. authenticated keeps
--    SELECT and INSERT and loses UPDATE and DELETE: the trail is append-only
--    for clients, with or without a policy.
-- 4. guardian_alerts: "Authenticated users create alerts" is dropped; "Users
--    read related guardian alerts" is re-pinned as 20260730120000 wrote it
--    (live matches). anon and PUBLIC lose every privilege. authenticated
--    keeps SELECT only: every write goes through the definer functions above.
-- 5. On all four, authenticated also loses TRUNCATE, REFERENCES, TRIGGER and
--    (PostgreSQL 17+) MAINTAIN. service_role is untouched.
-- 6. The push fails unless each table has exactly the expected policy set, no
--    open policy, no anon/PUBLIC privilege and exactly the authenticated
--    privileges above.
--
-- Not here: chat_channels_visible's owner branch, which lets a skipper who is
-- not a chat moderator create a Crew Chat, is 20261009171000. It has to ship
-- with build 125's Crew Chat fix, because builds 102-124 look the room up by
-- name and would make a duplicate room on every tap.
--
-- Builds: none needs a change. Replayed on live inside rolled-back
-- transactions with this file applied twice: owner adds and removes members,
-- crew invite accept and join_accepted_crew_channels, crew reads and leaving,
-- join-request approve/reject/withdraw, an admin approving a proposal and
-- reading the audit log, a moderator's audit entry, the Guardian broadcast
-- (both RPC names) and its feed, DMs and public channels all still work.
-- One harmless difference: approving a join request for someone who is
-- already a member now fails on the conflict branch instead of updating
-- nothing. The client discards that error and the person is a member either
-- way.
--
-- Undo
-- ────
-- Never recreate any of the four policies above. If a client path turns out
-- to need a privilege taken here, grant that one privilege back to
-- authenticated; never to anon.
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

-- ── 3. admin_audit_log ────────────────────────────────────────────────────

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_all" ON public.admin_audit_log;

DROP POLICY IF EXISTS "admin_audit_insert" ON public.admin_audit_log;
CREATE POLICY "admin_audit_insert" ON public.admin_audit_log FOR INSERT TO authenticated
WITH CHECK (actor_id = auth.uid() AND public.is_chat_moderator(auth.uid()));

DROP POLICY IF EXISTS "admin_audit_read" ON public.admin_audit_log;
CREATE POLICY "admin_audit_read" ON public.admin_audit_log FOR SELECT TO authenticated
USING (public.is_chat_admin(auth.uid()));

REVOKE ALL ON TABLE public.admin_audit_log FROM PUBLIC, anon;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.admin_audit_log FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO authenticated;

-- ── 4. guardian_alerts ────────────────────────────────────────────────────

ALTER TABLE public.guardian_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users create alerts" ON public.guardian_alerts;

DROP POLICY IF EXISTS "Users read related guardian alerts" ON public.guardian_alerts;
CREATE POLICY "Users read related guardian alerts" ON public.guardian_alerts FOR SELECT TO authenticated
USING (source_user_id = auth.uid() OR target_user_id = auth.uid());

REVOKE ALL ON TABLE public.guardian_alerts FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.guardian_alerts FROM authenticated;
GRANT SELECT ON TABLE public.guardian_alerts TO authenticated;

-- ── 5. MAINTAIN (PostgreSQL 17+; production runs 17) ─────────────────────
-- REVOKE ALL above already covers it for anon and PUBLIC.

DO $maintain$
BEGIN
    IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE 'REVOKE MAINTAIN ON TABLE public.channel_members, public.channel_join_requests, '
             || 'public.admin_audit_log, public.guardian_alerts FROM authenticated';
    END IF;
END;
$maintain$;

-- ── 6. Fail the push unless all four tables are exactly as stated ─────────
-- Catches a drift policy under a name this file does not know, and a grant
-- that crept back.

DO $check$
DECLARE
    expected_policies CONSTANT JSONB := jsonb_build_object(
        'channel_members', jsonb_build_array(
            'channel_members_add', 'channel_members_read', 'channel_members_remove'),
        'channel_join_requests', jsonb_build_array(
            'join_requests_create', 'join_requests_delete', 'join_requests_read', 'join_requests_review'),
        'admin_audit_log', jsonb_build_array(
            'admin_audit_insert', 'admin_audit_read'),
        'guardian_alerts', jsonb_build_array(
            'Users read related guardian alerts')
    );
    authenticated_keeps CONSTANT JSONB := jsonb_build_object(
        'channel_members', jsonb_build_array('SELECT', 'INSERT', 'UPDATE', 'DELETE'),
        'channel_join_requests', jsonb_build_array('SELECT', 'INSERT', 'UPDATE', 'DELETE'),
        'admin_audit_log', jsonb_build_array('SELECT', 'INSERT'),
        'guardian_alerts', jsonb_build_array('SELECT')
    );
    privileges TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    table_name TEXT;
    relation TEXT;
    actual JSONB;
    wanted JSONB;
    open_policies TEXT;
    grantee TEXT;
    privilege TEXT;
    held BOOLEAN;
BEGIN
    IF current_setting('server_version_num')::int >= 170000 THEN
        privileges := array_append(privileges, 'MAINTAIN');
    END IF;

    FOR table_name IN SELECT jsonb_object_keys(expected_policies) LOOP
        relation := 'public.' || table_name;

        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = relation::regclass) THEN
            RAISE EXCEPTION 'drift lockdown: RLS is off on %', relation;
        END IF;

        SELECT COALESCE(jsonb_agg(policyname::text ORDER BY policyname::text COLLATE "C"), '[]'::jsonb)
        INTO actual
        FROM pg_policies
        WHERE schemaname = 'public' AND tablename = table_name;
        SELECT jsonb_agg(p.policy_name ORDER BY p.policy_name COLLATE "C")
        INTO wanted
        FROM jsonb_array_elements_text(expected_policies -> table_name) AS p(policy_name);
        IF actual IS DISTINCT FROM wanted THEN
            RAISE EXCEPTION 'drift lockdown: % has policies %, expected %', relation, actual, wanted;
        END IF;

        -- Table and column grants both count: has_any_column_privilege is
        -- true for a table-level grant too.
        FOREACH grantee IN ARRAY ARRAY['anon', 'public', 'authenticated'] LOOP
            FOREACH privilege IN ARRAY privileges LOOP
                IF privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN
                    held := has_any_column_privilege(grantee, relation, privilege);
                ELSE
                    held := has_table_privilege(grantee, relation, privilege);
                END IF;
                IF grantee = 'authenticated' AND (authenticated_keeps -> table_name) @> jsonb_build_array(privilege) THEN
                    IF NOT has_table_privilege(grantee, relation, privilege) THEN
                        RAISE EXCEPTION 'drift lockdown: authenticated must keep % on %', privilege, relation;
                    END IF;
                ELSIF held THEN
                    RAISE EXCEPTION 'drift lockdown: % still holds % on %', grantee, privilege, relation;
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;

    SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO open_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('channel_members', 'channel_join_requests', 'admin_audit_log', 'guardian_alerts')
      AND (
          cmd = 'ALL'
          OR qual = 'true'
          OR with_check = 'true'
          OR roles && ARRAY['public', 'anon']::name[]
      );
    IF open_policies IS NOT NULL THEN
        RAISE EXCEPTION 'drift lockdown: open policies remain: %', open_policies;
    END IF;
END;
$check$;

RESET lock_timeout;
