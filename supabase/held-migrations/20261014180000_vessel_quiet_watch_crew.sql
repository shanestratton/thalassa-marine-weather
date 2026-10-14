-- The 'boat went quiet' watchdog, part 2: crew paging, two honest messages and
-- the all-clear (2026-10-14, build 129, package 129-08).
--
-- HELD. Written with 129, NOT pushed: supabase db push applies every pending
-- file in supabase/migrations, and this one waits until Shane has deployed
-- send-push (its boat_quiet / boat_quiet_clear mapping: one lock-screen
-- notification per boat, the page Time Sensitive) AND telemetry-relay (129-08:
-- it takes a live post whose readings' own clock has stalled, so the watchdog
-- still hears a Pi whose bus went silent). The Pi update with 129-08 comes
-- after: until a Pi sends bus_at_ms, her pages are the hedged kind below.
-- Release it by moving it
-- into supabase/migrations under a stamp newer than the newest applied
-- migration and, in the same commit, rewriting
-- tests/VesselQuietWatchCrewMigration.test.ts to read the released file (the
-- vessel vault limits were released that way on 2026-10-13, b85cd258d), then
-- push. Until it runs nothing answers vessel_quiet_watch_crew_boats(), so the
-- app keeps the crew switch hidden: no switch is offered that nothing honours.
-- The skipper's own switch shows once its column probe finds 125-11's table
-- (20261009150000, applied), and writes what that table already takes.
--
-- Shane's decisions (2026-10-13, "go with your recommendations for all
-- answers", the roadmap's recommendation for 129-08):
--
-- Who is paged
-- ────────────
-- * The owner, and every crew member with an ACCEPTED invite on her that has
--   Share Instrument Panel ticked (vessel_crew.permissions.can_view_instruments,
--   the flag vessel_telemetry_crew_reads checks, 20260907140000).
-- * Never: a pending or declined invite, a guest or passenger (the 'punter'
--   role, shown as Guest), anyone whose account is being deleted.
-- * A crew member can turn these pages off for themselves
--   (set_vessel_quiet_watch_crew_page). The owner's switch turns the watch off
--   for the boat.
--
-- When
-- ────
-- * 15 minutes of silence before a page (quiet_after_minutes, as 125).
-- * The declared weekly window (default Wed 19:30-19:50 in the boat's own
--   zone, window_tz): up to 10 minutes of a silence that falls inside it is
--   not counted. So an outage of 10 minutes or less inside the window never
--   pages; a longer one, or one outside it, pages once the counted silence
--   reaches the grace. (125 suppressed the whole window and restarted the
--   clock at its close; this replaces that.)
-- * One page per outage per recipient: the page and who got it are stored
--   under the row lock, in the same transaction as the queue rows.
-- * One all-clear when she is back, only to those the page went to, on the
--   page's own lock-screen notification (send-push collapses both on
--   data.collapse). A page still open from 125 (owner only) gets its all-clear
--   too. A page the queue still holds (its first send failed) is set aside as
--   the all-clear goes, so it can never land on top of it.
-- * The watch switched off while a page is open: those it went to are told
--   the watch is off (not that she is back), on the same notification.
-- * Flapping: for 30 minutes after an all-clear a new page needs the full
--   grace again, counted from the all-clear, with no window allowance. This
--   replaces 125's 60-minute cooldown, which could swallow a genuine second
--   outage.
-- * Day or night: these are safety pages and go at once. Nothing here holds
--   one for the night.
--
-- What it says (never more than is known)
-- ───────────────────────────────────────
-- Last heard = vessel_telemetry.updated_at, the server's receipt clock.
-- Bus = the newest time the boat's instruments spoke, as her Pi dates it
-- (extra.bus_at_ms, Pi update with 129-08), never later than last heard.
-- A Pi with 129-08 keeps posting while it is up and online, bus silent or
-- not (its post carries sent_at, its own clock; reported_at stays the
-- readings' time), so "nothing from her Pi" means her Pi or its internet.
-- * Nothing from the Pi for the grace: "Kestrel's Pi is offline, or the
--   boat's internet is down" (a Pi kept off the internet reads the same; the
--   body says only how long nothing has come).
-- * The same from an older Pi (no bus_at_ms in her last row), which stops
--   posting when her GPS clock stalls: "Kestrel's Pi has gone quiet", and the
--   body says it may be her Pi, her internet or her instruments. Its rows say
--   nothing of the bus, so it is never paged as instruments, and reported_at
--   (a GPS clock) is never taken for the bus.
-- * The Pi still reporting (heard within 5 minutes, its longest back-off) but
--   the bus silent for the grace: "Kestrel's instruments are silent".
-- * The boat's name is her own (boats.name, the telemetry row's boat, else
--   the owner's active vessel), at most 60 characters, control characters
--   removed. No name: "The boat's ...". No position is ever sent.
--
-- Undo
-- ────
--     Re-run supabase/migrations/20261009150000_vessel_quiet_watch.sql
-- (its CREATE OR REPLACE puts back the owner-only decision and watchdog; the
-- columns, the opt-outs table and the two crew calls added here stay and do
-- nothing), then
--     DROP TRIGGER IF EXISTS vessel_quiet_watch_after_switch_off ON public.vessel_quiet_watch;
--     DROP FUNCTION IF EXISTS public.vessel_quiet_watch_crew_boats(),
--         public.set_vessel_quiet_watch_crew_page(UUID, BOOLEAN);
-- (the app then hides the crew switch again).
--
-- No BEGIN/COMMIT: the CLI applies the file. Safe to re-run: IF NOT EXISTS,
-- CREATE OR REPLACE, DROP ... IF EXISTS before every trigger and constraint.
-- The cron job (vessel-quiet-watch, every minute) is not touched: it calls
-- check_vessel_quiet_watch(), replaced here. Nothing is switched on for any
-- vessel. lock_timeout is set for the session and reset at the end.

