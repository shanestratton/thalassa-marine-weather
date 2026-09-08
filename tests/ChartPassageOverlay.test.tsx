/**
 * The chart's "Passage" overlay (Shane 2026-09-09): the current route, its
 * track and the followed route's flag are OFF on the Obs page by default; the
 * punter turns them on from the layer FAB; clearing sticks.
 */
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chart = vi.hoisted(() => ({
    activeVoyage: null as null | { id: string; voyage_name: string; status: string },
    fetchRoutesAndTracks: vi.fn(),
    fetchVoyageAsTrack: vi.fn(),
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => chart.activeVoyage }));
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

const ROUTE = {
    id: 'plan-1',
    label: 'Newport → Whitsundays',
    points: [
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
    ],
};
const TRACK = {
    id: 'voyage-1',
    label: 'track',
    points: [
        { lat: 1, lon: 1 },
        { lat: 1.5, lon: 1.5 },
    ],
};

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
        chart.fetchRoutesAndTracks.mockResolvedValue({ routes: [ROUTE], tracks: [TRACK] });
        chart.fetchVoyageAsTrack.mockResolvedValue(TRACK);
    });
    afterEach(() => vi.useRealTimers());

    it('with the overlay OFF an active voyage puts nothing on the chart', async () => {
        const setRoute = vi.fn();
        const setTrack = vi.fn();
        const view = renderHook(({ on }) => useActiveVoyageChartSync(setRoute, setTrack, on), {
            initialProps: { on: false },
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(view.result.current.activeVoyageMode).toBe(true);
        expect(chart.fetchRoutesAndTracks).not.toHaveBeenCalled();
        expect(setRoute).not.toHaveBeenCalled();
        expect(setTrack).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(120_000);
            await Promise.resolve();
        });
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
    });

    it('turning it ON selects the passage; turning it OFF stops the re-apply for good', async () => {
        const setRoute = vi.fn();
        const setTrack = vi.fn();
        const view = renderHook(({ on }) => useActiveVoyageChartSync(setRoute, setTrack, on), {
            initialProps: { on: true },
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(chart.fetchRoutesAndTracks).toHaveBeenCalledTimes(1);
        expect(setRoute).toHaveBeenCalled();
        expect(setTrack).toHaveBeenCalled();
        setRoute.mockClear();
        setTrack.mockClear();
        view.rerender({ on: false });
        await act(async () => {
            vi.advanceTimersByTime(180_000);
            await Promise.resolve();
        });
        window.dispatchEvent(new Event('thalassa:routes-and-tracks-changed'));
        await act(async () => {
            await Promise.resolve();
        });
        expect(chart.fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(chart.fetchRoutesAndTracks).toHaveBeenCalledTimes(1);
        expect(setRoute).not.toHaveBeenCalled();
        expect(setTrack).not.toHaveBeenCalled();
    });
});

describe('MapHub wiring (source pins)', () => {
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
    it('feeds the overlay into the sync and the flag, offers "Passage" in the layer FAB, and a clear sticks', () => {
        expect(hub).toContain('useActiveVoyageChartSync(setActiveChartRoute, setActiveChartTrack, passageOverlay)');
        expect(hub).toContain(
            'useDestinationFlag(mapRef, mapReady && !planningSurface && passageOverlay, { onTap: () => setStopFollowAsk(true) })',
        );
        expect(hub).toContain("id: 'passage'");
        expect(hub).toContain("label: 'Passage'");
        expect(hub).toContain('enabled: passageOverlay');
        expect(hub.match(/if \(item === null\) setPassageOverlay\(false\);/g)?.length).toBe(2);
    });
});
