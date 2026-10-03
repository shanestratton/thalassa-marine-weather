-- watch_assignments becomes owner-only to read, apart from each crew member's
-- OWN assigned rows; crew read the whole watch bill by name (Shane 2026-10-03,
-- about crew still being able to read assigned crew emails from the watch
-- schedule: "yes place on your list").
--
-- The leak: watch_assignments_crew_read (20260723104000) let crew holding the
-- passage checklist permission SELECT whole watch_assignments rows over REST:
-- assigned_crew_email for every watch on the skipper's passage, and
-- assigned_crew_name, which the assign sheet derives from that email's local
-- part (WatchAssignSheet emailToName). f7d9863f stopped the app SHOWING
-- either to crew; the rows still carried them. The repository is public, so
-- the policy is discoverable.
--
-- After this:
--   - the passage owner reads and writes the raw rows exactly as before,
--     through the unchanged watch_assignments_owner_all (FOR ALL);
--   - crew who may see the watch schedule read, raw, only the rows that are
--     their OWN watches (watch_assignments_crew_read_own): assigned, and
--     naming them by user id or by their own sign-in address. Such a row
--     only ever carries the reader's own address, so no peer email leaves;
--   - for the rest of the bill crew call public.get_crew_watch_bill: per
--     watch its index, label and time, whether it is assigned, whether it is
--     the caller's own, and the assigned person's name parts from their own
--     name record. Never an email, a user id, the stored email-derived label,
--     or who assigned it.
--
-- Why crew keep their own raw rows: a crew phone on a build from before the
-- by-name read (f7d9863f or older) selects the raw rows and keeps the ones
-- carrying its own address. With the crew read simply dropped it would get
-- [] with no error: WatchAlarmService.scheduleForVoyage cancels before it
-- reschedules, so its pre-watch alarms would be cancelled at sea and The
-- Glass's Watch page would vanish. With the own-rows read it keeps both; only
-- its read-only card shows peers' watches as 'Not assigned' until it updates.
-- So this is safe to push before every crew phone has the new build.
--
-- Contract of get_crew_watch_bill(p_voyage_id):
--   - NULL for a signed-out caller and for anyone the dropped policy would not
--     have shown the rows to. The gate is that policy's own: the voyages row
--     whose id::TEXT is the voyage_id, and can_access_passage(owner, voyage,
--     'can_view_passage_checklist'), which the owner passes too. Never an
--     error, so the answer is no oracle and looks like an empty RLS read.
--   - assigned: the email is present, the skipper's own card's rule
--     (WatchScheduleCard isAssigned), so both cards agree on every slot.
--   - isSelf: an assigned row that names the caller by user id, or by the
--     caller's OWN auth address (WatchAlarmService and myWatches matched by
--     address; the read-only card by user id). Pre-watch alarms keep firing.
--     These are the rows watch_assignments_crew_read_own lets the caller
--     read raw (that policy takes the address from the sign-in token).
--   - names: only for the voyage owner and the owner's ACCEPTED crew, the
--     people get_crew_vessel_view's manifest names. From boat_members on one
--     of the owner's live hulls (the voyage's own hull first), else the
--     person's own auth name metadata, else none (the app reads 'Crew').
--     Never user_name_parts or the stored assigned_crew_name: both fall back
--     to the email's local part.
--
-- Readers and writers audited 2026-10-03 (repository and live catalogue,
-- read-only):
--   - services/WatchAssignmentService.ts is the only client that touches the
--     table: list (select), assign (upsert), clear/clearAll (delete), and
--     publishToCrew (the skipper's list, his vessel_crew rows and
--     queue_watch_schedule_push). WatchAlarmService, myWatches (The Glass's
--     Watch page) and WatchScheduleCard read through list(). The client keeps
--     the raw read when it holds a row this account assigned or a row that is
--     not its own (the skipper's read, or crew's before this push); otherwise
--     (nothing, or only its own watches) it asks get_crew_watch_bill, and
--     treats PGRST202 / 42883 as "not pushed yet", so the app works before
--     AND after.
--   - Live functions that read it are SECURITY DEFINER and unaffected by RLS:
--     queue_watch_schedule_push (gated on wa.assigned_by = auth.uid(), the
--     skipper) and scrub_account_deletion_survivors. Its triggers
--     (account_deletion_write_fence, trg_watch_assignments_updated_at) are
--     write-side only.
--   - No edge function, Pi service or public page reads it; send-push only
--     formats the queued 'watch_schedule_published' push.
--   - It is in no realtime publication, so the client's postgres_changes
--     listener has never delivered a row to anyone; crew refresh on the
--     skipper's 'schedule_published' broadcast, whose payload has no names.
--   - Live policies: watch_assignments_owner_all and
--     watch_assignments_crew_read, nothing else. Service-role readers bypass
--     RLS and are unaffected.
--
-- Order matters, so crew never lose the bill and the skipper never loses his
-- rows: the by-name read and the own-rows policy are created FIRST, only then
-- is the crew policy dropped, and the guard refuses to finish unless RLS is
-- on, the by-name read exists, the owner policy still reads and writes, the
-- own-rows policy is SELECT-only and self-limited, and no other policy can
-- read the table.
--
-- Written, NOT pushed: Shane says "yes, push it" first. It needs no app
-- release first (see above), and is safe to push after 20261003130000.
--
-- After the push, check it as the crew user in a rolled-back transaction and
-- print key names and counts only:
--   BEGIN;
--   SELECT set_config('request.jwt.claims',
--       '{"sub":"<crew uuid>","email":"<crew address>","role":"authenticated"}', true);
--   SET LOCAL ROLE authenticated;
--   SELECT count(*) FROM public.watch_assignments;          -- the crew member's own watches only
--   SELECT count(DISTINCT lower(assigned_crew_email)) FROM public.watch_assignments;  -- 0 or 1
--   SELECT jsonb_object_keys(public.get_crew_watch_bill('<voyage uuid>'));
--   SELECT jsonb_array_length(public.get_crew_watch_bill('<voyage uuid>')->'watches');
--   ROLLBACK;

