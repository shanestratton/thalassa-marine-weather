-- ═══════════════════════════════════════════════════════════════════════════
-- Enable RLS on the two tables that had it explicitly disabled.
--
-- Both were disabled on a premise that does not hold on Supabase:
--
--   linz_warnings   "only the edge function (service-role) and the scraper
--                    ever touch this table. No direct client access."
--   australian_ports "reference data the iOS client reads with the anon key.
--                    No writes from the client."
--
-- The `public` schema is PostgREST-exposed and the anon key SHIPS IN THE
-- CLIENT BUNDLE. Intent about who "ever touches" a table is not enforcement:
-- with RLS off, the gate is the GRANT, and Supabase's bootstrap grants
-- privileges on public tables to anon/authenticated by default. So
-- linz_warnings — in-force NAVAREA XIV navigational warnings, wrecks and
-- unlit buoys — was readable AND writable by anyone holding a key that is
-- published in the app. A deleted or forged warning is a marine safety issue,
-- not a data-integrity one.
--
-- The two tables get different treatment because their intent differs:
--   • linz_warnings   → service-role only. The client reaches it exclusively
--                       through the proxy-linz-msi edge function, which uses
--                       the service-role key. No client policy is needed, so
--                       RLS on with no policy is exactly right.
--   • australian_ports → genuinely world-readable reference data that
--                       AustralianPortsService queries directly with the anon
--                       key. It keeps public SELECT via an explicit policy,
--                       and loses everything else.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── linz_warnings: service-role only ──────────────────────────────────────
ALTER TABLE public.linz_warnings ENABLE ROW LEVEL SECURITY;

-- No policies on purpose. RLS with zero policies denies every non-service
-- role, which is what the original comment said it wanted. service_role
-- bypasses RLS, so the edge function and the scraper cron are unaffected.
REVOKE ALL ON public.linz_warnings FROM anon, authenticated;

-- ── australian_ports: public read, nothing else ───────────────────────────
ALTER TABLE public.australian_ports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS australian_ports_public_read ON public.australian_ports;
CREATE POLICY australian_ports_public_read ON public.australian_ports
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Reads stay open (that is the point of the table); writes do not. The prior
-- state relied on no INSERT/UPDATE/DELETE grant ever having been made, which
-- is an assumption about defaults rather than a guarantee.
REVOKE ALL ON public.australian_ports FROM anon, authenticated;
GRANT SELECT ON public.australian_ports TO anon, authenticated;

-- ── Verify (run manually after applying) ──────────────────────────────────
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('linz_warnings','australian_ports');
--   -- both relrowsecurity = true
--
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('linz_warnings','australian_ports')
--      AND grantee IN ('anon','authenticated');
--   -- expect ONLY australian_ports / SELECT
