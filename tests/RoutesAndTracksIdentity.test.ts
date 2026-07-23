import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getLogEntries: vi.fn(),
    getOfflineEntries: vi.fn(),
    getVoyageSummaries: vi.fn(),
    getVoyageEntries: vi.fn(),
}));

vi.mock('../services/shiplog/EntryCrud', () => ({
    getLogEntries: (...args: unknown[]) => mocks.getLogEntries(...args),
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    getOfflineEntries: (...args: unknown[]) => mocks.getOfflineEntries(...args),
}));
vi.mock('../services/shiplog/VoyageSummary', () => ({
    getVoyageSummaries: (...args: unknown[]) => mocks.getVoyageSummaries(...args),
    getVoyageEntries: (...args: unknown[]) => mocks.getVoyageEntries(...args),
    isLandVoyage: () => false,
}));
vi.mock('../services/shiplog/PassagePlanSave', () => ({
    ROUTE_GEOMETRY_NOTES_PREFIX: '__route_geometry__::',
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    fetchRoutesAndTracks,
    fetchSeaVoyageChoices,
    fetchVoyageAsTrack,
    loadVoyageTrackPoints,
} from '../services/shiplog/RoutesAndTracks';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function plannedEntries(owner: string, voyageId: string) {
    return [
        {
            id: `${owner}-1`,
            userId: owner,
            voyageId,
            timestamp: '2026-07-23T00:00:00.000Z',
            latitude: -27.4,
            longitude: 153,
            entryType: 'auto',
            source: 'planned_route',
            waypointName: `${owner} departure`,
            isOnWater: true,
        },
        {
            id: `${owner}-2`,
            userId: owner,
            voyageId,
            timestamp: '2026-07-23T01:00:00.000Z',
            latitude: -27.5,
            longitude: 153.1,
            entryType: 'auto',
            source: 'planned_route',
            waypointName: `${owner} arrival`,
            isOnWater: true,
        },
    ];
}

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    mocks.getLogEntries.mockResolvedValue([]);
    mocks.getOfflineEntries.mockResolvedValue([]);
    mocks.getVoyageSummaries.mockResolvedValue([]);
    mocks.getVoyageEntries.mockResolvedValue([]);
});

describe('RoutesAndTracks identity isolation', () => {
    it('separates A/B inflight and cache state, and A finally cannot clear B', async () => {
        const cloudA = deferred<ReturnType<typeof plannedEntries>>();
        mocks.getLogEntries
            .mockReturnValueOnce(cloudA.promise)
            .mockResolvedValueOnce(plannedEntries('account-b', 'planned_b'));

        const requestA = fetchRoutesAndTracks(true);
        await vi.waitFor(() => expect(mocks.getLogEntries).toHaveBeenCalledTimes(1));
        setAuthIdentityScope('account-b');

        const resultB = await fetchRoutesAndTracks();
        expect(resultB.routes.map((route) => route.id)).toEqual(['planned_b']);

        cloudA.resolve(plannedEntries('account-a', 'planned_a'));
        await expect(requestA).resolves.toEqual({ routes: [], tracks: [] });
        const cachedB = await fetchRoutesAndTracks();
        expect(cachedB.routes.map((route) => route.id)).toEqual(['planned_b']);
        expect(mocks.getLogEntries).toHaveBeenCalledTimes(2);
    });

    it('discards deferred A voyage choices', async () => {
        const summariesA = deferred<
            Array<{
                voyageId: string;
                isPlannedRoute: boolean;
                entryCount: number;
                startedAt: string;
                totalDistanceNM: number;
            }>
        >();
        mocks.getVoyageSummaries.mockReturnValueOnce(summariesA.promise);
        const request = fetchSeaVoyageChoices();
        setAuthIdentityScope('account-b');
        summariesA.resolve([
            {
                voyageId: 'voyage-a',
                isPlannedRoute: false,
                entryCount: 2,
                startedAt: '2026-07-23T00:00:00.000Z',
                totalDistanceNM: 5,
            },
        ]);
        await expect(request).resolves.toEqual([]);
    });

    it('discards a deferred A one-voyage track load', async () => {
        const voyageA = deferred<ReturnType<typeof plannedEntries>>();
        mocks.getVoyageEntries.mockReturnValueOnce(voyageA.promise);
        const request = fetchVoyageAsTrack('planned_a');
        setAuthIdentityScope('account-b');
        voyageA.resolve(plannedEntries('account-a', 'planned_a'));
        await expect(request).resolves.toBeNull();
    });

    it('discards deferred A point loads before falling through to B cloud data', async () => {
        const offlineA = deferred<ReturnType<typeof plannedEntries>>();
        mocks.getOfflineEntries.mockReturnValueOnce(offlineA.promise);
        const request = loadVoyageTrackPoints('planned_a');
        setAuthIdentityScope('account-b');
        offlineA.resolve(plannedEntries('account-a', 'planned_a'));
        await expect(request).resolves.toEqual([]);
        expect(mocks.getVoyageEntries).not.toHaveBeenCalled();
    });
});
