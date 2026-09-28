/**
 * The chart's "Passage" overlay (Shane 2026-09-09): the current route, its
 * track and the followed route's flag are OFF on the Obs page by default; the
 * punter turns them on from the layer FAB; clearing sticks.
 */
import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';

const chart = vi.hoisted(() => ({
    activeVoyage: null as null | { id: string; voyage_name: string; status: string },
    recording: { isTracking: false, isPaused: false, isRapidMode: false } as TrackingState,
    fetchRoutesAndTracks: vi.fn(),
    fetchVoyageAsTrack: vi.fn(),
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => chart.activeVoyage }));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getPublishedTrackingStatus: () => ({ ...chart.recording }),
        onTrackingStateChange: (listener: () => void) => {
            listener();
            return () => undefined;
        },
    },
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: chart.fetchRoutesAndTracks,
    fetchVoyageAsTrack: chart.fetchVoyageAsTrack,
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
    __resetPassageOverlayForTests,
    isPassageOverlayOn,
    setPassageOverlay,
    usePassageOverlay,
} from '../stores/chartPassageOverlay';
import { useActiveVoyageChartSync } from '../components/map/mapHub/useActiveVoyageChartSync';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';

const ROUTE: RouteOrTrack = {
    id: 'plan-1',
    label: 'Newport → Whitsundays',
    sublabel: '',
    points: [
        { lat: 1, lon: 1 },
        { lat: 1.2, lon: 1.8 },
        { lat: 2, lon: 2 },
    ],
    bbox: [1, 1, 2, 2],
    timestamp: 0,
    distanceNm: 100,
    isLocal: true,
    kind: 'sea',
};
const TRACK: RouteOrTrack = {
    ...ROUTE,
    id: 'voyage-1',
    label: 'track',
    points: [
        { lat: 1, lon: 1 },
        { lat: 1.5, lon: 1.5 },
    ],
};

function useChartSelection(on: boolean) {
    const [route, setRoute] = useState<RouteOrTrack | null>(null);
    const [track, setTrack] = useState<RouteOrTrack | null>(null);
    const voyage = useActiveVoyageChartSync(setRoute, setTrack, on);
    return { route, track, ...voyage };
}

describe('passage overlay preference', () => {
    beforeEach(() => {
        localStorage.clear();
        __resetPassageOverlayForTests();
    });

    it('is off by default and remembered on the device once turned on', () => {
        expect(isPassageOverlayOn()).toBe(false);
        const { result } = renderHook(() => usePassageOverlay());
        expect(result.current).toBe(false);
        act(() => setPassageOverlay(true));
        expect(result.current).toBe(true);
        expect(localStorage.getItem('thalassa_chart_passage_overlay_v1')).toBe('1');
        act(() => setPassageOverlay(false));
        expect(result.current).toBe(false);
        expect(localStorage.getItem('thalassa_chart_passage_overlay_v1')).toBeNull();
    });
});

describe('active voyage chart sync — opt-in', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        localStorage.clear();
        __resetPassageOverlayForTests();
        chart.activeVoyage = { id: 'voyage-1', voyage_name: 'Newport → Whitsundays', status: 'active' };
        chart.recording = {
            isTracking: true,
            isPaused: false,
            isRapidMode: false,
            currentVoyageId: 'voyage-1',
        };
        chart.fetchRoutesAndTracks.mockResolvedValue({ routes: [ROUTE], tracks: [TRACK] });
        chart.fetchVoyageAsTrack.mockResolvedValue(TRACK);
        useFollowRouteStore.getState().startFollowing(buildFollowRoutePlanFromRoute(ROUTE)!, ROUTE.id, ROUTE.points);
    });
    afterEach(() => {
        cleanup();
        useFollowRouteStore.getState().stopFollowing();
        vi.useRealTimers();
    });

    it('with the overlay OFF an active voyage puts nothing on the chart', async () => {
        const view = renderHook(({ on }) => useChartSelection(on), {
            initialProps: { on: false },
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(view.result.current.activeVoyageMode).toBe(true);
        expect(chart.fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(view.result.current.route).toBeNull();
        expect(view.result.current.track).toBeNull();
        await act(async () => {
            vi.advanceTimersByTime(120_000);
            await Promise.resolve();
        });
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(view.result.current.route).toBeNull();
        expect(view.result.current.track).toBeNull();
    });

    it('turning it ON selects the passage; turning it OFF stops the re-apply for good', async () => {
        const view = renderHook(({ on }) => useChartSelection(on), {
            initialProps: { on: false },
        });
        view.rerender({ on: true });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(chart.fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(view.result.current.route?.points).toBe(useFollowRouteStore.getState().routeCoords);
        expect(view.result.current.route?.points).toEqual(ROUTE.points);
        expect(view.result.current.track).toBeNull();
        view.rerender({ on: false });
        expect(view.result.current.route).toBeNull();
        expect(view.result.current.track).toBeNull();
        await act(async () => {
            vi.advanceTimersByTime(180_000);
            await Promise.resolve();
        });
        await act(async () => {
            window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed'));
            await Promise.resolve();
        });
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(chart.fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(view.result.current.route).toBeNull();
        expect(view.result.current.track).toBeNull();
    });

    it('does not revive an old cached passage trail when no recording is active', async () => {
        chart.recording = { isTracking: false, isPaused: false, isRapidMode: false };
        useFollowRouteStore.getState().stopFollowing();
        const view = renderHook(() => useChartSelection(true));
        await act(async () => {
            vi.advanceTimersByTime(120_000);
            window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed'));
            await Promise.resolve();
        });
        expect(chart.activeVoyage?.status).toBe('active');
        expect(view.result.current.activeVoyageMode).toBe(false);
        expect(view.result.current.route).toBeNull();
        expect(view.result.current.track).toBeNull();
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(chart.fetchRoutesAndTracks).not.toHaveBeenCalled();
    });
});

describe('MapHub wiring (source pins)', () => {
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
    it('feeds the overlay into the sync and the flag, offers "Passage" in the layer FAB, and a clear sticks', () => {
        expect(hub).toMatch(
            /useActiveVoyageChartSync\(\s*setActiveChartRoute,\s*setActiveChartTrack,\s*passageOverlay,?\s*\)/,
        );
        expect(hub).toContain(
            'useDestinationFlag(mapRef, mapReady && !planningSurface && passageOverlay, { onTap: () => setStopFollowAsk(true) })',
        );
        expect(hub).toContain("id: 'passage'");
        expect(hub).toContain("label: 'Passage'");
        expect(hub).toContain('enabled: passageOverlay');
        expect(hub).toMatch(/const passageOverviewAvailable =\s*passageHudOnChart &&\s*passageOverlay &&/);
        expect(hub).toMatch(
            /setActiveChartRoute\(item\);\s*if \(item\) setActiveChartTrack\(null\);[\s\S]*?setPassageOverlay\(false\);/,
        );
        expect(hub).toMatch(
            /setActiveChartTrack\(item\);\s*if \(item\) setActiveChartRoute\(null\);\s*setPassageOverlay\(false\);/,
        );
    });
});
