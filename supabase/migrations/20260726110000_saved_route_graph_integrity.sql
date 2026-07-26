-- Saved route graph integrity (2026-07-26).
--
-- A traced route is represented in three places: saved_routes is the
-- canonical editable route; ship_logs retains the planned-route compatibility
-- mirror; voyages powers Passage Planning.  These explicit, nullable links
-- make delete/reconciliation exact instead of guessing from a repeated label
-- or a calendar day.

ALTER TABLE public.saved_routes
    ADD COLUMN IF NOT EXISTS trip_id TEXT,
    ADD COLUMN IF NOT EXISTS leg_ordinal INTEGER,
    ADD COLUMN IF NOT EXISTS dest_name TEXT,
    ADD COLUMN IF NOT EXISTS planned_route_id TEXT,
    ADD COLUMN IF NOT EXISTS passage_voyage_id UUID;

ALTER TABLE public.saved_routes
    DROP CONSTRAINT IF EXISTS saved_routes_leg_ordinal_positive;
ALTER TABLE public.saved_routes
    ADD CONSTRAINT saved_routes_leg_ordinal_positive
    CHECK (leg_ordinal IS NULL OR leg_ordinal >= 1);

ALTER TABLE public.voyages
    ADD COLUMN IF NOT EXISTS saved_route_id TEXT;

ALTER TABLE public.ship_logs
    ADD COLUMN IF NOT EXISTS saved_route_id TEXT;

CREATE INDEX IF NOT EXISTS saved_routes_trip_idx
    ON public.saved_routes(user_id, trip_id, leg_ordinal)
    WHERE deleted = false AND trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS voyages_saved_route_idx
    ON public.voyages(user_id, saved_route_id)
    WHERE saved_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ship_logs_saved_route_idx
    ON public.ship_logs(user_id, saved_route_id)
    WHERE saved_route_id IS NOT NULL;

-- Client writes are offline-first and can arrive out of order. Never allow a
-- delayed pre-delete save to overwrite a newer tombstone (or a delayed edit to
-- overwrite a newer version). A deliberate re-save has to carry a newer
-- updated_at, which the client does for every mutation.
CREATE OR REPLACE FUNCTION public.saved_routes_keep_newest_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.updated_at > NEW.updated_at THEN
        RETURN OLD;
    END IF;
    IF OLD.deleted AND NOT NEW.deleted AND OLD.updated_at >= NEW.updated_at THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_routes_keep_newest_version_trigger ON public.saved_routes;
CREATE TRIGGER saved_routes_keep_newest_version_trigger
    BEFORE UPDATE ON public.saved_routes
    FOR EACH ROW
    EXECUTE FUNCTION public.saved_routes_keep_newest_version();

COMMENT ON COLUMN public.saved_routes.trip_id IS
    'Root saved_routes.id for a multi-leg trip; leg 1 owns its own id.';
COMMENT ON COLUMN public.saved_routes.leg_ordinal IS
    'One-based position in a saved-route trip chain.';
COMMENT ON COLUMN public.saved_routes.planned_route_id IS
    'Exact planned_* ship_logs voyage id mirrored from this saved route.';
COMMENT ON COLUMN public.saved_routes.passage_voyage_id IS
    'Exact voyages.id backing this saved route in Passage Planning.';
COMMENT ON COLUMN public.voyages.saved_route_id IS
    'Canonical saved_routes.id that created this planning record.';
COMMENT ON COLUMN public.ship_logs.saved_route_id IS
    'Canonical saved_routes.id that created this planned-route mirror.';
