/**
 * The 125-11 smoke must be able to sound at a berth (review finding): the
 * rule is awareness only under 0.5 kn, and Shane runs the smoke at a marina
 * dock. Started there, the injector gives the rule a fictional own motion
 * (smoke builds only) and feeds the crosser along the relative track, so the
 * scenario as started alarms, CPA ~0, all the way in.
 *
 * Positions are worldwide (Brest, Auckland): a global app. Fictional MMSI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    position: { lat: 48.38, lon: -4.49, sog: 0, cog: 0, timestamp: 0, source: 'gps' } as Record<string, unknown> | null,
    motion: { sogKn: 0 as number | null, cogDeg: null as number | null, source: 'phone', pair: 'inshore' },
    setDebugOwnMotion: vi.fn(),
}));

vi.mock('../services/ownshipPosition', () => ({
    getCachedOwnshipPosition: () => hoisted.position,
    resolveOwnMotion: () => hoisted.motion,
    setDebugOwnMotion: hoisted.setDebugOwnMotion,
}));

import { AisStore } from '../services/AisStore';
import {
    DEBUG_CROSSER,
    DEBUG_OWN_MOTION_KN,
    planDebugCrossing,
    startDebugCrossing,
    stopDebugAisInjector,
} from '../services/debug/aisInjector';
import { assessCollision } from '../utils/collisionRule';

const START = Date.UTC(2026, 9, 9, 20, 0, 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    AisStore.stop();
    hoisted.setDebugOwnMotion.mockClear();
});

afterEach(() => {
    stopDebugAisInjector();
    vi.useRealTimers();
});

describe('the smoke crossing alarms as started', () => {
    for (const [where, at] of [
        ['Brest', { lat: 48.38, lon: -4.49 }],
        ['Auckland', { lat: -36.84, lon: 174.77 }],
    ] as const) {
        it(`at a berth (${where}): the rule, told the fictional own motion, alarms all the way to CPA`, () => {
            const crossing = planDebugCrossing(at, { sogKn: 0, cogDeg: null });
            expect(crossing.mode).toBe('berth');
            expect(crossing.ownMotion).toEqual({ sogKn: DEBUG_OWN_MOTION_KN, cogDeg: 0 });
            expect(crossing.summary).toMatch(/not making way/);
            for (const minute of [0, 2, 4, 6, 7.5]) {
                const her = crossing.positionAt(minute * 60_000);
                const a = assessCollision(
                    { ...at, ...crossing.ownMotion },
                    { ...her, sogKn: crossing.speedKn, cogDeg: crossing.courseDeg, source: 'local', reportAgeSec: 2 },
                )!;
                expect(a.alarm, `minute ${minute}`).toBe(true);
                expect(a.cpaNm!).toBeLessThan(0.02);
                expect(a.tcpaMin!).toBeCloseTo(8 - minute, 0);
            }
        });
    }

    it('under way: our real motion, her real track', () => {
        const at = { lat: 48.38, lon: -4.49 };
        const crossing = planDebugCrossing(at, { sogKn: 6, cogDeg: 45 });
        expect(crossing.mode).toBe('under-way');
        const a = assessCollision(
            { ...at, sogKn: 6, cogDeg: 45 },
            { ...crossing.positionAt(0), sogKn: crossing.speedKn, cogDeg: crossing.courseDeg, source: 'local' },
        )!;
        expect(a.alarm).toBe(true);
        expect(a.tcpaMin!).toBeCloseTo(8, 0);
    });

    it('startDebugCrossing at a berth sets the fictional own motion and feeds a real AIS target', () => {
        hoisted.position = { lat: 48.38, lon: -4.49, sog: 0, cog: 0, timestamp: START, source: 'gps' };
        hoisted.motion = { sogKn: 0, cogDeg: null, source: 'phone', pair: 'inshore' };
        const said = startDebugCrossing();
        expect(said).toMatch(/DEBUG CROSSER is crossing from starboard/);
        expect(hoisted.setDebugOwnMotion).toHaveBeenCalledWith(
            expect.objectContaining({ sogKn: DEBUG_OWN_MOTION_KN, cogDeg: 0, until: START + 16 * 60_000 }),
        );
        vi.advanceTimersByTime(3 * 60_000);
        const her = AisStore.getTargets().get(DEBUG_CROSSER.mmsi)!;
        expect(her.name.trim()).toBe(DEBUG_CROSSER.name);
        const a = assessCollision(
            { lat: 48.38, lon: -4.49, sogKn: DEBUG_OWN_MOTION_KN, cogDeg: 0 },
            { lat: her.lat, lon: her.lon, sogKn: her.sog, cogDeg: her.cog, source: 'local', reportAgeSec: 1 },
        )!;
        expect(a.alarm).toBe(true);
        expect(a.tcpaMin!).toBeCloseTo(5, 0);

        stopDebugAisInjector();
        expect(hoisted.setDebugOwnMotion).toHaveBeenLastCalledWith(null);
    });
});
