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
 * role. The vessels-nearby Edge Function forwards the USER's JWT to the RPC —
 * which is why vessels_nearby must KEEP its authenticated grant: revoking it
 * would break the app's own AIS layer. The quota that function enforces belongs
 * in the function, not in the grant.
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

    it('does NOT revoke vessels_nearby from authenticated — the Edge Function runs as the user', () => {
        // supabase/functions/vessels-nearby/index.ts builds its client from
        // SUPABASE_ANON_KEY plus the caller's Authorization header.
        expect(code).not.toContain('vessels_nearby');
        const edge = readFileSync('supabase/functions/vessels-nearby/index.ts', 'utf8');
        expect(edge).toContain("Deno.env.get('SUPABASE_ANON_KEY')");
        expect(edge).toMatch(/global: \{ headers: \{ Authorization: authorization \} \}/);
    });

    it('the public page never reads the table from the browser', () => {
        const pub = readFileSync('src/voyageLogApi.ts', 'utf8');
        expect(pub).toContain('/functions/v1/voyage-log');
        expect(pub).not.toContain("from('vessels')");
        const voyageLog = readFileSync('supabase/functions/voyage-log/index.ts', 'utf8');
        expect(voyageLog).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
    });
});
