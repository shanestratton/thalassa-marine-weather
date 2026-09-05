/**
 * Anonymous callers could read every live AIS position, directly.
 *
 * Measured on production, 2026-09-05, publishable key, no session:
 * GET /rest/v1/vessels?select=mmsi&limit=1 → HTTP 200 with a row. The table
 * still carried the 2026-03-18 policy "Vessels are publicly readable"
 * USING (true), and search_vessels() — SECURITY DEFINER, returns lat/lon —
 * was granted to anon.
 *
 * Nothing anonymous needs either. The public Voyage Explorer gets its ships
 * from supabase/functions/voyage-log, which runs vessels_nearby as the service
 * role. Since 2026-09-05 the vessels-nearby Edge Function ALSO runs it as the
 * service role (its caller is verified and metered first), so the RPC's
 * authenticated grant is revoked in 20260905110000 — a separate migration, to
 * be applied only AFTER that Function is deployed, or the app's own AIS layer
 * breaks in between. The quota the function enforces belongs in the function,
 * and a grant that let clients skip it is gone.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260905102000_close_anon_ais.sql', 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

describe('anonymous AIS access is closed', () => {
    it('strips every anon privilege from the table', () => {
        expect(code).toMatch(/REVOKE ALL ON TABLE public\.vessels FROM anon;/);
    });

    it('replaces the public-read policy with a signed-in one', () => {
        expect(code).toMatch(/DROP POLICY IF EXISTS "Vessels are publicly readable" ON public\.vessels;/);
        expect(code).toMatch(
            /CREATE POLICY "Vessels readable by signed-in clients"\s*ON public\.vessels FOR SELECT TO authenticated\s*USING \(true\);/,
        );
    });

    it('takes exact-position search away from anon', () => {
        expect(code).toMatch(/REVOKE EXECUTE ON FUNCTION public\.search_vessels\(text, integer\) FROM anon;/);
    });

    it('leaves signed-in clients able to read — the chokepoint layer and search need it', () => {
        expect(code).not.toMatch(/REVOKE\s+(ALL|SELECT)[^;]*FROM authenticated/);
        expect(code).not.toMatch(/search_vessels[^;]*FROM authenticated/);
    });

    it('102000 leaves vessels_nearby alone — the grant moves in its own migration, after the deploy', () => {
        // Two-step on purpose: the Edge Function must run as the service role
        // BEFORE the authenticated grant goes, or AIS breaks in between.
        expect(code).not.toContain('vessels_nearby');
    });

    it('vessels-nearby runs the RPC as the service role and never forwards the caller JWT', () => {
        // Audit item 4, second half. Forwarding the user's JWT forced an
        // `authenticated` grant on the RPC, which let any signed-in client
        // call rpc/vessels_nearby directly and skip the 720/hour quota.
        const edge = readFileSync('supabase/functions/vessels-nearby/index.ts', 'utf8');
        expect(edge).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(edge).not.toContain("Deno.env.get('SUPABASE_ANON_KEY')");
        expect(edge).not.toMatch(/Authorization: authorization/);
        // The caller is still verified and metered — the quota is the point.
        const body = edge.slice(edge.indexOf('Deno.serve'));
        const quotaAt = body.indexOf("requireAuthenticatedQuota(req, 'vessels_nearby'");
        const rpcAt = body.indexOf(".rpc('vessels_nearby'");
        expect(quotaAt).toBeGreaterThan(0);
        expect(rpcAt).toBeGreaterThan(quotaAt);
    });

    it('110000 revokes the authenticated grant and keeps the service role', () => {
        const mig = readFileSync('supabase/migrations/20260905110000_vessels_nearby_service_role_only.sql', 'utf8');
        expect(mig).toMatch(/REVOKE EXECUTE ON FUNCTION public\.vessels_nearby\([^)]*\)\s+FROM authenticated;/);
        expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.vessels_nearby\([^)]*\)\s+TO service_role;/);
        // The order warning is part of the contract — it is what stops a
        // db push from running ahead of the Function deploy.
        expect(mig).toContain('deploy the vessels-nearby Function BEFORE applying this');
    });

    it('the public page never reads the table from the browser', () => {
        const pub = readFileSync('src/voyageLogApi.ts', 'utf8');
        expect(pub).toContain('/functions/v1/voyage-log');
        expect(pub).not.toContain("from('vessels')");
        const voyageLog = readFileSync('supabase/functions/voyage-log/index.ts', 'utf8');
        expect(voyageLog).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
    });
});
