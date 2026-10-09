/**
 * Her trail ashore (126-03a): the shore phone keeps the broadcasts it hears as
 * half-minute means (SwingTrack), in memory only, from app start, so the trail
 * grows while Shore Watch's page is closed.
 *
 * Fictional anchorages: off Lyttelton, New Zealand, and off Horta, the Azores.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PositionBroadcast, SyncBroadcast, SyncState } from '../services/AnchorWatchSyncService';

const sync = vi.hoisted(() => ({
    stateListeners: new Set<(state: SyncState) => void>(),
    broadcastListeners: new Set<(data: SyncBroadcast) => void>(),
    state: null as unknown as SyncState,
    latest: null as PositionBroadcast | null,
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onStateChange: vi.fn((listener: (state: SyncState) => void) => {
            sync.stateListeners.add(listener);
            listener(sync.state);
            return () => sync.stateListeners.delete(listener);
        }),
        onBroadcast: vi.fn((listener: (data: SyncBroadcast) => void) => {
            sync.broadcastListeners.add(listener);
            return () => sync.broadcastListeners.delete(listener);
        }),
        getLatestPosition: vi.fn(() => sync.latest),
    },
}));

import { AnchorWatchSyncService } from '../services/AnchorWatchSyncService';
import { ShoreSwingTrailStore } from '../services/shoreSwingTrail';

const CODE = 'ABCDEFGHJKLM';
const OTHER = 'NPQRSTUVWXYZ';
const LYTTELTON = { latitude: -43.61, longitude: 172.72 };
const HORTA = { latitude: 38.53, longitude: -28.62 };
/** On a half-minute boundary, so the buckets are easy to reason about. */
const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
let now = T0;

function shore(sessionCode: string | null, role: SyncState['role'] = 'shore'): SyncState {
    return {
        connected: true,
        role,
        sessionCode,
        peerConnected: true,
        lastPeerUpdate: now,
        peerDisconnectedAt: null,
    };
}

function emitState(state: SyncState) {
    sync.state = state;
    sync.stateListeners.forEach((listener) => listener(state));
}

function emit(data: SyncBroadcast) {
    sync.broadcastListeners.forEach((listener) => listener(data));
}

function position(
    vessel: { latitude: number; longitude: number },
    over: Partial<PositionBroadcast> = {},
    anchor = LYTTELTON,
): PositionBroadcast {
    return {
        type: 'position',
        vessel: { ...vessel, accuracy: 3, heading: 0, speed: 0, timestamp: now },
        anchor: { ...anchor, timestamp: T0 },
        distance: 12,
        swingRadius: 50,
        isAlarm: false,
        timestamp: now,
        ...over,
    };
}

const north = (metres: number) => ({ latitude: LYTTELTON.latitude + metres / 110540, longitude: LYTTELTON.longitude });

