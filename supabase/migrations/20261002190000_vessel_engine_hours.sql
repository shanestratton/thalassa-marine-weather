-- Engine hours become shared vessel data (Shane, 2026-10-02: "the engine hours
-- are not going across to the invitee").
--
-- The R&M engine-hours figure lived only in one device's localStorage, so the
-- skipper's iPad never saw what his iPhone held, and crew on his shared R&M
-- binder saw their own (empty) figure. This is one current reading per
-- skipper, synced like the binder tables (services/vessel/SyncService.ts,
-- register 'maintenance'; services/vessel/LocalEngineHoursService.ts).
--
-- One row per owner: user_id is UNIQUE. The row id is derived from the
-- owner (a one-way hash), so two devices that each create the row at once
-- write the SAME id and the second INSERT is ignored as a duplicate instead of
-- failing the unique owner. Not the owner id itself: realtime sends a DELETE's
-- primary key to every subscriber of the table (see 20261002150000).
--
-- The database holds every row to that id (vessel_engine_hours_id_is_owners).
-- The derivation is public (the repo is), so without it any signed-in account
-- that knows a skipper's user id could INSERT his row id under its OWN user
-- id first: RLS passes (its own row), the skipper's INSERT then meets
-- ON CONFLICT (id) DO NOTHING, is never listed back to him, and every later
-- edit of his fails "not found". Postgres checks the CHECK before it looks for
-- a conflict, so a squatted or random id is refused at INSERT.
--
-- RLS mirrors maintenance_tasks (20260723100000): the owner has full access;
-- accepted crew read it through the 'maintenance' register and write it
-- exactly where they may write maintenance_tasks (can_access_vessel_register
-- with p_write); only the owner deletes. R&M has no view-only split today
-- (p_write only narrows 'stores'): every accepted crew member the skipper
-- shares R&M with may change his engine hours, as they already edit and log
-- his tasks. No crew_rewrite_user_id trigger: the app stamps the skipper's id
-- on a crew write itself, and a reading moved to another owner would be the
-- wrong boat's.
--
-- Deploy order: the app works before this is pushed (it keeps the reading on
-- the device and skips the table quietly until the server has it), so this can
-- go in whenever Shane says yes. On 2026-10-02 the live database's newest
-- migration was 20261002120000, so `supabase db push` also applies
-- 20261002150000_binder_realtime_publication (the R&M tasks/history realtime
-- channel depends on it): ask for one yes that names both.

-- The row id for an owner's reading. MUST match engineHoursRowId in
-- services/vessel/LocalEngineHoursService.ts: the first 16 bytes of SHA-256 of
-- 'thalassa:vessel_engine_hours:v1:<owner>', as an RFC 9562 version 8 UUID.
-- e.g. owner 00000000-0000-4000-8000-000000000001 gives
-- 0c569ba4-8f18-8dad-b0d0-6ed8df8e30ac (tests/LocalEngineHoursService.test.ts).
-- Runs as the writer in the CHECK below, so authenticated keeps EXECUTE.
CREATE OR REPLACE FUNCTION public.vessel_engine_hours_row_id(p_owner UUID)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT encode(
        set_byte(set_byte(b, 6, (get_byte(b, 6) & 15) | 128), 8, (get_byte(b, 8) & 63) | 128),
        'hex'
    )::uuid
    FROM (
        SELECT substring(extensions.digest('thalassa:vessel_engine_hours:v1:' || p_owner::text, 'sha256') FROM 1 FOR 16) AS b
    ) AS owner_digest;
$$;

REVOKE ALL ON FUNCTION public.vessel_engine_hours_row_id(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vessel_engine_hours_row_id(UUID) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.vessel_engine_hours (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    hours INTEGER NOT NULL CHECK (hours >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vessel_engine_hours_id_is_owners CHECK (id = public.vessel_engine_hours_row_id(user_id))
);

ALTER TABLE public.vessel_engine_hours ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vessel_engine_hours FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vessel_engine_hours TO authenticated;

-- The same BEFORE UPDATE stamp the binder tables use (20260219000000), so an
-- edit moves updated_at on the database clock and incremental pulls see it.
DROP TRIGGER IF EXISTS trg_vessel_engine_hours_updated_at ON public.vessel_engine_hours;
CREATE TRIGGER trg_vessel_engine_hours_updated_at
    BEFORE UPDATE ON public.vessel_engine_hours
    FOR EACH ROW EXECUTE FUNCTION public.update_maintenance_tasks_updated_at();

-- A reading belongs to one owner for good. RLS checks the NEW owner only, so
-- crew who may edit the skipper's R&M could otherwise re-own his row.
CREATE OR REPLACE FUNCTION public.guard_vessel_engine_hours_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'An engine-hours reading cannot change owner';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_vessel_engine_hours_owner ON public.vessel_engine_hours;
CREATE TRIGGER trg_guard_vessel_engine_hours_owner
    BEFORE UPDATE ON public.vessel_engine_hours
    FOR EACH ROW EXECUTE FUNCTION public.guard_vessel_engine_hours_owner();

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.vessel_engine_hours;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.vessel_engine_hours
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP POLICY IF EXISTS "Register members read engine hours" ON public.vessel_engine_hours;
CREATE POLICY "Register members read engine hours"
    ON public.vessel_engine_hours FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', false));

DROP POLICY IF EXISTS "Register editors create engine hours" ON public.vessel_engine_hours;
CREATE POLICY "Register editors create engine hours"
    ON public.vessel_engine_hours FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));

DROP POLICY IF EXISTS "Register editors update engine hours" ON public.vessel_engine_hours;
CREATE POLICY "Register editors update engine hours"
    ON public.vessel_engine_hours FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));

DROP POLICY IF EXISTS "Engine hours owners delete" ON public.vessel_engine_hours;
CREATE POLICY "Engine hours owners delete"
    ON public.vessel_engine_hours FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- Live across devices: the R&M page subscribes to it. Guarded like
-- 20261002150000, so a replay (or a table published from the dashboard) is a
-- no-op.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'vessel_engine_hours'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.vessel_engine_hours;
    END IF;
END;
$$;
