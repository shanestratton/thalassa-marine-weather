import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipLogEntry } from '../types';
import type { SavedTrace } from '../services/routeTracer';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

const world = vi.hoisted(() => ({ traces: [] as unknown[], getEntries: vi.fn(), offline: false }));
vi.mock('../services/routeTracer', async (original) => ({
    ...(await original<typeof import('../services/routeTracer')>()),
    loadSavedTraces: () => world.traces,
}));
vi.mock('../services/shiplog/VoyageSummary', () => ({ getVoyageEntries: world.getEntries }));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (selector: (state: { isOffline: boolean }) => unknown) => selector({ isOffline: world.offline }),
}));

import {
    completePlannedRouteFingerprint,
    possibleUnlinkedRouteMirrors,
    reconcileFollowRouteMirrors,
} from '../services/followRoutePickerIdentity';
import { savedRouteGeometryFingerprint } from '../services/savedRouteLibrary';
import { useFollowRoutePickerIdentity } from '../hooks/useFollowRoutePickerIdentity';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const points = [
    { lat: -27.2, lon: 153.1 },
    { lat: -25, lon: 153.3 },
    { lat: -23.8, lon: 152.4 },
];
const trace = (overrides: Partial<SavedTrace> = {}): SavedTrace => ({
    id: 'leg-1',
    name: 'Newport - Coral Sea',
    createdAt: '2026-09-01T00:00:00Z',
    points,
    tripId: 'passage',
    legOrdinal: 1,
    plannedRouteId: 'planned_current',
    ...overrides,
});
const summary = (voyageId: string, overrides: Partial<VoyageSummary> = {}): VoyageSummary =>
    ({
        voyageId,
        isPlannedRoute: true,
        entryCount: 3,
        startedAt: '2026-09-01T00:00:00Z',
        endedAt: '2026-09-01T00:02:00Z',
        totalDistanceNM: 239.4,
        firstLat: points[0].lat,
        firstLon: points[0].lon,
        lastLat: points[2].lat,
        lastLon: points[2].lon,
        ...overrides,
    }) as VoyageSummary;
const rows = (voyageId: string, geometry = points): ShipLogEntry[] =>
    geometry.map(
        (point, index) =>
            ({
                id: `${voyageId}-${index}`,
                voyageId,
                source: 'planned_route',
                latitude: point.lat,
                longitude: point.lon,
                timestamp: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 60_000).toISOString(),
            }) as ShipLogEntry,
    );
const ids = (summaries: readonly VoyageSummary[]) => summaries.map((s) => s.voyageId);
const emptyLinks = new Map<string, string>();
const emptyEntries: ShipLogEntry[] = [];

