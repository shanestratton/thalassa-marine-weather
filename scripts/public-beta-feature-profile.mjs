import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PUBLIC_BETA_FEATURE_PROFILE_FILE = 'config/public-beta-features.json';
export const PUBLIC_BETA_FEATURE_ARTIFACT_FILE = 'public-beta-features.json';

export const PUBLIC_BETA_FEATURE_FLAG_KEYS = Object.freeze([
    'VITE_CMEMS_CURRENTS_ENABLED',
    'VITE_CMEMS_WAVES_ENABLED',
    'VITE_CMEMS_SST_ENABLED',
    'VITE_CMEMS_CHL_ENABLED',
    'VITE_CMEMS_SEAICE_ENABLED',
    'VITE_CMEMS_MLD_ENABLED',
    'VITE_MPA_ENABLED',
    'VITE_APPLE_SIGN_IN_ENABLED',
    'VITE_APPLE_MUSIC_ENABLED',
    'VITE_APPLE_WATCH_ENABLED',
    'VITE_GOOGLE_SIGN_IN_ENABLED',
    'VITE_ACCOUNT_DELETION_ENABLED',
    'VITE_GRANT_ALL_FEATURES',
    'VITE_ENABLE_ENC_DEMO_SAMPLES',
    'VITE_WX_SERVER_ENABLED',
]);

export const PUBLIC_BETA_ENDPOINT_KEYS = Object.freeze([
    'VITE_DEEPGRAM_PROXY_URL',
    'VITE_NATIVE_API_BASE',
    'VITE_WX_SERVER_BASE',
]);

export const PUBLIC_BETA_HELD_CAPABILITIES = Object.freeze([
    'apple-sign-in',
    'apple-watch-bridge',
    'account-deletion',
    'gmail',
    'grant-all-features',
    'enc-demo-samples',
    'private-weather-server',
    'community-precise-track-sharing',
    // 'musickit' RELEASED 2026-08-10: MusicKit App Service enabled on the App
    // ID, NSAppleMusicUsageDescription shipped, native AppleMusicPlugin wired.
    // The flag agreement gate in check-beta-readiness now governs it.
    'aishub-contribution',
    'retired-public-float-plan',
    // Calypso's conversational console, parked 2026-08-09: it mishears often
    // enough that a wrong answer and a right one sound identical. His voice
    // still reads MAYDAY, DSC and radio position reports — that path is
    // safetyTts and is not held.
    'calypso-voice-console',
    'calypso-proactive-alerts',
    'billing',
    'private-recipe-photos',
    'unverified-commercial-chart-packages',
    'spoonacular-online-catalogue',
    'marketplace',
]);

export const PUBLIC_BETA_REQUIRED_ABSENT_CLIENT_CONFIG = Object.freeze(['VITE_GOOGLE_OAUTH_CLIENT_ID']);
export const PUBLIC_BETA_REQUIRED_CREDENTIAL_PRESENCE = Object.freeze(['VITE_OWM_API_KEY', 'VITE_SENTRY_DSN']);

const PROFILE_KEYS = Object.freeze([
    'featureFlags',
    'heldCapabilities',
    'profile',
    'publicEndpoints',
    'requiredAbsentClientConfig',
    'requiredCredentialPresence',
    'schemaVersion',
]);
const ARTIFACT_KEYS = Object.freeze([...PROFILE_KEYS, 'credentialPresence', 'fingerprint'].sort());

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(value) {
    return isPlainObject(value) ? Object.keys(value).sort() : [];
}

function assertExactKeys(value, expected, label) {
    if (!isPlainObject(value) || JSON.stringify(sortedKeys(value)) !== JSON.stringify([...expected].sort())) {
        throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
    }
}

function assertExactStringSet(value, expected, label) {
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string') ||
        JSON.stringify([...new Set(value)].sort()) !== JSON.stringify([...expected].sort())
    ) {
        throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
    }
}

function normalizedHttpsEndpoint(value, label) {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${label} must be a valid HTTPS URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
    }
    return value.replace(/\/+$/, '');
}

