-- wx_subscriptions: announce through a validated RPC, not a table write.
--
-- Audit item 15 (2026-09-05). The fleet-presence table let anon and
-- authenticated clients INSERT and UPDATE rows directly. The cell_id regex
-- bounded the SHAPE of a cell but not its RANGE (any '9999_99999' passed), a
-- client could set last_seen_at to any time (keeping dead cells alive for
-- ever, or aging them out instantly), and nothing bounded HOW MANY cells one
-- client could create — each one is publisher work on Shane's weather server,
-- twelve models a cell, for ever.
--
-- Now: one SECURITY DEFINER function. It validates the cell against the real
-- 0.25° grid range, stamps last_seen_at itself, and refuses NEW cells once the
-- table holds its ceiling — an existing cell can always be refreshed, so a boat
-- in a busy sea is never refused, and a flood of invented cells stops at the
-- cap instead of at the publisher. The direct write policies are dropped and
-- the table privileges revoked, so the RPC is the only way in.
--
-- The client (services/weather/wxPublished.ts announceCell) already writes at
-- most once per 6 h per cell change; this is the server no longer trusting that.

CREATE OR REPLACE FUNCTION public.announce_wx_cell(p_cell text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    lat_idx integer;
    lon_idx integer;
    live_cells integer;
BEGIN
    -- Shape: '<lat×100>_<lon×100>', each a multiple of 25 (0.25° cell floor).
    IF p_cell IS NULL OR p_cell !~ '^-?\d{1,4}_-?\d{1,5}$' THEN
        RETURN false;
    END IF;
    lat_idx := split_part(p_cell, '_', 1)::integer;
    lon_idx := split_part(p_cell, '_', 2)::integer;
    -- Range: latitude −90..90 → −9000..9000; longitude −180..180 → −18000..18000.
    IF lat_idx < -9000 OR lat_idx > 9000 OR lon_idx < -18000 OR lon_idx > 18000
       OR lat_idx % 25 <> 0 OR lon_idx % 25 <> 0 THEN
        RETURN false;
    END IF;

    -- Refreshing a cell the fleet already occupies is always allowed.
    UPDATE public.wx_subscriptions SET last_seen_at = now() WHERE cell_id = p_cell;
    IF FOUND THEN
        RETURN true;
    END IF;

    -- A NEW cell is publisher work. 20 000 cells is ~1/5 of the planet's ocean
    -- at 0.25°, far beyond any real fleet; past it, new cells are refused and
    -- the boat falls back to the live API path it already has.
    SELECT count(*) INTO live_cells FROM public.wx_subscriptions;
    IF live_cells >= 20000 THEN
        RETURN false;
    END IF;

    INSERT INTO public.wx_subscriptions (cell_id, last_seen_at)
    VALUES (p_cell, now())
    ON CONFLICT (cell_id) DO UPDATE SET last_seen_at = now();
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.announce_wx_cell(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.announce_wx_cell(text) TO anon, authenticated, service_role;

-- The RPC is the only writer now.
DROP POLICY IF EXISTS wx_subscriptions_announce ON public.wx_subscriptions;
DROP POLICY IF EXISTS wx_subscriptions_refresh ON public.wx_subscriptions;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.wx_subscriptions
    FROM anon, authenticated;

COMMENT ON FUNCTION public.announce_wx_cell(text) IS
    'Fleet presence announce for the weather publisher. Validates the 0.25° cell, stamps last_seen_at server-side, refuses new cells past 20 000. Since 2026-09-05 the only writer to wx_subscriptions.';
