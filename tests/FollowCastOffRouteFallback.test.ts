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
    status: vi.fn(
        (): {
            tone: 'checked' | 'unchecked' | 'finding';
            code: string;
            reason: string | null;
            blocked: boolean;
        } => ({
            tone: 'checked',
            code: 'ok',
            reason: null,
            blocked: false,
        }),
    ),
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
    tracedRouteDirectUseStatus: mocks.status,
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
        mocks.status.mockReturnValue({ tone: 'checked', code: 'ok', reason: null, blocked: false });
    });

    it('falls back to the saved trace when the voyage has no log entries yet', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            {
                id: 'route-1',
                name: 'Newport → Mooloolaba',
                createdAt: '2026-08-20T00:00:00Z',
                points: tracePoints,
                plannedRouteId: 'planned-1',
            },
        ]);

        expect(await followCastOffRoute('voyage-1', 'route-1')).toEqual({ note: null, caution: null });
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
        const [plan, voyageId, coords] = mocks.startFollowing.mock.calls[0];
        expect(voyageId).toBe('voyage-1');
        expect(coords).toEqual(tracePoints);
        expect(plan).toBeTruthy();
        // The public page draws plan lines from the planned-route MIRROR
        // voyage, never the cast-off voyage itself.
        expect(mocks.publishFollowedRoute).toHaveBeenCalledWith('planned-1');
    });

    // Cast Off is advisory (no new hard gates): an unchecked or even a red
    // route is still the passage's own line, so it is followed and the
    // reason rides along as a caution on the passage (build 124).
    it('follows an unchecked (amber) route and returns the reason as a caution', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            {
                id: 'route-1',
                name: 'Cowes → Lymington',
                createdAt: '2026-08-20T00:00:00Z',
                points: tracePoints,
                plannedRouteId: 'planned-1',
            },
        ]);
        mocks.status.mockReturnValue({ tone: 'unchecked', code: 'aged', reason: 'Last checked 4 Sep', blocked: false });

        expect(await followCastOffRoute('voyage-1', 'route-1')).toEqual({
            note: null,
            // The code rides along so the card's title can say "check out of
            // date" rather than "not checked yet" over a route that WAS checked.
            caution: { tone: 'unchecked', text: 'Last checked 4 Sep', code: 'aged' },
        });
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
        expect(mocks.publishFollowedRoute).toHaveBeenCalledWith('planned-1');
    });

    it('follows a red route too, with a red caution naming the pins', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            { id: 'route-1', name: 'Nouméa → Îlot Maître', createdAt: '2026-08-20T00:00:00Z', points: tracePoints },
        ]);
        mocks.status.mockReturnValue({
            tone: 'finding',
            code: 'finding',
            reason: 'Pins 14→15: crosses charted land',
            blocked: true,
        });

        expect(await followCastOffRoute('voyage-1', 'route-1')).toEqual({
            note: null,
            caution: { tone: 'finding', text: 'Pins 14→15: crosses charted land', code: 'finding' },
        });
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
        // The red is accepted by the deliberate act of casting off, not ignored.
        expect(mocks.status).toHaveBeenCalledWith(expect.anything(), { acceptFinding: true });
    });

    it('opting out of the public page skips the publish but still follows locally', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            {
                id: 'route-1',
                name: 'Newport → Mooloolaba',
                createdAt: '2026-08-20T00:00:00Z',
                points: tracePoints,
                plannedRouteId: 'planned-1',
            },
        ]);

        expect(await followCastOffRoute('voyage-1', 'route-1', false)).toEqual({ note: null, caution: null });
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
        expect(mocks.publishFollowedRoute).not.toHaveBeenCalled();
    });

    // A legacy voyage row with no link columns matches its trace by NAME only.
    // That is a weak link, and since build 124 the gate no longer refuses an
    // unchecked line — so the name path demands a checked route, or an
    // unrelated unchecked line would be drawn on the chart and public page.
    it('a name-only match follows a CHECKED route', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            { id: 'route-9', name: 'Lymington → Yarmouth', createdAt: '2026-08-20T00:00:00Z', points: tracePoints },
        ]);
        expect(await followCastOffRoute('voyage-legacy', null, true, 'Lymington → Yarmouth')).toEqual({
            note: null,
            caution: null,
        });
        expect(mocks.startFollowing).toHaveBeenCalledTimes(1);
    });

    it('a name-only match to an UNCHECKED route is not followed or published — it says why', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([
            {
                id: 'route-9',
                name: 'Lymington → Yarmouth',
                createdAt: '2026-08-20T00:00:00Z',
                points: tracePoints,
                plannedRouteId: 'planned-9',
            },
        ]);
        mocks.status.mockReturnValue({ tone: 'unchecked', code: 'none', reason: 'Not checked yet', blocked: false });
        const outcome = await followCastOffRoute('voyage-legacy', null, true, 'Lymington → Yarmouth');
        expect(outcome.caution).toBeNull();
        expect(outcome.note).toMatch(/isn’t checked/);
        expect(mocks.startFollowing).not.toHaveBeenCalled();
        expect(mocks.publishFollowedRoute).not.toHaveBeenCalled();
    });

    it('returns false with no saved route link and no log entries', async () => {
        mocks.fetchVoyageAsTrack.mockResolvedValue(null);
        mocks.loadSavedTraces.mockReturnValue([]);
        const outcome = await followCastOffRoute('voyage-1', null);
        expect(outcome.note).toMatch(/no linked saved route/i);
        expect(outcome.caution).toBeNull();
        expect(mocks.startFollowing).not.toHaveBeenCalled();
    });
});
