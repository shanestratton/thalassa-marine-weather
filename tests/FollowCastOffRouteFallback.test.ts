/**
 * followCastOffRoute — a JUST-cast-off passage has no ship-log entries yet
 * (GPS is still warming up), so the auto-follow must fall back to the saved
 * trace itself instead of silently bailing. The silent bail was the Log
 * page's "which passage are you doing?" sheet appearing seconds after
 * casting off from the passage that IS the answer (Shane 2026-08-26).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchVoyageAsTrack: vi.fn(),
    loadSavedTraces: vi.fn(),
    blockReason: vi.fn(() => null as string | null),
    startFollowing: vi.fn(),
    publishFollowedRoute: vi.fn(() => Promise.resolve('linked')),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({ fetchVoyageAsTrack: mocks.fetchVoyageAsTrack }));
vi.mock('../services/routeTracer', () => ({
    loadSavedTraces: mocks.loadSavedTraces,
    displayRouteLabel: (t: { name: string }) => t.name,
}));
vi.mock('../services/traceDirectUseGate', () => ({
    tracedRouteDirectUseBlockReason: mocks.blockReason,
    tracedRouteFollowGeometry: (r: unknown) => r,
}));
vi.mock('../services/shiplog/publishFollowedRoute', () => ({ publishFollowedRoute: mocks.publishFollowedRoute }));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: { getState: () => ({ startFollowing: mocks.startFollowing }) },
}));

import { followCastOffRoute } from '../services/shiplog/followCastOffRoute';

const tracePoints = [
    { lat: -27.05, lon: 153.1 },
    { lat: -26.8, lon: 153.15 },
];

describe('followCastOffRoute', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.blockReason.mockReturnValue(null);
    });

    it('falls back to the saved trace when the voyage has no log entries yet', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            { id: 'route-1', name: 'Newport → Mooloolaba', createdAt: '2026-08-20T00:00:00Z', points: tracePoints },
        ]);

        expect(await followCastOffRoute('voyage-1', 'route-1')).toBe(true);
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
        const [plan, voyageId, coords] = mocks.startFollowing.mock.calls[0];
        expect(voyageId).toBe('voyage-1');
        expect(coords).toEqual(tracePoints);
        expect(plan).toBeTruthy();
        expect(mocks.publishFollowedRoute).toHaveBeenCalledWith('voyage-1');
    });

    it('still refuses when the gate blocks — an unverified line never auto-follows', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            { id: 'route-1', name: 'Newport → Mooloolaba', createdAt: '2026-08-20T00:00:00Z', points: tracePoints },
        ]);
        mocks.blockReason.mockReturnValue('not verified');

        expect(await followCastOffRoute('voyage-1', 'route-1')).toBe(false);
        expect(mocks.startFollowing).not.toHaveBeenCalled();
    });

    it('returns false with no saved route link and no log entries', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([]);
        expect(await followCastOffRoute('voyage-1', null)).toBe(false);
        expect(mocks.startFollowing).not.toHaveBeenCalled();
    });
});
