import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { ShipLogEntry } from '../types/navigation';
const reads = vi.hoisted(() => ({ entries: vi.fn(), pending: vi.fn(), community: vi.fn() }));
const vessel = vi.hoisted(() => {
    let state = { activeVesselId: 'a' };
    const listeners = new Set<(n: typeof state, p: typeof state) => void>();
    return {
        getState: () => state,
        subscribe: (fn: (n: typeof state, p: typeof state) => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        set: (id: string) => {
            const p = state;
            state = { activeVesselId: id };
            for (const fn of listeners) fn(state, p);
        },
    };
});
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: vessel }));
vi.mock('../services/shiplog/EntryCrud', () => ({ getLogEntries: reads.entries }));
vi.mock('../services/shiplog/OfflineQueue', () => ({ getOfflineEntries: reads.pending }));
vi.mock('../services/communityRoutes', () => ({ communityLanesNear: reads.community }));
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    collectTrackRoutingPriors,
    ownTrackPriorFragments,
    trackPriorContextKey,
} from '../services/routing/trackRoutingPriors';
const e = (i: number, patch: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
    id: String(i),
    userId: 'owner',
    voyageId: 'voyage',
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    latitude: -27 + i * 0.0001,
    longitude: 153,
    positionFormatted: '',
    entryType: 'auto',
    source: 'device',
    isOnWater: true,
    ...patch,
});
beforeEach(() => {
    setAuthIdentityScope('owner');
    vessel.set('a');
    reads.entries.mockReset().mockResolvedValue([e(0), e(1)]);
    reads.pending.mockReset().mockResolvedValue([]);
    reads.community.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
describe('private own corridors and the APPROVED-only lane boundary', () => {
    it('splits gaps and excludes foreign, imported, land and planned geometry', () => {
        const input = [
            e(0),
            e(1),
            e(2, { userId: 'foreign' }),
            e(20),
            e(21),
            e(22, { source: 'community_download' }),
            e(23),
            e(24),
            e(25, { isOnWater: false }),
            e(26),
            e(27),
            e(28, { source: 'planned_route' }),
            e(29),
            e(30),
        ];
        const priors = ownTrackPriorFragments(input, 'owner');
        expect(priors.length).toBe(5);
        expect(priors.every((p) => p.source === 'own-track' && p.points.length === 2)).toBe(true);
        expect(priors[0].points.at(-1)!.lat).toBe(e(1).latitude);
        expect(priors[1].points[0].lat).toBe(e(20).latitude);
    });
    it('uses bounded own history and only the existing approved-lane consumer, without lane authors or chart facts', async () => {
        reads.community.mockResolvedValue([
            {
                id: 'community-x',
                name: 'ignored author/name',
                points: [
                    { lat: -27, lon: 153 },
                    { lat: -27.001, lon: 153 },
                ],
                draftM: 9,
            },
        ]);
        const priors = await collectTrackRoutingPriors(
            { lat: -27, lon: 153 },
            { lat: -27.001, lon: 153 },
            new AbortController().signal,
            trackPriorContextKey(),
        );
        expect(reads.entries).toHaveBeenCalledWith(2000);
        expect(reads.community).toHaveBeenCalledWith(expect.any(Array), { fresh: true });
        expect(priors.map((p) => p.source)).toEqual(['own-track', 'approved-community']);
        expect(priors[1]).toEqual({
            source: 'approved-community',
            approval: 'approved',
            points: [
                { lat: -27, lon: 153 },
                { lat: -27.001, lon: 153 },
            ],
        });
    });
    it.each(['account', 'vessel'])('drops all late private hints after %s A/B/A', async (kind) => {
        reads.entries.mockImplementation(async () => {
            if (kind === 'account') {
                setAuthIdentityScope('b');
                setAuthIdentityScope('owner');
            } else {
                vessel.set('b');
                vessel.set('a');
            }
            return [e(0), e(1)];
        });
        expect(
            await collectTrackRoutingPriors(
                { lat: -27, lon: 153 },
                { lat: -27.001, lon: 153 },
                new AbortController().signal,
                trackPriorContextKey(),
            ),
        ).toEqual([]);
    });
    it('missing or slow optional sources cannot stall ordinary routing beyond two seconds', async () => {
        vi.useFakeTimers();
        reads.entries.mockReturnValue(new Promise(() => {}));
        const result = collectTrackRoutingPriors(
            { lat: -27, lon: 153 },
            { lat: -27.001, lon: 153 },
            new AbortController().signal,
            trackPriorContextKey(),
        );
        await vi.advanceTimersByTimeAsync(2000);
        expect(await result).toEqual([]);
    });
});
