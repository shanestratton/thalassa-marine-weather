import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedTrace } from '../services/routeTracer';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import {
    deleteLogbookRouteFromLibrary,
    loadLogbookRouteForEditing,
    loadSavedRouteLibrary,
    mergeSavedRouteLibrary,
    savedRouteGeometryFingerprint,
} from '../services/savedRouteLibrary';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    loadSavedTraces: vi.fn(),
    syncSavedRoutes: vi.fn(),
    fetchRoutesAndTracks: vi.fn(),
    fetchVoyageAsTrack: vi.fn(),
    deleteVoyageLogOnly: vi.fn(),
}));

vi.mock('../services/routeTracer', async (importOriginal) => {
    // The library statically uses the pure label/rollup helpers — keep the
    // real implementations, mock only the storage read.
    const actual = await importOriginal<typeof import('../services/routeTracer')>();
    return {
        ...actual,
        loadSavedTraces: mocks.loadSavedTraces,
    };
});

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: mocks.fetchRoutesAndTracks,
    fetchVoyageAsTrack: mocks.fetchVoyageAsTrack,
}));

vi.mock('../services/savedRoutesSync', () => ({
    syncSavedRoutes: mocks.syncSavedRoutes,
}));

vi.mock('../services/shiplog/EntryCrud', () => ({
    deleteVoyageLogOnly: mocks.deleteVoyageLogOnly,
}));

const points = [
    { lat: -27.47, lon: 153.02 },
    { lat: -27.3, lon: 153.2 },
    { lat: -27.1, lon: 153.4 },
];

function saved(id: string, name: string, geometry = points, timestamp = '2026-07-20T00:00:00.000Z'): SavedTrace {
    return { id, name, points: geometry, createdAt: timestamp };
}

function legacy(
    id: string,
    label: string,
    geometry = points,
    timestamp = Date.parse('2026-07-21T00:00:00.000Z'),
): RouteOrTrack {
    return {
        id,
        label,
        sublabel: 'Planned · 18 NM',
        points: geometry,
        bbox: [153.02, -27.47, 153.4, -27.1],
        timestamp,
        distanceNm: 18,
        isLocal: false,
        kind: 'sea',
    };
}

