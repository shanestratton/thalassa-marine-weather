/**
 * The 125-11 smoke must be able to sound at a berth (review finding): the
 * rule is awareness only under 0.5 kn, and Shane runs the smoke at a marina
 * dock. Started there, the injector gives the rule a fictional own motion
 * (smoke builds only) and feeds the crosser along the relative track, so the
 * scenario as started alarms, CPA ~0, all the way in.
 *
 * 125-01b adds the anchored smoke: stopped with the anchor watch on, a ship
 * under way passes 0.05 NM off, and close quarters must sound; with no anchor
 * watch (a berth) the same pass must stay quiet.
 *
 * Positions are worldwide (Brest, Auckland, Mindelo): a global app. Fictional MMSIs.
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
    DEBUG_PASSER,
    planDebugAnchorPass,
    planDebugCrossing,
    startDebugAnchorPass,
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
                    { ...at, ...crossing.ownMotion, atAnchor: false },
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
            { ...at, sogKn: 6, cogDeg: 45, atAnchor: false },
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
            { lat: 48.38, lon: -4.49, sogKn: DEBUG_OWN_MOTION_KN, cogDeg: 0, atAnchor: false },
            { lat: her.lat, lon: her.lon, sogKn: her.sog, cogDeg: her.cog, source: 'local', reportAgeSec: 1 },
        )!;
        expect(a.alarm).toBe(true);
        expect(a.tcpaMin!).toBeCloseTo(5, 0);

        stopDebugAisInjector();
        expect(hoisted.setDebugOwnMotion).toHaveBeenLastCalledWith(null);
    });
});

describe('the anchored smoke (125-01b): close quarters at anchor, quiet at a berth', () => {
    for (const [where, at] of [
        ['Brest', { lat: 48.38, lon: -4.49 }],
        ['Mindelo', { lat: 16.89, lon: -24.99 }],
    ] as const) {
        it(`${where}: a ship under way passes 0.05 NM off; it sounds only once inside 3 min, only at anchor`, () => {
            // Our own motion unknown: the run is told we are stopped.
            const pass = planDebugAnchorPass(at, { sogKn: null, cogDeg: null });
            expect(pass.mode).toBe('anchor');
            expect(pass.forcesOwnMotion).toBe(true);
            expect(pass.ownMotion).toEqual({ sogKn: 0, cogDeg: 0 });
            expect(pass.speedKn).toBeGreaterThan(2);
            expect(pass.summary).toMatch(/anchor watch/);
            for (const [minute, inside] of [
                [0, false],
                [1.5, false],
                [2.5, true],
                [4, true],
                [4.8, true],
            ] as const) {
                const her = pass.positionAt(minute * 60_000);
                const target = {
                    ...her,
                    sogKn: pass.speedKn,
                    cogDeg: pass.courseDeg,
                    source: 'local',
                    reportAgeSec: 2,
                };
                const anchored = assessCollision({ ...at, ...pass.ownMotion, atAnchor: true }, target)!;
                const berth = assessCollision({ ...at, ...pass.ownMotion, atAnchor: false }, target)!;
                expect(anchored.cpaNm!, `minute ${minute}`).toBeCloseTo(0.05, 2);
                expect(anchored.tcpaMin!, `minute ${minute}`).toBeCloseTo(5 - minute, 0);
                expect(anchored.alarm, `minute ${minute}`).toBe(inside);
                expect(anchored.closeQuarters, `minute ${minute}`).toBe(inside);
                expect(berth.alarm, `minute ${minute}`).toBe(false);
            }
        });
    }

    it('startDebugAnchorPass tells the rule we are stopped and feeds a real AIS target', () => {
        hoisted.position = { lat: 16.89, lon: -24.99, sog: 0, cog: 0, timestamp: START, source: 'nmea' };
        hoisted.motion = { sogKn: null, cogDeg: null, source: 'phone', pair: 'inshore' };
        const said = startDebugAnchorPass();
        expect(said).toMatch(/DEBUG PASSER/);
        expect(said).toMatch(/anchor watch/);
        expect(hoisted.setDebugOwnMotion).toHaveBeenCalledWith(
            expect.objectContaining({ sogKn: 0, cogDeg: 0, until: START + 16 * 60_000 }),
        );
        vi.advanceTimersByTime(3 * 60_000);
        const her = AisStore.getTargets().get(DEBUG_PASSER.mmsi)!;
        expect(her.name.trim()).toBe(DEBUG_PASSER.name);
        const target = {
            lat: her.lat,
            lon: her.lon,
            sogKn: her.sog,
            cogDeg: her.cog,
            source: 'local',
            reportAgeSec: 1,
        };
        const ownship = { lat: 16.89, lon: -24.99, sogKn: 0, cogDeg: 0 };
        expect(assessCollision({ ...ownship, atAnchor: true }, target)!.alarm).toBe(true);
        expect(assessCollision({ ...ownship, atAnchor: false }, target)!.alarm).toBe(false);

        stopDebugAisInjector();
        expect(hoisted.setDebugOwnMotion).toHaveBeenLastCalledWith(null);
    });

    it('our real motion already reads stopped: never overridden, so the smoke runs the real chain', () => {
        const at = { lat: 16.89, lon: -24.99 };
        for (const motion of [
            { sogKn: 0, cogDeg: null },
            { sogKn: 0.3, cogDeg: 215 },
        ]) {
            const pass = planDebugAnchorPass(at, motion);
            expect(pass.forcesOwnMotion, JSON.stringify(motion)).toBe(false);
            expect(pass.ownMotion).toEqual(motion);
            expect(pass.summary).toMatch(/reads stopped/);
            expect(pass.summary).not.toMatch(/told we are stopped/);
        }
        // Unknown, or moving (yawing at anchor reads as moving here): forced, and it says so.
        for (const [motion, says] of [
            [{ sogKn: null, cogDeg: null }, /reads unknown/],
            [{ sogKn: 1.2, cogDeg: 90 }, /reads 1\.2 kn/],
        ] as const) {
            const pass = planDebugAnchorPass(at, motion);
            expect(pass.forcesOwnMotion).toBe(true);
            expect(pass.ownMotion).toEqual({ sogKn: 0, cogDeg: 0 });
            expect(pass.summary).toMatch(says);
            expect(pass.summary).toMatch(/told we are stopped/);
        }

        hoisted.position = { ...at, sog: 0, cog: 0, timestamp: START, source: 'gps' };
        hoisted.motion = { sogKn: 0.2, cogDeg: null, source: 'phone', pair: 'inshore' };
        const said = startDebugAnchorPass();
        expect(said).toMatch(/reads stopped/);
        // Only the reset: no fictional own motion was set for the run.
        expect(hoisted.setDebugOwnMotion.mock.calls.every(([arg]) => arg === null)).toBe(true);
        vi.advanceTimersByTime(3 * 60_000);
        expect(AisStore.getTargets().get(DEBUG_PASSER.mmsi)).toBeTruthy();
    });
});
