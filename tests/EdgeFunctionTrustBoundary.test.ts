import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const functionSource = (name: string): string => source(`supabase/functions/${name}/index.ts`);

describe('Supabase Edge-function trust-boundary contracts', () => {
    it('streams bounded JSON instead of buffering attacker-controlled bodies', () => {
        const shared = source('supabase/functions/_shared/http-security.ts');
        expect(shared).toContain('req.body.getReader()');
        expect(shared).toContain('if (total > maxBytes)');
        expect(shared).not.toContain('await req.text()');
    });

    it('locks every cron/sweeper entry point to exact service-role POST requests', () => {
        for (const name of [
            'check-weather-alerts',
            'scrape-vessel-metadata',
            'sweep-expired-escrows',
            'sweep-stale-vessels',
        ]) {
            const edge = functionSource(name);
            expect(edge, name).toContain('requireServiceRolePost(');
            expect(edge, name).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        }
    });

    it('derives weather entitlement from the verified caller and never forwarded user input', () => {
        const edge = functionSource('get-weather');
        expect(edge).toContain("requireAuthenticatedOrPublicQuota(req, 'weather'");
        expect(edge).toContain(".eq('id', caller.userId)");
        expect(edge).not.toMatch(/\b(?:body|rawBody)\.user_id\b/);

        const pi = source('pi-cache/src/routes/weather.ts');
        const unifiedBlock = pi.slice(pi.indexOf("router.get('/unified'"), pi.indexOf("router.get('/stormglass'"));
        expect(unifiedBlock).not.toContain('params.user_id');
        expect(unifiedBlock).not.toMatch(/user_id:\s*String/);

        const client = source('services/weather/api/unified.ts');
        expect(client).not.toMatch(/body:\s*JSON\.stringify\([^)]*user_id/s);
    });

    it('uses bounded database identity lookup rather than Auth-admin enumeration', () => {
        const edge = functionSource('lookup-user');
        expect(edge).toContain("client.rpc('lookup_user_by_email'");
        expect(edge).toContain('requireAuthenticatedQuota(');
        expect(edge).not.toContain('auth.admin.listUsers');
    });

    it('requires quotas and timeouts around paid upstream weather/data services', () => {
        const publicPaid = [
            'fetch-gfs-tracker',
            'fetch-precip-grid',
            'fetch-pressure-grid',
            'fetch-weatherkit',
            'fetch-wind-grid',
            'fetch-wind-velocity',
            'gebco-depth',
            'get-marine',
            'osm-overlay',
            'proxy-amsa-msi',
            'proxy-himawari-ir',
            'proxy-nga-msi',
            'proxy-openmeteo',
            'proxy-overpass',
            'proxy-rainbow',
            'proxy-tides',
            'proxy-ukho-msi',
            'route-bathymetric',
            'satellite-tile',
        ];
        const authenticatedPaid = [
            'anthropic-proxy',
            'elevenlabs-tts',
            'gemini-diary',
            'lookup-vessel',
            'proxy-bosun-fallback',
            'proxy-gemini',
            'proxy-stormglass',
        ];

        for (const name of publicPaid) {
            const edge = functionSource(name);
            expect(edge, name).toContain('requireAuthenticatedOrPublicQuota(');
            expect(edge, name).toContain('fetchWithTimeout(');
        }
        for (const name of authenticatedPaid) {
            const edge = functionSource(name);
            expect(edge, name).toContain('requireAuthenticatedQuota(');
            if (name !== 'anthropic-proxy') expect(edge, name).toContain('fetchWithTimeout(');
        }
    });

    it('bounds WeatherKit request windows and its streamed upstream payload', () => {
        const edge = functionSource('fetch-weatherkit');
        expect(edge).toContain('hourlyEnd - hourlyStart > 7 * 86_400_000');
        expect(edge).toContain('hourlyStart < now - 48 * 3_600_000');
        expect(edge).toContain('readResponseTextLimited(upstream, 5_000_000)');
        expect(edge).not.toContain('await upstream.json()');
        expect(edge).not.toMatch(/console\.(?:log|info|warn|error)\([^\\n]*\\burl\\b/);
    });

    it('strictly normalizes fresh AIS rows at Edge and SQL boundaries', () => {
        const edge = functionSource('vessels-nearby');
        const migration = source('supabase/migrations/20260724090000_public_edge_quota_and_ais_rpc.sql');
        expect(edge).toContain('normalizeVessel(row, nowMs)');
        expect(edge).toContain("requireAuthenticatedQuota(req, 'vessels_nearby'");
        expect(edge).not.toContain('(v: any)');
        expect(migration).toContain("v.updated_at > statement_timestamp() - interval '2 hours'");
        expect(migration).toContain("v.updated_at <= statement_timestamp() + interval '2 minutes'");
        expect(migration).toContain('SECURITY INVOKER');
    });

    it('keeps Guardian episodes atomic, owner-scoped, fresh, and bounded', () => {
        const migration = source('supabase/migrations/20260724090000_public_edge_quota_and_ais_rpc.sql');
        expect(migration).toContain('guardian_watchdog_position');
        expect(migration).toContain('gp.user_id = p_user_id');
        expect(migration).toContain("v.updated_at <= statement_timestamp() + interval '2 minutes'");
        expect(migration).toContain('p_radius_nm IS NULL');
        expect(migration).toContain('p_radius_nm NOT BETWEEN 0.1 AND 5');
        expect(migration).toContain('LIMIT 100');
        expect(migration).toContain('guardian_watchdog_resolved_at_idx');
        expect(migration).toContain('DROP FUNCTION IF EXISTS public.check_bolo_distance(UUID, BIGINT)');
        expect(migration).not.toContain('CREATE FUNCTION public.check_bolo_distance');
        expect(migration).not.toContain('CREATE FUNCTION public.check_geofence_distance');
    });

    it('reserves capture before Stripe and provides service-only reconciliation', () => {
        const migration = source('supabase/migrations/20260724090000_public_edge_quota_and_ais_rpc.sql');
        expect(migration).toContain("'capture_pending'");
        expect(migration).toContain('claim_marketplace_escrow_reconciliation');
        expect(migration).toContain('finalize_marketplace_escrow_release');
        expect(migration).toContain('complete_marketplace_escrow_cancellation');
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.claim_marketplace_escrow_reconciliation\(INTEGER\)\s+TO service_role/,
        );

        expect(functionSource('create-marketplace-payment')).toContain('requireAuthenticatedQuota(');
        expect(functionSource('capture-escrow-payment')).toContain('requireAuthenticatedQuota(');
        expect(functionSource('sweep-expired-escrows')).toContain('requireServiceRolePost(');
        for (const functionName of ['create-marketplace-payment', 'capture-escrow-payment', 'sweep-expired-escrows']) {
            const edge = functionSource(functionName);
            expect(edge).toContain('timeout: STRIPE_TIMEOUT_MS');
            expect(edge).toContain('maxNetworkRetries: 1');
        }
    });
});
