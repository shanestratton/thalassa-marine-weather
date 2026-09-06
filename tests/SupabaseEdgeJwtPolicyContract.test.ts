/**
 * Every Edge Function's gateway JWT policy is declared in supabase/config.toml,
 * with a reason, and this test holds the file to the decisions.
 *
 * Audit item 17 (2026-09-05, revised 2026-09-06): 22 functions ran
 * verify_jwt=false on production against a `true` here. The first plan was to
 * flip production; then the dashboard's own toggle text was read: "Verify JWT
 * with legacy secret … Recommended: OFF with JWT and custom auth logic in your
 * function code." The check is bound to the legacy secret and breaks under the
 * new signing keys; every drifted function already guards itself. So the drift
 * resolved by the FILE moving to false, and nothing was toggled. Each function
 * is in exactly one of three buckets, and the buckets add up to the inventory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * verify_jwt = false, matching production, because the function guards itself —
 * the "custom auth logic in your function code" the platform recommends over the
 * legacy-secret gateway check. The rationale names the guard.
 */
const FUNCTION_GUARDED_OFF = {
    'elevenlabs-tts': 'requireAuthenticatedQuota verifies the signed-in session',
    'fetch-wind-grid': 'per-client public quota; app and Pi-cache callers',
    'fetch-wind-velocity': 'per-client public quota; no client caller remains',
    'gebco-depth': 'per-client public quota on public bathymetry',
    'get-weather': 'requireAuthenticatedOrPublicQuota selects the quota',
    'lookup-vessel': 'requireAuthenticatedQuota verifies the signed-in session',
    'maritime-intel': 'requireAuthenticatedOrPublicQuota plus a 10-minute cache',
    'proxy-amsa-msi': 'per-client public quota on a public notice feed',
    'proxy-gemini': 'requireAuthenticatedQuota verifies the signed-in session',
    'proxy-nga-msi': 'per-client public quota on a public notice feed',
    'proxy-openmeteo': 'per-client public quota; app and Pi-cache callers',
    'proxy-spoonacular': 'server-disabled provider plus a public quota',
    'proxy-stormglass': 'requireAuthenticatedQuota verifies the signed-in session',
    'proxy-tides': 'per-client public quota; app and Pi-cache callers',
    'route-bathymetric': 'public quota; routing moved client-side, no caller remains',
    'route-weather': 'service-role check plus a public quota',
} as const;

/** Already true on both sides; kept explicit with a caller rationale. */
const EXISTING_PROTECTED_FUNCTIONS = {
    'crew-phone-verification':
        'signed-in Crew List identity challenge with a second user-session check inside the function',
    'crew-profile-publication': 'signed-in publication request; the function fetches canonical data itself',
    'delete-account': 'irreversible signed-in mutation with a second identity check',
    'feedback-email-worker':
        'gateway-verified JWT plus a worker-level service_role claim or bounded exact internal worker secret',
    'founding-skipper-email-worker':
        'gateway-verified JWT plus a worker-level service_role claim or bounded exact internal worker secret',
    'register-apple-token': 'signed-in Apple code exchange with a second identity check',
} as const;

/** Callers that cannot present a Supabase JWT at all. Each function guards itself. */
const CREDENTIALLESS_ALLOWLIST = {
    'apple-server-notification': 'provider-signed Apple JWS webhook',
    'check-weather-alerts': 'pg_cron/pg_net POST with the service key; exact service-role POST checked before work',
    'deepgram-ws-proxy': 'browser WebSocket upgrade cannot carry Authorization; 60-second one-use ticket',
    'diary-relay':
        'Pi relay authenticates with its own relay token by design; pair/upsert/cancel verify user JWTs internally',
    'feedback-submission':
        'public feedback form with exact-origin CORS, HMAC per-client quota, strict validation, and service-role-only RPC',
    'fetch-gfs-tracker': 'bare fetch(url) from CycloneTrackingService; per-client public quota inside',
    'float-plan': 'database-free tombstone for historical public links',
    'founding-skipper-application': 'public application form with HMAC per-client quota and service-role-only RPC',
    'moderate-chat-message':
        'chat_messages trigger / retry sweep over pg_net with the service key; exact service-role POST checked',
    'proxy-himawari-ir': 'map raster source that cannot attach Authorization',
    'proxy-rainbow': 'credentialless Pi passthrough with a per-client public quota',
    'satellite-tile': 'map raster source that cannot attach Authorization; per-client public quota inside',
    'send-anchor-alarm': 'database trigger over pg_net with the service key; exact service-role POST checked',
    'send-push': 'database trigger / retry sweep over pg_net with the service key; exact service-role POST checked',
    'telemetry-relay':
        'Pi relay authenticates with its own relay token (the diary-relay pairing, via _shared/pi-relay-auth); no user JWT by design',
    'voyage-log': 'public shore-contact link with a scoped published-data response',
} as const;