SET lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regclass('public.vessel_quiet_watch') IS NULL THEN
        RAISE EXCEPTION 'vessel_quiet_watch_crew: 20261009150000_vessel_quiet_watch is not applied';
    END IF;
    IF to_regclass('public.vessel_crew') IS NULL OR to_regclass('public.vessel_telemetry') IS NULL THEN
        RAISE EXCEPTION 'vessel_quiet_watch_crew: vessel_crew or vessel_telemetry is missing';
    END IF;
    IF to_regprocedure('public.block_tombstoned_account_write()') IS NULL THEN
        RAISE EXCEPTION 'vessel_quiet_watch_crew: block_tombstoned_account_write() (the account-deletion fence) is missing';
    END IF;
END;
$precheck$;

-- ── 1. What the open page is about, who it went to, and the last all-clear ───

ALTER TABLE public.vessel_quiet_watch
    ADD COLUMN IF NOT EXISTS paged_kind TEXT,
    ADD COLUMN IF NOT EXISTS paged_bus_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paged_recipients UUID[],
    ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

ALTER TABLE public.vessel_quiet_watch DROP CONSTRAINT IF EXISTS vessel_quiet_watch_paged_kind;
ALTER TABLE public.vessel_quiet_watch
    ADD CONSTRAINT vessel_quiet_watch_paged_kind
    CHECK (paged_kind IS NULL OR paged_kind IN ('pi_offline', 'instruments_silent'));
ALTER TABLE public.vessel_quiet_watch DROP CONSTRAINT IF EXISTS vessel_quiet_watch_paged_recipients_bound;
ALTER TABLE public.vessel_quiet_watch
    ADD CONSTRAINT vessel_quiet_watch_paged_recipients_bound
    CHECK (paged_recipients IS NULL OR cardinality(paged_recipients) <= 64);

COMMENT ON COLUMN public.vessel_quiet_watch.paged_kind IS 'What the open page said: pi_offline or instruments_silent. NULL = no page open (or a 125 page).';
COMMENT ON COLUMN public.vessel_quiet_watch.paged_bus_at IS 'The bus time the open page is about; newer bus data (and a newer row) means she is back.';
COMMENT ON COLUMN public.vessel_quiet_watch.paged_recipients IS 'Who the open page went to: only they get the all-clear.';
COMMENT ON COLUMN public.vessel_quiet_watch.cleared_at IS 'When the last all-clear went: for 30 min a new page needs the full grace from here.';

