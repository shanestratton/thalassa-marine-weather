/**
 * The 50-route library cap (125-07). capSavedTracesPreservingTrips evicted the
 * OLDEST whole trips — a passage being sailed right now included, and a
 * checked leg as readily as an unchecked one. That was one root of Shane's
 * yellow Newport → Whitsundays legs (2026-10-08): the account still had the
 * route, the phone had silently dropped it and its check.
 *
 *  - a followed (active) trip is never evicted;
 *  - inside the cap, unchecked routes go before checked ones;
 *  - a refused write (quota) never drops the library.
 *
 * Fictional routes only: the Stockholm archipelago (Sweden).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: { draft: 1.8 * 3.28084, estimatedFields: [] } } }) },
}));
vi.mock('../services/VoyageService', () => ({ refreshSavedRouteVoyageVerification: vi.fn(async () => ({})) }));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    bankTraceVerification,
    capSavedTracesPreservingTrips,
    loadSavedTraces,
    saveTrace,
    type SavedTrace,
    type TraceLegVerdict,
    type TracePoint,
} from '../services/routeTracer';
import { evaluateTraceRelease } from '../services/traceVerification';
import { useFollowRouteStore } from '../stores/followRouteStore';
import type { VoyagePlan } from '../types';

const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 14,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
const checkFor = (points: TracePoint[], iso = new Date().toISOString()) =>
    evaluateTraceRelease(
        points,
        'ready',
        points.slice(1).map(() => clear),
        new Set(),
        {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'SE5STH01@4',
            departureMs: Date.parse('2026-10-11T06:00:00Z'),
            tideWindowLabel: '',
        },
        iso,
    ).verification!;

const day = (n: number) => new Date(Date.UTC(2026, 3, 1 + n, 8)).toISOString();
/** A distinct short line per index, north of Stockholm through the skerries. */
const line = (i: number): TracePoint[] => [
    { lat: 59.3 + i * 0.004, lon: 18.6 },
    { lat: 59.3 + i * 0.004, lon: 18.7 },
];
const route = (id: string, n: number, extras: Partial<SavedTrace> = {}): SavedTrace => ({
    id,
    name: `Skerries ${id}`,
    createdAt: day(n),
    points: line(n),
    ...extras,
});

const libraryKey = () => authScopedStorageKey('thalassa_traced_routes_v1');
const seed = (traces: SavedTrace[]) => localStorage.setItem(libraryKey(), JSON.stringify(traces));

/** A followed 3-leg passage (the OLDEST thing in the library), then 47 day sails. */
function fullLibrary(checked: (n: number) => boolean = () => false): SavedTrace[] {
    const trip = [1, 2, 3].map((ordinal) =>
        route(`leg-${ordinal}`, 0, {
            name: `Stavsnäs → Arholma (${ordinal === 1 ? '1st' : ordinal === 2 ? '2nd' : '3rd'} Leg)`,
            tripId: 'leg-1',
            legOrdinal: ordinal,
            points: line(100 + ordinal),
        }),
    );
    const sails = Array.from({ length: 47 }, (_, k) => {
        const n = k + 1;
        return route(`sail-${n}`, n, checked(n) ? { verification: checkFor(line(n)) } : {});
    });
    return [...sails.reverse(), ...trip];
}

const plan = { origin: 'Stavsnäs', destination: 'Arholma', waypoints: [] } as unknown as VoyagePlan;

