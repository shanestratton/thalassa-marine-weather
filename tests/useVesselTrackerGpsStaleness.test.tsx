/**
 * useVesselTracker — GPS-staleness clock (2026-08-03 life-safety module).
 *
 * applyGpsAgeTier is module-private, so the tiers are pinned through the
 * hook itself: a mocked GpsService feeds fixes, fake timers drive the
 * 1 Hz staleness ticker, and the marker DOM the hook builds is the
 * observable surface.
 *
 *   locked (<60s):    chip hidden, arrow live
 *   stale (60s–5min): greyed arrow/ring, amber "GPS 2m" chip
 *   lost (>5min):     greyed, red chip — position is history, not truth
 *
 * THE BLOCKER (verify-pass finding): GpsService replays the cached last
 * position on every (re)subscribe. A 30-min-old fix arriving "now" must
 * NOT reset the staleness clock — lastFixAt is the fix's OWN timestamp,
 * forward-only, and future device-clock skew clamps to now. A stale
 * position must never be indistinguishable from a live one.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVesselTracker } from '../components/map/useVesselTracker';
import { GPS_STALE_LIMIT_MS, GPS_VERY_STALE_MS } from '../services/shiplog/PositionResolver';

interface MockMarker {
    element: HTMLElement;
    setLngLat: ReturnType<typeof vi.fn>;
    addTo: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
    const markers: Array<{
        element: HTMLElement;
        setLngLat: ReturnType<typeof vi.fn>;
        addTo: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
    }> = [];
    const gpsCallbacks: Array<(pos: Record<string, unknown>) => void> = [];
    const watchUnsub = vi.fn();
    const watchPosition = vi.fn((cb: (pos: Record<string, unknown>) => void) => {
        gpsCallbacks.push(cb);
        return watchUnsub;
    });
    return {
        markers,
        gpsCallbacks,
        watchUnsub,
        watchPosition,
        getCurrentPosition: vi.fn().mockResolvedValue(null),
        getLastPosition: vi.fn(() => null),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
});

vi.mock('mapbox-gl', () => {
    class Marker {
        element: HTMLElement;
        setLngLat = vi.fn().mockReturnThis();
        addTo = vi.fn().mockReturnThis();
        remove = vi.fn();

        constructor(opts: { element: HTMLElement }) {
            this.element = opts.element;
            mocks.markers.push(this);
        }
    }
    return { default: { Marker }, Marker };
});

vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: mocks.watchPosition,
        getCurrentPosition: mocks.getCurrentPosition,
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: { getLastPosition: mocks.getLastPosition },
}));

// PositionResolver is imported for real (it owns THE app-wide staleness
// thresholds this suite pins); its service imports resolve to the mocks
// above plus this stub.
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: {} }));

// The real GpsReceiverStatusService drags in the NMEA/native-receiver
// stack. formatAge below mirrors the real export byte-for-byte
// (services/GpsReceiverStatusService.ts) so the chip text stays honest.
vi.mock('../services/GpsReceiverStatusService', () => ({
    formatAge: (ageMs: number): string => {
        if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s`;
        if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
        return `${Math.round(ageMs / 3_600_000)}h`;
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => mocks.logger,
}));

const T0 = new Date('2026-08-03T00:00:00Z').getTime();

const AMBER = 'rgb(245, 158, 11)';
const RED = 'rgb(239, 68, 68)';
const LIVE_RING = 'rgba(56, 189, 248, 0.2)';
const GREY_RING = 'rgba(148, 163, 184, 0.3)';

function makeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Map<string, { id: string }>();
    return {
        addSource: vi.fn((id: string) => {
            sources.set(id, { setData: vi.fn() });
        }),
        getSource: vi.fn((id: string) => sources.get(id)),
        addLayer: vi.fn((layer: { id: string }) => {
            layers.set(layer.id, layer);
        }),
        getLayer: vi.fn((id: string) => layers.get(id)),
        removeLayer: vi.fn((id: string) => {
            layers.delete(id);
        }),
        removeSource: vi.fn((id: string) => {
            sources.delete(id);
        }),
        flyTo: vi.fn(),
    };
}

function mountTracker() {
    const map = makeMap();
    const mapRef = { current: map as never };
    const view = renderHook(() => useVesselTracker(mapRef, true, true));

    const emit = (over: Record<string, unknown> = {}) => {
        const cb = mocks.gpsCallbacks.at(-1);
        act(() => {
            cb?.({
                latitude: -27.47,
                longitude: 153.02,
                accuracy: 5,
                altitude: null,
                heading: 45,
                speed: 3,
                timestamp: Date.now(),
                ...over,
            });
        });
    };
    const marker = (): MockMarker => {
        const m = mocks.markers.at(-1);
        if (!m) throw new Error('Vessel marker was never created');
        return m;
    };
    const part = (selector: string): HTMLElement => {
        const el = marker().element.querySelector(selector) as HTMLElement | null;
        if (!el) throw new Error(`Missing marker part ${selector}`);
        return el;
    };
    return {
        map,
        view,
        emit,
        marker,
        chip: () => part('.vessel-age-chip'),
        arrow: () => part('.vessel-arrow'),
        ring: () => part('.vessel-accuracy-ring'),
    };
}

const tick = (ms: number) =>
    act(() => {
        vi.advanceTimersByTime(ms);
    });

function expectLocked(t: ReturnType<typeof mountTracker>) {
    expect(t.chip().style.display).toBe('none');
    expect(t.arrow().style.filter).toBe('');
}

function expectStale(t: ReturnType<typeof mountTracker>, ageText: string) {
    expect(t.chip().style.display).toBe('block');
    expect(t.chip().style.color).toBe(AMBER);
    expect(t.chip().textContent).toBe(`GPS ${ageText}`);
    expect(t.arrow().style.filter).toBe('grayscale(1) brightness(0.85)');
    expect(t.ring().style.borderColor).toBe(GREY_RING);
}

function expectLost(t: ReturnType<typeof mountTracker>, ageText: string) {
    expect(t.chip().style.display).toBe('block');
    expect(t.chip().style.color).toBe(RED);
    expect(t.chip().textContent).toBe(`GPS ${ageText}`);
    expect(t.arrow().style.filter).toBe('grayscale(1) brightness(0.85)');
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mocks.markers.length = 0;
    mocks.gpsCallbacks.length = 0;
    mocks.watchPosition.mockClear();
    mocks.watchUnsub.mockClear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('useVesselTracker GPS-staleness clock', () => {
    it('sanity: the pinned thresholds are the app-wide 60s / 5min tiers', () => {
        expect(GPS_STALE_LIMIT_MS).toBe(60_000);
        expect(GPS_VERY_STALE_MS).toBe(300_000);
    });

    it('keeps the chip hidden and the vessel live while fixes are under 60s old (locked)', () => {
        const t = mountTracker();
        // Restoring the map is passive: consume an existing foreground grant,
        // but never start background/motion tracking merely to paint a marker.
        expect(mocks.watchPosition).toHaveBeenCalledWith(expect.any(Function));

        t.emit();
        expectLocked(t);

        // One second shy of the stale boundary: still locked.
        tick(GPS_STALE_LIMIT_MS - 1000);
        expectLocked(t);
    });

    it('greys the vessel with an amber chip at 60s and a red chip at 5min once fixes stop', () => {
        const t = mountTracker();
        t.emit();

        tick(GPS_STALE_LIMIT_MS); // exactly 60s of silence → stale (>= boundary)
        expectStale(t, '1m');

        tick(GPS_VERY_STALE_MS - GPS_STALE_LIMIT_MS); // 5min total → lost
        expectLost(t, '5m');
        expect(t.chip().style.borderColor).toBe('rgba(239, 68, 68, 0.6)');
    });

    it('BLOCKER: a replayed cached fix arriving "now" does not reset the staleness clock', () => {
        const t = mountTracker();
        t.emit({ timestamp: T0 });

        tick(120_000);
        expectStale(t, '2m');

        // GpsService replays the cached last position on (re)subscribe: an
        // old fix delivered at wall-clock "now". The chart may move the
        // marker to it, but the truth flag must keep counting from the
        // fix's OWN timestamp — receivedAt would flip this back to locked.
        t.emit({ latitude: -27.5, longitude: 153.1, timestamp: T0 });
        expect(t.marker().setLngLat).toHaveBeenLastCalledWith([153.1, -27.5]);

        tick(1000);
        expectStale(t, '2m');

        // And the clock keeps running from the replayed fix's age: at five
        // minutes past T0 the position is declared lost, replay or not.
        tick(GPS_VERY_STALE_MS - 121_000);
        expectLost(t, '5m');
    });

    it('recovers to locked on a genuinely fresh fix, and later replays cannot drag the clock backwards', () => {
        const t = mountTracker();
        t.emit({ timestamp: T0 });

        tick(120_000);
        expectStale(t, '2m');

        t.emit({ timestamp: Date.now() });
        tick(1000);
        expectLocked(t);
        expect(t.ring().style.borderColor).toBe(LIVE_RING);

        // Forward-only: a late replay of an OLDER fix after recovery must
        // not regress lastFixAt and re-grey a live vessel.
        t.emit({ timestamp: Date.now() - 200_000 });
        tick(1000);
        expectLocked(t);
    });

    it('clamps future-stamped fixes to now instead of banking phantom freshness (clock skew)', () => {
        const t = mountTracker();
        // A device clock 10 minutes fast stamps the fix in the future.
        t.emit({ timestamp: T0 + 600_000 });

        tick(1000);
        expectLocked(t);

        // 70s of silence: an unclamped clock would still read a negative
        // age (locked) for another ~9 minutes. The clamp means staleness
        // surfaces on schedule.
        tick(69_000);
        expectStale(t, '1m');
    });

    it('a stationary vessel still refreshes fix age through the trail noise filter', () => {
        const t = mountTracker();
        const berth = { latitude: -27.47, longitude: 153.02 };
        t.emit({ ...berth, timestamp: T0 });

        tick(120_000);
        expectStale(t, '2m');

        // Same coordinates: the trail's 5m noise filter early-returns, but
        // the fix-age update is ordered BEFORE it — an anchored boat with
        // healthy GPS must not creep into "stale".
        t.emit({ ...berth, timestamp: Date.now() });
        tick(1000);
        expectLocked(t);
    });

    it('tears down the watch, ticker and marker on unmount', () => {
        const t = mountTracker();
        t.emit();
        const marker = t.marker();

        t.view.unmount();
        expect(mocks.watchUnsub).toHaveBeenCalledTimes(1);
        expect(marker.remove).toHaveBeenCalledTimes(1);
        // The staleness interval is cleared: advancing time is inert.
        expect(() => vi.advanceTimersByTime(600_000)).not.toThrow();
    });
});