-- The client grants (20261009150000) name their columns, so none of these
-- four is writable by an app: they belong to the watchdog.

-- Switching on arms the clock and clears any old page, error and all-clear;
-- switching off clears them too (a page then open gets its closing word from
-- vessel_quiet_watch_after_switch_off, which still sees it in OLD).
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'A quiet watch stays with its owner' USING ERRCODE = '42501';
    END IF;
    IF NEW.window_tz IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.window_tz IS DISTINCT FROM OLD.window_tz)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS zone WHERE zone.name = NEW.window_tz) THEN
        RAISE EXCEPTION 'Unknown time zone: use an IANA name such as Europe/Paris' USING ERRCODE = '22023';
    END IF;
    IF (NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled)) OR NOT NEW.enabled THEN
        NEW.armed_at := CASE WHEN NEW.enabled THEN now() END;
        NEW.paged_at := NULL;
        NEW.paged_last_heard_at := NULL;
        NEW.paged_bus_at := NULL;
        NEW.paged_kind := NULL;
        NEW.paged_recipients := NULL;
        NEW.cleared_at := NULL;
        NEW.last_error_at := NULL;
        NEW.last_error_sqlstate := NULL;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_before_write() FROM PUBLIC, anon, authenticated;

-- ── 2. A crew member's "don't page me" ───────────────────────────────────────
--
-- A row means: do not page this person about this owner's boat. Written only
-- through set_vessel_quiet_watch_crew_page (below); no client grant reaches
-- the table. Removed with either account.

CREATE TABLE IF NOT EXISTS public.vessel_quiet_watch_optouts (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, owner_id),
    CONSTRAINT vessel_quiet_watch_optouts_not_own CHECK (user_id <> owner_id)
);

COMMENT ON TABLE public.vessel_quiet_watch_optouts IS
    'Crew who turned off quiet-boat pages for one boat (129-08). Written by set_vessel_quiet_watch_crew_page only.';

ALTER TABLE public.vessel_quiet_watch_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vessel_quiet_watch_optouts FROM PUBLIC, anon, authenticated;

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.vessel_quiet_watch_optouts;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.vessel_quiet_watch_optouts
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

-- ── 3. Who may be paged, and the boat's name ─────────────────────────────────