describe('the route-library cap', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-cap');
        useFollowRouteStore.getState().stopFollowing();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        useFollowRouteStore.getState().stopFollowing();
        setAuthIdentityScope(null);
    });

    it('a 51st save keeps a followed 3-leg trip whole', () => {
        seed(fullLibrary());
        // Under way on leg 2 (a Cast Off follow: its own voyage id, the leg's own pins).
        useFollowRouteStore.getState().startFollowing(plan, 'cast-off-voyage-0001', line(102));

        const saved = saveTrace('Sandhamn → Möja', line(200));
        expect(saved.persisted).toBe(true);
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).toHaveLength(50);
        expect(ids).toEqual(expect.arrayContaining(['leg-1', 'leg-2', 'leg-3', saved.trace.id]));
        // The oldest day sail went instead.
        expect(ids).not.toContain('sail-1');
    });

    it('…and when the follow names the passage itself (a Log pick of its Passage Planning row)', () => {
        const PASSAGE = '6e5d4c3b-2a19-4807-b6f5-e4d3c2b1a090';
        seed(fullLibrary().map((t) => (t.id === 'leg-3' ? { ...t, passageVoyageId: PASSAGE } : t)));
        // Followed by its voyage id, along a line that is not one leg's pins.
        useFollowRouteStore.getState().startFollowing(plan, PASSAGE, [...line(101), ...line(103)]);

        saveTrace('Sandhamn → Möja', line(200));
        expect(loadSavedTraces().map((t) => t.id)).toEqual(expect.arrayContaining(['leg-1', 'leg-2', 'leg-3']));
    });

    it('the same passage NOT followed is evicted whole, as before (oldest first)', () => {
        seed(fullLibrary());
        saveTrace('Sandhamn → Möja', line(200));
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).not.toEqual(expect.arrayContaining(['leg-1']));
        expect(ids.some((id) => id.startsWith('leg-'))).toBe(false);
        expect(ids).toContain('sail-1');
    });

    it('evicts an unchecked route before an older checked one', () => {
        // sail-1 (oldest day sail) is checked; sail-2 is not.
        seed(
            fullLibrary((n) => n === 1)
                .filter((t) => !t.id.startsWith('leg-'))
                .concat(route('sail-48', 48), route('sail-49', 49), route('sail-50', 50)),
        );
        expect(loadSavedTraces()).toHaveLength(50);

        saveTrace('Sandhamn → Möja', line(200));
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).toHaveLength(50);
        expect(ids).toContain('sail-1');
        expect(ids).not.toContain('sail-2');
    });

    it('keeps an unchecked route saved yesterday over an April checked one (recent trips are kept newest first)', () => {
        // 49 checked day sails from April, then yesterday's unchecked route — an
        // autorouting proposal saved offline, its cloud push not through yet.
        const yesterday = new Date(Date.now() - 86_400_000).toISOString();
        seed([
            route('yesterday', 0, { createdAt: yesterday, points: line(300) }),
            ...Array.from({ length: 49 }, (_, k) =>
                route(`sail-${k + 1}`, k + 1, { verification: checkFor(line(k + 1)) }),
            ).reverse(),
        ]);
        expect(loadSavedTraces()).toHaveLength(50);

        saveTrace('Sandhamn → Möja', line(200));
        const ids = loadSavedTraces().map((t) => t.id);
        expect(ids).toHaveLength(50);
        expect(ids).toContain('yesterday');
        // The oldest checked route went instead.
        expect(ids).not.toContain('sail-1');
        expect(ids).toContain('sail-2');
    });

    it('the pure rule over the cap: every trip from the last 30 days survives whatever its check state', () => {
        const now = Date.parse('2026-10-09T08:00:00Z');
        const aged = Array.from({ length: 50 }, (_, k) =>
            route(`aged-${k + 1}`, k + 1, { verification: checkFor(line(k + 1)) }),
        ).reverse();
        // Three routes built on another device yesterday: unchecked here.
        const desk = [1, 2, 3].map((n) =>
            route(`desk-${n}`, 0, {
                createdAt: new Date(now - 86_400_000 + n * 60_000).toISOString(),
                points: line(400 + n),
            }),
        );
        const kept = capSavedTracesPreservingTrips([...desk, ...aged], 50, new Set(), { nowMs: now }).map((t) => t.id);
        expect(kept).toHaveLength(50);
        expect(kept).toEqual(expect.arrayContaining(['desk-1', 'desk-2', 'desk-3']));
        // The three oldest checked trips went instead.
        expect(kept).not.toContain('aged-1');
        expect(kept).not.toContain('aged-2');
        expect(kept).not.toContain('aged-3');
        expect(kept).toContain('aged-4');
    });

    it('the pure rule over the cap: a route the account has not acknowledged yet is never what goes', () => {
        const now = Date.parse('2026-10-09T08:00:00Z');
        // 50 checked April-May trips, and one unchecked local-only route from
        // mid-April (a proposal the server refused as schema-pending).
        const checked = Array.from({ length: 50 }, (_, k) =>
            route(`aged-${k + 1}`, k + 1, { verification: checkFor(line(k + 1)) }),
        );
        const localOnly = route('local-only', 15, { points: line(500) });
        const traces = [...checked, localOnly].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const ids = (pending?: Set<string>) =>
            capSavedTracesPreservingTrips(traces, 50, new Set(), { nowMs: now, pendingIds: pending }).map((t) => t.id);
        expect(ids(new Set(['local-only']))).toContain('local-only');
        expect(ids(new Set(['local-only']))).not.toContain('aged-1');
        // Acknowledged (the account holds it): an old unchecked route goes first.
        expect(ids()).not.toContain('local-only');
        expect(ids()).toContain('aged-1');
    });

    it('the pure rule: newest write always admitted, protected trips exempt, checked before unchecked', () => {
        const a = route('a', 1, { verification: checkFor(line(1)) });
        const b = route('b', 2);
        const c = route('c', 3);
        const newest = route('n', 9);
        expect(capSavedTracesPreservingTrips([newest, c, b, a], 3).map((t) => t.id)).toEqual(['n', 'c', 'a']);
        expect(capSavedTracesPreservingTrips([newest, c, b, a], 3, new Set(['b'])).map((t) => t.id)).toEqual([
            'n',
            'b',
            'a',
        ]);
        // Under the cap nothing moves.
        expect(capSavedTracesPreservingTrips([newest, c, b, a], 50).map((t) => t.id)).toEqual(['n', 'c', 'b', 'a']);
    });

    it('a refused write (quota) leaves the library exactly as it was', () => {
        seed(fullLibrary());
        useFollowRouteStore.getState().startFollowing(plan, 'cast-off-voyage-0001', line(102));
        const before = localStorage.getItem(libraryKey());
        const key = libraryKey();
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
            if (k === key) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            return setItem.call(this, k, v);
        });

        const saved = saveTrace('Sandhamn → Möja', line(200));
        expect(saved.persisted).toBe(false);
        expect(bankTraceVerification('sail-5', checkFor(line(5)))).toEqual({ banked: false, reason: 'storage' });
        expect(localStorage.getItem(key)).toBe(before);
        expect(loadSavedTraces()).toHaveLength(50);
    });

    it('…even on a storage engine that drops the old value before refusing the new one', () => {
        seed(fullLibrary());
        const before = localStorage.getItem(libraryKey());
        const key = libraryKey();
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
            if (k === key && v !== before) {
                this.removeItem(k);
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            return setItem.call(this, k, v);
        });

        expect(saveTrace('Sandhamn → Möja', line(200)).persisted).toBe(false);
        expect(localStorage.getItem(key)).toBe(before);
        expect(loadSavedTraces()).toHaveLength(50);
    });
});
