import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * refreshSkipperClaim — the targeted cloud pull that makes the skipper-device
 * claim actually exclusive across devices.
 *
 * The claim rides in user_settings, and pullFromCloud runs ONCE per sign-in
 * generation — nothing re-pulled mid-session. Shane's iPhone + iPad (same
 * account) therefore both showed "This Device" and both published: each kept
 * its own local claim forever. This function is the fix, so its contract needs
 * pinning:
 *   1. a differing cloud claim REPLACES the local one (takeover lands here),
 *   2. application is echo-free (no merge_user_settings upload — echoing would
 *      ping-pong claimedAt between devices),
 *   3. it persists to Preferences (or a cold boot resurrects the stale claim),
 *   4. offline/error keeps the local claim (fail-open at sea, per mayPublish),
 *   5. the maxAgeMs throttle actually suppresses repeat fetches.
 */

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    /** cloud user_settings.settings.skipperDevice, keyed by user id */
    cloudClaim: {} as Record<string, { deviceId: string; deviceName: string; claimedAt: string } | null>,
    /** every select string that hit user_settings */
    claimSelects: [] as string[],
    cloudPatches: [] as Array<Record<string, unknown>>,
    failNextClaimRead: false,
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: harness.preferences[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.preferences[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete harness.preferences[key];
        }),
    },
}));

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            let eqValue = '';
            let selectStr = '';
            const builder = {
                select: (s: string) => {
                    selectStr = s;
                    return builder;
                },
                eq: (_column: string, value: string) => {
                    eqValue = value;
                    return builder;
                },
                maybeSingle: async () => {
                    if (table === 'user_settings' && selectStr === 'settings->skipperDevice') {
                        harness.claimSelects.push(selectStr);
                        if (harness.failNextClaimRead) {
                            harness.failNextClaimRead = false;
                            return { data: null, error: { message: 'network unreachable' } };
                        }
                        const claim = harness.cloudClaim[eqValue];
                        // PostgREST arrow selection aliases to the leaf key.
                        return { data: claim === undefined ? null : { skipperDevice: claim }, error: null };
                    }
                    if (table === 'user_settings') {
                        return { data: null, error: null };
                    }
                    return { data: null, error: null };
                },
            };
            return builder;
        }),
        rpc: vi.fn(async (name: string, args?: Record<string, unknown>) => {
            if (name === 'merge_user_settings' && args) harness.cloudPatches.push(args);
            return { data: null, error: null };
        }),
    },
}));

vi.mock('../../services/PiCacheService', () => ({
    piCache: { boot: vi.fn(), setDiaryRelayInternetPolicy: vi.fn(async () => false) },
}));
vi.mock('../../services/SubscriptionService', () => ({
    tierIsPro: (tier: string | undefined) => tier === 'crew' || tier === 'owner',
}));
vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@capacitor/geolocation', () => ({
    Geolocation: { requestPermissions: vi.fn(async () => ({ location: 'granted' })) },
}));

type SettingsModule = typeof import('../../stores/settingsStore');
type IdentityModule = typeof import('../../services/authIdentityScope');

const IPAD_CLAIM = { deviceId: 'dev-ipad', deviceName: 'iPad · beef', claimedAt: '2026-08-01T00:00:00.000Z' };
const IPHONE_CLAIM = { deviceId: 'dev-iphone', deviceName: 'iPhone · f00d', claimedAt: '2026-08-01T01:00:00.000Z' };

async function freshStore(): Promise<{ settings: SettingsModule; identity: IdentityModule }> {
    vi.resetModules();
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    for (const key of Object.keys(harness.cloudClaim)) delete harness.cloudClaim[key];
    harness.claimSelects.length = 0;
    harness.cloudPatches.length = 0;
    harness.failNextClaimRead = false;
    localStorage.clear();
    const identity = await import('../../services/authIdentityScope');
    const settings = await import('../../stores/settingsStore');
    identity.setAuthIdentityScope('skipper-1');
    settings.useSettingsStore.getState()._setUserId('skipper-1');
    await settings.awaitSettingsLoaded();
    return { settings, identity };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('refreshSkipperClaim', () => {
    it('lands a takeover made on another device, without echoing an upload', async () => {
        const { settings } = await freshStore();
        // This device believes it holds the claim (the shipped stale state).
        settings.useSettingsStore.setState((s) => ({
            settings: { ...s.settings, skipperDevice: IPHONE_CLAIM },
        }));
        harness.cloudClaim['skipper-1'] = IPAD_CLAIM; // the iPad took over
        harness.cloudPatches.length = 0;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        expect(settings.useSettingsStore.getState().settings.skipperDevice).toEqual(IPAD_CLAIM);
        // Echo-free: applying a cloud value must never upload it back.
        expect(harness.cloudPatches).toHaveLength(0);
        // Persisted: a cold boot must not resurrect the stale claim.
        const persisted = Object.entries(harness.preferences).find(([, v]) => v.includes('dev-ipad'));
        expect(persisted).toBeTruthy();
    });

    it('a released claim (cloud null) clears the local one', async () => {
        const { settings } = await freshStore();
        settings.useSettingsStore.setState((s) => ({
            settings: { ...s.settings, skipperDevice: IPHONE_CLAIM },
        }));
        harness.cloudClaim['skipper-1'] = null;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        expect(settings.useSettingsStore.getState().settings.skipperDevice).toBeUndefined();
    });

    it('offline keeps the local claim — fail-open at sea', async () => {
        const { settings } = await freshStore();
        settings.useSettingsStore.setState((s) => ({
            settings: { ...s.settings, skipperDevice: IPHONE_CLAIM },
        }));
        harness.failNextClaimRead = true;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        expect(settings.useSettingsStore.getState().settings.skipperDevice).toEqual(IPHONE_CLAIM);
    });

    it('an identical cloud claim is a no-op (no state churn, no persistence write)', async () => {
        const { settings } = await freshStore();
        settings.useSettingsStore.setState((s) => ({
            settings: { ...s.settings, skipperDevice: IPHONE_CLAIM },
        }));
        harness.cloudClaim['skipper-1'] = { ...IPHONE_CLAIM };
        const before = settings.useSettingsStore.getState().settings;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });

        expect(settings.useSettingsStore.getState().settings).toBe(before);
    });

    it('throttles: a second call inside maxAgeMs does not refetch', async () => {
        const { settings } = await freshStore();
        harness.cloudClaim['skipper-1'] = IPAD_CLAIM;

        await settings.refreshSkipperClaim({ maxAgeMs: 0 });
        const fetches = harness.claimSelects.length;
        await settings.refreshSkipperClaim({ maxAgeMs: 60_000 });

        expect(harness.claimSelects.length).toBe(fetches);
    });
});