describe('saved route Plan-library compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.loadSavedTraces.mockReturnValue([]);
        mocks.syncSavedRoutes.mockImplementation(async () => mocks.loadSavedTraces());
        mocks.fetchRoutesAndTracks.mockResolvedValue({ routes: [], tracks: [] });
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.deleteVoyageLogOnly.mockResolvedValue(true);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('fingerprints metre-equivalent geometry while preserving direction', () => {
        const noisy = points.map((point) => ({ lat: point.lat + 0.0000002, lon: point.lon - 0.0000002 }));
        const withDuplicate = [noisy[0], noisy[0], noisy[1], noisy[2]];

        expect(savedRouteGeometryFingerprint(withDuplicate)).toBe(savedRouteGeometryFingerprint(points));
        expect(savedRouteGeometryFingerprint([...points].reverse())).not.toBe(savedRouteGeometryFingerprint(points));
    });

    it('keeps canonical rows and removes their log mirrors plus repeated legacy mirrors', () => {
        const canonicalA = saved('saved-a', 'Moreton run');
        const canonicalAlias = saved('saved-alias', 'Moreton training line', points, '2026-07-19T00:00:00.000Z');
        const mirror = legacy(
            'planned-mirror',
            'Brisbane → Moreton',
            points.map((point) => ({ lat: point.lat + 0.0000001, lon: point.lon })),
        );
        const legacyOnlyPoints = [
            { lat: -26.8, lon: 153.1 },
            { lat: -26.5, lon: 153.3 },
        ];
        const olderLegacy = legacy('planned-old', 'Old plan', legacyOnlyPoints, 100);
        const newerLegacy = legacy('planned-new', 'Recovered plan', legacyOnlyPoints, 200);

        const merged = mergeSavedRouteLibrary([canonicalA, canonicalAlias], [mirror, olderLegacy, newerLegacy]);

        expect(merged.map((item) => item.key)).toEqual(['saved:saved-a', 'saved:saved-alias', 'logbook:planned-new']);
    });

    it('publishes canonical routes before a slow legacy lookup completes', async () => {
        const canonical = saved('saved-a', 'Immediate route');
        mocks.loadSavedTraces.mockReturnValue([canonical]);
        let resolveLegacy!: (value: { routes: RouteOrTrack[]; tracks: RouteOrTrack[] }) => void;
        mocks.fetchRoutesAndTracks.mockReturnValue(
            new Promise((resolve) => {
                resolveLegacy = resolve;
            }),
        );
        const onCanonical = vi.fn();

        const loading = loadSavedRouteLibrary(getAuthIdentityScope(), onCanonical);
        await vi.waitFor(() => expect(onCanonical).toHaveBeenCalled());
        expect(onCanonical.mock.calls[0][0].map((item: { key: string }) => item.key)).toEqual(['saved:saved-a']);

        resolveLegacy({ routes: [legacy('planned-other', 'Older route', [...points].reverse())], tracks: [] });
        await expect(loading).resolves.toHaveLength(2);
    });

    it('adds cloud-synced canonical routes when Plan is opened directly on another device', async () => {
        const local = saved('saved-local', 'Local route');
        const remote = saved('saved-remote', 'Remote route', [...points].reverse(), '2026-07-22T00:00:00.000Z');
        mocks.loadSavedTraces.mockReturnValue([local]);
        mocks.syncSavedRoutes.mockResolvedValue([remote, local]);
        const onCanonical = vi.fn();

        const library = await loadSavedRouteLibrary(getAuthIdentityScope(), onCanonical);

        expect(onCanonical.mock.calls[0][0].map((item: { key: string }) => item.key)).toEqual(['saved:saved-local']);
        expect(onCanonical.mock.calls.at(-1)?.[0].map((item: { key: string }) => item.key)).toEqual([
            'saved:saved-remote',
            'saved:saved-local',
        ]);
        expect(library.map((item) => item.key)).toEqual(['saved:saved-remote', 'saved:saved-local']);
    });

    it('loads exact per-voyage logbook geometry for editing', async () => {
        const exact = [
            { lat: -27.47, lon: 153.02 },
            { lat: -27.41234567, lon: 153.12345678 },
            { lat: -27.1, lon: 153.4 },
        ];
        mocks.fetchVoyageAsTrack.mockResolvedValue(legacy('planned-exact', 'Exact historical plan', exact));

        await expect(loadLogbookRouteForEditing('planned-exact', getAuthIdentityScope())).resolves.toEqual({
            voyageId: 'planned-exact',
            name: 'Exact historical plan',
            points: exact,
        });
    });

    it('fails closed when an exact logbook route cannot be loaded', async () => {
        mocks.fetchVoyageAsTrack.mockRejectedValue(new Error('offline'));

        await expect(loadLogbookRouteForEditing('planned-offline', getAuthIdentityScope())).resolves.toBeNull();
    });

    it('deletes only an identity-owned planned compatibility route', async () => {
        const accountA = getAuthIdentityScope();

        await expect(deleteLogbookRouteFromLibrary('planned_old', accountA)).resolves.toBe(true);
        expect(mocks.deleteVoyageLogOnly).toHaveBeenCalledWith('planned_old');

        await expect(deleteLogbookRouteFromLibrary('actual-voyage', accountA)).resolves.toBe(false);
        expect(mocks.deleteVoyageLogOnly).toHaveBeenCalledTimes(1);

        setAuthIdentityScope('account-b');
        await expect(deleteLogbookRouteFromLibrary('planned_private', accountA)).resolves.toBe(false);
        expect(mocks.deleteVoyageLogOnly).toHaveBeenCalledTimes(1);
    });

    it('drops a logbook geometry result when the account changes in flight', async () => {
        let resolveRoute!: (value: RouteOrTrack) => void;
        mocks.fetchVoyageAsTrack.mockReturnValue(
            new Promise((resolve) => {
                resolveRoute = resolve;
            }),
        );
        const accountA = getAuthIdentityScope();
        const loading = loadLogbookRouteForEditing('planned-private', accountA);
        await vi.waitFor(() => expect(mocks.fetchVoyageAsTrack).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        resolveRoute(legacy('planned-private', 'Private A route'));

        await expect(loading).resolves.toBeNull();
    });
});