export function normalizePublicBetaFeatureProfile(value) {
    assertExactKeys(value, PROFILE_KEYS, 'public-beta feature profile');
    if (value.schemaVersion !== 1) throw new Error('public-beta feature profile schemaVersion must equal 1');
    if (value.profile !== 'public-beta-v1')
        throw new Error('public-beta feature profile name must equal public-beta-v1');

    assertExactKeys(value.featureFlags, PUBLIC_BETA_FEATURE_FLAG_KEYS, 'featureFlags');
    const featureFlags = Object.fromEntries(
        PUBLIC_BETA_FEATURE_FLAG_KEYS.map((key) => {
            if (typeof value.featureFlags[key] !== 'boolean') throw new Error(`featureFlags.${key} must be boolean`);
            return [key, value.featureFlags[key]];
        }),
    );

    assertExactKeys(value.publicEndpoints, PUBLIC_BETA_ENDPOINT_KEYS, 'publicEndpoints');
    const publicEndpoints = {
        VITE_DEEPGRAM_PROXY_URL: normalizedHttpsEndpoint(
            value.publicEndpoints.VITE_DEEPGRAM_PROXY_URL,
            'publicEndpoints.VITE_DEEPGRAM_PROXY_URL',
        ),
        VITE_NATIVE_API_BASE: normalizedHttpsEndpoint(
            value.publicEndpoints.VITE_NATIVE_API_BASE,
            'publicEndpoints.VITE_NATIVE_API_BASE',
        ),
        VITE_WX_SERVER_BASE: value.publicEndpoints.VITE_WX_SERVER_BASE,
    };
    if (typeof publicEndpoints.VITE_WX_SERVER_BASE !== 'string') {
        throw new Error('publicEndpoints.VITE_WX_SERVER_BASE must be a string');
    }

    assertExactStringSet(value.heldCapabilities, PUBLIC_BETA_HELD_CAPABILITIES, 'heldCapabilities');
    assertExactStringSet(
        value.requiredAbsentClientConfig,
        PUBLIC_BETA_REQUIRED_ABSENT_CLIENT_CONFIG,
        'requiredAbsentClientConfig',
    );
    assertExactStringSet(
        value.requiredCredentialPresence,
        PUBLIC_BETA_REQUIRED_CREDENTIAL_PRESENCE,
        'requiredCredentialPresence',
    );

    return {
        schemaVersion: 1,
        profile: 'public-beta-v1',
        featureFlags,
        publicEndpoints,
        heldCapabilities: [...PUBLIC_BETA_HELD_CAPABILITIES],
        requiredAbsentClientConfig: [...PUBLIC_BETA_REQUIRED_ABSENT_CLIENT_CONFIG],
        requiredCredentialPresence: [...PUBLIC_BETA_REQUIRED_CREDENTIAL_PRESENCE],
    };
}

export function readPublicBetaFeatureProfile(root) {
    const target = path.resolve(root, PUBLIC_BETA_FEATURE_PROFILE_FILE);
    return normalizePublicBetaFeatureProfile(JSON.parse(fs.readFileSync(target, 'utf8')));
}

export function publicBetaCredentialPresenceFromEnvironment(profile, environment) {
    const normalized = normalizePublicBetaFeatureProfile(profile);
    return Object.fromEntries(
        normalized.requiredCredentialPresence.map((name) => [name, String(environment[name] ?? '').trim().length > 0]),
    );
}

function normalizeCredentialPresence(profile, value) {
    const normalized = normalizePublicBetaFeatureProfile(profile);
    assertExactKeys(value, normalized.requiredCredentialPresence, 'credentialPresence');
    return Object.fromEntries(
        normalized.requiredCredentialPresence.map((name) => {
            if (typeof value[name] !== 'boolean') throw new Error(`credentialPresence.${name} must be boolean`);
            return [name, value[name]];
        }),
    );
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

export function createPublicBetaFeatureArtifact(profile, credentialPresence) {
    const normalized = normalizePublicBetaFeatureProfile(profile);
    const normalizedPresence = normalizeCredentialPresence(normalized, credentialPresence);
    const fingerprintPayload = { ...normalized, credentialPresence: normalizedPresence };
    const fingerprint = fingerprintForPayload(fingerprintPayload);
    return { ...fingerprintPayload, fingerprint };
}

function fingerprintForPayload(payload) {
    return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

export function serializePublicBetaFeatureArtifact(profile, credentialPresence) {
    return `${JSON.stringify(createPublicBetaFeatureArtifact(profile, credentialPresence), null, 2)}\n`;
}

export function publicBetaFeatureDefines(profile) {
    const normalized = normalizePublicBetaFeatureProfile(profile);
    const entries = [
        ...Object.entries(normalized.featureFlags).map(([key, enabled]) => [key, String(enabled)]),
        ...Object.entries(normalized.publicEndpoints),
        ...normalized.requiredAbsentClientConfig.map((key) => [key, '']),
    ];
    return Object.fromEntries(entries.map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]));
}