CREATE OR REPLACE FUNCTION public.get_crew_watch_bill(p_voyage_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    caller UUID := auth.uid();
    caller_address TEXT;
    passage_id UUID;
    passage_owner UUID;
    passage_boat UUID;
    watches JSONB;
BEGIN
    IF caller IS NULL OR p_voyage_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT voyage.id, voyage.user_id, voyage.boat_id
      INTO passage_id, passage_owner, passage_boat
      FROM public.voyages AS voyage
     WHERE voyage.id::TEXT = p_voyage_id
       AND public.can_access_passage(voyage.user_id, voyage.id, 'can_view_passage_checklist')
     LIMIT 1;

    IF passage_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT lower(btrim(u.email))
      INTO caller_address
      FROM auth.users AS u
     WHERE u.id = caller;

    WITH people AS (
        SELECT passage_owner AS person_id
        UNION
        SELECT m.crew_user_id
          FROM public.vessel_crew AS m
         WHERE m.owner_id = passage_owner
           AND m.status = 'accepted'
           AND m.crew_user_id IS NOT NULL
    )
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_strip_nulls(jsonb_build_object(
                       'watchIndex', slot.watch_index,
                       'watchLabel', slot.watch_label,
                       'watchTimeLabel', slot.watch_time_label,
                       'assigned', slot.is_assigned,
                       'isSelf', slot.is_self,
                       'prefix', NULLIF(btrim(slot.prefix), ''),
                       'firstName', NULLIF(btrim(slot.first_name), ''),
                       'nickname', NULLIF(btrim(slot.nickname), ''),
                       'lastName', NULLIF(btrim(slot.last_name), '')
                   ))
                   ORDER BY slot.watch_index
               ),
               '[]'::JSONB
           )
      INTO watches
      FROM (
          SELECT w.watch_index,
                 left(w.watch_label, 200) AS watch_label,
                 left(w.watch_time_label, 200) AS watch_time_label,
                 assigned.yes AS is_assigned,
                 assigned.yes AND COALESCE(
                     w.assigned_crew_user_id = caller
                     OR lower(btrim(w.assigned_crew_email)) = caller_address,
                     FALSE
                 ) AS is_self,
                 CASE WHEN bm.found THEN bm.prefix ELSE meta.prefix END AS prefix,
                 CASE WHEN bm.found THEN bm.first_name ELSE meta.first_name END AS first_name,
                 CASE WHEN bm.found THEN bm.nickname ELSE meta.nickname END AS nickname,
                 CASE WHEN bm.found THEN bm.last_name ELSE meta.last_name END AS last_name
            FROM public.watch_assignments AS w
           CROSS JOIN LATERAL (
               SELECT NULLIF(btrim(w.assigned_crew_email), '') IS NOT NULL AS yes
           ) AS assigned
            LEFT JOIN people
              ON assigned.yes
             AND people.person_id = w.assigned_crew_user_id
            LEFT JOIN LATERAL (
                SELECT TRUE AS found,
                       left(bm.prefix, 40) AS prefix,
                       left(bm.first_name, 80) AS first_name,
                       left(bm.nickname, 80) AS nickname,
                       left(bm.last_name, 80) AS last_name
                  FROM public.boat_members AS bm
                  JOIN public.boats AS boat
                    ON boat.id = bm.boat_id
                 WHERE bm.user_id = people.person_id
                   AND boat.owner_id = passage_owner
                   AND boat.archived_at IS NULL
                 ORDER BY (boat.id = passage_boat) DESC NULLS LAST, boat.updated_at DESC, boat.id
                 LIMIT 1
            ) AS bm ON TRUE
            LEFT JOIN LATERAL (
                SELECT CASE WHEN jsonb_typeof(u.raw_user_meta_data->'prefix') = 'string'
                            THEN left(u.raw_user_meta_data->>'prefix', 40) END AS prefix,
                       CASE WHEN jsonb_typeof(u.raw_user_meta_data->'first_name') = 'string'
                            THEN left(u.raw_user_meta_data->>'first_name', 80) END AS first_name,
                       CASE WHEN jsonb_typeof(u.raw_user_meta_data->'nickname') = 'string'
                            THEN left(u.raw_user_meta_data->>'nickname', 80) END AS nickname,
                       CASE WHEN jsonb_typeof(u.raw_user_meta_data->'last_name') = 'string'
                            THEN left(u.raw_user_meta_data->>'last_name', 80) END AS last_name
                  FROM auth.users AS u
                 WHERE u.id = people.person_id
            ) AS meta ON bm.found IS NULL
           WHERE w.voyage_id = p_voyage_id
      ) AS slot;

    RETURN jsonb_build_object('version', 1, 'watches', COALESCE(watches, '[]'::JSONB));
