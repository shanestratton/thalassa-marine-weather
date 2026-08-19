-- search_vessels: return what the table actually holds, and harden the edge.
--
-- WHY. Shane, 2026-08-19: "if you enter any ship into the search button for
-- the ais, it does not show anything". Tested live against production:
--
--   search_vessels('503058420')     -> 1 row       (MMSI path works)
--   search_vessels('AGATTI ISLAND') -> []          (a name IN THE TABLE)
--
-- The very first predicate was `v.location IS NOT NULL`, applied BEFORE the
-- name is compared. AIS sends position and static data as separate messages,
-- so a vessel whose name has arrived but whose first position has not is
-- silently unsearchable. Measured: 63 named vessels had no location. And the
-- larger reason search felt dead — 1,014 of 1,254 vessels had a position but
-- NO name — was the position-report null-wipe fixed the same day in
-- 20260819050000 (merge_vessels). Together: 86% of the fleet unsearchable by
-- name, and the user shown an empty list with no explanation.
--
-- WHAT CHANGES.
--   1. No location filter. A match without a fix is still a match; lat/lon
--      come back NULL and the client says "no position yet" instead of
--      hiding the ship. `has_position` is returned explicitly so the client
--      never has to infer it from 0/0 or null.
--   2. Ranking that puts the best hit first: exact MMSI, then exact name,
--      then name-prefix, then word-prefix, then call sign; freshest within a
--      tier. Before, ORDER BY updated_at alone let a stale exact match lose
--      to a fresh partial one.
--   3. Hardening, because this is reachable by anon:
--        - query trimmed and length-bounded (2..64) — a 1-char or 10 KB query
--          is refused, not scanned;
--        - LIKE metacharacters in the user's text are ESCAPED, so "%" or "_"
--          cannot turn a prefix search into a full-table wildcard scan;
--        - max_results clamped to 1..25 regardless of what the caller asks;
--        - STABLE + SECURITY DEFINER with a fixed search_path, as before, and
--          the same anon/authenticated grants re-asserted explicitly.
--   4. Returns updated_at so the client can show how fresh a hit is.
--
-- The 2..64 bound and the 25 cap are deliberately generous for real use and
-- deliberately tight for abuse; the ILIKE prefix forms remain index-friendly
-- if a text_pattern_ops index is added later, which the old '% ' || q form
-- never was.
DROP FUNCTION IF EXISTS public.search_vessels(text, integer);

CREATE OR REPLACE FUNCTION public.search_vessels(
    search_query text,
    max_results integer DEFAULT 10
)
RETURNS TABLE (
    mmsi bigint,
    name text,
    call_sign text,
    ship_type integer,
    sog float,
    lat double precision,
    lon double precision,
    has_position boolean,
    updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    WITH q AS (
        SELECT
            btrim(coalesce(search_query, ''))                                   AS raw,
            -- Escape LIKE metacharacters so user text is matched literally.
            replace(replace(replace(btrim(coalesce(search_query, '')),
                '\', '\\'), '%', '\%'), '_', '\_')                             AS esc,
            greatest(1, least(coalesce(max_results, 10), 25))                    AS lim
    ),
    guarded AS (
        SELECT * FROM q
        WHERE length(raw) BETWEEN 2 AND 64
    ),
    ranked AS (
        SELECT
            v.mmsi, v.name, v.call_sign, v.ship_type, v.sog,
            ST_Y(v.location::geometry) AS lat,
            ST_X(v.location::geometry) AS lon,
            (v.location IS NOT NULL)   AS has_position,
            v.updated_at,
            CASE
                WHEN g.raw ~ '^\d{5,9}$' AND v.mmsi = g.raw::bigint          THEN 0
                WHEN v.name IS NOT NULL AND upper(v.name) = upper(g.raw)      THEN 1
                WHEN v.name      ILIKE g.esc || '%'                           THEN 2
                WHEN v.name      ILIKE '% ' || g.esc || '%'
                  OR v.name      ILIKE '%-' || g.esc || '%'                   THEN 3
                WHEN v.call_sign ILIKE g.esc || '%'                           THEN 4
                ELSE 9
            END AS tier,
            g.lim
        FROM public.vessels v
        CROSS JOIN guarded g
        WHERE
            (g.raw ~ '^\d{5,9}$' AND v.mmsi = g.raw::bigint)
            OR (v.name      ILIKE g.esc || '%')
            OR (v.name      ILIKE '% ' || g.esc || '%')
            OR (v.name      ILIKE '%-' || g.esc || '%')
            OR (v.call_sign ILIKE g.esc || '%')
    )
    SELECT mmsi, name, call_sign, ship_type, sog, lat, lon, has_position, updated_at
    FROM ranked
    ORDER BY tier, updated_at DESC
    LIMIT (SELECT lim FROM guarded LIMIT 1);
$$;

REVOKE ALL ON FUNCTION public.search_vessels(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_vessels(text, integer) TO anon, authenticated;
