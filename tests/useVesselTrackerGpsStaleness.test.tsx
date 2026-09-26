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
    options: { rotationAlignment?: string; pitchAlignment?: string };
    setLngLat: ReturnType<typeof vi.fn>;
    addTo: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
    const markers: Array<{
        element: HTMLElement;
        options: { rotationAlignment?: string; pitchAlignment?: string };
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
        anchorState: 'idle',
        anchorCallbacks: new Set<() => void>(),
        nmeaState: {} as Record<string, { value: number | null; lastUpdated: number; freshness: string }>,
        nmeaCallbacks: new Set<() => void>(),
        nmeaPositionCallbacks: new Set<() => void>(),
    };
});

vi.mock('mapbox-gl', () => {
    class Marker {
        element: HTMLElement;
        options: { rotationAlignment?: string; pitchAlignment?: string };
        setLngLat = vi.fn().mockReturnThis();
        addTo = vi.fn().mockReturnThis();
        remove = vi.fn();

        constructor(opts: { element: HTMLElement; rotationAlignment?: string; pitchAlignment?: string }) {
            this.element = opts.element;
            this.options = opts;
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

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: () => ({ state: mocks.anchorState, gpsSource: 'native' }),
        subscribe: (callback: () => void) => {
            mocks.anchorCallbacks.add(callback);
            callback();
            return () => mocks.anchorCallbacks.delete(callback);
        },
    },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        getState: () => ({ role: 'vessel', sessionCode: null }),
        onStateChange: () => () => {},
    },
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => ({ sessionCode: null, position: null, stale: true, cause: null }),
        subscribe: () => () => {},
    },
}));

// PositionResolver is imported for real (it owns THE app-wide staleness
// thresholds this suite pins); its service imports resolve to the mocks
// above plus this stub.
// The tracker now paints through the ownship arbiter (2026-08-31: the arrow
// sat on the house while the boat streamed from her berth). These stubs keep
// the original STALENESS cases on phone GPS. Direction cases below seed real
// arbiter-shaped NMEA metrics, with independent position and heading callbacks.
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        onPosition: (callback: () => void) => {
            mocks.nmeaPositionCallbacks.add(callback);
            return () => mocks.nmeaPositionCallbacks.delete(callback);
        },
        start: vi.fn(),
    },
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getSavedConfig: () => null },
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => mocks.nmeaState,
        start: vi.fn(),
        subscribe: (callback: () => void) => {
            mocks.nmeaCallbacks.add(callback);
            return () => mocks.nmeaCallbacks.delete(callback);
        },
    },
}));

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
// The live glow's edge (a 4 px glow since UX scorecard run 6, not a 64 px pulse).
const LIVE_RING = 'rgba(56, 189, 248, 0.35)';
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
        status: () => part('.vessel-sog-badge'),
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
    mocks.anchorState = 'idle';
    mocks.anchorCallbacks.clear();
    mocks.nmeaState = {};
    mocks.nmeaCallbacks.clear();
    mocks.nmeaPositionCallbacks.clear();
});

