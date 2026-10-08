/**
 * The 125-11 smoke's beacon (smoke builds only, like the crossing target): a
 * fictional AIS-SART through the real receiver path, in test mode (status 15
 * and 'SART TEST') or active (status 14 and 'SART ACTIVE'), drifting so the
 * Go-to page has something to follow. Starting 'active' after 'test' is the
 * test-to-active switch that must sound again.
 *
 * Fictional MMSI (970 with manufacturer 00). Positions worldwide (Auckland, and
 * Fiji across the antimeridian).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    position: { lat: -36.84, lon: 174.77, sog: 0, cog: 0, timestamp: 0, source: 'gps' } as Record<
        string,
        unknown
    > | null,
}));

vi.mock('../services/ownshipPosition', () => ({
    getCachedOwnshipPosition: () => hoisted.position,
    resolveOwnMotion: () => ({ sogKn: 0, cogDeg: null, source: 'phone', pair: 'inshore' }),
    setDebugOwnMotion: vi.fn(),
}));

import { AisStore } from '../services/AisStore';
import { DEBUG_SART, startDebugSart, stopDebugAisInjector } from '../services/debug/aisInjector';
import { classifyDistress, distressKindOfMmsi, rangeBearing } from '../utils/collisionRule';

const START = Date.UTC(2026, 9, 9, 20, 0, 0);

function classified() {
    const t = AisStore.getTargets().get(DEBUG_SART.mmsi);
    const text = AisStore.getSafetyText(DEBUG_SART.mmsi);
    return classifyDistress({
        mmsi: DEBUG_SART.mmsi,
        navStatus: t?.navStatus ?? null,
        navStatusAt: t?.lastUpdated ?? null,
        safetyText: text?.text ?? null,
        safetyTextAt: text?.at ?? null,
        source: 'local',
        hasPosition: !!t,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    AisStore.stop();
    hoisted.position = { lat: -36.84, lon: 174.77, sog: 0, cog: 0, timestamp: START, source: 'gps' };
});

afterEach(() => {
    stopDebugAisInjector();
    AisStore.stop();
    vi.useRealTimers();
});

describe('the smoke SART', () => {
    it('is a fictional 970 beacon', () => {
        expect(distressKindOfMmsi(DEBUG_SART.mmsi)).toBe('sart');
    });

    it('in test mode: status 15 and SART TEST, a test that never alarms', () => {
        const summary = startDebugSart('test');
        expect(summary).toMatch(/test/i);
        expect(AisStore.getSafetyText(DEBUG_SART.mmsi)?.text).toBe('SART TEST');
        expect(classified()).toMatchObject({ state: 'test', sounds: false });
        vi.advanceTimersByTime(90_000);
        expect(classified()).toMatchObject({ state: 'test', sounds: false });
    });

    it('switched to active: status 14 and SART ACTIVE, which sounds', () => {
        startDebugSart('test');
        vi.advanceTimersByTime(10_000);
        const summary = startDebugSart('active');
        expect(summary).toMatch(/active/i);
        expect(classified()).toMatchObject({ state: 'active', sounds: true, positionKnown: true });
    });

    it('starts about 1.5 NM off and drifts, so Go to it has a moving mark to follow', () => {
        startDebugSart('active');
        const first = { ...AisStore.getTargets().get(DEBUG_SART.mmsi)! };
        const away = rangeBearing(-36.84, 174.77, first.lat, first.lon);
        expect(away.rangeNm).toBeGreaterThan(1.3);
        expect(away.rangeNm).toBeLessThan(1.7);
        vi.advanceTimersByTime(5 * 60_000);
        const later = AisStore.getTargets().get(DEBUG_SART.mmsi)!;
        const drift = rangeBearing(first.lat, first.lon, later.lat, later.lon);
        expect(drift.rangeNm).toBeGreaterThan(0.05);
    });

    it('drifts across the antimeridian without a jump (Fiji)', () => {
        hoisted.position = { lat: -16.8, lon: 179.99, sog: 0, cog: 0, timestamp: START, source: 'gps' };
        startDebugSart('active');
        vi.advanceTimersByTime(10 * 60_000);
        const t = AisStore.getTargets().get(DEBUG_SART.mmsi)!;
        expect(t.lon).toBeGreaterThanOrEqual(-180);
        expect(t.lon).toBeLessThanOrEqual(180);
        expect(rangeBearing(-16.8, 179.99, t.lat, t.lon).rangeNm).toBeLessThan(2);
    });

    it('needs a fix to place it, and says so', () => {
        hoisted.position = null;
        expect(startDebugSart('active')).toMatch(/No position fix/);
        expect(AisStore.getTargets().has(DEBUG_SART.mmsi)).toBe(false);
    });
});
