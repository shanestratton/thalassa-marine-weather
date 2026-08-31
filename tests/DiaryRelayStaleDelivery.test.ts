/**
 * Server-sync integrity: losing deliveries and revision minting (2026-09-01).
 *
 * Two audited defects, one chain of data loss:
 *
 *  1. A rejected ('stale') delivery used to masquerade as success — the Edge
 *     boundary answers HTTP 200 {ok:true, status:'stale', entry:<winner>} for
 *     a LOSING envelope, and the client retired its local copy as 'synced',
 *     silently replacing the skipper's later words with the winner's.
 *  2. Revision minting was an unlocked read-modify-write: an edit resolved
 *     through a stale snapshot (cache, an old _recentlySynced hit) could
 *     re-mint a revision number the server had already bound to a DIFFERENT
 *     payload — a tie the relay RPC breaks first-writer-wins.
 *
 * These tests drive the real DiaryService against a mocked relay transport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const relay = vi.hoisted(() => ({
    cloudAllowed: false,
    submitDiaryDirect: vi.fn(),
    handoffDiaryToPi: vi.fn(),
}));

vi.mock('../services/DiaryRelayTransport', () => ({
    canAttemptDiaryCloudDelivery: () => relay.cloudAllowed,
    submitDiaryDirect: relay.submitDiaryDirect,
    handoffDiaryToPi: relay.handoffDiaryToPi,
    handoffVideoToPi: vi.fn(async () => false),
    isPiVideoRelayAvailable: () => false,
    cancelDiaryDirect: vi.fn(async () => false),
    cancelDiaryOnPi: vi.fn(async () => false),
    syncPiDiaryRelayInternetPolicy: vi.fn(async () => true),
}));

// Mutable holder so tests can swap between "offline" (null) and a mocked
// client. The getter keeps DiaryService's `supabase` binding live.
const mockSupabase: { current: unknown } = { current: null };
vi.mock('../services/supabase', () => ({
    get supabase() {
        return mockSupabase.current;
    },
}));

import { DiaryService } from '../services/DiaryService';
import { authScopedStorageKey, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

const TEST_SCOPE: AuthIdentityScope = { key: 'user:u1', userId: 'u1', generation: 0 };
const PENDING_KEY = authScopedStorageKey('thalassa_diary_pending_v2', TEST_SCOPE);
const CACHE_KEY = authScopedStorageKey('thalassa_diary_entries_v2', TEST_SCOPE);
const FLOOR_KEY = authScopedStorageKey('thalassa_diary_revision_floor_v1', TEST_SCOPE);

const readPending = (): Record<string, unknown>[] => JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
const readFloor = (operationId: string): number | undefined => {
    const list: [string, number][] = JSON.parse(localStorage.getItem(FLOOR_KEY) ?? '[]');
    return list.find(([id]) => id === operationId)?.[1];
};

// Unique ids per test: the singleton service keeps an in-memory
// _recentlySynced buffer across tests within the same auth scope.
const pendingEntry = (offlineId: string, operationId: string, overrides: Record<string, unknown> = {}) => ({
    id: offlineId,
    user_id: 'u1',
    owner_user_id: 'u1',
    client_operation_id: operationId,
    client_revision: 2,
    title: 'Corrected title',
    body: 'The corrected words',
    mood: 'good',
    photos: [],
    audio_url: null,
    video_url: null,
    latitude: null,
    longitude: null,
    location_name: '',
    weather_summary: '',
    weather_data: null,
    voyage_id: null,
    boat_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:10:00.000Z',
    _offline: true,
    ...overrides,
});

// Shape of to_jsonb(diary_entries) as the Edge Function relays it back.
const serverRow = (serverId: string, operationId: string, overrides: Record<string, unknown> = {}) => ({
    id: serverId,
    user_id: 'u1',
    client_operation_id: operationId,
    client_revision: 2,
    title: 'Corrected title',
    body: 'The corrected words',
    mood: 'good',
    photos: [],
    audio_url: null,
    video_url: null,
    latitude: null,
    longitude: null,
    location_name: '',
    weather_summary: '',
    weather_data: null,
    voyage_id: null,
    boat_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-09-01T00:00:00+00:00',
    updated_at: '2026-09-01T00:10:00+00:00',
    ...overrides,
});

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('u1');
    relay.cloudAllowed = true;
    // mockReset (not clear): an unconsumed mockResolvedValueOnce from one
    // test must not leak into the next test's first delivery.
    relay.handoffDiaryToPi.mockReset().mockResolvedValue(null);
    relay.submitDiaryDirect.mockReset().mockResolvedValue(null);
    mockSupabase.current = {
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    };
});

describe('stale delivery reconciliation', () => {
    it('retires the entry as synced when the winner is our own duplicate (Pi/retry dedup)', async () => {
        const OP = 'diary_op_dedup_1';
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-101', OP)]));
        // Identical payload already landed via the other path; losing to
        // yourself is a completion, not a conflict.
        relay.submitDiaryDirect.mockResolvedValueOnce({ status: 'stale', entry: serverRow('srv-101', OP) });

        await DiaryService.syncPending();

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        expect(readPending()).toHaveLength(0);
        expect(readFloor(OP)).toBe(2);
    });

    it('outbids an equal-revision divergent winner instead of discarding the local copy', async () => {
        const OP = 'diary_op_outbid_1';
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-102', OP)]));
        relay.submitDiaryDirect
            // A pre-correction duplicate won first-writer-wins for revision 2.
            .mockResolvedValueOnce({
                status: 'stale',
                entry: serverRow('srv-102', OP, { body: 'The PRE-correction words' }),
            })
            // The bumped redelivery is accepted and echoes our content back.
            .mockImplementationOnce(async (envelope: { client_revision: number; body: string }) => ({
                status: 'accepted',
                entry: serverRow('srv-102', OP, {
                    client_revision: envelope.client_revision,
                    body: envelope.body,
                }),
            }));

        await DiaryService.syncPending();

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(2);
        const redelivered = relay.submitDiaryDirect.mock.calls[1]?.[0] as {
            client_revision: number;
            body: string;
        };
        // The corrected save re-delivers ABOVE the winner — its words survive.
        expect(redelivered.client_revision).toBe(3);
        expect(redelivered.body).toBe('The corrected words');
        expect(readPending()).toHaveLength(0);
        expect(readFloor(OP)).toBe(3);
    });

    it('keeps the entry queued (with the bumped revision) when the outbid redelivery fails', async () => {
        const OP = 'diary_op_outbid_defer_1';
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-103', OP)]));
        relay.submitDiaryDirect
            .mockResolvedValueOnce({
                status: 'stale',
                entry: serverRow('srv-103', OP, { body: 'The PRE-correction words' }),
            })
            .mockResolvedValueOnce(null); // network died mid-outbid

        await DiaryService.syncPending();

        const queued = readPending();
        expect(queued).toHaveLength(1);
        expect(queued[0].client_revision).toBe(3);
        expect(queued[0].body).toBe('The corrected words');
    });

    it('accepts a strictly newer synced revision as canonical and retires the older draft', async () => {
        const OP = 'diary_op_newer_1';
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-104', OP)]));
        relay.submitDiaryDirect.mockResolvedValueOnce({
            status: 'stale',
            entry: serverRow('srv-104', OP, { client_revision: 5, body: 'Words from the other phone' }),
        });

        await DiaryService.syncPending();

        // The revision protocol arbitrates: rev 5 beats the local rev 2 draft.
        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        expect(readPending()).toHaveLength(0);
        expect(readFloor(OP)).toBe(5);
    });
});

describe('serialized revision minting (the floor)', () => {
    it('an edit resolved through a stale cache snapshot cannot re-mint a confirmed revision', async () => {
        const OP = 'diary_op_floor_1';
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-105', OP)]));
        relay.submitDiaryDirect.mockImplementationOnce(async (envelope: { client_revision: number }) => ({
            status: 'accepted',
            entry: serverRow('srv-105', OP, { client_revision: envelope.client_revision }),
        }));

        await DiaryService.syncPending();
        expect(readPending()).toHaveLength(0);
        expect(readFloor(OP)).toBe(2);

        // A server refresh left a STALE copy (revision 1) in the cache — the
        // exact snapshot that used to make the next edit re-mint revision 2
        // for different words, losing first-writer-wins to the synced copy.
        relay.cloudAllowed = false;
        mockSupabase.current = null;
        localStorage.setItem(
            CACHE_KEY,
            JSON.stringify([pendingEntry('srv-105', OP, { client_revision: 1, _offline: false })]),
        );

        const result = await DiaryService.updateEntry('srv-105', { title: 'Second correction' });
        expect(result.ok).toBe(true);

        const queued = readPending();
        expect(queued).toHaveLength(1);
        // max(snapshot 1, floor 2) + 1 — never revision 2 again.
        expect(queued[0].client_revision).toBe(3);
        expect(readFloor(OP)).toBe(3);
    });

    it('setEntryPublished mints through the same floor as every other writer', async () => {
        const OP = 'diary_op_floor_2';
        relay.cloudAllowed = false;
        mockSupabase.current = null;
        localStorage.setItem(PENDING_KEY, JSON.stringify([pendingEntry('offline-106', OP, { client_revision: 1 })]));
        // This device has already minted up to revision 4 for the operation.
        localStorage.setItem(FLOOR_KEY, JSON.stringify([[OP, 4]]));

        const result = await DiaryService.setEntryPublished('offline-106', true);
        expect(result).toBe('deferred');

        const queued = readPending();
        expect(queued).toHaveLength(1);
        expect(queued[0].client_revision).toBe(5);
        expect(queued[0].publish_requested).toBe(true);
        expect(readFloor(OP)).toBe(5);
    });
});
