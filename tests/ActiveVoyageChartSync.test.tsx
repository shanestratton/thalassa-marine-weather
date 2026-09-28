import { useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';

const world = vi.hoisted(() => ({
    activeVoyage: null as { id: string; status: string; voyage_name: string } | null,
    recording: { isTracking: false, isPaused: false, isRapidMode: false } as TrackingState,
    recordingListeners: new Set<() => void>(),
    fetchRoutesAndTracks: vi.fn(),
    fetchVoyageAsTrack: vi.fn(),
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => world.activeVoyage }));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getPublishedTrackingStatus: () => ({ ...world.recording }),
        onTrackingStateChange: (listener: () => void) => {
            world.recordingListeners.add(listener);
            listener();
            return () => world.recordingListeners.delete(listener);
        },
    },
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: world.fetchRoutesAndTracks,
    fetchVoyageAsTrack: world.fetchVoyageAsTrack,
}));

import { useActiveVoyageChartSync } from '../components/map/mapHub/useActiveVoyageChartSync';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const POINTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -26.8, lon: 153.8 },
    { lat: -23.9, lon: 152.4 },
];
const PLAN: VoyagePlan = {
    origin: 'Newport',
    destination: 'Coral Sea',
    originCoordinates: POINTS[0],
    destinationCoordinates: POINTS[2],
    departureDate: '2026-09-19T00:00:00Z',
    waypoints: [],
    distanceApprox: '200 NM',
    durationApprox: '2 days',
    overview: 'Current route',
};
function item(id: string, points = POINTS): RouteOrTrack {
    return {
        id,
        label: 'Newport → Coral Sea',
        sublabel: '',
        points,
        bbox: [152.4, -27.2, 153.8, -23.9],
        timestamp: 0,
        distanceNm: 200,
        isLocal: false,
        kind: 'sea',
    };
}
function setVoyage(id: string | null) {
    world.recording = { isTracking: !!id, isPaused: false, isRapidMode: false, currentVoyageId: id ?? undefined };
    world.recordingListeners.forEach((listener) => listener());
}
function renderSync(
    enabled = true,
    initialRoute: RouteOrTrack | null = null,
    initialTrack: RouteOrTrack | null = null,
) {
    return renderHook(
        ({ enabled }) => {
            const [route, setRoute] = useState(initialRoute);
            const [track, setTrack] = useState(initialTrack);
            const voyage = useActiveVoyageChartSync(setRoute, setTrack, enabled);
            return { route, setRoute, track, setTrack, ...voyage };
        },
        { initialProps: { enabled } },
    );
}
function deferredTrack() {
    let resolve!: (track: RouteOrTrack | null) => void;
    const promise = new Promise<RouteOrTrack | null>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('chart-skipper');
    useFollowRouteStore.getState().stopFollowing();
    world.activeVoyage = null;
    setVoyage(null);
    world.fetchRoutesAndTracks.mockReset().mockResolvedValue({ routes: [item('stale-same-name')], tracks: [] });
    world.fetchVoyageAsTrack.mockReset().mockResolvedValue(null);
});
afterEach(() => {
    cleanup();
    useFollowRouteStore.getState().stopFollowing();
    vi.useRealTimers();
});

