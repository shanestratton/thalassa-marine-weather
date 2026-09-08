/**
 * settingsStore — vessel release and MMSI claim (2026-09-08 decision).
 *
 * Shane: "the only way a person can get access to the same vessel as someone
 * who has already claimed it, is via the invite part. however we also need a
 * way for a punter to release a vessel in case it has been sold, or they were
 * just doing a delivery."
 *
 * These pin the store side of that design: release is refused while this
 * device is tracking or offline and is never queued; releasing the last hull
 * leaves a placeholder profile that no device will re-bootstrap; the two
 * server refusals (VESSEL_RELEASED terminal, MMSI_CLAIMED banner + no retry)
 * are honoured by every bootstrap path; and the phone-side detachments run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    fleetRows: [] as Array<Record<string, unknown>>,
    releasedRows: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as Array<{ name: string; args?: Record<string, unknown> }>,
    bootstrapError: null as Record<string, unknown> | null,
    releaseError: null as Record<string, unknown> | null,
    /** Consumed by the next get_owned_vessel_fleet call: a dropped connection mid-action. */
    fleetReadErrorOnce: null as Record<string, unknown> | null,
    /** Consumed by the next get_released_vessels call: parks a slow pull so another action can land first. */
    releasedGate: null as Promise<void> | null,
    releaseResult: {} as Record<string, unknown>,
    tracking: false,
    forgetPairing: vi.fn(),
    forgetRelayPairings: vi.fn(),
    syncIdentity: vi.fn(async () => null),
    invalidatePermissions: vi.fn(),
    piConfigure: vi.fn(),
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

