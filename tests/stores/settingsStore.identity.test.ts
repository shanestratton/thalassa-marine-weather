import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../../types';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    deferredGets: new Map<string, Array<Promise<{ value: string | null }>>>(),
    deferredSets: new Map<string, Array<Promise<void>>>(),
    getCalls: [] as string[],
    setCalls: [] as Array<{ key: string; value: string }>,
    profileSettings: {} as Record<string, Partial<UserSettings> | null>,
    vessels: {} as Record<string, Record<string, unknown> | null>,
    upserts: [] as Array<Record<string, unknown>>,
    geolocationPromise: null as Promise<{ location: string }> | null,
    geolocationCalls: 0,
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => {
            harness.getCalls.push(key);
            const pending = harness.deferredGets.get(key);
            if (pending?.length) return pending.shift()!;
            return { value: harness.preferences[key] ?? null };
        }),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.setCalls.push({ key, value });
            const pending = harness.deferredSets.get(key);
            if (pending?.length) await pending.shift();
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
            const builder = {
                select: () => builder,
                eq: (_column: string, value: string) => {
                    eqValue = value;
                    return builder;
                },
                maybeSingle: async () => {
                    if (table === 'profiles') {
                        const settings = harness.profileSettings[eqValue];
                        return { data: settings ? { settings } : null, error: null };
                    }
                    if (table === 'vessel_identity') {
                        return { data: harness.vessels[eqValue] ?? null, error: null };
                    }
                    return { data: null, error: null };
                },
                upsert: async (payload: Record<string, unknown>) => {
                    harness.upserts.push(payload);
                    return { data: null, error: null };
                },
            };
            return builder;
        }),
    },
}));

vi.mock('../../services/PiCacheService', () => ({
    piCache: { boot: vi.fn() },
}));

