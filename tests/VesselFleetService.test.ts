/**
 * VesselFleetService — owned-vessel cloud-sync contract.
 *
 * The fleet is deliberately separate from the legacy single
 * `settings.vessel` object: a skipper may own up to five boats, while the
 * rest of the app consumes one explicitly selected active boat. These tests
 * are intentionally service-level so the UI and the native app share the
 * same ownership, normalisation, and offline-delivery rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceStore = vi.hoisted(() => new Map<string, string>());
/** Controllable PostgREST stand-in for the release/undo/claim RPC paths. */
const rpcMock = vi.hoisted(() =>
    vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
);

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: preferenceStore.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            preferenceStore.set(key, value);
        },
    },
}));

vi.mock('../services/supabase', () => ({
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    supabase: { rpc: rpcMock },
}));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    MAX_OWNED_VESSELS,
    RELEASE_OFFLINE_MESSAGE,
    VesselClaimedError,
    VesselReleasedError,
    bootstrapOwnedVesselProfile,
    canAddOwnedVessel,
    discardQueuedVesselPatchesForBoat,
    drainQueuedVesselPatches,
    loadCachedOwnedVesselFleet,
    loadReleasedVessels,
    normaliseVesselProfilePatchForCloud,
    normalizeVesselFleetPayload,
    patchOwnedVesselProfile,
    persistCachedOwnedVesselFleet,
    queueVesselPatch,
    releaseOwnedVessel,
    selectActiveOwnedVessel,
    undoVesselRelease,
} from '../services/VesselFleetService';

const OWNER_A = 'skipper-a';
const OWNER_B = 'skipper-b';

function profile(name: string) {
    return {
        name,
        type: 'sail' as const,
        length: 42,
        beam: 13,
        draft: 6.5,
        displacement: 24_000,
        maxWaveHeight: 5,
        cruisingSpeed: 6.4,
        fuelCapacity: 120,
        waterCapacity: 180,
    };
}

function row(id: string, ownerId = OWNER_A, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        owner_id: ownerId,
        profile: profile(`Vessel ${id}`),
        updated_at: '2026-07-27T10:00:00.000Z',
        is_active: false,
        ...overrides,
    };
}

function fleetWith(count: number) {
    return normalizeVesselFleetPayload(
        {
            vessels: Array.from({ length: count }, (_, index) =>
                row(`boat-${index + 1}`, OWNER_A, {
                    is_active: index === 0,
                    updated_at: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
                }),
            ),
        },
        OWNER_A,
    );
}

beforeEach(() => {
    localStorage.clear();
    preferenceStore.clear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
    setAuthIdentityScope(OWNER_A);
});

afterEach(() => {
    localStorage.clear();
    preferenceStore.clear();
    setAuthIdentityScope(null);
});

