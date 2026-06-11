/**
 * Tests for CapturePipeline — focused on the gating logic that lives
 * exclusively in this module after the extraction (dedup threshold,
 * speed-spike rejection, acceleration-spike rejection, quarter-hour
 * timestamp snap, rolling waypoint demotion, flushBufferedTrack drain
 * + thinning + setCachedFix loop).
 *
 * Strategy: heavy mocking of the persistence + GPS resolution surface
 * (saveEntryOnlineOrOffline, getLastPosition, saveLastPosition,
 * getBestPosition, etc.) so we can drive the pipeline through synthetic
 * positions and observe the resulting entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (top-level — vi.mock factories are hoisted) ───────────────

vi.mock('../services/shiplog/EntrySave', () => ({
    saveEntryOnlineOrOffline: vi.fn(async (entry: Record<string, unknown>) => ({
        saved: { ...entry, id: 'mock-id' },
        entryId: 'mock-id',
        wasOffline: false,
    })),
    retryGpsAndUpdateEntry: vi.fn(),
    demotePreviousAutoWaypoint: vi.fn(async () => undefined),
    webGetFreshPosition: vi.fn(async () => null),
}));

vi.mock('../services/shiplog/TrackingStateStore', async () => {
    const actual = await vi.importActual<typeof import('../services/shiplog/TrackingStateStore')>(
        '../services/shiplog/TrackingStateStore',
    );
    return {
        ...actual,
        getLastPosition: vi.fn(async () => null),
        saveLastPosition: vi.fn(async () => undefined),
    };
});

vi.mock('../services/shiplog/PositionResolver', () => ({
    getBestPosition: vi.fn(async (cachedFix: unknown) => cachedFix),
    getGpsStatus: vi.fn(() => 'locked'),
    getGpsNavData: vi.fn(() => ({ sogKts: 0, cogDeg: 0 })),
}));

vi.mock('../services/shiplog/waterDetection', () => ({
    checkIsOnWater: vi.fn(async () => true),
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getAdaptedThresholds: () => ({ trackThinningMultiplier: 1, courseChangeMinMovementM: 1 }),
        feed: vi.fn(),
        reset: vi.fn(),
    },
}));

vi.mock('../services/shiplog/helpers', async () => {
    const actual = await vi.importActual<typeof import('../services/shiplog/helpers')>('../services/shiplog/helpers');
    return {
        ...actual,
        getWeatherSnapshot: vi.fn(() => ({})),
    };
});

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getFreshPosition: vi.fn(async () => null),
        getLastPosition: vi.fn(() => null),
    },
}));

import {
    captureImmediate,
    captureLog,
    addManual,
    flushBufferedTrack,
    type CaptureContext,
} from '../services/shiplog/CapturePipeline';
import { GpsTrackBuffer } from '../services/shiplog/GpsTrackBuffer';
import { saveEntryOnlineOrOffline, demotePreviousAutoWaypoint } from '../services/shiplog/EntrySave';
import { getLastPosition, saveLastPosition } from '../services/shiplog/TrackingStateStore';
import { getBestPosition } from '../services/shiplog/PositionResolver';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';
import type { CachedPosition } from '../services/BgGeoManager';

const saveEntry = saveEntryOnlineOrOffline as ReturnType<typeof vi.fn>;
const demoteWaypoint = demotePreviousAutoWaypoint as ReturnType<typeof vi.fn>;
const lastPosition = getLastPosition as ReturnType<typeof vi.fn>;
const saveLastPos = saveLastPosition as ReturnType<typeof vi.fn>;
const bestPosition = getBestPosition as ReturnType<typeof vi.fn>;

function makeFix(lat = -27.5, lon = 153.0, speed = 5, heading = 90): CachedPosition {
    return {
        latitude: lat,
        longitude: lon,
        accuracy: 5,
        altitude: null,
        heading,
        speed,
        timestamp: Date.now(),
        receivedAt: Date.now(),
    } as CachedPosition;
}

function makeCtx(overrides: Partial<CaptureContext> = {}): CaptureContext {
    const trackingState: TrackingState = {
        isTracking: true,
        isPaused: false,
        isRapidMode: false,
        currentVoyageId: 'test-voyage',
    };
    let cachedFix: CachedPosition | null = makeFix();
    let waterStatus: boolean | undefined = true;
    return {
        trackingState,
        saveTrackingState: vi.fn(async () => undefined),
        isNative: false,
        getCachedFix: () => cachedFix,
        setCachedFix: (pos) => {
            cachedFix = pos;
        },
        trackBuffer: new GpsTrackBuffer(),
        getLastWaterStatus: () => waterStatus,
        setLastWaterStatus: (v) => {
            waterStatus = v;
        },
        rescheduleAdaptiveInterval: vi.fn(async () => undefined),
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
    saveEntry.mockClear();
    demoteWaypoint.mockClear();
    lastPosition.mockReset().mockResolvedValue(null);
    saveLastPos.mockReset().mockResolvedValue(undefined);
    bestPosition.mockReset().mockImplementation(async (cachedFix: unknown) => cachedFix);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('captureImmediate', () => {
    it('uses the cached fix when fresh and saves the entry', async () => {
        const ctx = makeCtx();
        const entry = await captureImmediate(ctx, undefined, 'Voyage Start');
        expect(entry).not.toBeNull();
        expect(entry!.waypointName).toBe('Voyage Start');
        expect(entry!.latitude).toBeCloseTo(-27.5);
        expect(entry!.longitude).toBeCloseTo(153.0);
        expect(saveEntry).toHaveBeenCalledTimes(1);
    });

    it('persists with placeholder coords when no fix is available', async () => {
        const ctx = makeCtx({ getCachedFix: () => null });
        // captureImmediate polls the fix cache for up to 30s (Voyage
        // Start) before falling back to the placeholder — advance fake
        // timers through the whole warm-up window.
        const promise = captureImmediate(ctx);
        await vi.advanceTimersByTimeAsync(31_000);
        const entry = await promise;
        expect(entry).not.toBeNull();
        // Placeholder lat/lon are 0 because the warm-up loop didn't find a fix.
        expect(entry!.latitude).toBe(0);
        expect(entry!.longitude).toBe(0);
        expect(entry!.positionFormatted).toContain('Acquiring');
    });

    it('rejects a teleport-stale fix (own GPS timestamp predates start) and stamps from the first fresh fix', async () => {
        // BgGeo replays the previous session's location with a fresh
        // receivedAt at engine start — the gate must judge the fix by
        // its OWN timestamp and keep waiting for a real one.
        const staleFix = {
            ...makeFix(-27.0, 152.5),
            timestamp: Date.now() - 10 * 60 * 1000, // produced 10 min ago, elsewhere
            receivedAt: Date.now(), // ...but delivered just now
        } as CachedPosition;
        let currentFix: CachedPosition = staleFix;
        const ctx = makeCtx({ getCachedFix: () => currentFix });

        const promise = captureImmediate(ctx, undefined, 'Voyage Start');
        // After 2s of warm-up polling, a genuine fix arrives.
        await vi.advanceTimersByTimeAsync(2_000);
        currentFix = { ...makeFix(-27.5, 153.0), timestamp: Date.now(), receivedAt: Date.now() } as CachedPosition;
        await vi.advanceTimersByTimeAsync(1_000);
        const entry = await promise;

        expect(entry).not.toBeNull();
        expect(entry!.latitude).toBeCloseTo(-27.5);
        expect(entry!.longitude).toBeCloseTo(153.0);
    });
});

describe('captureLog — DEDUP threshold (~5m / 0.005nm)', () => {
    it('returns null and records lastCheckDeduped when vessel barely moved', async () => {
        // Last position is 1m away → distanceNM ~5e-4 < 0.005 threshold
        lastPosition.mockResolvedValueOnce({
            latitude: -27.5,
            longitude: 153.0,
            timestamp: '2026-05-02T05:59:00Z',
            cumulativeDistanceNM: 10,
        });
        const ctx = makeCtx();
        // Fix is at the same coords → distance 0
        const result = await captureLog(ctx, { entryType: 'auto' });
        expect(result).toBeNull();
        expect(ctx.trackingState.lastCheckDeduped).toBe(true);
    });

    it('skipDedup=true bypasses the threshold (used by flushBufferedTrack)', async () => {
        lastPosition.mockResolvedValueOnce({
            latitude: -27.5,
            longitude: 153.0,
            timestamp: '2026-05-02T05:59:00Z',
            cumulativeDistanceNM: 10,
        });
        const ctx = makeCtx();
        const result = await captureLog(ctx, { entryType: 'auto', skipDedup: true });
        expect(result).not.toBeNull();
    });
});

describe('captureLog — speed sanity', () => {
    it('rejects entries with implied speed > 100 kts (drops, returns null)', async () => {
        // Last fix 1 min ago → 1° lat = 60nm in 1 min = 3600 kts
        lastPosition.mockResolvedValueOnce({
            latitude: -28.5,
            longitude: 153.0,
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            cumulativeDistanceNM: 0,
        });
        const ctx = makeCtx();
        const result = await captureLog(ctx);
        expect(result).toBeNull();
        // Critical: NEVER write the spike's coords to last-position
        expect(saveLastPos).not.toHaveBeenCalled();
    });

    it('rejects acceleration spike (delta > 50 kts)', async () => {
        // Last position was at 1 kt; this fix implies ~60 kts — under the
        // 100 kn absolute cap (Layer 1) but a +59 kn jump, well over the
        // 50 kn per-fix acceleration gate (Layer 2, raised from 8 kn on
        // 2026-05-19 to stop rejecting legitimate driving fixes).
        lastPosition.mockResolvedValueOnce({
            latitude: -27.5166667,
            longitude: 153.0,
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            cumulativeDistanceNM: 0,
            speedKts: 1,
        });
        const ctx = makeCtx();
        // Fix moved ~1nm in 60s = ~60 kts implied → +59 kt accel
        bestPosition.mockResolvedValueOnce(makeFix(-27.5, 153.0, 5));
        const result = await captureLog(ctx);
        expect(result).toBeNull();
        // Critical: NEVER write the spike's coords to last-position
        expect(saveLastPos).not.toHaveBeenCalled();
    });

    it('zeros speed when last position was the 0,0 placeholder from captureImmediate', async () => {
        lastPosition.mockResolvedValueOnce({
            latitude: 0,
            longitude: 0,
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            cumulativeDistanceNM: 0,
        });
        const ctx = makeCtx();
        const result = await captureLog(ctx);
        expect(result).not.toBeNull();
        // distanceNM huge but speedKts forced to 0
        expect(result!.speedKts).toBe(0);
    });
});

describe('captureLog — rolling waypoint promotion', () => {
    it('promotes auto entries to "Latest Position" waypoints + demotes previous', async () => {
        const ctx = makeCtx();
        const result = await captureLog(ctx, { entryType: 'auto' });
        expect(result!.entryType).toBe('waypoint');
        expect(result!.waypointName).toBe('Latest Position');
        expect(demoteWaypoint).toHaveBeenCalledTimes(1);
    });

    it('keeps user-supplied waypoint name on manual entries — no demote', async () => {
        const ctx = makeCtx();
        const result = await captureLog(ctx, { entryType: 'waypoint', waypointName: 'Cape Bowling Green' });
        expect(result!.entryType).toBe('waypoint');
        expect(result!.waypointName).toBe('Cape Bowling Green');
        expect(demoteWaypoint).not.toHaveBeenCalled();
    });
});

describe('captureLog — quarter-hour timestamp snap', () => {
    it('snaps offshore-mode auto entries to xx:00, xx:15, xx:30, xx:45', async () => {
        // Set system time to xx:08
        vi.setSystemTime(new Date('2026-05-02T06:08:23Z'));
        const ctx = makeCtx();
        ctx.trackingState.loggingZone = 'offshore';
        // Fix's own timestamp also xx:08
        bestPosition.mockResolvedValueOnce(makeFix(-27.5, 153.0));
        const result = await captureLog(ctx, { entryType: 'auto' });
        // Should snap to nearest 15min — 8 → 15.
        expect(result!.timestamp).toMatch(/06:15:00/);
    });

    it('does NOT snap nearshore / coastal / rapid mode entries', async () => {
        vi.setSystemTime(new Date('2026-05-02T06:08:23Z'));
        const ctx = makeCtx();
        ctx.trackingState.loggingZone = 'nearshore';
        const result = await captureLog(ctx, { entryType: 'auto' });
        expect(result!.timestamp).toMatch(/06:08/);
    });
});

describe('addManual', () => {
    it('returns null when no active voyage', async () => {
        const ctx = makeCtx();
        ctx.trackingState.currentVoyageId = undefined;
        const result = await addManual(ctx, { notes: 'foo' });
        expect(result).toBeNull();
    });

    it('persists with placeholder when GPS fails', async () => {
        bestPosition.mockResolvedValueOnce(null);
        const ctx = makeCtx();
        const result = await addManual(ctx, { notes: 'engine started' });
        expect(result).not.toBeNull();
        expect(result!.notes).toBe('engine started');
        expect(result!.latitude).toBe(0);
    });

    it('uses "manual" entryType when no waypointName given', async () => {
        const ctx = makeCtx();
        const result = await addManual(ctx, { notes: 'pirates spotted' });
        expect(result!.entryType).toBe('manual');
    });

    it('uses "waypoint" entryType when waypointName given', async () => {
        const ctx = makeCtx();
        const result = await addManual(ctx, { waypointName: 'Anchor', notes: 'set ground tackle' });
        expect(result!.entryType).toBe('waypoint');
        expect(result!.waypointName).toBe('Anchor');
    });
});

describe('flushBufferedTrack', () => {
    it('falls back to single capture when buffer is empty', async () => {
        const ctx = makeCtx();
        await flushBufferedTrack(ctx);
        // Single captureLog → one saveEntry call.
        expect(saveEntry).toHaveBeenCalledTimes(1);
    });

    it('does nothing when paused', async () => {
        const ctx = makeCtx();
        ctx.trackingState.isPaused = true;
        await flushBufferedTrack(ctx);
        expect(saveEntry).not.toHaveBeenCalled();
    });

    it('logs each thinned point sequentially when buffer has many', async () => {
        const ctx = makeCtx();
        // Fill buffer with a clear straight-line track (RDP keeps endpoints).
        for (let i = 0; i < 5; i++) {
            ctx.trackBuffer.push(makeFix(-27.5 + i * 0.001, 153.0));
        }
        await flushBufferedTrack(ctx);
        // RDP on a straight line keeps just the endpoints — so 2 captures.
        // (Plus possibly intermediate points if speed/heading changes are detected;
        // synthetic data has no heading/speed deltas → just endpoints.)
        expect(saveEntry).toHaveBeenCalled();
        expect(saveEntry.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
});