beforeEach(() => {
    now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sync.stateListeners.clear();
    sync.broadcastListeners.clear();
    sync.state = shore(CODE);
    sync.latest = null;
    vi.mocked(AnchorWatchSyncService.onStateChange).mockClear();
    vi.mocked(AnchorWatchSyncService.onBroadcast).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('ShoreSwingTrailStore', () => {
    it('start() twice subscribes once', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        store.start();
        expect(AnchorWatchSyncService.onStateChange).toHaveBeenCalledOnce();
        expect(AnchorWatchSyncService.onBroadcast).toHaveBeenCalledOnce();
    });

    it('adds a fresh, valid position broadcast as a half-minute mean', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        emit(position(north(10)));
        now += 10_000;
        emit(position(north(20)));
        const points = store.points(CODE);
        expect(points).toHaveLength(1);
        expect(points[0].latitude).toBeCloseTo(north(15).latitude, 9);
        expect(points[0].timestamp).toBe(T0);
    });

    it.each<[string, (p: PositionBroadcast) => PositionBroadcast]>([
        ['a broadcast 40 s old', (p) => ({ ...p, timestamp: now - 40_000 })],
        ['a fix 40 s old', (p) => ({ ...p, vessel: { ...p.vessel, timestamp: now - 40_000 } })],
        ['a broadcast from a clock a minute fast', (p) => ({ ...p, timestamp: now + 60_000 })],
        ['a fix with no time', (p) => ({ ...p, vessel: { ...p.vessel, timestamp: Number.NaN } })],
        ['a latitude past the pole', (p) => ({ ...p, vessel: { ...p.vessel, latitude: 95 } })],
        ['a longitude that is not a number', (p) => ({ ...p, vessel: { ...p.vessel, longitude: Number.NaN } })],
        ['an anchor with no position', (p) => ({ ...p, anchor: undefined as unknown as PositionBroadcast['anchor'] })],
        ['a distance that is not a number', (p) => ({ ...p, distance: Number.NaN })],
        ['no swing radius', (p) => ({ ...p, swingRadius: 0 })],
        ['no alarm flag', (p) => ({ ...p, isAlarm: undefined as unknown as boolean })],
    ])('ignores %s, as the shore alarm does', (_label, spoil) => {
        const store = new ShoreSwingTrailStore();
        store.start();
        emit(spoil(position(north(10))));
        expect(store.points(CODE)).toEqual([]);
    });

    it("ignores 'status' (GPS lost) and alarm broadcasts: they carry no fix", () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        emit({ type: 'status', gpsAvailable: false, reason: 'gps_unavailable', source: 'pi', timestamp: now });
        emit({ type: 'alarm', triggered: true, distance: 60, swingRadius: 50, timestamp: now });
        expect(store.points(CODE)).toEqual([]);
    });

    it('ignores a replayed or out-of-order fix, inside the half-minute too', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        const first = position(north(10));
        emit(first);
        now += 10_000;
        emit(position(north(20)));
        const before = store.points(CODE);
        // The first packet again, and then an older fix that arrives late.
        emit(first);
        emit(
            position(north(40), { vessel: { ...north(40), accuracy: 3, heading: 0, speed: 0, timestamp: T0 + 5_000 } }),
        );
        expect(store.points(CODE)).toEqual(before);
        // A fix from a half-minute already closed adds nothing either.
        now = T0 + 45_000;
        emit(position(north(30)));
        const closed = store.points(CODE);
        emit(
            position(north(90), { vessel: { ...north(90), accuracy: 3, heading: 0, speed: 0, timestamp: T0 + 1_000 } }),
        );
        expect(store.points(CODE)).toEqual(closed);
    });

    it('a moved anchor keeps her trail: it is her track, not the mark’s', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        emit(position(north(10)));
        now += 30_000;
        const moved = { latitude: LYTTELTON.latitude + 0.0002, longitude: LYTTELTON.longitude };
        emit(position(north(12), {}, moved));
        expect(store.points(CODE)).toHaveLength(2);
    });

    it('a new session code starts a new trail', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        emit(position(north(10)));
        now += 30_000;
        emit(position(north(12)));
        expect(store.points(CODE)).toHaveLength(2);

        emitState(shore(OTHER));
        expect(store.points(CODE)).toEqual([]);
        expect(store.points(OTHER)).toEqual([]);
        now += 30_000;
        emit(position(HORTA, {}, HORTA));
        expect(store.points(OTHER)).toHaveLength(1);
        expect(store.points(OTHER)[0].latitude).toBeCloseTo(HORTA.latitude, 9);
    });

    it('keeps nothing on the boat’s own phone or with no session', () => {
        sync.state = shore(CODE, 'vessel');
        const store = new ShoreSwingTrailStore();
        store.start();
        emit(position(north(10)));
        expect(store.points(CODE)).toEqual([]);
        emitState(shore(null));
        emit(position(north(10)));
        expect(store.points(CODE)).toEqual([]);
    });

    it('seeds from the position already heard when it starts', () => {
        sync.latest = position(north(10));
        const store = new ShoreSwingTrailStore();
        store.start();
        expect(store.points(CODE)).toHaveLength(1);
    });

    it('returns the newest half-minutes, 500 by default, and the same array until she moves on', () => {
        const store = new ShoreSwingTrailStore();
        store.start();
        for (let i = 0; i < 600; i++) {
            now = T0 + i * 30_000;
            emit(position(north(10 + (i % 7))));
        }
        const drawn = store.points(CODE);
        expect(drawn).toHaveLength(500);
        expect(drawn[499].timestamp).toBe(T0 + 599 * 30_000);
        expect(drawn[0].timestamp).toBe(T0 + 100 * 30_000);
        expect(store.points(CODE, 10)).toHaveLength(10);
        // Stable between broadcasts, so the radar's model is not rebuilt each second.
        expect(store.points(CODE)).toBe(drawn);
        now += 30_000;
        emit(position(north(11)));
        expect(store.points(CODE)).not.toBe(drawn);
    });
});