describe('VesselFleetService fleet normalisation', () => {
    it('keeps only valid, owned, unique rows and honours a valid explicit active boat', () => {
        const fleet = normalizeVesselFleetPayload(
            {
                active_boat_id: ' boat-b ',
                vessels: [
                    row(' boat-a ', OWNER_A, { is_active: true }),
                    row('boat-b'),
                    // Never accept another skipper's profile merely because
                    // an over-broad query happened to return it.
                    row('foreign-boat', OWNER_B, { is_active: true }),
                    // A duplicate response must not create a second
                    // selectable vessel.
                    row('boat-a', OWNER_A, { updated_at: '2026-07-28T10:00:00.000Z' }),
                    // Nor can malformed cloud/cache data become the active
                    // profile.
                    row('broken-boat', OWNER_A, { profile: null }),
                ],
            },
            OWNER_A,
        );

        expect(fleet.vessels.map((vessel) => vessel.id)).toEqual(['boat-a', 'boat-b']);
        expect(fleet.activeBoatId).toBe('boat-b');
        expect(fleet.vessels.filter((vessel) => vessel.is_active)).toEqual([expect.objectContaining({ id: 'boat-b' })]);
    });

    it('falls back deterministically when the requested active id is absent or foreign', () => {
        const fleet = normalizeVesselFleetPayload(
            {
                active_boat_id: 'not-owned',
                vessels: [
                    row('boat-a', OWNER_A, { updated_at: '2026-07-24T10:00:00.000Z' }),
                    row('boat-b', OWNER_A, {
                        is_active: true,
                        updated_at: '2026-07-25T10:00:00.000Z',
                    }),
                    row('foreign-boat', OWNER_B, {
                        is_active: true,
                        updated_at: '2026-07-29T10:00:00.000Z',
                    }),
                ],
            },
            OWNER_A,
        );

        expect(fleet.activeBoatId).toBe('boat-b');
        expect(fleet.vessels.filter((vessel) => vessel.is_active)).toHaveLength(1);
    });

    it('uses the newest valid owned vessel when legacy data has no active selection', () => {
        const fleet = normalizeVesselFleetPayload(
            {
                vessels: [
                    row('older', OWNER_A, { updated_at: '2026-07-20T10:00:00.000Z' }),
                    row('newer', OWNER_A, { updated_at: '2026-07-26T10:00:00.000Z' }),
                ],
            },
            OWNER_A,
        );

        expect(fleet.activeBoatId).toBe('newer');
        expect(fleet.vessels.find((vessel) => vessel.id === 'newer')).toMatchObject({ is_active: true });
    });

    it('keeps a valid partial vessel-unit preference instead of dropping the whole object', () => {
        const fleet = normalizeVesselFleetPayload(
            {
                vessels: [
                    row('boat-a', OWNER_A, {
                        vessel_units: { volume: 'l' },
                    }),
                ],
            },
            OWNER_A,
        );

        expect(fleet.vessels[0]?.vessel_units).toEqual({
            length: 'ft',
            beam: 'ft',
            draft: 'ft',
            displacement: 'lbs',
            volume: 'l',
        });
    });
});

describe('VesselFleetService active-selection and client cap', () => {
    it('allows the first through fifth owned vessel, but never offers a sixth', () => {
        expect(MAX_OWNED_VESSELS).toBe(5);
        expect(canAddOwnedVessel(fleetWith(0))).toBe(true);
        expect(canAddOwnedVessel(fleetWith(MAX_OWNED_VESSELS - 1))).toBe(true);
        expect(canAddOwnedVessel(fleetWith(MAX_OWNED_VESSELS))).toBe(false);
        expect(canAddOwnedVessel(fleetWith(MAX_OWNED_VESSELS + 1))).toBe(false);
    });

    it('switches exactly one selected owned vessel without mutating the previous fleet', () => {
        const before = normalizeVesselFleetPayload(
            {
                active_boat_id: 'boat-a',
                vessels: [row('boat-a'), row('boat-b')],
            },
            OWNER_A,
        );

        const after = selectActiveOwnedVessel(before, 'boat-b');

        expect(after).not.toBe(before);
        expect(after.activeBoatId).toBe('boat-b');
        expect(after.vessels.filter((vessel) => vessel.is_active)).toEqual([expect.objectContaining({ id: 'boat-b' })]);
        expect(before.activeBoatId).toBe('boat-a');
        expect(before.vessels.filter((vessel) => vessel.is_active)).toEqual([
            expect.objectContaining({ id: 'boat-a' }),
        ]);
    });

    it('does not change the active vessel for an unknown id', () => {
        const before = normalizeVesselFleetPayload(
            {
                active_boat_id: 'boat-a',
                vessels: [row('boat-a'), row('boat-b')],
            },
            OWNER_A,
        );

        const after = selectActiveOwnedVessel(before, 'not-a-boat');

        expect(after.activeBoatId).toBe('boat-a');
        expect(after.vessels.filter((vessel) => vessel.is_active)).toEqual([expect.objectContaining({ id: 'boat-a' })]);
    });
});

