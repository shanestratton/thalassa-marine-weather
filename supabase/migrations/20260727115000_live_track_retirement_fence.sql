-- Live-track quality + retirement fence (2026-07-27).
--
-- live_track is intentionally an ephemeral shadow rather than the durable
-- ship_logs record. That means a voyage can be discarded before its local
-- ship-log queue ever uploads. Without a separate server-side fence, a late
-- retry from that device could recreate a public live tail for a voyage the
-- skipper has archived, deleted, or discarded.

ALTER TABLE public.live_track
    ADD COLUMN IF NOT EXISTS is_on_water BOOLEAN;

-- The public voyage selector and active-tail fetch both scope by owner and
-- voyage. Keep that lookup cheap without changing the existing owner/time
-- retention index.
CREATE INDEX IF NOT EXISTS live_track_user_voyage_timestamp_idx
    ON public.live_track (user_id, voyage_id, timestamp DESC)
    WHERE voyage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.live_track_retirements (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'deleted'
        CHECK (reason IN ('archived', 'deleted', 'discarded')),
    retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, voyage_id),
    CHECK (btrim(voyage_id) <> ''),
    CHECK (length(voyage_id) <= 256)
);

ALTER TABLE public.live_track_retirements ENABLE ROW LEVEL SECURITY;

-- Owners can establish or refresh their own retirement fence. They cannot
-- delete it: immutable voyage ids are never reused, and allowing a stale app
-- to remove the row would re-open an intentionally private track.
DROP POLICY IF EXISTS live_track_retirements_select_own ON public.live_track_retirements;
CREATE POLICY live_track_retirements_select_own ON public.live_track_retirements
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS live_track_retirements_insert_own ON public.live_track_retirements;
CREATE POLICY live_track_retirements_insert_own ON public.live_track_retirements
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS live_track_retirements_update_own ON public.live_track_retirements;
CREATE POLICY live_track_retirements_update_own ON public.live_track_retirements
    FOR UPDATE USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- One implementation is shared by the client-facing retirement row and the
-- durable ship_logs archive trigger below. SECURITY DEFINER is deliberate:
-- archive propagation must remain reliable even when RLS policy shape changes
-- in a future app release.
CREATE OR REPLACE FUNCTION public.retire_live_track_voyage(
    p_user_id UUID,
    p_voyage_id TEXT,
    p_reason TEXT DEFAULT 'deleted'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    normalized_voyage_id TEXT := btrim(coalesce(p_voyage_id, ''));
BEGIN
    IF p_user_id IS NULL OR normalized_voyage_id = '' OR normalized_voyage_id = 'default_voyage' THEN
        RETURN;
    END IF;

    IF length(normalized_voyage_id) > 256 THEN
        RAISE EXCEPTION 'live-track voyage id exceeds 256 characters';
    END IF;

    IF p_reason NOT IN ('archived', 'deleted', 'discarded') THEN
        RAISE EXCEPTION 'invalid live-track retirement reason';
    END IF;

    INSERT INTO public.live_track_retirements (user_id, voyage_id, reason, retired_at)
    VALUES (p_user_id, normalized_voyage_id, p_reason, NOW())
    ON CONFLICT (user_id, voyage_id) DO UPDATE
        SET reason = EXCLUDED.reason,
            retired_at = GREATEST(public.live_track_retirements.retired_at, EXCLUDED.retired_at);

    DELETE FROM public.live_track
    WHERE user_id = p_user_id
      AND voyage_id = normalized_voyage_id;
END;
$$;

-- A retirement is a no-revival fence. Returning NULL skips a delayed insert
-- or upsert without failing the entire client batch; the client can safely
-- advance its high-water mark because there is intentionally nothing to send.
CREATE OR REPLACE FUNCTION public.suppress_retired_live_track()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    normalized_voyage_id TEXT := btrim(coalesce(NEW.voyage_id, ''));
BEGIN
    IF normalized_voyage_id = '' THEN
        RETURN NEW;
    END IF;

    NEW.voyage_id := normalized_voyage_id;
    IF EXISTS (
        SELECT 1
        FROM public.live_track_retirements AS retirement
        WHERE retirement.user_id = NEW.user_id
          AND retirement.voyage_id = normalized_voyage_id
    ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS live_track_suppress_retired_voyage ON public.live_track;
CREATE TRIGGER live_track_suppress_retired_voyage
    BEFORE INSERT OR UPDATE OF user_id, voyage_id ON public.live_track
    FOR EACH ROW
    EXECUTE FUNCTION public.suppress_retired_live_track();

-- The durable archive path also retires the live tail. This is the critical
-- offline fallback: archive intent replay eventually updates ship_logs even
-- if the original device no longer has network access to clear live_track.
--
-- Use transition tables and fire once per UPDATE statement. A long passage
-- can contain many thousands of ship_logs rows; a row trigger would perform
-- the same retirement upsert/delete thousands of times for one archive tap.
CREATE OR REPLACE FUNCTION public.retire_live_tracks_on_ship_log_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    archived_voyage RECORD;
BEGIN
    FOR archived_voyage IN
        SELECT DISTINCT
            updated.user_id,
            btrim(updated.voyage_id) AS voyage_id
        FROM new_rows AS updated
        INNER JOIN old_rows AS prior USING (id)
        WHERE updated.archived IS TRUE
          AND prior.archived IS DISTINCT FROM TRUE
          AND updated.voyage_id IS NOT NULL
          AND btrim(updated.voyage_id) <> ''
    LOOP
        PERFORM public.retire_live_track_voyage(
            archived_voyage.user_id,
            archived_voyage.voyage_id,
            'archived'
        );
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ship_logs_retire_live_track_on_archive ON public.ship_logs;
CREATE TRIGGER ship_logs_retire_live_track_on_archive
    AFTER UPDATE ON public.ship_logs
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.retire_live_tracks_on_ship_log_archive();

-- These are trigger-internal primitives, not public RPCs. The app writes its
-- own RLS-scoped retirement row; callers must never be able to retire another
-- account's voyage by invoking a SECURITY DEFINER function directly.
REVOKE ALL ON FUNCTION public.retire_live_track_voyage(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.suppress_retired_live_track()
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retire_live_tracks_on_ship_log_archive()
    FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.live_track.is_on_water IS
    'Capture-time water verification copied from the ship-log GPS entry; NULL means not yet classified.';
COMMENT ON TABLE public.live_track_retirements IS
    'Permanent no-revival fences for public live tails of archived, deleted, or discarded voyages.';