describe('Passage chart route authority', () => {
    it('draws the exact sanitized followed curve before a named voyage exists', () => {
        useFollowRouteStore
            .getState()
            .startFollowing(PLAN, 'planned-log-route', [
                POINTS[0],
                POINTS[0],
                { lat: Number.NaN, lon: 153 },
                ...POINTS.slice(1),
            ]);
        const { result } = renderSync();

        expect(result.current.activeVoyageMode).toBe(false);
        expect(result.current.route?.id).toBe('planned-log-route');
        expect(result.current.route?.points).toBe(useFollowRouteStore.getState().routeCoords);
        expect(result.current.route?.points).toEqual(POINTS);
        expect(result.current.route?.bbox).toEqual([152.4, -27.2, 153.8, -23.9]);
        expect(world.fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(world.fetchVoyageAsTrack).not.toHaveBeenCalled();
    });

    it('never selects a same-name saved route, including after stopping follow and refreshing the log', async () => {
        setVoyage('recording-voyage');
        useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', POINTS);
        const { result } = renderSync();
        expect(world.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(result.current.route?.id).toBe('planned-log-route');
        expect(result.current.track).toBeNull();

        act(() => useFollowRouteStore.getState().stopFollowing());
        expect(result.current.route).toBeNull();
        await waitFor(() => expect(world.fetchVoyageAsTrack).toHaveBeenCalledWith('recording-voyage'));
        await act(async () => window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed')));
        expect(result.current.route).toBeNull();
        expect(world.fetchRoutesAndTracks).not.toHaveBeenCalled();
    });

    it('replaces or reverses a follow with the same id and point count without retaining the previous line', () => {
        useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', POINTS);
        const { result } = renderSync();
        const original = result.current.route;
        const replaced = [POINTS[0], { lat: -25.8, lon: 154.3 }, POINTS[2]];
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', replaced));
        expect(result.current.route).not.toBe(original);
        expect(result.current.route?.points).toEqual(replaced);

        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', [...replaced].reverse()));
        expect(result.current.route?.points).toEqual([...replaced].reverse());
    });

    it('keeps the selected follow independent of the recording voyage lifecycle', async () => {
        setVoyage('recording-a');
        useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', POINTS);
        const { result } = renderSync();
        const route = result.current.route;
        await act(async () => setVoyage('recording-b'));
        expect(result.current.route).toBe(route);
        await act(async () => setVoyage(null));
        expect(result.current.route).toBe(route);
    });

    it('clears owned selections on disable while preserving manual choices, even with the same id', async () => {
        const manualRoute = item('planned-log-route', [...POINTS].reverse());
        const manualTrack = item('manual-track');
        const { result, rerender } = renderSync(false, manualRoute, manualTrack);
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'planned-log-route', POINTS));
        await act(async () => setVoyage('recording-a'));
        expect(result.current.route).toBe(manualRoute);
        expect(result.current.track).toBe(manualTrack);
        expect(world.fetchVoyageAsTrack).not.toHaveBeenCalled();

        rerender({ enabled: true });
        expect(result.current.route?.points).toEqual(POINTS);
        rerender({ enabled: false });
        expect(result.current.route).toBeNull();

        rerender({ enabled: true });
        act(() => {
            result.current.setRoute(manualRoute);
            result.current.setTrack(manualTrack);
        });
        rerender({ enabled: false });
        act(() => useFollowRouteStore.getState().stopFollowing());
        await act(async () => setVoyage(null));
        expect(result.current.route).toBe(manualRoute);
        expect(result.current.track).toBe(manualTrack);
    });

    it('clears the previous account follow and uses only the new account geometry', () => {
        useFollowRouteStore.getState().startFollowing(PLAN, 'planned-a', POINTS);
        const { result } = renderSync();
        act(() => setAuthIdentityScope('chart-other-skipper'));
        expect(result.current.route).toBeNull();
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'planned-b', [...POINTS].reverse()));
        expect(result.current.route?.id).toBe('planned-b');
        expect(result.current.route?.points).toEqual([...POINTS].reverse());
    });
});

