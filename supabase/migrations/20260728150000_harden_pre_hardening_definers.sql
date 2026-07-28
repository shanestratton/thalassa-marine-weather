-- Close the pre-hardening SECURITY DEFINER stratum.
--
-- The July 2026 hardening pass was applied by enumerating the functions that
-- existed at the time, so everything created before it kept the unsafe
-- defaults. Enumerated against the LIVE catalogue rather than by grepping
-- migrations: 115 SECURITY DEFINER functions exist, 11 of ours had no
-- `search_path` pinned, and all 11 carried an implicit `=X/postgres` ACL
-- entry — the grant to PUBLIC.
--
-- That is not theoretical. Executed as the `anon` role — the key that ships
-- inside the web bundle — this returned a real name out of auth.users:
--
--     SET LOCAL ROLE anon;
--     SELECT public.user_display_name('<uuid>');   -->  'Shane Stratton'
--
-- Two separate defects, fixed separately below.
--
-- 1. NO search_path. A SECURITY DEFINER function runs as its owner, so an
--    unpinned search_path lets a caller who can create objects shadow an
--    unqualified name inside the body and have it executed as postgres.
--    Pinning is pure hardening with no behavioural change, so it is applied
--    to all eleven.
--
-- 2. EXECUTE granted to PUBLIC. Revoked from every function that no client
--    calls. For the five the app genuinely does call, only the implicit
--    PUBLIC grant is dropped — their explicit anon/authenticated grants stay,
--    so the public AIS search, metadata lookup and download counter keep
--    working exactly as before.

-- ── 1. Pin search_path on all eleven ────────────────────────────────────
-- pg_catalog first so built-ins cannot be shadowed; pg_temp last, per the
-- standard recommendation for SECURITY DEFINER bodies.
ALTER FUNCTION public.broadcast_guardian_alert(UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, JSONB)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_bolo_distance(INTEGER, DOUBLE PRECISION, DOUBLE PRECISION)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_geofence_distance(INTEGER, DOUBLE PRECISION, DOUBLE PRECISION)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.guardian_set_home(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.increment_download_count(UUID)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.log_service(UUID, INTEGER, TEXT, NUMERIC)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.lookup_vessel_metadata(BIGINT[])
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.search_vessels(TEXT, INTEGER)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sweep_expired_escrows()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.sync_vessel_crew_to_boat_members()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.user_display_name(UUID)
    SET search_path = pg_catalog, public, pg_temp;

-- ── 2a. No client caller: revoke from every client-reachable role ───────
-- Verified by searching the tree for `.rpc('<name>'`: zero call sites. These
-- are trigger bodies and maintenance routines, reachable through the
-- statements that fire them rather than over PostgREST.
--
-- user_display_name is the leak above: it selects from auth.users, has no
-- auth.uid() gate, and needs no client access at all.
REVOKE ALL ON FUNCTION public.user_display_name(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_bolo_distance(INTEGER, DOUBLE PRECISION, DOUBLE PRECISION)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_geofence_distance(INTEGER, DOUBLE PRECISION, DOUBLE PRECISION)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guardian_set_home(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_vessel_crew_to_boat_members() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_expired_escrows() FROM PUBLIC, anon, authenticated;

-- ── 2b. Client callers: drop the implicit PUBLIC grant only ────────────
-- Each of these keeps its explicit anon/authenticated grant, so behaviour is
-- unchanged; what goes is the blanket PUBLIC entry that arrived by default.
REVOKE ALL ON FUNCTION public.search_vessels(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_vessel_metadata(BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_download_count(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_service(UUID, INTEGER, TEXT, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_guardian_alert(UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, JSONB)
    FROM PUBLIC;

-- Re-assert the grants the app relies on. REVOKE ... FROM PUBLIC does not
-- touch a role's own entry, but stating them makes the intended reachability
-- of each function explicit rather than inherited.
GRANT EXECUTE ON FUNCTION public.search_vessels(TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_vessel_metadata(BIGINT[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_download_count(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_service(UUID, INTEGER, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_guardian_alert(UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, JSONB)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.guardian_set_home(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION)
    TO authenticated;