-- The one rule for crew: an accepted invite on this owner's boat with Share
-- Instrument Panel ticked, not a guest, not the owner.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_crew_qualifies(p_owner_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT p_user_id IS NOT NULL
       AND p_owner_id IS NOT NULL
       AND p_user_id <> p_owner_id
       AND EXISTS (
           SELECT 1
             FROM public.vessel_crew AS membership
            WHERE membership.owner_id = p_owner_id
              AND membership.crew_user_id = p_user_id
              AND membership.status = 'accepted'
              AND membership.role IS DISTINCT FROM 'punter'
              AND COALESCE((membership.permissions ->> 'can_view_instruments')::boolean, false)
       )
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_crew_qualifies(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- The owner first, then every qualifying crew member who has not opted out;
-- nobody whose account is being deleted. At most 64.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_recipients(p_owner_id UUID)
RETURNS UUID[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(array_agg(who.recipient ORDER BY who.is_owner DESC, who.recipient), ARRAY[]::UUID[])
      FROM (
          SELECT candidate.recipient, candidate.is_owner
            FROM (
                SELECT p_owner_id AS recipient, true AS is_owner
                UNION
                SELECT DISTINCT membership.crew_user_id, false
                  FROM public.vessel_crew AS membership
                 WHERE membership.owner_id = p_owner_id
                   AND public.vessel_quiet_watch_crew_qualifies(p_owner_id, membership.crew_user_id)
                   AND NOT EXISTS (
                       SELECT 1 FROM public.vessel_quiet_watch_optouts AS optout
                        WHERE optout.user_id = membership.crew_user_id AND optout.owner_id = p_owner_id
                   )
            ) AS candidate
           WHERE NOT EXISTS (
               SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = candidate.recipient
           )
           ORDER BY candidate.is_owner DESC, candidate.recipient
           LIMIT 64
      ) AS who
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_recipients(UUID) FROM PUBLIC, anon, authenticated;

-- Her own name: the telemetry row's boat, else the owner's active vessel,
-- only ever one of the owner's own boats.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_boat_name(p_owner_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT NULLIF(btrim(regexp_replace(left(boat.name, 60), '[[:cntrl:]]', '', 'g')), '')
      FROM public.boats AS boat
     WHERE boat.owner_id = p_owner_id
       AND boat.id = COALESCE(
           (SELECT telemetry.boat_id FROM public.vessel_telemetry AS telemetry WHERE telemetry.owner_id = p_owner_id),
           (SELECT active.boat_id FROM public.user_active_vessels AS active WHERE active.user_id = p_owner_id)
       )
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_boat_name(UUID) FROM PUBLIC, anon, authenticated;

-- ── 4. The decision, as pure expressions ─────────────────────────────────────

-- How much of the silence since p_from falls inside the latest occurrence of
-- the declared window (evaluated in the vessel's own zone, may cross
-- midnight), at most 10 minutes. Zero with no window.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_window_allowance(
    p_from TIMESTAMPTZ,
    p_now TIMESTAMPTZ,
    p_window_dow INTEGER,
    p_window_start TIME,
    p_window_end TIME,
    p_window_tz TEXT
)
RETURNS INTERVAL
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    WITH clock AS (
        SELECT p_now AT TIME ZONE p_window_tz AS local_now
        WHERE p_window_tz IS NOT NULL AND p_window_dow IS NOT NULL
          AND p_window_start IS NOT NULL AND p_window_end IS NOT NULL
          AND p_from IS NOT NULL AND p_now IS NOT NULL
    ),
    this_week AS (
        SELECT local_now,
               (local_now::date - ((EXTRACT(DOW FROM local_now)::int - p_window_dow + 7) % 7)) + p_window_start AS opens_local
        FROM clock
    ),
    occurrence AS (
        SELECT CASE WHEN opens_local > local_now THEN opens_local - interval '7 days' ELSE opens_local END AS opened_local
        FROM this_week
    ),
    span AS (
        SELECT opened_local AT TIME ZONE p_window_tz AS opened_at,
               (opened_local + CASE
                   WHEN p_window_end > p_window_start THEN p_window_end - p_window_start
                   ELSE p_window_end - p_window_start + interval '24 hours'
               END) AT TIME ZONE p_window_tz AS closes_at
        FROM occurrence
    )
    SELECT COALESCE(
        (SELECT LEAST(
                    interval '10 minutes',
                    GREATEST(interval '0', LEAST(p_now, closes_at) - GREATEST(p_from, opened_at))
                )
           FROM span),
        interval '0'
    )
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_window_allowance(
    TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TIME, TIME, TEXT
) FROM PUBLIC, anon, authenticated;

-- Verdicts:
--   off                      the watch is switched off
--   never_heard              no telemetry row: nothing to go quiet
--   recovered                a page is open and both a newer row and newer bus
--                            data have come: send the all-clear
--   already_paged            a page is open and she is still quiet: say nothing
--   page_pi_offline          nothing from the Pi for the grace
--   page_instruments_silent  the Pi reported in the last 5 min, but the bus
--                            has been silent for the grace
--   within_grace             anything else
-- Silence counts from the latest of last heard (or the bus), switch-on and,
-- within 30 min of an all-clear, the all-clear; less the window's allowance,
-- which is not given within 30 min of an all-clear.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_verdict(
    p_now TIMESTAMPTZ,
    p_enabled BOOLEAN,
    p_armed_at TIMESTAMPTZ,
    p_last_heard_at TIMESTAMPTZ,
    p_bus_at TIMESTAMPTZ,
    p_paged_at TIMESTAMPTZ,
    p_paged_last_heard_at TIMESTAMPTZ,
    p_paged_bus_at TIMESTAMPTZ,
    p_cleared_at TIMESTAMPTZ,
    p_quiet_after_minutes INTEGER,
    p_window_dow INTEGER,
    p_window_start TIME,
    p_window_end TIME,
    p_window_tz TEXT
)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    WITH settled AS (
        SELECT make_interval(mins => COALESCE(p_quiet_after_minutes, 15)) AS grace,
               COALESCE(p_cleared_at > p_now - interval '30 minutes', false) AS settling
    ),
    starts AS (
        SELECT settled.grace,
               settled.settling,
               GREATEST(p_last_heard_at, p_armed_at, CASE WHEN settled.settling THEN p_cleared_at END) AS pi_from,
               GREATEST(p_bus_at, p_armed_at, CASE WHEN settled.settling THEN p_cleared_at END) AS bus_from
        FROM settled
    ),
    counted AS (
        SELECT starts.grace,
               p_now - starts.pi_from - CASE WHEN starts.settling THEN interval '0' ELSE
                   public.vessel_quiet_watch_window_allowance(starts.pi_from, p_now, p_window_dow, p_window_start, p_window_end, p_window_tz)
               END AS pi_silence,
               p_now - starts.bus_from - CASE WHEN starts.settling THEN interval '0' ELSE
                   public.vessel_quiet_watch_window_allowance(starts.bus_from, p_now, p_window_dow, p_window_start, p_window_end, p_window_tz)
               END AS bus_silence
        FROM starts
    )
    SELECT CASE
        WHEN NOT COALESCE(p_enabled, false) THEN 'off'
        WHEN p_last_heard_at IS NULL THEN 'never_heard'
        WHEN p_paged_at IS NOT NULL
             AND p_last_heard_at > COALESCE(p_paged_last_heard_at, '-infinity'::timestamptz)
             AND COALESCE(p_bus_at, p_last_heard_at) > COALESCE(p_paged_bus_at, '-infinity'::timestamptz) THEN 'recovered'
        WHEN p_paged_at IS NOT NULL THEN 'already_paged'
        WHEN counted.pi_silence >= counted.grace THEN 'page_pi_offline'
        WHEN p_bus_at IS NOT NULL
             AND p_now - p_last_heard_at <= interval '5 minutes'
             AND counted.bus_silence >= counted.grace THEN 'page_instruments_silent'
        ELSE 'within_grace'
    END
    FROM counted
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_verdict(
    TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    INTEGER, INTEGER, TIME, TIME, TEXT
) FROM PUBLIC, anon, authenticated;

-- "18 minutes", "3 hours".
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_duration(p_minutes INTEGER)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT CASE
        WHEN GREATEST(1, COALESCE(p_minutes, 1)) = 1 THEN '1 minute'
        WHEN p_minutes < 120 THEN p_minutes || ' minutes'
        ELSE (p_minutes / 60) || ' hours'
    END
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_duration(INTEGER) FROM PUBLIC, anon, authenticated;

-- The words. p_kind: pi_offline, instruments_silent, clear_pi_offline,
-- clear_instruments_silent, clear_watch_off. p_bus_unknown: her last row did
-- not date her bus (an older Pi), so a silence may be her Pi, her internet or
-- her instruments, and the page says so.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_message(
    p_kind TEXT,
    p_boat_name TEXT,
    p_minutes INTEGER,
    p_bus_unknown BOOLEAN
)
RETURNS TABLE (title TEXT, body TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
    SELECT
        CASE
            WHEN p_kind = 'pi_offline' AND p_bus_unknown THEN
                COALESCE(p_boat_name || '’s', 'The boat’s') || ' Pi has gone quiet'
            WHEN p_kind = 'pi_offline' THEN
                COALESCE(p_boat_name || '’s Pi is offline, or the boat’s internet is down',
                         'The boat’s Pi is offline, or her internet is down')
            WHEN p_kind = 'instruments_silent' THEN
                COALESCE(p_boat_name || '’s', 'The boat’s') || ' instruments are silent'
            WHEN p_kind = 'clear_watch_off' THEN
                COALESCE(p_boat_name || '’s', 'The boat’s') || ' quiet-boat watch is off'
            ELSE COALESCE(p_boat_name || ' is reporting again', 'The boat is reporting again')
        END,
        CASE
            WHEN p_kind = 'pi_offline' AND p_bus_unknown THEN
                'Nothing from her Pi for ' || public.vessel_quiet_watch_duration(p_minutes)
                    || '. Her Pi may be off, her internet down or her instruments silent.'
                    || ' Thalassa will tell you when she reports again.'
            WHEN p_kind = 'pi_offline' THEN
                'Nothing from her Pi for ' || public.vessel_quiet_watch_duration(p_minutes)
                    || '. Thalassa will tell you when she reports again.'
            WHEN p_kind = 'instruments_silent' THEN
                'Her Pi is still reporting, but nothing from her GPS or instruments for '
                    || public.vessel_quiet_watch_duration(p_minutes)
                    || '. Thalassa will tell you when she reports again.'
            WHEN p_kind = 'clear_instruments_silent' THEN
                'Her instruments are reporting again, after ' || public.vessel_quiet_watch_duration(p_minutes) || '.'
            WHEN p_kind = 'clear_watch_off' THEN
                'The watch was switched off, so Thalassa won’t page about her, or say when she reports again, until it’s on again.'
            ELSE
                'Thalassa is hearing from her Pi again, after ' || public.vessel_quiet_watch_duration(p_minutes) || '.'
        END
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_message(TEXT, TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ── 5. The watchdog ──────────────────────────────────────────────────────────
--
-- One row's failure (a tombstoned account, an unreadable zone) is logged,
-- stamped on that row (last_error_at, last_error_sqlstate) and skipped; it
-- never stops the other boats being watched. Its pages, all-clear and paged
-- state roll back together, so a failed one is retried the next minute.
CREATE OR REPLACE FUNCTION public.check_vessel_quiet_watch()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    watch RECORD;
    verdict TEXT;
    kind TEXT;
    recipients UUID[];
    said RECORD;
    quiet_minutes INTEGER;
    collapse TEXT;
    failed_state TEXT;
BEGIN
    FOR watch IN
        SELECT q.owner_id, q.enabled, q.armed_at, q.paged_at, q.paged_last_heard_at, q.paged_bus_at,
               q.paged_kind, q.paged_recipients, q.cleared_at,
               q.quiet_after_minutes, q.window_dow, q.window_start, q.window_end, q.window_tz,
               heard.last_heard_at,
               -- NULL when her Pi does not date the bus (LEAST would skip the NULL).
               CASE WHEN heard.pi_bus_at IS NOT NULL THEN LEAST(heard.last_heard_at, heard.pi_bus_at) END AS bus_at,
               heard.pi_bus_at IS NULL AS bus_unknown
        FROM public.vessel_quiet_watch AS q
        LEFT JOIN LATERAL (
            SELECT COALESCE(t.updated_at, t.reported_at) AS last_heard_at,
                   CASE
                       WHEN jsonb_typeof(t.extra -> 'bus_at_ms') = 'number'
                            AND (t.extra ->> 'bus_at_ms')::numeric BETWEEN 1000000000000 AND 100000000000000
                       THEN to_timestamp((t.extra ->> 'bus_at_ms')::double precision / 1000)
                   END AS pi_bus_at
            FROM public.vessel_telemetry AS t
            WHERE t.owner_id = q.owner_id
        ) AS heard ON true
        WHERE q.enabled
          AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = q.owner_id)
        FOR UPDATE OF q SKIP LOCKED
    LOOP
        BEGIN
            verdict := public.vessel_quiet_watch_verdict(
                now(), watch.enabled, watch.armed_at, watch.last_heard_at, watch.bus_at,
                watch.paged_at, watch.paged_last_heard_at, watch.paged_bus_at, watch.cleared_at,
                watch.quiet_after_minutes, watch.window_dow, watch.window_start, watch.window_end, watch.window_tz
            );
            -- One notification per boat on each phone: the page, then its all-clear over it.
            collapse := left(md5('vessel-quiet-watch:' || watch.owner_id::text), 16);

            IF verdict = 'recovered' THEN
                kind := COALESCE(watch.paged_kind, 'pi_offline');
                quiet_minutes := GREATEST(1, floor(EXTRACT(EPOCH FROM now() - CASE
                    WHEN kind = 'instruments_silent' THEN COALESCE(watch.paged_bus_at, watch.paged_last_heard_at)
                    ELSE watch.paged_last_heard_at
                END) / 60))::int;
                SELECT * INTO said FROM public.vessel_quiet_watch_message(
                    'clear_' || kind, public.vessel_quiet_watch_boat_name(watch.owner_id), quiet_minutes, false
                );

                -- A page the drain still holds (its first send failed) would land
                -- on top of this all-clear, on the same notification: done, unsent.
                UPDATE public.push_notification_queue
                SET sent_at = now(), processing_at = NULL, last_error = 'superseded by the all-clear'
                WHERE recipient_user_id = ANY (COALESCE(watch.paged_recipients, ARRAY[watch.owner_id]))
                  AND notification_type = 'boat_quiet'
                  AND sent_at IS NULL
                  AND data ->> 'collapse' = collapse;

                -- Only those the page went to (a 125 page went to the owner alone).
                INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
                SELECT paged.recipient, 'boat_quiet_clear', said.title, said.body,
                       jsonb_build_object('kind', 'boat_quiet_clear', 'collapse', collapse, 'quiet_minutes', quiet_minutes)
                  FROM unnest(COALESCE(watch.paged_recipients, ARRAY[watch.owner_id])) AS paged(recipient)
                 WHERE NOT EXISTS (
                     SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = paged.recipient
                 );

                UPDATE public.vessel_quiet_watch
                SET paged_at = NULL, paged_last_heard_at = NULL, paged_bus_at = NULL, paged_kind = NULL,
                    paged_recipients = NULL, cleared_at = now()
                WHERE owner_id = watch.owner_id;
            ELSIF verdict IN ('page_pi_offline', 'page_instruments_silent') THEN
                kind := substr(verdict, 6);
                quiet_minutes := GREATEST(1, floor(EXTRACT(EPOCH FROM now() - CASE
                    WHEN kind = 'instruments_silent' THEN watch.bus_at
                    ELSE watch.last_heard_at
                END) / 60))::int;
                recipients := public.vessel_quiet_watch_recipients(watch.owner_id);
                SELECT * INTO said FROM public.vessel_quiet_watch_message(
                    kind, public.vessel_quiet_watch_boat_name(watch.owner_id), quiet_minutes, watch.bus_unknown
                );

                UPDATE public.vessel_quiet_watch
                SET paged_at = now(), paged_last_heard_at = watch.last_heard_at, paged_bus_at = watch.bus_at,
                    paged_kind = kind, paged_recipients = recipients, last_paged_at = now()
                WHERE owner_id = watch.owner_id;

                INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
                SELECT paged.recipient, 'boat_quiet', said.title, said.body,
                       jsonb_build_object(
                           'kind', kind,
                           'collapse', collapse,
                           'last_heard_at', watch.last_heard_at,
                           'quiet_minutes', quiet_minutes
                       )
                  FROM unnest(recipients) AS paged(recipient);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            failed_state := SQLSTATE;
            RAISE WARNING 'check_vessel_quiet_watch skipped one watch (SQLSTATE %)', failed_state;
            BEGIN
                UPDATE public.vessel_quiet_watch
                SET last_error_at = now(), last_error_sqlstate = failed_state
                WHERE owner_id = watch.owner_id;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'check_vessel_quiet_watch could not record that failure (SQLSTATE %)', SQLSTATE;
            END;
        END;
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.check_vessel_quiet_watch() FROM PUBLIC, anon, authenticated;

-- Switched off while a page is open. vessel_quiet_watch_before_write clears
-- the page, so the watchdog never sends its all-clear: the switch-off tells
-- those the page went to that the watch is off (never that she is back), on
-- the page's own notification, and sets aside a page the queue still holds so
-- it cannot land after this. A failure here is logged and swallowed: it never
-- stops the skipper switching the watch off.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_after_switch_off()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    collapse TEXT;
    paged UUID[];
    said RECORD;
BEGIN
    collapse := left(md5('vessel-quiet-watch:' || OLD.owner_id::text), 16);
    paged := COALESCE(OLD.paged_recipients, ARRAY[OLD.owner_id]);
    BEGIN
        UPDATE public.push_notification_queue
        SET sent_at = now(), processing_at = NULL, last_error = 'superseded: the watch was switched off'
        WHERE recipient_user_id = ANY (paged)
          AND notification_type = 'boat_quiet'
          AND sent_at IS NULL
          AND data ->> 'collapse' = collapse;
        SELECT * INTO said FROM public.vessel_quiet_watch_message(
            'clear_watch_off', public.vessel_quiet_watch_boat_name(OLD.owner_id), 0, false
        );
        INSERT INTO public.push_notification_queue(recipient_user_id, notification_type, title, body, data)
        SELECT stood.recipient, 'boat_quiet_clear', said.title, said.body,
               jsonb_build_object('kind', 'boat_quiet_clear', 'collapse', collapse, 'reason', 'watch_off')
          FROM unnest(paged) AS stood(recipient)
         WHERE NOT EXISTS (
             SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = stood.recipient
         );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'vessel_quiet_watch_after_switch_off sent no closing word (SQLSTATE %)', SQLSTATE;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_after_switch_off() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vessel_quiet_watch_after_switch_off ON public.vessel_quiet_watch;
CREATE TRIGGER vessel_quiet_watch_after_switch_off
    AFTER UPDATE OF enabled ON public.vessel_quiet_watch
    FOR EACH ROW
    WHEN (OLD.enabled AND NOT NEW.enabled AND OLD.paged_at IS NOT NULL)
    EXECUTE FUNCTION public.vessel_quiet_watch_after_switch_off();

-- 125's decision is replaced by vessel_quiet_watch_verdict.
DROP FUNCTION IF EXISTS public.vessel_quiet_watch_decision(
    TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    INTEGER, INTEGER, TIME, TIME, TEXT
);

-- ── 6. What a crew member's Preferences reads and writes ─────────────────────
--
-- The boats this account crews with Share Instrument Panel ticked (never as a
-- guest): her name, whether her skipper has the watch on, and whether this
-- account is paged. Signed-in callers only; their own answer only.
CREATE OR REPLACE FUNCTION public.vessel_quiet_watch_crew_boats()
RETURNS TABLE (owner_id UUID, boat_name TEXT, watch_on BOOLEAN, paging_me BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT boat.owner_id,
           public.vessel_quiet_watch_boat_name(boat.owner_id),
           COALESCE((SELECT q.enabled FROM public.vessel_quiet_watch AS q WHERE q.owner_id = boat.owner_id), false),
           NOT EXISTS (
               SELECT 1 FROM public.vessel_quiet_watch_optouts AS optout
                WHERE optout.user_id = auth.uid() AND optout.owner_id = boat.owner_id
           )
      FROM (
          SELECT DISTINCT membership.owner_id
            FROM public.vessel_crew AS membership
           WHERE membership.crew_user_id = auth.uid()
             AND public.vessel_quiet_watch_crew_qualifies(membership.owner_id, auth.uid())
      ) AS boat
     WHERE auth.uid() IS NOT NULL
     ORDER BY 2 NULLS LAST, 1
$$;
REVOKE ALL ON FUNCTION public.vessel_quiet_watch_crew_boats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vessel_quiet_watch_crew_boats() TO authenticated;

-- Page me, or not, about this boat. Turning pages off needs a qualifying
-- membership; turning them back on is always the caller's own business.
CREATE OR REPLACE FUNCTION public.set_vessel_quiet_watch_crew_page(p_owner_id UUID, p_page_me BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    me UUID := auth.uid();
BEGIN
    IF me IS NULL THEN
        RAISE EXCEPTION 'Sign in to change this' USING ERRCODE = '42501';
    END IF;
    IF p_owner_id IS NULL OR p_page_me IS NULL THEN
        RAISE EXCEPTION 'Name the boat''s owner and on or off' USING ERRCODE = '22023';
    END IF;
    IF p_page_me THEN
        DELETE FROM public.vessel_quiet_watch_optouts WHERE user_id = me AND owner_id = p_owner_id;
        RETURN true;
    END IF;
    IF NOT public.vessel_quiet_watch_crew_qualifies(p_owner_id, me) THEN
        RAISE EXCEPTION 'Only crew she shares her instruments with are paged' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.vessel_quiet_watch_optouts (user_id, owner_id)
    VALUES (me, p_owner_id)
    ON CONFLICT (user_id, owner_id) DO NOTHING;
    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.set_vessel_quiet_watch_crew_page(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_vessel_quiet_watch_crew_page(UUID, BOOLEAN) TO authenticated;

RESET lock_timeout;
