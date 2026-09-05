/**
 * Every Edge Function's gateway JWT policy is declared in supabase/config.toml,
 * with a reason, and this test holds the file to the decisions.
 *
 * Audit item 17 (2026-09-05): 22 functions ran verify_jwt=false on production
 * against a `true` here — the flag had lived in whoever's shell ran the last
 * deploy. The production probe that day showed the gateway accepts the
 * sb_publishable_ key on verify_jwt=true functions, so `true` only breaks a
 * caller that sends NO credential. Each function below is therefore in exactly
 * one of four buckets, and the buckets add up to the whole inventory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Remote was false, config true; every caller sends a credential → flip remote to true (dashboard toggle). */
const FLIP_TO_TRUE = {
    'elevenlabs-tts': 'signed-in voice callers via getAuthenticatedFunctionHeaders',
    'fetch-wind-velocity': 'no client caller remains; nothing to break',
    'gebco-depth': 'phone-only callers, user JWT or publishable-key fallback',
    'lookup-vessel': 'signed-in vessel caller via getAuthenticatedFunctionHeaders',
    'maritime-intel': 'MaritimeIntelService sends the publishable key as Bearer',
    'proxy-amsa-msi': 'NoticeToMarinersService sends the publishable key as Bearer',
    'proxy-gemini': 'three signed-in callers via getAuthenticatedFunctionHeaders',
    'proxy-nga-msi': 'NoticeToMarinersService sends the publishable key as Bearer',
    'proxy-spoonacular': 'supabase.functions.invoke always sends a credential',
    'proxy-stormglass': 'signed-in weather caller via getAuthenticatedFunctionHeaders',
    'route-bathymetric': 'bathymetricRouter sends the app URL and publishable key',
    'route-weather': 'weatherRouter always sends Authorization plus apikey',
} as const;

/** Already true on both sides; kept explicit with a caller rationale. */
const EXISTING_PROTECTED_FUNCTIONS = {
    'crew-phone-verification':
        'signed-in Crew List identity challenge with a second user-session check inside the function',
    'crew-profile-publication': 'signed-in publication request; the function fetches canonical data itself',
    'delete-account': 'irreversible signed-in mutation with a second identity check',
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
    'proxy-himawari-ir': 'map raster source that cannot attach Authorization',
    'proxy-rainbow': 'credentialless Pi passthrough with a per-client public quota',
    'satellite-tile': 'map raster source that cannot attach Authorization; per-client public quota inside',
    'send-anchor-alarm': 'database trigger over pg_net with the service key; exact service-role POST checked',
    'send-push': 'database trigger / retry sweep over pg_net with the service key; exact service-role POST checked',
    'voyage-log': 'public shore-contact link with a scoped published-data response',
} as const;

/**
 * The phone sends a credential, but the boat Pi also calls these upstream for
 * its cache and its headers could not be read from ashore on 2026-09-05. They
 * stay false until the Pi is checked; the config block says PI-PENDING.
 */
const PI_PENDING_FALSE = {
    'fetch-wind-grid': 'Pi GRIB cache upstream',
    'get-weather': 'Pi weather cache upstream',
    'proxy-openmeteo': 'Pi weather cache upstream',
    'proxy-tides': 'Pi tides cache upstream',
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

    it('explicitly protects every credentialed function at the gateway', () => {
        for (const [name, rationale] of Object.entries({ ...EXISTING_PROTECTED_FUNCTIONS, ...FLIP_TO_TRUE })) {
            expect(rationale, `${name} must retain a reviewed caller rationale`).not.toHaveLength(0);
            expect(policies[name], `${name} must declare verify_jwt = true`).toBe(true);
        }
    });

    it('declares exactly the credentialless and PI-PENDING functions as verify_jwt = false', () => {
        const configuredFalse = Object.entries(policies)
            .filter(([, verifyJwt]) => !verifyJwt)
            .map(([name]) => name)
            .sort();
        const expected = [...Object.keys(CREDENTIALLESS_ALLOWLIST), ...Object.keys(PI_PENDING_FALSE)].sort();
        expect(configuredFalse).toEqual(expected);
    });

    it('marks the four Pi-called functions PI-PENDING in the config, so they are re-checked aboard', () => {
        for (const name of Object.keys(PI_PENDING_FALSE)) {
            const at = config.indexOf(`[functions.${name}]`);
            expect(at, name).toBeGreaterThan(0);
            const block = config.slice(at, config.indexOf('verify_jwt', at));
            expect(block, `${name} block must say PI-PENDING`).toContain('PI-PENDING');
        }
    });

    it('accounts for all 22 functions that had drifted on 2026-09-05, each in exactly one bucket', () => {
        const buckets: Record<string, readonly string[]> = {
            flipToTrue: Object.keys(FLIP_TO_TRUE),
            credentialless: Object.keys(CREDENTIALLESS_ALLOWLIST),
            piPending: Object.keys(PI_PENDING_FALSE),
        };
        for (const name of DRIFTED_ON_2026_09_05) {
            const hits = Object.entries(buckets).filter(([, names]) => names.includes(name));
            expect(
                hits.map(([b]) => b),
                `${name} must be in exactly one bucket`,
            ).toHaveLength(1);
        }
        expect(DRIFTED_ON_2026_09_05).toHaveLength(22);
        expect(Object.keys(FLIP_TO_TRUE)).toHaveLength(12);
        // The six credentialless drifts plus the eight that were already allowlisted.
        expect(Object.keys(CREDENTIALLESS_ALLOWLIST)).toHaveLength(14);
        expect(Object.keys(PI_PENDING_FALSE)).toHaveLength(4);
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