describe('VesselFleetService offline fleet cache', () => {
    it('restores all owned profiles only to the account that cached them', async () => {
        const fleet = normalizeVesselFleetPayload(
            {
                active_boat_id: 'boat-b',
                vessels: [row('boat-a'), row('boat-b')],
            },
            OWNER_A,
        );

        await persistCachedOwnedVesselFleet(fleet, undefined, 'boat-b');
        await expect(loadCachedOwnedVesselFleet()).resolves.toMatchObject({
            pendingActiveBoatId: 'boat-b',
            fleet: {
                activeBoatId: 'boat-b',
                vessels: [expect.objectContaining({ id: 'boat-a' }), expect.objectContaining({ id: 'boat-b' })],
            },
        });

        setAuthIdentityScope(OWNER_B);
        await expect(loadCachedOwnedVesselFleet()).resolves.toBeNull();

        setAuthIdentityScope(OWNER_A);
        const restored = await loadCachedOwnedVesselFleet();
        expect(restored?.fleet.vessels.map((vessel) => vessel.id)).toEqual(['boat-a', 'boat-b']);
        expect(restored?.pendingActiveBoatId).toBe('boat-b');
    });

    it('drops a cached pending selection that is not part of the cached fleet', async () => {
        const fleet = normalizeVesselFleetPayload({ active_boat_id: 'boat-a', vessels: [row('boat-a')] }, OWNER_A);

        await persistCachedOwnedVesselFleet(fleet, undefined, 'not-owned');
        await expect(loadCachedOwnedVesselFleet()).resolves.toMatchObject({
            pendingActiveBoatId: null,
            fleet: { activeBoatId: 'boat-a' },
        });
    });

    it('prefers the newest valid cache when native and browser mirrors disagree', async () => {
        const original = normalizeVesselFleetPayload(
            { active_boat_id: 'boat-a', vessels: [row('boat-a'), row('boat-b')] },
            OWNER_A,
        );
        await persistCachedOwnedVesselFleet(original, undefined, null);

        const browserNewer = selectActiveOwnedVessel(original, 'boat-b');
        localStorage.setItem(
            authScopedStorageKey('thalassa_owned_vessel_fleet_cache_v1', getAuthIdentityScope()),
            JSON.stringify({
                version: 1,
                ownerUserId: OWNER_A,
                savedAt: '2030-01-01T00:00:00.000Z',
                fleet: browserNewer,
                pendingActiveBoatId: 'boat-b',
            }),
        );

        await expect(loadCachedOwnedVesselFleet()).resolves.toMatchObject({
            pendingActiveBoatId: 'boat-b',
            fleet: { activeBoatId: 'boat-b' },
        });
    });
});

