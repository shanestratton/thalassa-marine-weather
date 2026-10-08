/**
 * Own-ship motion for the collision rule (125-01 scope item 6): the boat's own
 * GPS is the truth (NmeaStore SOG/COG, any lane), else this phone's fix.
 * Unknown stays unknown — the rule turns it into range-only, never a 0 kn
 * own ship that makes every crossing look like a stopped boat's problem.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { __resetOwnMotionForTests, resolveOwnMotion, setDebugOwnMotion } from '../services/ownshipPosition';

beforeEach(() => __resetOwnMotionForTests());

const NOW = Date.UTC(2026, 9, 9, 4, 0, 0);
const metric = (value: number | null, age = 1_000, freshness = 'live') => ({
    value,
    lastUpdated: NOW - age,
    freshness,
});
const phone = (speedMs: number, heading: number | null, age = 2_000) => ({
    latitude: 41.38,
    longitude: 2.19,
    accuracy: 5,
    altitude: null,
    heading,
    speed: speedMs,
    timestamp: NOW - age,
});

describe('resolveOwnMotion', () => {
    it("prefers the boat's own GPS over the phone", () => {
        const motion = resolveOwnMotion({ sog: metric(6.2), cog: metric(45) }, phone(3, 90), NOW);
        expect(motion).toEqual({ sogKn: 6.2, cogDeg: 45, source: 'nmea', pair: 'offshore' });
    });

    it("falls back to the phone's fix when the boat's SOG is dead", () => {
        const motion = resolveOwnMotion(
            { sog: metric(6.2, 20_000, 'dead'), cog: metric(45, 20_000, 'dead') },
            phone(3, 90),
            NOW,
        );
        expect(motion.source).toBe('phone');
        expect(motion.sogKn).toBeCloseTo(5.83, 2);
        expect(motion.cogDeg).toBe(90);
    });

    it('never mixes the two: a boat SOG without a boat COG keeps the course unknown', () => {
        expect(resolveOwnMotion({ sog: metric(6.2), cog: metric(null) }, phone(3, 90), NOW)).toMatchObject({
            sogKn: 6.2,
            cogDeg: null,
            source: 'nmea',
        });
    });

    it("keeps the phone's missing heading unknown", () => {
        expect(resolveOwnMotion({}, phone(3, -1), NOW).cogDeg).toBeNull();
        expect(resolveOwnMotion({}, phone(3, null), NOW).cogDeg).toBeNull();
    });

    it('treats an old phone fix as no motion at all', () => {
        expect(resolveOwnMotion({}, phone(3, 90, 61_000), NOW)).toMatchObject({
            sogKn: null,
            cogDeg: null,
            source: null,
        });
    });

    it('reports nothing when there is nothing', () => {
        expect(resolveOwnMotion({}, null, NOW)).toMatchObject({ sogKn: null, cogDeg: null, source: null });
    });

    it('rejects a boat COG of 360 (not available)', () => {
        expect(resolveOwnMotion({ sog: metric(5), cog: metric(360) }, null, NOW).cogDeg).toBeNull();
    });

    it('reads a phone fix that came with no speed as unknown, never as stopped (web / PWA lanes)', () => {
        // GpsService stamps speedUnknown where the platform gave null and it
        // filled in a placeholder 0.
        const noSpeed = { ...phone(0, null), speedUnknown: true };
        expect(resolveOwnMotion({}, noSpeed, NOW)).toMatchObject({ sogKn: null, cogDeg: null, source: null });
        // A measured 0 is still a measured 0.
        expect(resolveOwnMotion({}, phone(0, null), NOW).sogKn).toBe(0);
    });

    it('carries the pair in use, with its hysteresis shared by every caller', () => {
        const at = (kn: number) => resolveOwnMotion({ sog: metric(kn), cog: metric(90) }, null, NOW).pair;
        expect(at(2.8)).toBe('inshore');
        expect(at(3.1)).toBe('offshore');
        expect(at(2.8)).toBe('offshore');
        expect(at(3.2)).toBe('offshore');
        expect(at(2.4)).toBe('inshore');
        expect(at(2.9)).toBe('inshore');
    });

    it('ignores the smoke-only debug own motion in every build but the smoke build', () => {
        // vitest defines __THALASSA_DEBUG_AIS_INJECTOR__ false, as every release does.
        setDebugOwnMotion({ sogKn: 5, cogDeg: 0, until: NOW + 60_000 });
        expect(resolveOwnMotion({}, null, NOW)).toMatchObject({ sogKn: null, source: null });
        // And every read of it sits behind the build-time constant.
        const source = readFileSync(resolve(process.cwd(), 'services/ownshipPosition.ts'), 'utf8');
        const reads = source
            .split('\n')
            .filter((line) => /debugOwnMotion\b/.test(line) && !/^\s*(\*|\/\/|let )/.test(line));
        for (const line of reads) {
            if (/__resetOwnMotionForTests|debugOwnMotion = null;$/.test(line.trim())) continue;
            expect(line, line).toMatch(/__THALASSA_DEBUG_AIS_INJECTOR__|debugOwnMotion\.(sogKn|cogDeg)/);
        }
    });
});