/**
 * Production may receive repository/Vercel/local environment variables, but
 * they are assertions rather than overrides. A supplied value must agree with
 * the committed profile or the build stops before emitting mixed artifacts.
 * Required-absent identifiers are not overrideable at all: the Vite defines
 * above always replace them with an empty string.
 */
export function publicBetaFeatureEnvironmentConflicts(profile, environment) {
    const normalized = normalizePublicBetaFeatureProfile(profile);
    const expected = {
        ...Object.fromEntries(Object.entries(normalized.featureFlags).map(([key, value]) => [key, String(value)])),
        ...normalized.publicEndpoints,
    };
    return Object.entries(expected)
        .filter(([key, value]) => Object.hasOwn(environment, key) && String(environment[key] ?? '') !== value)
        .map(([key]) => key)
        .sort();
}

export function publicBetaFeatureArtifactFailures(value, profile, expectedCredentialPresence) {
    let expected;
    try {
        expected = createPublicBetaFeatureArtifact(profile, expectedCredentialPresence);
    } catch (error) {
        return [`expected public-beta profile is invalid: ${error instanceof Error ? error.message : error}`];
    }
    if (!isPlainObject(value)) return ['feature manifest must contain a JSON object'];

    const failures = [];
    if (JSON.stringify(sortedKeys(value)) !== JSON.stringify(ARTIFACT_KEYS)) {
        failures.push(`manifest keys must equal ${ARTIFACT_KEYS.join(', ')}`);
    }
    for (const [key, enabled] of Object.entries(expected.featureFlags)) {
        if (value.featureFlags?.[key] !== enabled) failures.push(`${key} must equal ${enabled}`);
    }
    for (const [key, endpoint] of Object.entries(expected.publicEndpoints)) {
        if (value.publicEndpoints?.[key] !== endpoint) failures.push(`${key} endpoint does not match the profile`);
    }
    for (const name of expected.requiredAbsentClientConfig) {
        if (!value.requiredAbsentClientConfig?.includes(name)) failures.push(`${name} must remain absent`);
    }
    for (const name of expected.requiredCredentialPresence) {
        if (value.credentialPresence?.[name] !== expected.credentialPresence[name]) {
            failures.push(
                expected.credentialPresence[name]
                    ? `${name} must be present at build time`
                    : `${name} presence does not match the expected build environment`,
            );
        }
    }
    let contentFingerprint = null;
    try {
        const actualProfile = Object.fromEntries(PROFILE_KEYS.map((key) => [key, value[key]]));
        const normalizedActualProfile = normalizePublicBetaFeatureProfile(actualProfile);
        const normalizedActualPresence = normalizeCredentialPresence(normalizedActualProfile, value.credentialPresence);
        contentFingerprint = fingerprintForPayload({
            ...normalizedActualProfile,
            credentialPresence: normalizedActualPresence,
        });
    } catch (error) {
        failures.push(`feature manifest structure is invalid: ${error instanceof Error ? error.message : error}`);
    }
    if (value.fingerprint !== expected.fingerprint || value.fingerprint !== contentFingerprint) {
        failures.push('feature manifest fingerprint does not match');
    }
    if (canonicalJson(value) !== canonicalJson(expected) && failures.length === 0) {
        failures.push('feature manifest does not byte-semantically match the canonical public-beta profile');
    }
    return failures;
}