describe('VesselFleetService queued vessel patches', () => {
    it('keeps a Comfort Zone OFF clear explicit through the offline queue', async () => {
        const cloudPatch = normaliseVesselProfilePatchForCloud({
            comfortParams: { maxWindKts: undefined, maxWaveM: 2.5 },
        });
        expect(cloudPatch.comfortParams).toEqual({ maxWindKts: null, maxWaveM: 2.5 });

        await queueVesselPatch({ boatId: 'boat-a', patch: cloudPatch, revision: 1 });
        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (job) => {
            pushed.push(job);
        });

        expect(pushed).toEqual([
            expect.objectContaining({
                boatId: 'boat-a',
                patch: { comfortParams: { maxWindKts: null, maxWaveM: 2.5 } },
            }),
        ]);
    });

    it('coalesces offline edits to the same boat and sends the latest revision once', async () => {
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { draft: 7.2, cruisingSpeed: 6.1 } },
            revision: 1,
        });
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { name: 'Serene Summer', draft: 7.5 } },
            revision: 2,
        });

        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (job) => {
            pushed.push(job);
        });

        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({
            boatId: 'boat-a',
            patch: {
                profile: {
                    name: 'Serene Summer',
                    draft: 7.5,
                    cruisingSpeed: 6.1,
                },
            },
            revision: 2,
        });

        // A completed job is gone — reopening the app must not re-send it.
        await drainQueuedVesselPatches(async (job) => {
            pushed.push(job);
        });
        expect(pushed).toHaveLength(1);
    });

    it('retains a failed offline patch for a later retry', async () => {
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { airDraft: 58 } },
            revision: 3,
        });

        const failedPush = vi.fn(async () => {
            throw new Error('offline');
        });
        // The service may report failure in its return value or reject; the
        // durable contract is that the job remains present either way.
        await drainQueuedVesselPatches(failedPush).catch(() => undefined);
        expect(failedPush).toHaveBeenCalledTimes(1);

        const retryPush = vi.fn(async () => undefined);
        await drainQueuedVesselPatches(retryPush);
        expect(retryPush).toHaveBeenCalledTimes(1);
        expect(retryPush).toHaveBeenCalledWith(
            expect.objectContaining({
                boatId: 'boat-a',
                patch: { profile: { airDraft: 58 } },
                revision: 3,
            }),
        );
    });

    it('never lets an in-flight retry erase a newer edit to the same vessel', async () => {
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { draft: 6.8 } },
            revision: 1,
        });

        let releaseFirstDelivery!: () => void;
        const firstPush = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    releaseFirstDelivery = resolve;
                }),
        );
        const draining = drainQueuedVesselPatches(firstPush);
        await vi.waitFor(() => expect(firstPush).toHaveBeenCalledTimes(1));

        // This mimics an edit on the same device while reconnect delivery is
        // still awaiting its response. The retry may remove only the exact
        // snapshot it sent, never the coalesced newer patch.
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { draft: 7.3 } },
            revision: 2,
        });
        releaseFirstDelivery();
        await draining;

        const retryPush = vi.fn(async () => undefined);
        await drainQueuedVesselPatches(retryPush);
        expect(retryPush).toHaveBeenCalledWith(
            expect.objectContaining({
                boatId: 'boat-a',
                patch: { profile: { draft: 7.3 } },
                revision: 2,
            }),
        );
    });

    it('keeps queued patches inside the authenticated skipper scope', async () => {
        await queueVesselPatch({
            boatId: 'boat-a',
            patch: { profile: { draft: 7.4 } },
            revision: 4,
        });

        setAuthIdentityScope(OWNER_B);
        const wrongOwnerPush = vi.fn(async () => undefined);
        await drainQueuedVesselPatches(wrongOwnerPush);
        expect(wrongOwnerPush).not.toHaveBeenCalled();

        setAuthIdentityScope(OWNER_A);
        const rightOwnerPush = vi.fn(async () => undefined);
        await drainQueuedVesselPatches(rightOwnerPush);
        expect(rightOwnerPush).toHaveBeenCalledWith(expect.objectContaining({ boatId: 'boat-a', revision: 4 }));
    });

    it('keeps a newer browser fallback patch when native Preferences is stale', async () => {
        await queueVesselPatch({ boatId: 'boat-a', patch: { profile: { draft: 6.2 } }, revision: 1 });
        const outboxKey = authScopedStorageKey('thalassa_vessel_fleet_outbox_v1', getAuthIdentityScope());
        const staleNative = preferenceStore.get(outboxKey)!;

        await queueVesselPatch({ boatId: 'boat-a', patch: { profile: { draft: 7.1 } }, revision: 2 });
        const browser = JSON.parse(localStorage.getItem(outboxKey)!) as Record<string, unknown>;
        browser.savedAt = '2030-01-01T00:00:00.000Z';
        localStorage.setItem(outboxKey, JSON.stringify(browser));
        preferenceStore.set(outboxKey, staleNative);

        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (entry) => {
            pushed.push(entry);
        });

        expect(pushed).toEqual([
            expect.objectContaining({ boatId: 'boat-a', revision: 2, patch: { profile: { draft: 7.1 } } }),
        ]);
    });

    it('removes archived-vessel patches without blocking another boat in the FIFO', async () => {
        await queueVesselPatch({ boatId: 'boat-a', patch: { profile: { draft: 7.4 } }, revision: 1 });
        await queueVesselPatch({ boatId: 'boat-b', patch: { profile: { draft: 5.8 } }, revision: 1 });

        await expect(discardQueuedVesselPatchesForBoat('boat-a')).resolves.toBe(1);
        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (entry) => {
            pushed.push(entry);
        });

        expect(pushed).toEqual([expect.objectContaining({ boatId: 'boat-b', revision: 1 })]);
    });
});