vi.mock('../../services/SubscriptionService', () => ({
    tierIsPro: (tier: string | undefined) => tier === 'crew' || tier === 'owner',
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock('@capacitor/geolocation', () => ({
    Geolocation: {
        requestPermissions: vi.fn(async () => {
            harness.geolocationCalls += 1;
            return harness.geolocationPromise ?? { location: 'granted' };
        }),
    },
}));

type SettingsModule = typeof import('../../stores/settingsStore');
type IdentityModule = typeof import('../../services/authIdentityScope');

function resetHarness(): void {
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    harness.deferredGets.clear();
    harness.deferredSets.clear();
    harness.getCalls.length = 0;
    harness.setCalls.length = 0;
    for (const key of Object.keys(harness.profileSettings)) delete harness.profileSettings[key];
    for (const key of Object.keys(harness.vessels)) delete harness.vessels[key];
    harness.upserts.length = 0;
    harness.geolocationPromise = null;
    harness.geolocationCalls = 0;
    localStorage.clear();
}

async function freshStore(seed?: () => void): Promise<{ settings: SettingsModule; identity: IdentityModule }> {
    vi.resetModules();
    resetHarness();
    seed?.();
    const identity = await import('../../services/authIdentityScope');
    const settings = await import('../../stores/settingsStore');
    await settings.awaitSettingsLoaded();
    return { settings, identity };
}

function vessel(name: string, draft: number) {
    return {
        name,
        type: 'sail' as const,
        length: 40,
        beam: 12,
        draft,
        displacement: 20_000,
        maxWaveHeight: 5,
        cruisingSpeed: 7,
        fuelCapacity: 100,
        waterCapacity: 200,
    };
}

async function update(settings: SettingsModule, patch: Partial<UserSettings>): Promise<void> {
    await settings.useSettingsStore.getState().updateSettings(patch);
}

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('settingsStore identity isolation', () => {
    it('keeps A and B durable state isolated across A → B → A with synchronous warm paint', async () => {
        const { settings, identity } = await freshStore();

        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();
        await update(settings, { firstName: 'Alice', vessel: vessel('A Boat', 6) });

        identity.setAuthIdentityScope('account-b');
        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
        await settings.awaitSettingsLoaded();
        await update(settings, { firstName: 'Bob', vessel: vessel('B Boat', 4) });

        identity.setAuthIdentityScope('account-a');
        // The account-scoped localStorage mirror paints before async
        // Preferences has made a single bridge round trip.
        expect(settings.useSettingsStore.getState().settings.firstName).toBe('Alice');
        expect(settings.useSettingsStore.getState().settings.vessel?.name).toBe('A Boat');
        await settings.awaitSettingsLoaded();

        const aKey = identity.authScopedStorageKey('thalassa_settings', identity.getAuthIdentityScope());
        identity.setAuthIdentityScope('account-b');
        const bKey = identity.authScopedStorageKey('thalassa_settings', identity.getAuthIdentityScope());
        expect(JSON.parse(harness.preferences[aKey])).toMatchObject({
            owner_user_id: 'account-a',
            settings: { firstName: 'Alice', vessel: { name: 'A Boat' } },
        });
        expect(JSON.parse(harness.preferences[bKey])).toMatchObject({
            owner_user_id: 'account-b',
            settings: { firstName: 'Bob', vessel: { name: 'B Boat' } },
        });
    });

    it('warm-paints a known same-account mirror on a fresh store instance', async () => {
        vi.resetModules();
        resetHarness();
        const identity = await import('../../services/authIdentityScope');
        const aScope = identity.setAuthIdentityScope('account-a');
        localStorage.setItem(
            identity.authScopedStorageKey('thalassa_settings_mirror', aScope),
            JSON.stringify({
                version: 2,
                owner_user_id: 'account-a',
                settings: {
                    subscriptionTier: 'owner',
                    firstName: 'Warm Alice',
                    vessel: vessel('Warm A Boat', 6),
                },
            }),
        );

        const settings = await import('../../stores/settingsStore');
        expect(settings.useSettingsStore.getState()).toMatchObject({
            loading: false,
            settings: {
                firstName: 'Warm Alice',
                vessel: { name: 'Warm A Boat' },
            },
        });
        await settings.awaitSettingsLoaded();
    });

    it('fences a stale A disk promise before it can replace B state', async () => {
        const { settings, identity } = await freshStore();
        const aScope = {
            key: 'user:account-a',
            userId: 'account-a',
            generation: identity.getAuthIdentityScope().generation + 1,
        };
        const aKey = identity.authScopedStorageKey('thalassa_settings', aScope);
        const diskRead = deferred<{ value: string | null }>();
        harness.deferredGets.set(aKey, [diskRead.promise]);

        identity.setAuthIdentityScope('account-a');
        await vi.waitFor(() => expect(harness.getCalls).toContain(aKey));

        identity.setAuthIdentityScope('account-b');
        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        diskRead.resolve({
            value: JSON.stringify({
                version: 2,
                owner_user_id: 'account-a',
                settings: { ...settings.DEFAULT_SETTINGS, firstName: 'Late Alice', vessel: vessel('Late A', 7) },
            }),
        });
        await settings.awaitSettingsLoaded();

        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
    });

    it('fences stale A cloud/geolocation work from B state, storage, and events', async () => {
        const { settings, identity } = await freshStore();
        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();

        harness.profileSettings['account-a'] = { firstName: 'Cloud Alice' };
        harness.vessels['account-a'] = {
            vessel_name: 'Cloud A Boat',
            vessel_type: 'sail',
            model: 'A Model',
        };
        const permission = deferred<{ location: string }>();
        harness.geolocationPromise = permission.promise;
        const dispatch = vi.spyOn(window, 'dispatchEvent');

        settings.useSettingsStore.getState()._setUserId('account-a');
        await vi.waitFor(() => expect(harness.geolocationCalls).toBe(1));

        identity.setAuthIdentityScope('account-b');
        permission.resolve({ location: 'granted' });
        await settings.awaitSettingsLoaded();
        await Promise.resolve();

        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
        expect(
            dispatch.mock.calls.some(
                ([event]) =>
                    event instanceof CustomEvent &&
                    (event.type === 'thalassa:settings-restored' || event.type === 'thalassa:settings-restored-modal'),
            ),
        ).toBe(false);
        const bKey = identity.authScopedStorageKey('thalassa_settings', identity.getAuthIdentityScope());
        expect(harness.preferences[bKey]).toBeUndefined();
    });

    it('does not launch A cloud sync when its disk write resolves after switching to B', async () => {
        const { settings, identity } = await freshStore();
        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();
        const aKey = identity.authScopedStorageKey('thalassa_settings', identity.getAuthIdentityScope());
        const diskWrite = deferred<void>();
        harness.deferredSets.set(aKey, [diskWrite.promise]);

        const saving = settings.useSettingsStore.getState().updateSettings({
            firstName: 'Late Alice',
            vessel: vessel('Late A Boat', 7),
        });
        await vi.waitFor(() => expect(harness.setCalls.some(({ key }) => key === aKey)).toBe(true));
        identity.setAuthIdentityScope('account-b');
        diskWrite.resolve();
        await saving;
        await settings.awaitSettingsLoaded();

        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(harness.upserts).toEqual([]);
        expect(JSON.parse(harness.preferences[aKey])).toMatchObject({
            owner_user_id: 'account-a',
            settings: { firstName: 'Late Alice' },
        });
    });

    it('reconciles B cloud data only with B local defaults, never A vessel state', async () => {
        const { settings, identity } = await freshStore();
        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();
        await update(settings, { vessel: vessel('A Boat', 8), firstName: 'Alice' });

        identity.setAuthIdentityScope('account-b');
        await settings.awaitSettingsLoaded();
        harness.profileSettings['account-b'] = {
            firstName: 'Bob Cloud',
            defaultLocation: 'B Harbour',
        };
        harness.vessels['account-b'] = {
            vessel_name: 'B Cloud Boat',
            vessel_type: 'power',
            model: 'B Model',
        };
        settings.useSettingsStore.getState()._setUserId('account-b');
        await vi.waitFor(() => expect(settings.useSettingsStore.getState().settings.firstName).toBe('Bob Cloud'));

        const merged = settings.useSettingsStore.getState().settings;
        expect(merged.vessel).toMatchObject({
            name: 'B Cloud Boat',
            type: 'power',
            model: 'B Model',
        });
        expect(merged.vessel?.draft).toBeUndefined();
        expect(JSON.stringify(merged)).not.toContain('A Boat');
        expect(
            harness.upserts
                .filter((payload) => payload.id === 'account-b')
                .some((payload) => JSON.stringify(payload).includes('A Boat')),
        ).toBe(false);
    });

    it('assigns anonymous onboarding once to the first direct sign-in, then clears browse mode', async () => {
        const { settings, identity } = await freshStore();
        await update(settings, { firstName: 'Onboarded', vessel: vessel('Anonymous Boat', 5) });

        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();
        expect(settings.useSettingsStore.getState().settings.vessel?.name).toBe('Anonymous Boat');
        settings.useSettingsStore.getState()._setUserId('account-a');
        await vi.waitFor(() => expect(harness.upserts.some((payload) => payload.id === 'account-a')).toBe(true));
        expect(harness.upserts.find((payload) => payload.id === 'account-a')).toMatchObject({
            settings: { vessel: { name: 'Anonymous Boat' } },
        });

        identity.setAuthIdentityScope(null);
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
        await settings.awaitSettingsLoaded();

        identity.setAuthIdentityScope('account-b');
        await settings.awaitSettingsLoaded();
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
        expect(JSON.parse(harness.preferences.thalassa_settings_anonymous_claim_v1)).toMatchObject({
            owner_user_id: 'account-a',
            state: 'completed',
        });
    });

    it('quarantines unattributed global legacy settings instead of guessing the next owner', async () => {
        const { settings, identity } = await freshStore(() => {
            const raw = JSON.stringify({ firstName: 'Legacy Alice', vessel: vessel('Legacy A Boat', 9) });
            harness.preferences.thalassa_settings = raw;
            localStorage.setItem('thalassa_settings_mirror', raw);
        });

        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(harness.preferences.thalassa_settings).toBeUndefined();
        expect(harness.preferences.thalassa_settings_quarantine_v2).toContain('Legacy Alice');
        expect(localStorage.getItem('thalassa_settings_mirror_quarantine_v2')).toContain('Legacy Alice');

        identity.setAuthIdentityScope('account-a');
        await settings.awaitSettingsLoaded();
        expect(settings.useSettingsStore.getState().settings.firstName).toBeUndefined();
        expect(settings.useSettingsStore.getState().settings.vessel).toBeUndefined();
    });
});