END;
$$;

REVOKE ALL ON FUNCTION public.get_crew_watch_bill(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crew_watch_bill(TEXT) TO authenticated;

COMMENT ON FUNCTION public.get_crew_watch_bill(TEXT) IS
    'Watch bill by name (2026-10-03): per watch its label, time, assigned and self flags, and the person''s own name parts. No emails or user ids. NULL unless the caller may see the passage checklist.';

-- Crew's own watches, raw: exactly the rows get_crew_watch_bill marks isSelf
-- (assigned, and naming the caller by user id or by the caller's own
-- sign-in address), behind the dropped policy's own gate, so a removed crew
-- member reads nothing. A row read here only ever carries the reader's own
-- address. SELECT only: writes stay the owner's (watch_assignments_owner_all).
DROP POLICY IF EXISTS watch_assignments_crew_read_own ON public.watch_assignments;
CREATE POLICY watch_assignments_crew_read_own
    ON public.watch_assignments FOR SELECT TO authenticated
    USING (
        NULLIF(btrim(assigned_crew_email), '') IS NOT NULL
        AND (
            assigned_crew_user_id = auth.uid()
            OR lower(btrim(assigned_crew_email)) = lower(NULLIF(btrim(auth.jwt() ->> 'email'), ''))
        )
        AND EXISTS (
            SELECT 1
              FROM public.voyages AS voyage
             WHERE voyage.id::TEXT = watch_assignments.voyage_id
               AND public.can_access_passage(voyage.user_id, voyage.id, 'can_view_passage_checklist')
        )
    );

COMMENT ON POLICY watch_assignments_crew_read_own ON public.watch_assignments IS
    'Crew read their OWN assigned watches raw (2026-10-03), so older app builds keep their pre-watch alarms. The rest of the bill is by name through get_crew_watch_bill.';

DROP POLICY IF EXISTS watch_assignments_crew_read ON public.watch_assignments;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = 'public.watch_assignments'::regclass
           AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'watch_assignments has row level security off; refusing to continue';
    END IF;
    IF to_regprocedure('public.get_crew_watch_bill(text)') IS NULL THEN
        RAISE EXCEPTION 'public.get_crew_watch_bill(text) is missing; crew would lose the watch bill';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS policy
         WHERE policy.schemaname = 'public'
           AND policy.tablename = 'watch_assignments'
           AND policy.policyname = 'watch_assignments_owner_all'
           AND policy.cmd = 'ALL'
           AND policy.qual ~ 'voyages\.user_id = auth\.uid\(\)'
           AND policy.with_check ~ 'voyages\.user_id = auth\.uid\(\)'
    ) THEN
        RAISE EXCEPTION 'watch_assignments has no owner policy; refusing to leave the skipper without his watch bill';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS policy
         WHERE policy.schemaname = 'public'
           AND policy.tablename = 'watch_assignments'
           AND policy.policyname = 'watch_assignments_crew_read_own'
           AND policy.cmd = 'SELECT'
           AND policy.permissive = 'PERMISSIVE'
           AND policy.roles = ARRAY['authenticated']::NAME[]
           AND policy.qual ~ 'assigned_crew_user_id = auth\.uid\(\)'
           AND policy.qual ~ 'auth\.jwt\(\) ->> ''email'''
           AND policy.qual ~ 'can_access_passage\(voyage\.user_id, voyage\.id, ''can_view_passage_checklist'''
    ) THEN
        RAISE EXCEPTION 'watch_assignments_crew_read_own is missing or no longer limited to the caller''s own watches';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS policy
         WHERE policy.schemaname = 'public'
           AND policy.tablename = 'watch_assignments'
           AND policy.cmd IN ('SELECT', 'ALL')
           AND (
               policy.policyname NOT IN ('watch_assignments_owner_all', 'watch_assignments_crew_read_own')
               OR (
                   policy.policyname = 'watch_assignments_owner_all'
                   AND COALESCE(policy.qual, '') ~ '(can_access_passage|vessel_crew)'
               )
           )
    ) THEN
        RAISE EXCEPTION 'watch_assignments still has a read policy other than the owner''s and the crew''s own-watch read';
    END IF;
END;
$$;