/** The 22 that had drifted on 2026-09-05 — every one must land in a bucket above. */
const DRIFTED_ON_2026_09_05 = [
    'check-weather-alerts',
    'deepgram-ws-proxy',
    'elevenlabs-tts',
    'fetch-gfs-tracker',
    'fetch-wind-grid',
    'fetch-wind-velocity',
    'gebco-depth',
    'get-weather',
    'lookup-vessel',
    'maritime-intel',
    'proxy-amsa-msi',
    'proxy-gemini',
    'proxy-nga-msi',
    'proxy-openmeteo',
    'proxy-spoonacular',
    'proxy-stormglass',
    'proxy-tides',
    'route-bathymetric',
    'route-weather',
    'satellite-tile',
    'send-anchor-alarm',
    'send-push',
] as const;

function parseVerifyJwtPolicies(source: string): Record<string, boolean> {
    const policies: Record<string, boolean> = {};
    let currentFunction: string | null = null;

    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        const section = line.match(/^\[functions\.([a-z0-9-]+)\]$/);
        if (section) {
            currentFunction = section[1];
            if (currentFunction in policies) throw new Error(`Duplicate function policy: ${currentFunction}`);
            continue;
        }

        if (!currentFunction) continue;
        const setting = line.match(/^verify_jwt\s*=\s*(true|false)$/);
        if (setting) {
            policies[currentFunction] = setting[1] === 'true';
            currentFunction = null;
        }
    }

    return policies;
}

describe('Supabase Edge gateway JWT policy', () => {
    const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
    const policies = parseVerifyJwtPolicies(config);

    it('keeps the gateway check only on the reviewed irreversible / credential-issuing paths', () => {
        for (const [name, rationale] of Object.entries(EXISTING_PROTECTED_FUNCTIONS)) {
            expect(rationale, `${name} must retain a reviewed caller rationale`).not.toHaveLength(0);
            expect(policies[name], `${name} must declare verify_jwt = true`).toBe(true);
        }
        const configuredTrue = Object.entries(policies)
            .filter(([, verifyJwt]) => verifyJwt)
            .map(([name]) => name)
            .sort();
        expect(configuredTrue).toEqual(Object.keys(EXISTING_PROTECTED_FUNCTIONS).sort());
    });

    it('declares exactly the credentialless and function-guarded functions as verify_jwt = false', () => {
        const configuredFalse = Object.entries(policies)
            .filter(([, verifyJwt]) => !verifyJwt)
            .map(([name]) => name)
            .sort();
        const expected = [...Object.keys(CREDENTIALLESS_ALLOWLIST), ...Object.keys(FUNCTION_GUARDED_OFF)].sort();
        expect(configuredFalse).toEqual(expected);
    });

    it('records the platform guidance that decided the drift, so nobody flips these back on by reflex', () => {
        expect(config).toContain('Recommended: OFF with JWT and custom auth logic in your function code');
        expect(config).not.toContain('PI-PENDING');
    });

    it('accounts for all 22 functions that had drifted on 2026-09-05, each in exactly one bucket', () => {
        const buckets: Record<string, readonly string[]> = {
            functionGuarded: Object.keys(FUNCTION_GUARDED_OFF),
            credentialless: Object.keys(CREDENTIALLESS_ALLOWLIST),
        };
        for (const name of DRIFTED_ON_2026_09_05) {
            const hits = Object.entries(buckets).filter(([, names]) => names.includes(name));
            expect(
                hits.map(([b]) => b),
                `${name} must be in exactly one bucket`,
            ).toHaveLength(1);
        }
        expect(DRIFTED_ON_2026_09_05).toHaveLength(22);
        // 16 function-guarded + 6 credentialless drifts = 22.
        expect(Object.keys(FUNCTION_GUARDED_OFF)).toHaveLength(16);
        // The six credentialless drifts, the eight already allowlisted,
        // moderate-chat-message (new 2026-09-05, same pg_net shape as send-push),
        // and telemetry-relay (new 2026-09-06, the Pi's relay-token pairing).
        expect(Object.keys(CREDENTIALLESS_ALLOWLIST)).toHaveLength(16);
    });

    it('every declared function has a comment explaining its policy', () => {
        for (const name of Object.keys(policies)) {
            const at = config.indexOf(`[functions.${name}]`);
            const block = config.slice(at, config.indexOf('verify_jwt', at));
            expect(
                block.split('\n').some((l) => l.trim().startsWith('#')),
                `${name} needs a reason`,
            ).toBe(true);
        }
    });
});
