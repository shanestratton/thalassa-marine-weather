/**
 * useVesselTracker — GPS-staleness clock (2026-08-03 life-safety module).
 *
 * applyGpsAgeTier is module-private, so the tiers are pinned through the
 * hook itself: a mocked GpsService feeds fixes, fake timers drive the
 * 1 Hz staleness ticker, and the marker DOM the hook builds is the
 * observable surface.
 *
 * The marker's tier and its badge's words come from ONE fix state
 * (components/gpsFixState.ts), through the same live gates the System status
 * box uses — 30 s for the phone, the boat's lane gate for her feed. UX
 * referee run 8 (gps-one-truth): the chart drew a live-looking 'Stopped' off
 * a 46 s old fix while MOB, Radio and Anchor Watch said NO FIX.
 *
 *   locked (live):              chip hidden, arrow live, badge 'Stopped'/SOG
 *   stale (past the live gate): greyed arrow/ring, amber 'Last fix 46 s' badge
 *   lost (>5min):               greyed, red badge — position is history
 *
 * The top chip carries the same 'Last fix …' only while an anchor label
 * holds the badge, so the age is always shown, and only once.
 *
 * THE BLOCKER (verify-pass finding): GpsService replays the cached last
 * position on every (re)subscribe. A 30-min-old fix arriving "now" must
 * NOT reset the staleness clock — lastFixAt is the fix's OWN timestamp,
 * forward-only, and future device-clock skew clamps to now. A stale
 * position must never be indistinguishable from a live one.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    isBasePlaceLabelLayer,
    ownshipPlaceLabelWasReset,
    spokenOwnshipBadge,
    syncOwnshipPlaceLabel,
    useVesselTracker,
    withOwnshipLabelFade,
} from '../components/map/useVesselTracker';
import { GPS_STALE_LIMIT_MS, GPS_VERY_STALE_MS } from '../services/shiplog/PositionResolver';
import { PHONE_LIVE_FIX_MAX_AGE_MS } from '../components/gpsFixState';
import { boatGpsDiagnosticSource, presentGpsDiagnostics } from '../components/gpsDiagnosticsPresentation';
import { NMEA_USABLE_MAX_AGE_MS } from '../services/nmea/nmeaCadence';

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

// The badge says the fix age, once: the chip stays hidden unless an anchor
// label holds the badge.
function expectStale(t: ReturnType<typeof mountTracker>, ageText: string) {
    expect(t.status().textContent).toBe(`Last fix ${ageText}`);
    expect(t.status().classList.contains('text-amber-400')).toBe(true);
    expect(t.status().classList.contains('text-sky-400')).toBe(false);
    expect(t.chip().style.display).toBe('none');
    expect(t.arrow().style.filter).toBe('grayscale(1) brightness(0.85)');
    expect(t.ring().style.borderColor).toBe(GREY_RING);
}

function expectLost(t: ReturnType<typeof mountTracker>, ageText: string) {
    expect(t.status().textContent).toBe(`Last fix ${ageText}`);
    expect(t.status().classList.contains('text-red-400')).toBe(true);
    expect(t.status().classList.contains('text-amber-400')).toBe(false);
    expect(t.chip().style.display).toBe('none');
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
        // One img, one name: it carries the visible chip too (UX scorecard run 10).
        expect(t.marker().element.getAttribute('aria-label')).toMatch(/^Own ship, .+; heading unavailable$/);
        expect(t.arrow().querySelector<SVGElement>('.vessel-directional-shape')!.style.display).toBe('none');
        expect(t.arrow().querySelector<SVGElement>('.vessel-neutral-shape')!.style.display).not.toBe('none');
    };

    it('draws a stationary vessel pointing true north at 0°, separate from cached COG', () => {
        seedStoppedVessel();
        const t = mountTracker();
        expect(t.marker().element.dataset.source).toBe('vessel');
        expect(t.marker().element.dataset.directionSource).toBe('heading');
        expect(t.marker().element.getAttribute('aria-label')).toBe('Own ship, stopped; bow heading 0° true');
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

    it('sanity: the pinned thresholds are the 30 s phone live gate and the 5 min lost tier', () => {
        expect(PHONE_LIVE_FIX_MAX_AGE_MS).toBe(30_000);
        expect(GPS_VERY_STALE_MS).toBe(300_000);
        // The shiplog's own 60 s stale limit is unchanged; it no longer
        // decides whether the chart may call a position live.
        expect(GPS_STALE_LIMIT_MS).toBe(60_000);
    });

    it('keeps the chip hidden and the vessel live while the phone fix is inside its 30 s gate (locked)', () => {
        const t = mountTracker();
        // Restoring the map is passive: consume an existing foreground grant,
        // but never start background/motion tracking merely to paint a marker.
        expect(mocks.watchPosition).toHaveBeenCalledWith(expect.any(Function));

        t.emit({ speed: 0 });
        expectLocked(t);

        // On the gate itself: still live, still 'Stopped'.
        tick(PHONE_LIVE_FIX_MAX_AGE_MS);
        expectLocked(t);
        expect(t.status().textContent).toBe('Stopped');
    });

    it("says 'Last fix 46 s' on a grey marker instead of a live-looking 'Stopped' (referee run 8)", () => {
        const t = mountTracker();
        t.emit({ speed: 0 });
        expect(t.status().textContent).toBe('Stopped');

        tick(46_000);
        expectStale(t, '46 s');
        expect(t.status().textContent).not.toBe('Stopped');
        // VoiceOver hears the stale fix too, not just 'Position' (UX scorecard run 10),
        // in the chip's own words and no softer hedge of its own.
        expect(t.marker().element.getAttribute('aria-label')).toBe(
            'Own ship, last fix 46 seconds ago; heading unavailable',
        );
    });

    it('greys the vessel with an amber badge past the gate and a red one at 5min once fixes stop', () => {
        const t = mountTracker();
        t.emit();

        tick(PHONE_LIVE_FIX_MAX_AGE_MS + 1000); // one second past the gate → stale
        expectStale(t, '31 s');

        tick(GPS_STALE_LIMIT_MS - PHONE_LIVE_FIX_MAX_AGE_MS - 1000);
        expectStale(t, '1 min');

        tick(GPS_VERY_STALE_MS - GPS_STALE_LIMIT_MS); // 5min total → lost
        expectLost(t, '5 min');
    });

    it('keeps an anchor label on the badge and moves the fix age to the chip, in the same words', () => {
        const t = mountTracker();
        t.emit({ speed: 0 });
        act(() => {
            mocks.anchorState = 'watching';
            mocks.anchorCallbacks.forEach((callback) => callback());
        });
        expect(t.status().textContent).toBe('Anchored');
        expectLocked(t);

        tick(46_000);
        // The watch owns the badge (its own GPS watchdog gates it); the stale
        // fix is still shown, once, and the marker still greys.
        expect(t.status().textContent).toBe('Anchored');
        expect(t.chip().style.display).toBe('block');
        expect(t.chip().textContent).toBe('Last fix 46 s');
        expect(t.chip().style.color).toBe(AMBER);
        expect(t.arrow().style.filter).toBe('grayscale(1) brightness(0.85)');
        // The name carries the badge and the chip, in the chip's own words.
        expect(t.marker().element.getAttribute('aria-label')).toBe(
            'Own ship, anchored, last fix 46 seconds ago; heading unavailable',
        );

        tick(GPS_VERY_STALE_MS - 46_000);
        expect(t.chip().textContent).toBe('Last fix 5 min');
        expect(t.chip().style.color).toBe(RED);
        expect(t.chip().style.borderColor).toBe('rgba(239, 68, 68, 0.6)');
        expect(t.marker().element.getAttribute('aria-label')).toBe(
            'Own ship, anchored, last fix 5 minutes ago; heading unavailable',
        );
    });

    it("reads the boat's own lane gate for a vessel-fed marker, not the phone's", () => {
        const metric = (value: number, at = Date.now()) => ({ value, lastUpdated: at, freshness: 'live' });
        mocks.nmeaState = { latitude: metric(-20.26), longitude: metric(148.82), sog: metric(0) };
        const t = mountTracker();
        expect(t.marker().element.dataset.source).toBe('vessel');
        expect(t.status().textContent).toBe('Stopped');

        tick(NMEA_USABLE_MAX_AGE_MS);
        expectLocked(t);
        tick(1000);
        expectStale(t, '14 s');
    });

    it('BLOCKER: a replayed cached fix arriving "now" does not reset the staleness clock', () => {
        const t = mountTracker();
        t.emit({ timestamp: T0 });

        tick(120_000);
        expectStale(t, '2 min');

        // GpsService replays the cached last position on (re)subscribe: an
        // old fix delivered at wall-clock "now". The chart may move the
        // marker to it, but the truth flag must keep counting from the
        // fix's OWN timestamp — receivedAt would flip this back to locked.
        t.emit({ latitude: -27.5, longitude: 153.1, timestamp: T0 });
        expect(t.marker().setLngLat).toHaveBeenLastCalledWith([153.1, -27.5]);

        tick(1000);
        expectStale(t, '2 min');

        // And the clock keeps running from the replayed fix's age: at five
        // minutes past T0 the position is declared lost, replay or not.
        tick(GPS_VERY_STALE_MS - 121_000);
        expectLost(t, '5 min');
    });

    it('recovers to locked on a genuinely fresh fix, and later replays cannot drag the clock backwards', () => {
        const t = mountTracker();
        t.emit({ timestamp: T0 });

        tick(120_000);
        expectStale(t, '2 min');

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
        expectStale(t, '1 min');
    });

    it('a stationary vessel still refreshes fix age through the trail noise filter', () => {
        const t = mountTracker();
        const berth = { latitude: -27.47, longitude: 153.02 };
        t.emit({ ...berth, timestamp: T0 });

        tick(120_000);
        expectStale(t, '2 min');

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

// Adversarial review (gps-one-truth): the badge must read the SAME fix time
// the System status card reads for the receiver the marker is drawing.
describe('useVesselTracker dates each receiver by its own fix', () => {
    const metric = (value: number | null, at = Date.now()) => ({ value, lastUpdated: at, freshness: 'live' });

    it("dates the phone stand-in by the phone's own fix, never by the boat's newer one", () => {
        mocks.nmeaState = { latitude: metric(-20.26), longitude: metric(148.82), sog: metric(0) };
        const t = mountTracker();
        expect(t.marker().element.dataset.source).toBe('vessel');
        expect(t.status().textContent).toBe('Stopped');

        // The boat goes quiet (the arbiter drops her feed at 15 s) and the
        // phone watch replays its cached fix from two minutes before hers.
        tick(20_000);
        t.emit({ latitude: -27.47, longitude: 153.02, speed: 0, timestamp: T0 - 120_000 });
        expect(t.marker().element.dataset.source).toBe('phone');
        // One shared forward-only clock dated this 2-min-old phone position
        // by the boat's fix 20 s ago: a live 'Stopped' inside the phone gate.
        expectStale(t, '2 min');

        // A genuinely fresh phone fix is live on the phone's own clock.
        t.emit({ latitude: -27.47, longitude: 153.02, speed: 0, timestamp: Date.now() });
        expectLocked(t);
        expect(t.status().textContent).toBe('Stopped');
    });

    it('ignores an undated fix instead of poisoning the clock', () => {
        const t = mountTracker();
        t.emit({ speed: 0, timestamp: Number.NaN });
        expect(t.status().textContent).toBe('No fix');
        t.emit({ speed: 0, timestamp: Date.now() });
        expectLocked(t);
        expect(t.status().textContent).toBe('Stopped');
    });

    // The Pi's lanes stamp lat/lon with the phone's READ time; the System
    // status card dates the coordinates by the snapshot's position sample.
    const piLan = (positionSampleAt: number | undefined, source: 'pi' | 'device' = 'pi') =>
        ({
            connectionStatus: 'remote',
            remote: {
                source,
                via: 'lan',
                deviceLabel: 'Pi',
                reportedAt: Date.now(),
                receivedAt: Date.now(),
                ...(positionSampleAt === undefined ? {} : { positionSampleAt }),
            },
            latitude: metric(-20.26),
            longitude: metric(148.82),
            sog: metric(0),
            satellites: metric(9),
            hdop: metric(0.9),
            gpsFixQuality: null,
            gpsFixQualityUpdatedAt: null,
            gpsAccuracyM: null,
        }) as unknown as typeof mocks.nmeaState;

    it.each([
        [2_000, 'Stopped', 'Position 2 s ago'],
        [25_000, 'Last fix 25 s', 'No live fix · last position 25 s ago'],
    ])(
        'a Pi LAN position sampled %i ms ago reads the same on the badge (%s) as on the System status card',
        (sampleAgeMs, badge, cardLine) => {
            mocks.nmeaState = piLan(Date.now() - sampleAgeMs);
            const t = mountTracker();
            expect(t.marker().element.dataset.source).toBe('vessel');
            expect(t.status().textContent).toBe(badge);
            const card = presentGpsDiagnostics(
                boatGpsDiagnosticSource(mocks.nmeaState as unknown as Parameters<typeof boatGpsDiagnosticSource>[0])!,
                Date.now(),
            );
            expect(card.position).toBe(cardLine);
        },
    );

    // The Pi sends position_at whenever it can prove the fix's time (and not
    // once the position is 10 min old); Radio treats a Pi row without it as
    // no fix (radioTelemetryPosition). The badge must not read 'Stopped' off
    // the phone's read time while the card says 'No position yet'.
    it('an undated Pi position is no fix on the badge, as on the card and in Radio', () => {
        mocks.nmeaState = piLan(undefined);
        const t = mountTracker();
        expect(t.marker().element.dataset.source).toBe('vessel');
        expect(t.status().textContent).toBe('No fix');
        expect(t.status().classList.contains('text-red-400')).toBe(true);
        expect(t.arrow().style.filter).toBe('grayscale(1) brightness(0.85)');
        const card = presentGpsDiagnostics(
            boatGpsDiagnosticSource(mocks.nmeaState as unknown as Parameters<typeof boatGpsDiagnosticSource>[0])!,
            Date.now(),
        );
        expect(card.position).toBe('No position yet');
    });

    it('a Pi row that stops carrying its sample time keeps counting from the last dated fix', () => {
        mocks.nmeaState = piLan(Date.now() - 2_000);
        const t = mountTracker();
        expect(t.status().textContent).toBe('Stopped');
        tick(10_000);
        act(() => {
            mocks.nmeaState = piLan(undefined);
            mocks.nmeaPositionCallbacks.forEach((callback) => callback());
        });
        expect(t.status().textContent).toBe('Stopped');
        tick(10_000);
        expectStale(t, '22 s');
    });

    it("another device's shared row keeps its receipt time (no sample time is sent for it)", () => {
        mocks.nmeaState = piLan(undefined, 'device');
        const t = mountTracker();
        expect(t.status().textContent).toBe('Stopped');
    });
});

describe('own-ship spoken name and the town name under the dot (UX scorecard run 10)', () => {
    it("spells out the badge's units without changing its words", () => {
        expect(spokenOwnshipBadge('Last fix 46 s')).toBe('last fix 46 seconds ago');
        expect(spokenOwnshipBadge('Last fix 1 min')).toBe('last fix 1 minute ago');
        expect(spokenOwnshipBadge('Last fix 2 h')).toBe('last fix 2 hours ago');
        expect(spokenOwnshipBadge('3.2 kts')).toBe('3.2 knots');
        expect(spokenOwnshipBadge('SOG —')).toBe('speed over ground unavailable');
        expect(spokenOwnshipBadge('Stopped')).toBe('stopped');
        expect(spokenOwnshipBadge('No fix')).toBe('no fix');
    });

    it("touches only the base style's settlement and place layers", () => {
        expect(isBasePlaceLabelLayer({ id: 'settlement-major-label', type: 'symbol', source: 'composite' })).toBe(true);
        expect(isBasePlaceLabelLayer({ id: 'place_town', type: 'symbol', source: 'openmaptiles' })).toBe(true);
        expect(isBasePlaceLabelLayer({ id: 'country-label', type: 'symbol', source: 'composite' })).toBe(false);
        expect(isBasePlaceLabelLayer({ id: 'poi-label', type: 'symbol', source: 'composite' })).toBe(false);
        expect(isBasePlaceLabelLayer({ id: 'enc-vec-lndare-label', type: 'symbol', source: 'enc-vec' })).toBe(false);
        expect(isBasePlaceLabelLayer({ id: 'settlement-major-label', type: 'fill', source: 'composite' })).toBe(false);
    });

    it('wraps opacity in a feature-state fade, keeping a zoom curve at the top', () => {
        const hidden = ['boolean', ['feature-state', 'thalassaOwnshipHidden'], false];
        expect(withOwnshipLabelFade(undefined)).toEqual(['case', hidden, 0, 1]);
        expect(withOwnshipLabelFade(0.8)).toEqual(['case', hidden, 0, 0.8]);
        expect(withOwnshipLabelFade(['interpolate', ['linear'], ['zoom'], 8, 0, 10, 1])).toEqual([
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            ['case', hidden, 0, 0],
            10,
            ['case', hidden, 0, 1],
        ]);
        expect(withOwnshipLabelFade(['step', ['zoom'], 0, 9, 1])).toEqual([
            'step',
            ['zoom'],
            ['case', hidden, 0, 0],
            9,
            ['case', hidden, 0, 1],
        ]);
        // Already armed: unchanged. A legacy stops function cannot be wrapped.
        const armed = ['case', hidden, 0, 1];
        expect(withOwnshipLabelFade(armed)).toBe(armed);
        expect(withOwnshipLabelFade({ stops: [[8, 0]] })).toBeNull();
    });

    /** A style with one settlement layer and one town, 'Gladstone', drawn under the dot. */
    function placeMap(textOpacity: unknown) {
        const layers = [
            { id: 'settlement-major-label', type: 'symbol', source: 'composite', 'source-layer': 'place_label' },
        ];
        const paint = new Map<string, unknown>([['settlement-major-label|text-opacity', textOpacity]]);
        const state = new Map<string | number, Record<string, unknown>>();
        const map = {
            getStyle: () => ({ layers }),
            getLayer: (id: string) => layers.find((layer) => layer.id === id),
            getPaintProperty: (id: string, property: string) => paint.get(`${id}|${property}`),
            setPaintProperty: vi.fn((id: string, property: string, value: unknown) => {
                paint.set(`${id}|${property}`, value);
            }),
            project: ([x, y]: [number, number]) => ({ x, y }),
            queryRenderedFeatures: vi.fn(() => [
                {
                    id: 7,
                    source: 'composite',
                    sourceLayer: 'place_label',
                    layer: { id: 'settlement-major-label' },
                    properties: { class: 'settlement', type: 'city', name: 'Gladstone' },
                    geometry: { type: 'Point', coordinates: [101, 100] },
                },
            ]),
            setFeatureState: vi.fn((target: { id: string | number }, value: Record<string, unknown>) => {
                state.set(target.id, { ...state.get(target.id), ...value });
            }),
            removeFeatureState: vi.fn((target: { id: string | number }) => {
                state.delete(target.id);
            }),
            getFeatureState: (target: { id: string | number }) => state.get(target.id) ?? {},
        };
        return { map, state, asMap: map as never };
    }

    it('fades the one town the dot sits on, writes the style once, and restores it', () => {
        const { map, state, asMap } = placeMap(undefined);
        syncOwnshipPlaceLabel(asMap, [100, 100]);
        expect(state.get(7)).toEqual({ thalassaOwnshipHidden: true });
        expect(map.setPaintProperty).toHaveBeenCalledTimes(2); // text and icon opacity, once
        expect(ownshipPlaceLabelWasReset(asMap)).toBe(false);

        // The same view again: nothing written.
        syncOwnshipPlaceLabel(asMap, [100, 100]);
        expect(map.setPaintProperty).toHaveBeenCalledTimes(2);
        expect(map.setFeatureState).toHaveBeenCalledTimes(1);

        // Own-ship gone: the name comes back.
        syncOwnshipPlaceLabel(asMap, null);
        expect(state.has(7)).toBe(false);
    });

    it('leaves a label whose opacity it cannot wrap, and records nothing for the ticker to retry', () => {
        const { map, state, asMap } = placeMap({ stops: [[8, 0]] });
        syncOwnshipPlaceLabel(asMap, [100, 100]);
        expect(map.setFeatureState).not.toHaveBeenCalled();
        expect(state.has(7)).toBe(false);
        expect(ownshipPlaceLabelWasReset(asMap)).toBe(false);
    });
});