vi.mock('../services/supabase', () => ({
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    supabase: {
        from: vi.fn(() => {
            const builder = {
                select: () => builder,
                eq: () => builder,
                limit: () => builder,
                maybeSingle: async () => ({ data: null, error: null }),
            };
            return builder;
        }),
        auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
        rpc: vi.fn(async (name: string, args?: Record<string, unknown>) => {
            harness.rpcCalls.push({ name, args });
            switch (name) {
                case 'get_owned_vessel_fleet': {
                    const failure = harness.fleetReadErrorOnce;
                    if (failure) {
                        harness.fleetReadErrorOnce = null;
                        return { data: null, error: failure };
                    }
                    return {
                        data: {
                            vessels: harness.fleetRows,
                            active_boat_id: harness.fleetRows.find((row) => row.is_active === true)?.id ?? null,
                        },
                        error: null,
                    };
                }
                case 'get_released_vessels': {
                    const gate = harness.releasedGate;
                    if (gate) {
                        harness.releasedGate = null;
                        await gate;
                    }
                    return { data: harness.releasedRows, error: null };
                }
                case 'bootstrap_owned_vessel_profile': {
                    if (harness.bootstrapError) return { data: null, error: harness.bootstrapError };
                    const created = boatRow('bootstrapped', {
                        profile: args?.p_profile as Record<string, unknown>,
                        is_active: true,
                    });
                    harness.fleetRows = [created];
                    return { data: [created], error: null };
                }
                case 'release_owned_vessel': {
                    if (harness.releaseError) return { data: null, error: harness.releaseError };
                    const released = harness.fleetRows.find((row) => row.id === args?.p_boat_id);
                    harness.fleetRows = harness.fleetRows.filter((row) => row !== released);
                    if (released) {
                        harness.releasedRows = [
                            {
                                ...released,
                                is_active: false,
                                archived_at: RELEASED_AT,
                                released_at: RELEASED_AT,
                                release_reason: args?.p_reason,
                            },
                            ...harness.releasedRows,
                        ];
                    }
                    return { data: harness.releaseResult, error: null };
                }
                case 'undo_vessel_release': {
                    const restored = harness.releasedRows.find((row) => row.id === args?.p_boat_id);
                    harness.releasedRows = harness.releasedRows.filter((row) => row !== restored);
                    if (restored) {
                        const { archived_at: _a, released_at: _r, release_reason: _reason, ...active } = restored;
                        harness.fleetRows = [
                            ...harness.fleetRows,
                            { ...active, is_active: harness.fleetRows.length === 0 },
                        ];
                    }
                    return { data: { restored: true, claim_lost: false }, error: null };
                }
                case 'patch_owned_vessel_profile':
                    return { data: [harness.fleetRows.find((row) => row.id === args?.p_boat_id)], error: null };
                default:
                    return { data: null, error: null };
            }
        }),
    },
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        boot: vi.fn(),
        setDiaryRelayInternetPolicy: vi.fn(async () => false),
        configure: (config: unknown) => harness.piConfigure(config),
    },
}));
vi.mock('../services/SubscriptionService', () => ({
    tierIsPro: (tier: string | undefined) => tier === 'crew' || tier === 'owner',
}));
vi.mock('../managers/SubscriptionManager', () => ({
    getSubscriptionStatus: vi.fn(async () => ({
        status: 'free',
        trialStartDate: null,
        subscriptionExpiry: null,
        trialRemainingDays: 0,
    })),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('@capacitor/geolocation', () => ({
    Geolocation: { requestPermissions: vi.fn(async () => ({ location: 'granted' })) },
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { isTracking: () => harness.tracking },
}));
vi.mock('../services/PiPairingService', () => ({
    forgetPairing: () => harness.forgetPairing(),
}));
vi.mock('../services/DiaryRelayTransport', () => ({
    forgetRelayPairings: (scopeKey: string) => harness.forgetRelayPairings(scopeKey),
}));
vi.mock('../services/VesselIdentityService', () => ({
    syncIdentity: () => harness.syncIdentity(),
}));
vi.mock('../hooks/usePermissions', () => ({
    invalidatePermissions: () => harness.invalidatePermissions(),
}));

type SettingsModule = typeof import('../stores/settingsStore');
type IdentityModule = typeof import('../services/authIdentityScope');

const ACCOUNT = 'account-a';
const RELEASED_AT = '2026-09-08T01:02:03.000Z';
const MMSI = '503101240';
const TRACKING_GATE = "You're recording a passage on her. Finish or pause it before releasing.";
const OFFLINE_GATE =
    'Releasing needs a connection — it disconnects crew, the Pi and the public page in the cloud. Nothing has changed.';

function vessel(name: string, extra: Record<string, unknown> = {}) {
    return {
        name,
        type: 'sail' as const,
        length: 40,
        beam: 12,
        draft: 6,
        displacement: 20_000,
        maxWaveHeight: 5,
        cruisingSpeed: 7,
        fuelCapacity: 100,
        waterCapacity: 200,
        mmsi: MMSI,
        ...extra,
    };
}

function boatRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        owner_id: ACCOUNT,
        profile: vessel('Serene Summer'),
        revision: 1,
        updated_at: '2026-09-01T00:00:00.000Z',
        is_active: true,
        mmsi_claimed: true,
        ...extra,
    };
}

function resetHarness(): void {
    for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
    harness.fleetRows = [];
    harness.releasedRows = [];
    harness.rpcCalls = [];
    harness.bootstrapError = null;
    harness.releaseError = null;
    harness.fleetReadErrorOnce = null;
    harness.releasedGate = null;
    harness.releaseResult = {
        released: true,
        remaining_active_boats: 0,
        next_active_boat_id: null,
        crew_removed: 2,
        invites_revoked: 1,
        relays_removed: 1,
        relays_unmatched: 0,
        telemetry_cleared: 1,
        public_pages_disabled: 1,
    };
    harness.tracking = false;
    harness.forgetPairing.mockClear();
    harness.forgetRelayPairings.mockClear();
    harness.syncIdentity.mockClear();
    harness.invalidatePermissions.mockClear();
    harness.piConfigure.mockClear();
    localStorage.clear();
}

/**
 * A fresh store signed in as account-a. `localVessel` seeds the on-disk
 * settings envelope BEFORE the store module loads, which is how a stale
 * profile on a second phone reaches the bootstrap paths.
 */
async function freshStore(options: { localVessel?: Record<string, unknown> } = {}): Promise<{
    settings: SettingsModule;
    identity: IdentityModule;
}> {
    vi.resetModules();
    resetHarness();
    const identity = await import('../services/authIdentityScope');
    const scope = identity.setAuthIdentityScope(ACCOUNT);
    if (options.localVessel) {
        harness.preferences[identity.authScopedStorageKey('thalassa_settings', scope)] = JSON.stringify({
            version: 2,
            owner_user_id: ACCOUNT,
            settings: { vessel: options.localVessel },
        });
    }
    const settings = await import('../stores/settingsStore');
    await settings.awaitSettingsLoaded();
    return { settings, identity };
}

function rpcNames(): string[] {
    return harness.rpcCalls.map((call) => call.name);
}

function persistedSettings(identity: IdentityModule): UserSettings {
    const key = identity.authScopedStorageKey('thalassa_settings', identity.getAuthIdentityScope());
    return (JSON.parse(harness.preferences[key]) as { settings: UserSettings }).settings;
}

async function whileOffline(work: () => Promise<void>): Promise<void> {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
        await work();
    } finally {
        Reflect.deleteProperty(navigator, 'onLine');
    }
}

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('settingsStore vessel release', () => {
    it('releases the only hull: placeholder profile, released row, phone-side detachments, and no re-bootstrap', async () => {
        const { settings, identity } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [boatRow('boat-1')];
        await store.getState().syncVesselFleet();
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        expect(store.getState().vesselFleet).toHaveLength(1);
        harness.rpcCalls = [];

        const result = await store.getState().releaseVesselProfile('boat-1', 'sold');

        expect(harness.rpcCalls).toContainEqual({
            name: 'release_owned_vessel',
            args: { p_boat_id: 'boat-1', p_reason: 'sold' },
        });
        expect(result).toEqual({
            released: true,
            remainingActiveBoats: 0,
            nextActiveBoatId: null,
            crewRemoved: 2,
            invitesRevoked: 1,
            relaysRemoved: 1,
            relaysUnmatched: 0,
            telemetryCleared: 1,
            publicPagesDisabled: 1,
        });

        const state = store.getState();
        expect(state.vesselFleet).toEqual([]);
        expect(state.activeVesselId).toBeNull();
        expect(state.vesselFleetStatus).toBe('saved');
        // The compatibility snapshot no longer looks like a real boat, so
        // hasMeaningfulVesselProfile is false on every device that syncs it.
        expect(state.settings.vessel).toMatchObject({ name: 'My Boat', length: 0, draft: 0 });
        expect(state.settings.vessel?.mmsi).toBeUndefined();
        expect(state.settings.vessel?.model).toBeUndefined();
        expect(state.settings.vessel?.registration).toBeUndefined();
        expect(state.settings.polarData).toBeUndefined();
        expect(state.settings.polarBoatModel).toBeUndefined();
        expect(state.settings.polarSource_type).toBeUndefined();
        expect(state.settings.comfortParams).toBeUndefined();
        expect(persistedSettings(identity).vessel?.name).toBe('My Boat');
        expect(state.releasedVessels).toEqual([
            { boatId: 'boat-1', name: 'Serene Summer', releasedAt: RELEASED_AT, releaseReason: 'sold' },
        ]);

        // Exactly PiCacheTab.handleForget, plus the relay map, identity and permission re-reads.
        expect(harness.forgetPairing).toHaveBeenCalledTimes(1);
        expect(harness.piConfigure).toHaveBeenCalledWith({ enabled: false });
        expect(harness.forgetRelayPairings).toHaveBeenCalledWith(identity.getAuthIdentityScope().key);
        expect(harness.syncIdentity).toHaveBeenCalledTimes(1);
        expect(harness.invalidatePermissions).toHaveBeenCalledTimes(1);
        expect(state.settings.piCacheEnabled).toBe(false);
        // The Pi flag is the only thing that travels to user_settings; the
        // released rows are store state and never leave the device this way.
        // (queueSettingsSync is fire-and-forget, hence the wait.)
        await vi.waitFor(() =>
            expect(harness.rpcCalls.filter((call) => call.name === 'merge_user_settings')).toEqual([
                { name: 'merge_user_settings', args: { p_patch: { piCacheEnabled: false } } },
            ]),
        );

        // No device may re-create her: neither the periodic fleet sync…
        harness.rpcCalls = [];
        await store.getState().syncVesselFleet();
        expect(rpcNames()).toContain('get_owned_vessel_fleet');
        expect(rpcNames()).not.toContain('bootstrap_owned_vessel_profile');
        expect(store.getState().settings.vessel?.name).toBe('My Boat');

        // …nor the sign-in pull on the next fence of the same account.
        identity.setAuthIdentityScope(null);
        identity.setAuthIdentityScope(ACCOUNT);
        await settings.awaitSettingsLoaded();
        harness.rpcCalls = [];
        store.getState()._setUserId(ACCOUNT);
        await vi.waitFor(() =>
            expect(
                harness.rpcCalls.filter((call) => call.name === 'get_owned_vessel_fleet').length,
            ).toBeGreaterThanOrEqual(3),
        );
        expect(rpcNames()).not.toContain('bootstrap_owned_vessel_profile');
        expect(store.getState().settings.vessel?.name).toBe('My Boat');
    });

    it('releasing one of several hulls keeps the replacement active and its profile intact', async () => {
        const { settings } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [
            boatRow('delivery-boat', { profile: vessel('Delivery Boat', { mmsi: '503000002' }) }),
            boatRow('own-boat', { is_active: false, updated_at: '2026-08-01T00:00:00.000Z' }),
        ];
        harness.releaseResult = {
            ...harness.releaseResult,
            remaining_active_boats: 1,
            next_active_boat_id: 'own-boat',
        };
        await store.getState().syncVesselFleet();
        expect(store.getState().activeVesselId).toBe('delivery-boat');

        // The server picks the replacement (verbatim archive logic); the
        // mock mirrors that by making the survivor active.
        harness.fleetRows[1] = { ...harness.fleetRows[1], is_active: true };
        const result = await store.getState().releaseVesselProfile('delivery-boat', 'delivery_complete');

        expect(result.remainingActiveBoats).toBe(1);
        expect(result.nextActiveBoatId).toBe('own-boat');
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['own-boat']);
        expect(store.getState().activeVesselId).toBe('own-boat');
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        expect(store.getState().releasedVessels).toEqual([
            {
                boatId: 'delivery-boat',
                name: 'Delivery Boat',
                releasedAt: RELEASED_AT,
                releaseReason: 'delivery_complete',
            },
        ]);
        // Detachments still run: the cloud cut the hull's relay row, so this
        // phone must not silently re-pair the Pi while still on her LAN.
        expect(harness.forgetPairing).toHaveBeenCalledTimes(1);
        expect(harness.invalidatePermissions).toHaveBeenCalledTimes(1);
    });

    it('refuses while this device is tracking — before any RPC — and reports both gates synchronously', async () => {
        const { settings } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [boatRow('boat-1')];
        await store.getState().syncVesselFleet();
        harness.rpcCalls = [];

        harness.tracking = true;
        await expect(store.getState().releaseVesselProfile('boat-1', 'sold')).rejects.toThrow(
            "You're recording a passage on her. Finish or pause it before releasing.",
        );
        expect(rpcNames()).not.toContain('release_owned_vessel');
        expect(store.getState().vesselFleet).toHaveLength(1);
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        expect(harness.forgetPairing).not.toHaveBeenCalled();

        // The probe loads lazily on first call; the action above already
        // imported ShipLogService, so the sync answer is available now.
        await vi.waitFor(() => expect(store.getState().releaseBlockedReason()).toBe(TRACKING_GATE));
        harness.tracking = false;
        expect(store.getState().releaseBlockedReason()).toBeNull();

        await whileOffline(async () => {
            expect(store.getState().releaseBlockedReason()).toBe(OFFLINE_GATE);
            await expect(store.getState().releaseVesselProfile('boat-1', 'sold')).rejects.toThrow(OFFLINE_GATE);
        });
        expect(rpcNames()).not.toContain('release_owned_vessel');
        expect(store.getState().vesselFleet).toHaveLength(1);
        // Tracking wins when both gates apply.
        harness.tracking = true;
        await whileOffline(async () => {
            expect(store.getState().releaseBlockedReason()).toBe(TRACKING_GATE);
        });
    });

    it('a failed release is surfaced, leaves the fleet alone and never enters the patch outbox', async () => {
        const { settings } = await freshStore();
        const store = settings.useSettingsStore;
        const fleetService = await import('../services/VesselFleetService');
        harness.fleetRows = [boatRow('boat-1')];
        await store.getState().syncVesselFleet();
        harness.releaseError = {
            code: '42501',
            message: 'Vessel not found, already archived, or not owned by current user',
        };

        await expect(store.getState().releaseVesselProfile('boat-1', 'other')).rejects.toThrow(/not owned/);

        expect(store.getState().vesselFleetStatus).toBe('error');
        expect(store.getState().vesselFleet).toHaveLength(1);
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        await expect(fleetService.getQueuedVesselPatches()).resolves.toEqual([]);
        expect(harness.forgetPairing).not.toHaveBeenCalled();
        expect(harness.invalidatePermissions).not.toHaveBeenCalled();
    });

    it('a release whose fleet reload fails still resolves, projects her out locally and runs the detachments', async () => {
        const { settings, identity } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [boatRow('boat-1')];
        await store.getState().syncVesselFleet();
        harness.rpcCalls = [];
        // The connection drops right after release_owned_vessel commits.
        harness.fleetReadErrorOnce = { code: 'PGRST000', message: 'connection lost' };

        const result = await store.getState().releaseVesselProfile('boat-1', 'sold');

        // She IS released in the cloud, so the action must not throw and the
        // skipper must not be told to tap Release again.
        expect(result.released).toBe(true);
        expect(harness.rpcCalls.filter((call) => call.name === 'release_owned_vessel')).toHaveLength(1);
        const state = store.getState();
        expect(state.vesselFleet).toEqual([]);
        expect(state.activeVesselId).toBeNull();
        expect(state.settings.vessel).toMatchObject({ name: 'My Boat', length: 0 });
        expect(state.settings.vessel?.mmsi).toBeUndefined();
        expect(persistedSettings(identity).vessel?.name).toBe('My Boat');
        // 'error' is honest about the reload; the release itself succeeded.
        expect(state.vesselFleetStatus).toBe('error');
        // The phone-side detachments must run regardless — this is what stops
        // the phone silently re-pairing the buyer's Pi on the boat LAN.
        expect(harness.forgetPairing).toHaveBeenCalledTimes(1);
        expect(harness.piConfigure).toHaveBeenCalledWith({ enabled: false });
        expect(harness.forgetRelayPairings).toHaveBeenCalledTimes(1);
        expect(harness.syncIdentity).toHaveBeenCalledTimes(1);
        expect(harness.invalidatePermissions).toHaveBeenCalledTimes(1);
        expect(state.settings.piCacheEnabled).toBe(false);

        // The next sync repaints from the server and nobody re-bootstraps her.
        harness.rpcCalls = [];
        await store.getState().syncVesselFleet();
        expect(store.getState().vesselFleetStatus).toBe('saved');
        expect(rpcNames()).not.toContain('bootstrap_owned_vessel_profile');
        expect(store.getState().releasedVessels).toEqual([
            { boatId: 'boat-1', name: 'Serene Summer', releasedAt: RELEASED_AT, releaseReason: 'sold' },
        ]);
    });

    it('a failed reload after releasing one of several hulls projects the replacement the server chose', async () => {
        const { settings } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [
            boatRow('delivery-boat', { profile: vessel('Delivery Boat', { mmsi: '503000002' }) }),
            boatRow('own-boat', { is_active: false, updated_at: '2026-08-01T00:00:00.000Z' }),
        ];
        harness.releaseResult = {
            ...harness.releaseResult,
            remaining_active_boats: 1,
            next_active_boat_id: 'own-boat',
        };
        await store.getState().syncVesselFleet();
        harness.fleetReadErrorOnce = { code: 'PGRST000', message: 'connection lost' };

        const result = await store.getState().releaseVesselProfile('delivery-boat', 'delivery_complete');

        expect(result.nextActiveBoatId).toBe('own-boat');
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['own-boat']);
        expect(store.getState().activeVesselId).toBe('own-boat');
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        expect(store.getState().vesselFleetStatus).toBe('error');
        expect(harness.forgetPairing).toHaveBeenCalledTimes(1);
    });

    it('undo brings the hull back into the fleet and clears its released row', async () => {
        const { settings } = await freshStore();
        const store = settings.useSettingsStore;
        harness.fleetRows = [boatRow('boat-1')];
        await store.getState().syncVesselFleet();
        await store.getState().releaseVesselProfile('boat-1', 'sold');
        expect(store.getState().releasedVessels).toHaveLength(1);
        harness.invalidatePermissions.mockClear();
        harness.syncIdentity.mockClear();

        await expect(store.getState().undoVesselRelease('boat-1')).resolves.toEqual({
            restored: true,
            claimLost: false,
        });

        expect(harness.rpcCalls).toContainEqual({ name: 'undo_vessel_release', args: { p_boat_id: 'boat-1' } });
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['boat-1']);
        expect(store.getState().activeVesselId).toBe('boat-1');
        expect(store.getState().settings.vessel?.name).toBe('Serene Summer');
        expect(store.getState().settings.vessel?.mmsi).toBe(MMSI);
        expect(store.getState().releasedVessels).toEqual([]);
        expect(store.getState().vesselFleetStatus).toBe('saved');
        // She is back, so the skipper grant and identity are re-read.
        expect(harness.syncIdentity).toHaveBeenCalledTimes(1);
        expect(harness.invalidatePermissions).toHaveBeenCalledTimes(1);
    });
});

