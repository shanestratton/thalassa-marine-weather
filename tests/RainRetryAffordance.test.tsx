import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import { useUIStore } from '../stores/uiStore';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

/**
 * When the radar index fetch fails the scrubber has nothing to scrub, and the
 * control used to render one anyway with the word "Retry" printed under "No
 * Data" — over handlers that were never assigned in that branch. Tapping it
 * did nothing. Recovery was real but lived entirely in a 60-second self-heal
 * timer, so a skipper who lost radar could press that word repeatedly and
 * watch a full minute pass with no response.
 *
 * These tests hold the affordance to its promise.
 */
function weather(overrides: Record<string, unknown> = {}): WeatherControlsWeather {
    return {
        activeLayers: new Set(['rain']),
        rainReady: false,
        rainLoading: false,
        rainImageLoading: false,
        rainFrameCount: 0,
        rainFrameIndex: 0,
        rainPlaying: false,
        rainNowIdxRef: { current: 0 },
        unifiedFramesRef: { current: [] },
        retryRain: vi.fn(),
        ...overrides,
    } as unknown as WeatherControlsWeather;
}

function renderControls(w: WeatherControlsWeather) {
    return render(
        <MapWeatherControls
            weather={w}
            visible={true}
            embedded={false}
            controlsHidden={false}
            onControlsHiddenChange={vi.fn()}
        />,
    );
}

afterEach(() => {
    cleanup();
    useUIStore.setState({ isOffline: false });
});

describe('rain retry affordance', () => {
    it('offers a tappable retry when there are no frames', () => {
        const w = weather();
        renderControls(w);

        const button = screen.getByRole('button', { name: /retry/i });
        fireEvent.click(button);

        expect(w.retryRain).toHaveBeenCalledTimes(1);
    });

    it('does not advertise retry while the fetch is still running', () => {
        renderControls(weather({ rainLoading: true }));

        // A spinner is the honest answer mid-fetch; inviting a retry here
        // would just stack a second request on top of the live one.
        expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    });

    it('does not advertise retry once frames have arrived', () => {
        renderControls(
            weather({
                rainReady: true,
                rainFrameCount: 3,
                unifiedFramesRef: {
                    current: [
                        { label: '-20m', type: 'radar' },
                        { label: 'Now', type: 'radar' },
                        { label: '+30m', type: 'forecast' },
                    ],
                },
            }),
        );

        expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    });

    // A skipper offshore needs to know whether the app is broken or the link
    // is. Radar is WAN-only, and on a boat "connected" usually means connected
    // to the vessel's own LAN with the uplink down, so the bare label is
    // actively unhelpful in the exact situation it appears in.
    it('names the link as the cause when there is no WAN', () => {
        useUIStore.setState({ isOffline: true });
        renderControls(weather());

        expect(screen.getByText(/no internet/i)).toBeTruthy();
    });

    it('does not blame the link when the device is online', () => {
        useUIStore.setState({ isOffline: false });
        renderControls(weather());

        expect(screen.queryByText(/no internet/i)).toBeNull();
        expect(screen.getByText(/tap to retry/i)).toBeTruthy();
    });

    it('still offers the retry while offline — the probe can be stale', () => {
        useUIStore.setState({ isOffline: true });
        const w = weather();
        renderControls(w);

        // The WAN probe runs every 2 min (30 s after a failure), so it can lag
        // reality by a long way on a boat drifting back into cell range.
        // Refusing the tap would strand the skipper behind a stale flag.
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(w.retryRain).toHaveBeenCalledTimes(1);
    });

    it('routes the retry through the session cleanup, not a bare frame clear', () => {
        const src = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        const body = src.slice(
            src.indexOf('const retryRain = useCallback'),
            src.indexOf('const retryRain = useCallback') + 600,
        );

        // Cleanup aborts the in-flight fetch AND removes the radar-*/
        // rainbow-fc-* layers. Skipping it would leave the previous session's
        // tiles painted under a freshly-built timeline.
        expect(body).toContain('rainCleanupRef.current?.()');

        // Cleanup empties the frame array, which is what actually re-arms the
        // build guard. Zeroing the fetch stamp alone would not: staleness
        // requires a NON-ZERO stamp, so the guard would decline to refetch and
        // the spinner raised below would never come down.
        expect(body).toContain('setRainLoading(true)');
        expect(body).toContain('setRainRefreshNonce');
    });
});