/** jsdom's navigator.onLine is a prototype getter; shadow it on the instance for one block. */
async function whileOffline(work: () => Promise<void>): Promise<void> {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
        await work();
    } finally {
        Reflect.deleteProperty(navigator, 'onLine');
    }
}

function releasedRow(id: string, name: string, releasedAt: string, reason: string, ownerId = OWNER_A) {
    return row(id, ownerId, {
        profile: profile(name),
        archived_at: releasedAt,
        released_at: releasedAt,
        release_reason: reason,
    });
}

/**
 * Release and MMSI claim (2026-09-08 decision). The service is the only
 * client path that talks to release_owned_vessel / undo_vessel_release, and
 * it is never allowed to queue either of them.
 */
describe('VesselFleetService release, undo and claim refusals', () => {
    it('releases through release_owned_vessel, retires the hull and drops only its queued edits', async () => {
        await queueVesselPatch({ boatId: 'sold-boat', patch: { profile: { draft: 7.4 } }, revision: 1 });
        await queueVesselPatch({ boatId: 'kept-boat', patch: { profile: { draft: 5.8 } }, revision: 1 });
        rpcMock.mockImplementation(async (name) =>
            name === 'release_owned_vessel'
                ? {
                      data: {
                          released: true,
                          remaining_active_boats: 1,
                          next_active_boat_id: 'kept-boat',
                          crew_removed: 2,
                          invites_revoked: 0,
                          relays_removed: 1,
                          relays_unmatched: 0,
                          telemetry_cleared: 1,
                          public_pages_disabled: 1,
                      },
                      error: null,
                  }
                : { data: null, error: null },
        );

        const result = await releaseOwnedVessel('sold-boat', 'sold');

        expect(rpcMock).toHaveBeenCalledWith('release_owned_vessel', { p_boat_id: 'sold-boat', p_reason: 'sold' });
        expect(result).toEqual({
            released: true,
            remainingActiveBoats: 1,
            nextActiveBoatId: 'kept-boat',
            crewRemoved: 2,
            invitesRevoked: 0,
            relaysRemoved: 1,
            relaysUnmatched: 0,
            telemetryCleared: 1,
            publicPagesDisabled: 1,
        });

        // The released hull's edits are gone; the other boat's FIFO is untouched.
        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (entry) => {
            pushed.push(entry);
        });
        expect(pushed).toEqual([expect.objectContaining({ boatId: 'kept-boat' })]);

        // A later edit to the released hull is terminal — never a new queue entry.
        const late = await patchOwnedVesselProfile({
            boatId: 'sold-boat',
            patch: { profile: { draft: 8 } },
            revision: 2,
        });
        expect(late).toMatchObject({ value: null, queued: false });
        expect(late.error?.message).toMatch(/archived/);
        expect(rpcMock).not.toHaveBeenCalledWith('patch_owned_vessel_profile', expect.anything());
        const retryPush = vi.fn(async () => undefined);
        await drainQueuedVesselPatches(retryPush);
        expect(retryPush).not.toHaveBeenCalled();
    });

    it('refuses to release offline with the design sentence and never touches the RPC or the outbox', async () => {
        await whileOffline(async () => {
            await expect(releaseOwnedVessel('offline-boat', 'other')).rejects.toThrow(RELEASE_OFFLINE_MESSAGE);
        });
        expect(rpcMock).not.toHaveBeenCalled();

        // Nothing has changed: the hull is still editable and nothing was queued for it.
        const pushed: unknown[] = [];
        await drainQueuedVesselPatches(async (entry) => {
            pushed.push(entry);
        });
        expect(pushed).toEqual([]);
        await queueVesselPatch({ boatId: 'offline-boat', patch: { profile: { draft: 6 } }, revision: 1 });
        await drainQueuedVesselPatches(async (entry) => {
            pushed.push(entry);
        });
        expect(pushed).toEqual([expect.objectContaining({ boatId: 'offline-boat' })]);
    });

    it('undo un-retires the hull so its edits are accepted again', async () => {
        rpcMock.mockImplementation(async (name) => {
            if (name === 'release_owned_vessel')
                return { data: { released: true, remaining_active_boats: 0 }, error: null };
            if (name === 'undo_vessel_release') return { data: { restored: true, claim_lost: true }, error: null };
            if (name === 'patch_owned_vessel_profile')
                return { data: [row('undo-boat', OWNER_A, { revision: 2 })], error: null };
            return { data: null, error: null };
        });

        await releaseOwnedVessel('undo-boat', 'delivery_complete');
        const whileReleased = await patchOwnedVesselProfile({
            boatId: 'undo-boat',
            patch: { profile: { draft: 6.1 } },
            revision: 1,
        });
        expect(whileReleased.error?.message).toMatch(/archived/);

        await expect(undoVesselRelease('undo-boat')).resolves.toEqual({ restored: true, claimLost: true });
        expect(rpcMock).toHaveBeenCalledWith('undo_vessel_release', { p_boat_id: 'undo-boat' });

        const afterUndo = await patchOwnedVesselProfile({
            boatId: 'undo-boat',
            patch: { profile: { draft: 6.1 } },
            revision: 1,
        });
        expect(afterUndo.queued).toBe(false);
        expect(afterUndo.value?.id).toBe('undo-boat');
    });

    it('maps MMSI_CLAIMED and VESSEL_RELEASED refusals to typed errors from details and hint', async () => {
        rpcMock.mockResolvedValueOnce({
            data: null,
            error: { code: 'P0001', message: 'MMSI_CLAIMED', details: 'Serene Summer', hint: '503101240' },
        });
        const claimed = await bootstrapOwnedVesselProfile(profile('Second Phone Boat')).catch((error) => error);
        expect(claimed).toBeInstanceOf(VesselClaimedError);
        expect(claimed).toMatchObject({ vesselName: 'Serene Summer', mmsi: '503101240' });

        rpcMock.mockResolvedValueOnce({
            data: null,
            error: {
                code: 'P0001',
                message: 'VESSEL_RELEASED',
                details: 'Serene Summer',
                hint: '2026-09-08T01:02:03.000Z|sold',
            },
        });
        const released = await bootstrapOwnedVesselProfile(profile('Serene Summer')).catch((error) => error);
        expect(released).toBeInstanceOf(VesselReleasedError);
        expect(released).toMatchObject({
            vesselName: 'Serene Summer',
            releasedAt: '2026-09-08T01:02:03.000Z',
            reason: 'sold',
        });

        // supabase-js raises PostgrestError as an Error instance; the class
        // mapping must win over the generic Error pass-through.
        rpcMock.mockResolvedValueOnce({
            data: null,
            error: Object.assign(new Error('MMSI_CLAIMED'), { code: 'P0001', details: 'Calypso', hint: '503000001' }),
        });
        const claimedInstance = await bootstrapOwnedVesselProfile(profile('Calypso')).catch((error) => error);
        expect(claimedInstance).toBeInstanceOf(VesselClaimedError);
        expect(claimedInstance).toMatchObject({ vesselName: 'Calypso', mmsi: '503000001' });

        // Any other refusal stays an ordinary Error.
        rpcMock.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Authentication is required' } });
        const plain = await bootstrapOwnedVesselProfile(profile('Plain')).catch((error) => error);
        expect(plain).toBeInstanceOf(Error);
        expect(plain).not.toBeInstanceOf(VesselClaimedError);
        expect(plain).not.toBeInstanceOf(VesselReleasedError);
    });

    it('reads the claim and release columns tolerantly and round-trips them through the fleet cache', async () => {
        const fleet = normalizeVesselFleetPayload(
            {
                vessels: [
                    row('claimed', OWNER_A, { is_active: true, mmsi_claimed: true }),
                    // A row from a server still ahead of the migration has none of the columns.
                    row('legacy'),
                ],
            },
            OWNER_A,
        );
        expect(fleet.vessels.find((vessel) => vessel.id === 'claimed')).toMatchObject({
            mmsiClaimed: true,
            releasedAt: null,
            releaseReason: null,
        });
        // A row without the column (a server ahead of the build, an older cache)
        // says NOTHING about the claim — null, never false, or every skipper with
        // an MMSI would read the "claimed by them" advisory about their own boat.
        expect(fleet.vessels.find((vessel) => vessel.id === 'legacy')).toMatchObject({
            mmsiClaimed: null,
            releasedAt: null,
            releaseReason: null,
        });

        await persistCachedOwnedVesselFleet(fleet, undefined, null);
        const restored = await loadCachedOwnedVesselFleet();
        expect(restored?.fleet.vessels.find((vessel) => vessel.id === 'claimed')?.mmsiClaimed).toBe(true);
        expect(restored?.fleet.vessels.find((vessel) => vessel.id === 'legacy')?.mmsiClaimed).toBeNull();

        // A released hull is archived and therefore never part of the active fleet.
        const withReleased = normalizeVesselFleetPayload(
            {
                vessels: [releasedRow('gone', 'Sold Boat', '2026-09-08T00:00:00.000Z', 'sold'), row('kept')],
            },
            OWNER_A,
        );
        expect(withReleased.vessels.map((vessel) => vessel.id)).toEqual(['kept']);
    });

    it('lists released hulls newest first, ignores foreign and active rows, and treats a missing RPC as empty', async () => {
        rpcMock.mockResolvedValueOnce({
            data: [
                releasedRow('older', 'Delivery Boat', '2026-09-01T00:00:00.000Z', 'delivery_complete'),
                releasedRow('newer', 'Serene Summer', '2026-09-08T00:00:00.000Z', 'sold'),
                releasedRow('foreign', 'Not Mine', '2026-09-09T00:00:00.000Z', 'sold', OWNER_B),
                row('active'),
            ],
            error: null,
        });
        await expect(loadReleasedVessels()).resolves.toEqual([
            {
                boatId: 'newer',
                name: 'Serene Summer',
                releasedAt: '2026-09-08T00:00:00.000Z',
                releaseReason: 'sold',
            },
            {
                boatId: 'older',
                name: 'Delivery Boat',
                releasedAt: '2026-09-01T00:00:00.000Z',
                releaseReason: 'delivery_complete',
            },
        ]);
        expect(rpcMock).toHaveBeenCalledWith('get_released_vessels');

        // A client shipped before the 20260908170000 migration is not an error.
        rpcMock.mockResolvedValueOnce({
            data: null,
            error: { code: 'PGRST202', message: 'Could not find the function public.get_released_vessels' },
        });
        await expect(loadReleasedVessels()).resolves.toEqual([]);

        rpcMock.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });
        await expect(loadReleasedVessels()).rejects.toThrow('permission denied');
    });
});