describe('settingsStore bootstrap refusals', () => {
    const releasedBootstrapError = {
        code: 'P0001',
        message: 'VESSEL_RELEASED',
        details: 'Serene Summer',
        hint: `${RELEASED_AT}|sold`,
    };
    const claimedBootstrapError = {
        code: 'P0001',
        message: 'MMSI_CLAIMED',
        details: 'Serene Summer',
        hint: MMSI,
    };
    const releasedServerRow = boatRow('boat-1', {
        is_active: false,
        archived_at: RELEASED_AT,
        released_at: RELEASED_AT,
        release_reason: 'sold',
    });

    it('VESSEL_RELEASED from the fleet sync is terminal: placeholder profile, released row, no retry', async () => {
        const { settings, identity } = await freshStore({ localVessel: vessel('Serene Summer') });
        const store = settings.useSettingsStore;
        expect(store.getState().settings.vessel?.mmsi).toBe(MMSI);
        harness.bootstrapError = releasedBootstrapError;
        harness.releasedRows = [releasedServerRow];

        await store.getState().syncVesselFleet();

        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().vesselFleetStatus).toBe('saved');
        expect(store.getState().vesselFleet).toEqual([]);
        expect(store.getState().settings.vessel).toMatchObject({ name: 'My Boat', length: 0 });
        expect(store.getState().settings.vessel?.mmsi).toBeUndefined();
        expect(persistedSettings(identity).vessel?.name).toBe('My Boat');
        expect(store.getState().releasedVessels).toEqual([
            { boatId: 'boat-1', name: 'Serene Summer', releasedAt: RELEASED_AT, releaseReason: 'sold' },
        ]);

        harness.rpcCalls = [];
        await store.getState().syncVesselFleet();
        expect(rpcNames()).toContain('get_owned_vessel_fleet');
        expect(rpcNames()).not.toContain('bootstrap_owned_vessel_profile');
    });

    it('VESSEL_RELEASED from the sign-in pull is terminal too, and the follow-up sync does not retry', async () => {
        const { settings } = await freshStore({ localVessel: vessel('Serene Summer') });
        const store = settings.useSettingsStore;
        harness.bootstrapError = releasedBootstrapError;
        harness.releasedRows = [releasedServerRow];

        store.getState()._setUserId(ACCOUNT);
        // pull (1 fleet read) then the finally-sync (2 fleet reads, or 1 if it bails early).
        await vi.waitFor(() =>
            expect(
                harness.rpcCalls.filter((call) => call.name === 'get_owned_vessel_fleet').length,
            ).toBeGreaterThanOrEqual(3),
        );
        await vi.waitFor(() => expect(store.getState().vesselFleetStatus).toBe('saved'));

        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().settings.vessel).toMatchObject({ name: 'My Boat', length: 0 });
        expect(store.getState().settings.vessel?.mmsi).toBeUndefined();
        expect(store.getState().releasedVessels).toEqual([
            { boatId: 'boat-1', name: 'Serene Summer', releasedAt: RELEASED_AT, releaseReason: 'sold' },
        ]);
    });

    it('MMSI_CLAIMED sets the claim conflict, leaves the local profile intact and stops retrying until the MMSI changes', async () => {
        const { settings } = await freshStore({ localVessel: vessel('Second Phone Boat') });
        const store = settings.useSettingsStore;
        harness.bootstrapError = claimedBootstrapError;

        await store.getState().syncVesselFleet();

        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().vesselClaimConflict).toEqual({ vesselName: 'Serene Summer', mmsi: MMSI });
        // Never touched: the skipper decides between 'Enter crew code' and 'Save without MMSI'.
        expect(store.getState().settings.vessel).toMatchObject({ name: 'Second Phone Boat', mmsi: MMSI, draft: 6 });
        expect(store.getState().vesselFleet).toEqual([]);

        harness.rpcCalls = [];
        await store.getState().syncVesselFleet();
        expect(rpcNames()).toContain('get_owned_vessel_fleet');
        expect(rpcNames()).not.toContain('bootstrap_owned_vessel_profile');
        expect(store.getState().vesselClaimConflict).toEqual({ vesselName: 'Serene Summer', mmsi: MMSI });

        // 'Save without MMSI': the conflict clears and the one-shot bootstrap re-arms.
        harness.bootstrapError = null;
        harness.rpcCalls = [];
        await store.getState().patchActiveVesselProfile({ mmsi: undefined });

        expect(store.getState().vesselClaimConflict).toBeNull();
        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['bootstrapped']);
        expect(store.getState().settings.vessel?.name).toBe('Second Phone Boat');
        expect(store.getState().settings.vessel?.mmsi).toBeUndefined();
    });

    it('MMSI_CLAIMED from the sign-in pull is not retried by the follow-up sync, and dismiss clears the banner', async () => {
        const { settings } = await freshStore({ localVessel: vessel('Second Phone Boat') });
        const store = settings.useSettingsStore;
        harness.bootstrapError = claimedBootstrapError;

        store.getState()._setUserId(ACCOUNT);
        await vi.waitFor(() =>
            expect(
                harness.rpcCalls.filter((call) => call.name === 'get_owned_vessel_fleet').length,
            ).toBeGreaterThanOrEqual(3),
        );
        await vi.waitFor(() => expect(store.getState().vesselClaimConflict).not.toBeNull());
        await vi.waitFor(() => expect(store.getState().vesselFleetStatus).toBe('saved'));

        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().vesselClaimConflict).toEqual({ vesselName: 'Serene Summer', mmsi: MMSI });
        expect(store.getState().settings.vessel).toMatchObject({ name: 'Second Phone Boat', mmsi: MMSI });

        store.getState().dismissVesselClaimConflict();
        expect(store.getState().vesselClaimConflict).toBeNull();
    });

    it("a slow sign-in pull that hit MMSI_CLAIMED does not repaint the banner over a later 'Save without MMSI'", async () => {
        const { settings } = await freshStore({ localVessel: vessel('Second Phone Boat') });
        const store = settings.useSettingsStore;
        harness.bootstrapError = claimedBootstrapError;
        let openGate: () => void = () => undefined;
        harness.releasedGate = new Promise<void>((resolve) => {
            openGate = resolve;
        });

        // The pull bootstraps (refused: MMSI_CLAIMED), then parks on its
        // released-vessels read with the conflict still only in a local.
        store.getState()._setUserId(ACCOUNT);
        await vi.waitFor(() => expect(rpcNames()).toContain('get_released_vessels'));
        expect(rpcNames().filter((name) => name === 'bootstrap_owned_vessel_profile')).toHaveLength(1);
        expect(store.getState().vesselClaimConflict).toBeNull();

        // Meanwhile the skipper saves without the MMSI and the boat bootstraps.
        harness.bootstrapError = null;
        await store.getState().patchActiveVesselProfile({ mmsi: undefined });
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['bootstrapped']);
        expect(store.getState().vesselClaimConflict).toBeNull();

        // The stale pull lands: its fleet snapshot already yields to the newer
        // mutation, and so must its claim banner.
        openGate();
        await vi.waitFor(() =>
            expect(
                harness.rpcCalls.filter((call) => call.name === 'get_owned_vessel_fleet').length,
            ).toBeGreaterThanOrEqual(3),
        );
        await vi.waitFor(() => expect(store.getState().vesselFleetStatus).toBe('saved'));
        expect(store.getState().vesselClaimConflict).toBeNull();
        expect(store.getState().vesselFleet.map((boat) => boat.id)).toEqual(['bootstrapped']);
        expect(store.getState().settings.vessel?.mmsi).toBeUndefined();
    });

    it('a claim conflict and released rows are fenced per account', async () => {
        const { settings, identity } = await freshStore({ localVessel: vessel('Second Phone Boat') });
        const store = settings.useSettingsStore;
        harness.bootstrapError = claimedBootstrapError;
        harness.releasedRows = [releasedServerRow];
        await store.getState().syncVesselFleet();
        expect(store.getState().vesselClaimConflict).not.toBeNull();
        expect(store.getState().releasedVessels).toHaveLength(1);

        identity.setAuthIdentityScope('account-b');

        expect(store.getState().vesselClaimConflict).toBeNull();
        expect(store.getState().releasedVessels).toEqual([]);
        await settings.awaitSettingsLoaded();
    });
});