describe('Passage chart sailed track', () => {
    it('replaces a track with the followed route and rejects a late trail response', async () => {
        setVoyage('recording-a');
        const pending = deferredTrack();
        world.fetchVoyageAsTrack.mockReturnValueOnce(pending.promise);
        const { result } = renderSync();
        await waitFor(() => expect(world.fetchVoyageAsTrack).toHaveBeenCalledOnce());
        act(() => useFollowRouteStore.getState().startFollowing(PLAN, 'followed', POINTS));
        await act(async () => pending.resolve(item('recording-a')));
        expect(result.current.route?.id).toBe('followed');
        expect(result.current.track).toBeNull();
        world.fetchVoyageAsTrack.mockResolvedValue(item('recording-a'));
        act(() => useFollowRouteStore.getState().stopFollowing());
        await waitFor(() => expect(result.current.track?.id).toBe('recording-a'));
        expect(result.current.route).toBeNull();
    });

    it('uses the actual casual recording without falling back to a cached named passage or route', async () => {
        world.activeVoyage = { id: 'old-named-passage', status: 'active', voyage_name: 'Old passage' };
        setVoyage('just-recording');
        world.fetchVoyageAsTrack.mockResolvedValue(item('just-recording'));
        const { result } = renderSync();
        await waitFor(() => expect(result.current.track?.id).toBe('just-recording'));
        expect(result.current.route).toBeNull();
        expect(result.current.activeVoyageId).toBe('just-recording');
        expect(world.fetchVoyageAsTrack).toHaveBeenCalledExactlyOnceWith('just-recording');
    });

    it('keeps same-recording trail through pause and resume while fresh data is unavailable', async () => {
        setVoyage('recording-a');
        const original = item('recording-a');
        world.fetchVoyageAsTrack.mockResolvedValue(original);
        const { result } = renderSync();
        await waitFor(() => expect(result.current.track).toBe(original));
        world.fetchVoyageAsTrack.mockResolvedValue(null);
        act(() => {
            world.recording = { ...world.recording, isTracking: false, isPaused: true };
            world.recordingListeners.forEach((listener) => listener());
        });
        expect(result.current.track).toBe(original);
        expect(result.current.activeVoyageMode).toBe(false);
        expect(result.current.hasRecording).toBe(true);
        act(() => setVoyage('recording-a'));
        expect(result.current.track).toBe(original);
        expect(result.current.activeVoyageMode).toBe(true);
        expect(world.fetchVoyageAsTrack).toHaveBeenCalledTimes(1);
    });

    it('retains the current recording trail when a refresh fails', async () => {
        setVoyage('recording-a');
        const original = item('recording-a');
        world.fetchVoyageAsTrack.mockResolvedValue(original);
        const { result } = renderSync();
        await waitFor(() => expect(result.current.track).toBe(original));
        world.fetchVoyageAsTrack.mockRejectedValueOnce(new Error('Temporarily offline'));
        await act(async () => window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed')));
        expect(result.current.track).toBe(original);
    });

    it('refreshes only the active recording on the minute and log changes, preserving unchanged selections', async () => {
        vi.useFakeTimers();
        setVoyage('recording-a');
        const original = item('recording-a');
        world.fetchVoyageAsTrack.mockResolvedValue(original);
        const { result, rerender } = renderSync();
        await act(async () => {});
        expect(result.current.track).toBe(original);

        world.fetchVoyageAsTrack.mockResolvedValue({ ...original, points: [...original.points] });
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(result.current.track).toBe(original);
        const grown = item('recording-a', [...POINTS, { lat: -23.7, lon: 152.2 }]);
        world.fetchVoyageAsTrack.mockResolvedValue(grown);
        await act(async () => window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed')));
        expect(result.current.track).toBe(grown);
        expect(world.fetchVoyageAsTrack).toHaveBeenCalledTimes(3);
        expect(world.fetchRoutesAndTracks).not.toHaveBeenCalled();

        world.fetchVoyageAsTrack.mockResolvedValue(null);
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(result.current.track).toBe(grown);

        rerender({ enabled: false });
        expect(result.current.track).toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        expect(world.fetchVoyageAsTrack).toHaveBeenCalledTimes(4);
    });

    it('clears the old voyage track immediately and rejects its pending refresh after a voyage switch', async () => {
        setVoyage('recording-a');
        world.fetchVoyageAsTrack.mockResolvedValue(item('recording-a'));
        const { result } = renderSync();
        await waitFor(() => expect(result.current.track?.id).toBe('recording-a'));
        const oldRefresh = deferredTrack();
        world.fetchVoyageAsTrack.mockReturnValueOnce(oldRefresh.promise);
        await act(async () => window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed')));
        const newVoyage = deferredTrack();
        world.fetchVoyageAsTrack.mockReturnValueOnce(newVoyage.promise);
        await act(async () => setVoyage('recording-b'));
        expect(result.current.track).toBeNull();
        await act(async () => oldRefresh.resolve(item('recording-a')));
        expect(result.current.track).toBeNull();
        await act(async () => newVoyage.resolve(item('recording-b')));
        expect(result.current.track?.id).toBe('recording-b');
        await act(async () => setVoyage(null));
        expect(result.current.track).toBeNull();
    });

    it('rejects a previous account response even when the cached active voyage id has not changed', async () => {
        setVoyage('recording-a');
        const previousAccount = deferredTrack();
        world.fetchVoyageAsTrack.mockReturnValueOnce(previousAccount.promise);
        const { result } = renderSync();
        await waitFor(() => expect(world.fetchVoyageAsTrack).toHaveBeenCalledTimes(1));
        await act(async () => setAuthIdentityScope('chart-other-skipper'));
        await act(async () => previousAccount.resolve(item('recording-a')));
        expect(result.current.track).toBeNull();
    });
});
