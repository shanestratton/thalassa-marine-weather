import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RECONCILED_PROTECTED_FUNCTIONS = {
    'elevenlabs-tts': 'signed-in voice caller plus authenticated quota',
    'fetch-wind-grid': 'app/Pi caller with user-or-anon JWT plus quota',
    'fetch-wind-velocity': 'app caller with user-or-anon JWT plus quota',
    'gebco-depth': 'app caller with user-or-anon JWT plus bathymetry quota',
    'get-weather': 'app/Pi caller with user-or-anon JWT plus weather quota',
    'lookup-vessel': 'signed-in vessel caller plus authenticated quota',
    'maritime-intel': 'public-news caller with anon JWT plus public quota',
    'proxy-amsa-msi': 'web notice caller with user-or-anon JWT plus quota',
    'proxy-gemini': 'signed-in AI caller plus authenticated provider quota',
    'proxy-nga-msi': 'web notice caller with user-or-anon JWT plus quota',
    'proxy-openmeteo': 'app/Pi caller with user-or-anon JWT plus weather quota',
    'proxy-spoonacular': 'held credentialed client with server-disabled provider',
    'proxy-stormglass': 'signed-in weather caller plus authenticated provider quota',
    'proxy-tides': 'app/Pi caller with user-or-anon JWT plus tides quota',
    'route-bathymetric': 'credentialed route caller plus route quota',
    'route-weather': 'credentialed route caller plus route quota',
} as const;

const EXISTING_PROTECTED_FUNCTIONS = {
    'delete-account': 'irreversible signed-in mutation with a second identity check',
    'register-apple-token': 'signed-in Apple code exchange with a second identity check',
} as const;

const EXISTING_CREDENTIALLESS_ALLOWLIST = {
    'apple-server-notification': 'provider-signed Apple JWS webhook',
    'float-plan': 'database-free tombstone for historical public links',
    'proxy-himawari-ir': 'map raster source that cannot attach Authorization',
    'proxy-rainbow': 'credentialless Pi passthrough with a per-client public quota',
    'voyage-log': 'public shore-contact link with a scoped published-data response',
} as const;

// These six match live gateway reality but are deliberately not persisted by
// this change. Making a new credentialless exception durable requires its own
// approval even though each function has a compensating boundary.
const REVIEW_PENDING_CREDENTIALLESS_ALLOWLIST = {
    'check-weather-alerts': 'exact service-role POST checked before cron work',
    'deepgram-ws-proxy': '60-second one-use WebSocket ticket',
    'fetch-gfs-tracker': 'bare cyclone fetch with a per-client public quota',
    'satellite-tile': 'map raster source with a per-client public quota',
    'send-anchor-alarm': 'exact service-role POST checked before alarm delivery',
    'send-push': 'exact service-role POST checked before push delivery',
} as const;

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
        const protectedFunctions = {
            ...EXISTING_PROTECTED_FUNCTIONS,
            ...RECONCILED_PROTECTED_FUNCTIONS,
        };

        for (const [name, callerRationale] of Object.entries(protectedFunctions)) {
            expect(callerRationale, `${name} must retain a reviewed caller rationale`).not.toHaveLength(0);
            expect(policies[name], `${name} must declare verify_jwt = true`).toBe(true);
        }
    });

    it('keeps the existing credentialless gateway bypasses narrowly allowlisted', () => {
        const configuredFalse = Object.entries(policies)
            .filter(([, verifyJwt]) => !verifyJwt)
            .map(([name]) => name)
            .sort();

        expect(configuredFalse).toEqual(Object.keys(EXISTING_CREDENTIALLESS_ALLOWLIST).sort());
    });

    it('documents all 22 live drift decisions without persisting new bypasses', () => {
        expect(Object.keys(RECONCILED_PROTECTED_FUNCTIONS)).toHaveLength(16);
        expect(Object.keys(REVIEW_PENDING_CREDENTIALLESS_ALLOWLIST)).toHaveLength(6);

        for (const [name, callerRationale] of Object.entries(REVIEW_PENDING_CREDENTIALLESS_ALLOWLIST)) {
            expect(callerRationale, `${name} must retain a reviewed caller rationale`).not.toHaveLength(0);
            expect(policies[name], `${name} requires separate approval before source persistence`).toBeUndefined();
        }
    });
});