describe('useVesselTracker independent true-heading updates', () => {
    const metric = (value: number | null, at = Date.now()) => ({ value, lastUpdated: at, freshness: 'live' });
    const seedStoppedVessel = () => {
        mocks.nmeaState = {
            latitude: metric(-20.26),
            longitude: metric(148.82),
            sog: metric(0),
            cog: metric(240),
            heading: metric(180), // Unqualified legacy heading must never drive the bow.
            headingTrue: metric(0),
        };
    };
    const expectNeutral = (t: ReturnType<typeof mountTracker>) => {
        expect(t.marker().element.dataset.directionSource).toBe('unknown');
        expect(t.marker().element.getAttribute('aria-label')).toBe('Position; heading unavailable');
        expect(t.arrow().querySelector<SVGElement>('.vessel-directional-shape')!.style.display).toBe('none');
        expect(t.arrow().querySelector<SVGElement>('.vessel-neutral-shape')!.style.display).not.toBe('none');
    };

    it('draws a stationary vessel pointing true north at 0°, separate from cached COG', () => {
        seedStoppedVessel();
        const t = mountTracker();
        expect(t.marker().element.dataset.source).toBe('vessel');
        expect(t.marker().element.dataset.directionSource).toBe('heading');
        expect(t.marker().element.getAttribute('aria-label')).toBe('Bow heading 0° true');
        expect(t.arrow().style.transform).toBe('rotate(0deg)');
        expect(t.arrow().querySelector<SVGElement>('.vessel-directional-shape')!.style.display).not.toBe('none');
        expect(t.arrow().querySelector<SVGElement>('.vessel-neutral-shape')!.style.display).toBe('none');
        expect(t.status().textContent).toBe('Stopped');
    });

    it('updates the bow from instrument callbacks without a new GPS fix or marker translation', () => {
        seedStoppedVessel();
        const t = mountTracker();
        const translations = t.marker().setLngLat.mock.calls.length;
        t.marker().element.style.transform = 'translate(100px, 200px) rotateZ(-30deg)';
        act(() => {
            mocks.nmeaState.headingTrue = metric(45);
            mocks.nmeaCallbacks.forEach((callback) => callback());
        });
        expect(t.arrow().style.transform).toBe('rotate(45deg)');
        expect(t.marker().setLngLat).toHaveBeenCalledTimes(translations);
        expect(t.marker().element.style.transform).toBe('translate(100px, 200px) rotateZ(-30deg)');
        expect(t.marker().options).toMatchObject({ rotationAlignment: 'map', pitchAlignment: 'map' });
        t.view.unmount();
        expect(mocks.nmeaCallbacks.size).toBe(0);
        expect(mocks.nmeaPositionCallbacks.size).toBe(0);
    });

    it('retires expired heading to a neutral dot while newer position fixes remain fresh', () => {
        seedStoppedVessel();
        const t = mountTracker();
        tick(12_000);
        act(() => {
            mocks.nmeaState.latitude = metric(-20.26);
            mocks.nmeaState.longitude = metric(148.82);
            mocks.nmeaPositionCallbacks.forEach((callback) => callback());
        });
        expect(t.marker().element.dataset.directionSource).toBe('heading');
        tick(2_000);
        expectNeutral(t);
        expectLocked(t); // The position itself is still fresh, not a GPS failure.
    });

    it('crosses north directly without a CSS tween that sweeps the long way around', () => {
        seedStoppedVessel();
        mocks.nmeaState.headingTrue = metric(359);
        const t = mountTracker();
        expect(t.arrow().style.transform).toBe('rotate(359deg)');
        expect(t.arrow().style.transition).not.toContain('transform');
        expect(t.arrow().style.transition).not.toContain('all');
        act(() => {
            mocks.nmeaState.headingTrue = metric(1);
            mocks.nmeaCallbacks.forEach((callback) => callback());
        });
        expect(t.arrow().style.transform).toBe('rotate(1deg)');
        expect(t.marker().element.dataset.directionSource).toBe('heading');
    });

    it('keeps stopped phone GPS neutral rather than using its noisy COG or the vessel compass', () => {
        mocks.nmeaState = { headingTrue: metric(75) };
        const t = mountTracker();
        t.emit({ speed: 0, heading: 240 });
        expect(t.marker().element.dataset.source).toBe('phone');
        expectNeutral(t);
        t.emit({ speed: 0.2, heading: 170 });
        expectNeutral(t);
    });

    it('uses and labels phone travel direction only while moving, then clears it on stopping', () => {
        const t = mountTracker();
        t.emit({ speed: 2, heading: 80 });
        expect(t.marker().element.dataset.directionSource).toBe('course');
        expect(t.arrow().style.transform).toBe('rotate(80deg)');
        expect(t.marker().element.getAttribute('aria-label')).toContain('bow heading unavailable');
        t.emit({ speed: 0, heading: 80 });
        expectNeutral(t);
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('useVesselTracker GPS-staleness clock', () => {
    it('keeps stopped and underway badges beside the fix, in theme colours, without moving or rotating the GPS root', () => {
        const t = mountTracker();
        t.emit({ speed: 0 });
        const root = t.marker().element;
        root.style.transform = 'translate(310px, 240px) rotateZ(-30deg)';
        const coordinates = t.marker().setLngLat.mock.lastCall;
        const checkLayout = () => {
            // Beside the dot and centred on it (UX scorecard run 6): a badge
            // parked below the fix read as a basemap place label's caption.
            expect(t.status().style.top).toBe('50%');
            expect(t.status().style.left).toBe('calc(50% + 18px)');
            expect(t.status().style.bottom).toBe('');
            expect(t.status().style.transform).toBe('translateY(-50%)');
            // Colours are theme classes, so daylight can remap them.
            expect(t.status().style.color).toBe('');
            expect(t.status().style.background).toBe('');
            expect(root.style.width).toBe('48px');
            expect(root.style.height).toBe('48px');
            expect(root.style.position).toBe('');
            expect(root.style.transform).toBe('translate(310px, 240px) rotateZ(-30deg)');
            expect(t.marker().setLngLat.mock.lastCall).toEqual(coordinates);
        };
        expect(t.status().textContent).toBe('Stopped');
        expect(t.status().classList.contains('text-sky-400')).toBe(true);
        checkLayout();
        t.emit({ speed: 3, heading: 75 });
        expect(t.status().textContent).toBe('5.8 kts');
        expect(t.arrow().style.transform).toBe('rotate(75deg)');
        checkLayout();
        act(() => {
            mocks.anchorState = 'watching';
            mocks.anchorCallbacks.forEach((callback) => callback());
        });
        expect(t.status().textContent).toBe('Anchored');
        expect(t.status().classList.contains('text-emerald-400')).toBe(true);
        expect(t.status().classList.contains('text-sky-400')).toBe(false);
        checkLayout();
    });

    it('updates anchor status on arm and stop without waiting for the next GPS fix', () => {
        const t = mountTracker();
        t.emit({ speed: 0 });
        expect(t.status().textContent).toBe('Stopped');
        act(() => {
            mocks.anchorState = 'watching';
            mocks.anchorCallbacks.forEach((callback) => callback());
        });
        expect(t.status().textContent).toBe('Anchored');
        act(() => {
            mocks.anchorState = 'idle';
            mocks.anchorCallbacks.forEach((callback) => callback());
        });
        expect(t.status().textContent).toBe('Stopped');
        t.view.unmount();
        expect(mocks.anchorCallbacks.size).toBe(0);
    });

    it('does not turn a missing phone speed into an anchored or stopped claim', () => {
        const t = mountTracker();
        t.emit({ speed: null });
        expect(t.status().textContent).toBe('SOG —');
    });

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
