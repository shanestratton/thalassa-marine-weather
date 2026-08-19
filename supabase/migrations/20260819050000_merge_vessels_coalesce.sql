-- merge_vessels — upsert AIS rows WITHOUT letting a partial message null a
-- field it did not carry.
--
-- WHY. The ingest worker batches rows through PostgREST, and supabase-js
-- builds the batch's `columns` list as the UNION of every row's keys
-- (postgrest-js: `columns = values.reduce((acc,x) => acc.concat(Object.keys(x)))`).
-- PostgREST then fills any row missing a key with NULL — and upserts that
-- NULL over the stored value. So a position report for a vessel that shares
-- a batch with a static-data report for a DIFFERENT vessel arrives as
-- {..., name: null, call_sign: null, ...} and wipes her name.
--
-- This always happened. Nobody saw it, because every vessel was rewritten
-- every ~10 s and the next ShipStaticData frame put the name straight back.
-- The 2026-08-19 change-detection fix (write only what changed) exposed it:
-- a moored boat is now written once per 10 min, so the NULL lands and STAYS
-- until the next static frame beats the heartbeat. Measured live: BUNGAREE
-- (503058420) reporting at 22.7 kt, name gone.
--
-- Fix: merge server-side with COALESCE(new, existing) per column, in one
-- statement per batch. A field the message did not carry can no longer
-- overwrite one it did. AIS position and static data are separate messages
-- by design, so this is the semantics the table wanted all along.
CREATE OR REPLACE FUNCTION public.merge_vessels(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    n integer;
BEGIN
    WITH incoming AS (
        SELECT
            (r->>'mmsi')::bigint                       AS mmsi,
            r->>'name'                                 AS name,
            r->>'call_sign'                            AS call_sign,
            (r->>'ship_type')::integer                 AS ship_type,
            r->>'destination'                          AS destination,
            (r->>'imo_number')::integer                AS imo_number,
            CASE WHEN r ? 'location'
                 THEN ST_GeogFromText(r->>'location') END AS location,
            (r->>'cog')::float                         AS cog,
            (r->>'sog')::float                         AS sog,
            (r->>'heading')::integer                   AS heading,
            (r->>'nav_status')::integer                AS nav_status,
            (r->>'dimension_a')::integer               AS dimension_a,
            (r->>'dimension_b')::integer               AS dimension_b,
            (r->>'dimension_c')::integer               AS dimension_c,
            (r->>'dimension_d')::integer               AS dimension_d
        FROM jsonb_array_elements(rows) AS r
        WHERE (r->>'mmsi') IS NOT NULL
    ),
    upserted AS (
        INSERT INTO public.vessels AS v
            (mmsi, name, call_sign, ship_type, destination, imo_number, location,
             cog, sog, heading, nav_status,
             dimension_a, dimension_b, dimension_c, dimension_d, updated_at)
        SELECT
            mmsi, name, call_sign, ship_type, destination, imo_number, location,
            cog, sog, heading, nav_status,
            dimension_a, dimension_b, dimension_c, dimension_d, now()
        FROM incoming
        ON CONFLICT (mmsi) DO UPDATE SET
            name        = COALESCE(EXCLUDED.name,        v.name),
            call_sign   = COALESCE(EXCLUDED.call_sign,   v.call_sign),
            ship_type   = COALESCE(EXCLUDED.ship_type,   v.ship_type),
            destination = COALESCE(EXCLUDED.destination, v.destination),
            imo_number  = COALESCE(EXCLUDED.imo_number,  v.imo_number),
            location    = COALESCE(EXCLUDED.location,    v.location),
            cog         = COALESCE(EXCLUDED.cog,         v.cog),
            sog         = COALESCE(EXCLUDED.sog,         v.sog),
            heading     = COALESCE(EXCLUDED.heading,     v.heading),
            nav_status  = COALESCE(EXCLUDED.nav_status,  v.nav_status),
            dimension_a = COALESCE(EXCLUDED.dimension_a, v.dimension_a),
            dimension_b = COALESCE(EXCLUDED.dimension_b, v.dimension_b),
            dimension_c = COALESCE(EXCLUDED.dimension_c, v.dimension_c),
            dimension_d = COALESCE(EXCLUDED.dimension_d, v.dimension_d),
            updated_at  = now()
        RETURNING 1
    )
    SELECT count(*) INTO n FROM upserted;
    RETURN n;
END;
$$;

-- Only the ingest worker (service role) may call this. Never the app.
REVOKE ALL ON FUNCTION public.merge_vessels(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_vessels(jsonb) TO service_role;
