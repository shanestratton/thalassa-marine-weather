-- Author-stamped followed-route links (2026-09-08).
--
-- Two devices signed into one skipper account: the second one to open the Log
-- page saw nothing of the route the first was already following, and could
-- overwrite it with another (Shane 2026-09-08). voyage_plan_links carried no
-- author, so neither device could tell "mine" from "the other phone's".
--
-- Stamp WHO wrote the row and WHEN. The app hydrates every device from the
-- active voyage's link row and names the other device before it lets anyone
-- replace it. No leases, no refusal triggers, no new policies: Cast Off is
-- advisory (migration 20260826130000) and so is this — the server records,
-- the client confirms.
--
-- device_id is the per-install id from services/skipperDevice.ts (the same
-- one the exclusive publishing claim uses), device_name its friendly label
-- ("iPhone/iPad · 3f2a"), updated_at is server-stamped so two phones with
-- drifting clocks still agree on who wrote last.

ALTER TABLE public.voyage_plan_links
    ADD COLUMN IF NOT EXISTS device_id TEXT,
    ADD COLUMN IF NOT EXISTS device_name TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.voyage_plan_links_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS voyage_plan_links_touch ON public.voyage_plan_links;
CREATE TRIGGER voyage_plan_links_touch
    BEFORE INSERT OR UPDATE ON public.voyage_plan_links
    FOR EACH ROW EXECUTE FUNCTION public.voyage_plan_links_touch();

-- Which device is recording the Ship's Log for an active passage. Written by
-- the device that actually casts off (not by a response-loss retry from a
-- second device), read by every other device so its cautions can name it:
-- "Recording on Shane's iPhone".
ALTER TABLE public.voyages
    ADD COLUMN IF NOT EXISTS recording_device_id TEXT,
    ADD COLUMN IF NOT EXISTS recording_device_name TEXT;