beforeEach(() => {
    world.traces = [];
    world.offline = false;
    world.getEntries.mockReset().mockResolvedValue([]);
    setAuthIdentityScope('picker-a');
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('canonical follow-route identities', () => {
    it('preserves a full passage and actual sailed record that share a first-leg anchor trace', () => {
        const input = [
            summary('planned_current'),
            summary('passage-record'),
            summary('actual-sailed', { isPlannedRoute: false }),
        ];
        const result = reconcileFollowRouteMirrors(
            input,
            new Map([
                ['passage-record', 'leg-1'],
                ['actual-sailed', 'leg-1'],
            ]),
            [trace({ passageVoyageId: 'passage-record' })],
            new Map(),
        );
        expect(ids(result.summaries)).toEqual(ids(input));
        expect(result.links.get('passage-record')).toBe('leg-1'); // grouping only
        expect(result.geometryLinks.has('passage-record')).toBe(false);
        expect(result.geometryLinks.get('planned_current')).toBe('leg-1');
    });
    it('allows a passage anchor to carry steering identity only when its complete geometry is that trace', () => {
        const input = [summary('passage-record')];
        const fullPassage = [...points, { lat: -20, lon: 149 }];
        const linkedTrace = trace({ passageVoyageId: 'passage-record' });
        const longer = reconcileFollowRouteMirrors(
            input,
            emptyLinks,
            [linkedTrace],
            new Map([['passage-record', savedRouteGeometryFingerprint(fullPassage)!]]),
        );
        expect(longer.geometryLinks.has('passage-record')).toBe(false);
        const exact = reconcileFollowRouteMirrors(
            input,
            emptyLinks,
            [linkedTrace],
            new Map([['passage-record', savedRouteGeometryFingerprint(points)!]]),
        );
        expect(exact.geometryLinks.get('passage-record')).toBe('leg-1');
    });
    it('keeps only the passage leg when two old standalone mirrors have its complete geometry', () => {
        const input = [summary('planned_copy_1'), summary('planned_copy_2'), summary('planned_current')];
        const fingerprints = new Map(input.map((s) => [s.voyageId, savedRouteGeometryFingerprint(points)!]));
        const result = reconcileFollowRouteMirrors(input, emptyLinks, [trace()], fingerprints);
        expect(ids(result.summaries)).toEqual(['planned_current']);
        expect([...result.links.values()]).toEqual(['leg-1', 'leg-1', 'leg-1']);
        expect(input).toHaveLength(3); // no deletion or mutation of the actual log or plan
    });
    it('prefers the current explicit mirror even when a duplicate is newer', () => {
        const result = reconcileFollowRouteMirrors(
            [summary('planned_newer', { startedAt: '2026-10-01T00:00:00Z' }), summary('planned_current')],
            new Map([['planned_newer', 'leg-1']]),
            [trace()],
            new Map(),
        );
        expect(ids(result.summaries)).toEqual(['planned_current']);
    });
    it('does not merge by matching name, endpoints, point count or distance alone', () => {
        const different = [points[0], { lat: -25, lon: 154 }, points[2]];
        const input = [summary('planned_distinct'), summary('planned_current')];
        const result = reconcileFollowRouteMirrors(
            input,
            emptyLinks,
            [trace()],
            new Map([['planned_distinct', savedRouteGeometryFingerprint(different)!]]),
        );
        expect(ids(result.summaries)).toEqual(ids(input));
        expect(result.links.has('planned_distinct')).toBe(false);
    });
    it('does not merge reverse geometry or ambiguous same-line canonical routes', () => {
        const input = [summary('planned_current'), summary('planned_other'), summary('planned_unknown')];
        const result = reconcileFollowRouteMirrors(
            input,
            emptyLinks,
            [trace(), trace({ id: 'leg-other', plannedRouteId: 'planned_other', tripId: 'other-trip' })],
            new Map([['planned_unknown', savedRouteGeometryFingerprint(points)!]]),
        );
        expect(ids(result.summaries)).toEqual(ids(input));
        expect(result.links.has('planned_unknown')).toBe(false);
        expect(
            reconcileFollowRouteMirrors(
                [summary('planned_reverse')],
                emptyLinks,
                [trace()],
                new Map([['planned_reverse', savedRouteGeometryFingerprint([...points].reverse())!]]),
            ).links.has('planned_reverse'),
        ).toBe(false);
    });
    it('keeps unknown and foreign explicit links rather than assigning them to another route', () => {
        const result = reconcileFollowRouteMirrors(
            [summary('planned_unknown'), summary('planned_current')],
            new Map([['planned_unknown', 'deleted-or-other-trace']]),
            [trace()],
            new Map([['planned_unknown', savedRouteGeometryFingerprint(points)!]]),
        );
        expect(result.summaries).toHaveLength(2);
        expect(result.links.get('planned_unknown')).toBe('deleted-or-other-trace');
    });
    it('accepts complete ordered planned entries but refuses partial, recorded or mismatched records', () => {
        const s = summary('planned_current');
        const entries = rows(s.voyageId);
        expect(completePlannedRouteFingerprint(s, [...entries].reverse())).toBe(savedRouteGeometryFingerprint(points));
        expect(completePlannedRouteFingerprint(s, entries.slice(0, 2))).toBeNull();
        expect(completePlannedRouteFingerprint(s, [...entries, { ...entries[0], id: 'extra' }])).toBeNull();
        expect(
            completePlannedRouteFingerprint(s, [
                { ...entries[0], source: 'device' } as ShipLogEntry,
                ...entries.slice(1),
            ]),
        ).toBeNull();
        expect(completePlannedRouteFingerprint(s, rows('someone-else'))).toBeNull();
    });
    it('limits candidate reads to small, unlinked planned routes with matching endpoints', () => {
        const input = [
            summary('candidate'),
            summary('huge', { entryCount: 10_000 }),
            summary('recorded', { isPlannedRoute: false }),
            summary('elsewhere', { firstLat: 12 }),
            summary('linked'),
        ];
        expect(ids(possibleUnlinkedRouteMirrors(input, new Map([['linked', 'leg-1']]), [trace()]))).toEqual([
            'candidate',
        ]);
    });
});

it('compares the full stored curve, never just sparse waypoints through its endpoints', () => {
    const s = summary('planned_curve', { entryCount: 2 });
    const entries = rows(s.voyageId, [points[0], points[2]]);
    entries[0].notes = `__route_geometry__::${JSON.stringify(points.map((point) => [point.lon, point.lat]))}\nRoute notes`;
    expect(completePlannedRouteFingerprint(s, entries)).toBe(savedRouteGeometryFingerprint(points));
    entries[0].notes = '__route_geometry__::broken';
    expect(completePlannedRouteFingerprint(s, entries)).toBeNull();
});

describe('bounded picker compatibility reads', () => {
    it('resolves old mirrors once without reading the entire history or rereading on live entry updates', async () => {
        world.traces = [trace()];
        world.getEntries.mockImplementation(async (id: string) => rows(id));
        const summaries = [summary('planned_copy_1'), summary('planned_copy_2'), summary('planned_current')];
        const scope = getAuthIdentityScope();
        const { result, rerender } = renderHook(
            ({ entries }) => useFollowRoutePickerIdentity(summaries, emptyLinks, entries, scope),
            { initialProps: { entries: emptyEntries } },
        );
        await waitFor(() => expect(ids(result.current.summaries)).toEqual(['planned_current']));
        expect(world.getEntries).toHaveBeenCalledTimes(2);
        expect(world.getEntries).toHaveBeenCalledWith('planned_copy_1', false, {
            maxRows: 4,
            requireComplete: true,
            signal: expect.any(AbortSignal),
        });
        rerender({ entries: [] });
        await act(async () => {});
        expect(world.getEntries).toHaveBeenCalledTimes(2);
        const snapshot = result.current.reconcileSnapshot(summaries);
        expect(ids(snapshot.summaries)).toEqual(['planned_current']);
    });
    it('keeps unresolved rows when offline and does not ask the network', async () => {
        world.traces = [trace()];
        world.offline = true;
        const summaries = [summary('planned_copy'), summary('planned_current')];
        const { result } = renderHook(() =>
            useFollowRoutePickerIdentity(summaries, emptyLinks, emptyEntries, getAuthIdentityScope()),
        );
        await act(async () => {});
        expect(result.current.summaries).toHaveLength(2);
        expect(world.getEntries).not.toHaveBeenCalled();
    });
    it('uses complete resident geometry immediately without network', () => {
        world.traces = [trace()];
        const summaries = [summary('planned_copy'), summary('planned_current')];
        const { result } = renderHook(() =>
            useFollowRoutePickerIdentity(summaries, emptyLinks, rows('planned_copy'), getAuthIdentityScope()),
        );
        expect(ids(result.current.summaries)).toEqual(['planned_current']);
        expect(world.getEntries).not.toHaveBeenCalled();
    });
    it('ignores late results after an account switch even when metadata is identical', async () => {
        world.traces = [trace()];
        let finish!: (rows: ShipLogEntry[]) => void;
        world.getEntries.mockImplementation(
            () =>
                new Promise<ShipLogEntry[]>((resolve) => {
                    finish = resolve;
                }),
        );
        const summaries = [summary('planned_copy'), summary('planned_current')];
        const { result, rerender } = renderHook(
            ({ scope }) => useFollowRoutePickerIdentity(summaries, emptyLinks, emptyEntries, scope),
            { initialProps: { scope: getAuthIdentityScope() } },
        );
        await waitFor(() => expect(world.getEntries).toHaveBeenCalledTimes(1));
        act(() => {
            setAuthIdentityScope('picker-b');
            world.offline = true;
            rerender({ scope: getAuthIdentityScope() });
        });
        await act(async () => {
            finish(rows('planned_copy'));
        });
        expect(result.current.summaries).toHaveLength(2);
        expect(result.current.links.has('planned_copy')).toBe(false);
    });
    it('aborts pending compatibility reads when the picker owner unmounts', async () => {
        world.traces = [trace()];
        world.getEntries.mockReturnValue(new Promise(() => {}));
        const { unmount } = renderHook(() =>
            useFollowRoutePickerIdentity([summary('planned_copy')], emptyLinks, emptyEntries, getAuthIdentityScope()),
        );
        await waitFor(() => expect(world.getEntries).toHaveBeenCalledOnce());
        const options = world.getEntries.mock.calls[0][2] as { signal: AbortSignal };
        expect(options.signal.aborted).toBe(false);
        unmount();
        expect(options.signal.aborted).toBe(true);
    });
});
