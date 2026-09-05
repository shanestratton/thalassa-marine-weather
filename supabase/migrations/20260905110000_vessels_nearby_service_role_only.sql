-- vessels_nearby: callable by the service role only.
--
-- Audit item 4 (2026-09-05), second half. Closing anonymous reads
-- (20260905102000) left one door: the vessels-nearby Edge Function forwarded
-- the caller's JWT to this RPC, so the RPC had to stay executable by
-- `authenticated` — and a signed-in client could therefore call
-- rpc/vessels_nearby directly from the app's own credentials, bypassing the
-- 720-per-hour quota the Edge Function enforces. The quota was the point.
--
-- The Edge Function now runs the RPC as the service role (its caller is still
-- verified and metered by requireAuthenticatedQuota), so `authenticated` no
-- longer needs the grant. voyage-log already runs it as the service role.
--
-- ORDER MATTERS: deploy the vessels-nearby Function BEFORE applying this
-- migration. Applied first, every AIS request from the app fails with
-- "permission denied for function vessels_nearby" until the deploy lands.

REVOKE EXECUTE ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
    FROM authenticated;
REVOKE ALL ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.vessels_nearby(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) IS
    'Nearby AIS targets. Service-role only since 2026-09-05: reached through the vessels-nearby Edge Function (authenticated + quota) and voyage-log (public page).';
