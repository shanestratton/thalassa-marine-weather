-- Anonymous callers could read every live AIS position, directly.
--
-- Measured against production on 2026-09-05 with the publishable key and no
-- session: GET /rest/v1/vessels?select=mmsi&limit=1 → HTTP 200 with a row. The
-- table carried the original 2026-03-18 policy "Vessels are publicly readable"
-- USING (true), and the default table grants left anon with SELECT (and,
-- pointlessly, INSERT/UPDATE/DELETE/TRUNCATE — RLS stopped those, but they
-- should not exist). search_vessels() is SECURITY DEFINER, returns lat/lon,
-- and was granted to anon, so an unauthenticated search returned exact
-- positions too.
--
-- Nothing anonymous needs either. The only in-app direct table read is
-- components/map/useChokepointLayer.ts, signed in. The only search_vessels
-- caller is components/map/VesselSearch.tsx, signed in. The public Voyage
-- Explorer never touches this table from the browser: supabase/functions/
-- voyage-log runs vessels_nearby with the service role. The vessels-nearby
-- Edge Function forwards the USER's JWT to the same RPC, which is why
-- vessels_nearby keeps its authenticated grant below — revoking it would break
-- the app's own AIS layer, and the quota that function enforces belongs in the
-- function, not in the grant.

REVOKE ALL ON TABLE public.vessels FROM anon;
-- Signed-in clients read. They never write; the worker does, as service_role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vessels FROM authenticated;

DROP POLICY IF EXISTS "Vessels are publicly readable" ON public.vessels;
CREATE POLICY "Vessels readable by signed-in clients"
    ON public.vessels FOR SELECT TO authenticated
    USING (true);

REVOKE EXECUTE ON FUNCTION public.search_vessels(text, integer) FROM anon;
