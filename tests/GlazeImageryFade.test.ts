/**
 * "at about zoom 13.5 a very high quality image flashes on the screen and then
 * it goes away" (Shane 2026-08-23).
 *
 * What he was watching is the Maxar tile landing crisp and the depth glaze
 * painting over it. That is the glaze doing its job — but at that range he is
 * close enough to read individual coral heads out of the imagery, and at Lady
 * Musgrave the imagery is the better information.
 *
 * SO THE SAFE-WATER WASH THINS OUT PAST z13, AND NOTHING ELSE DOES.
 *
 * That distinction is the whole design. The glaze's verdict is safety-bearing:
 * drying, charted-shallow and the router-hazard caution band each carry their
 * own wash, and bright paper means water you can sail. Fading the lot would
 * strip the shoal warnings at exactly the zoom where the boat is closest to
 * them. These tests exist to stop someone "simplifying" this into one fade.
 */
import { describe, expect, it } from 'vitest';
import { buildDepareSatelliteOpacity } from '../components/map/encDepthStyle';

type Expr = unknown;
const isFaded = (v: Expr): boolean => Array.isArray(v) && v[0] === '*';

/** The `step` output list: [stopValue, output, stopValue, output, …] after the
 *  leading default. Returns { belowHazard, atOrAboveHazard } outputs. */
function stopOutputs(safety: number, hazard: number) {
    const expr = buildDepareSatelliteOpacity(safety, hazard) as unknown[];
    const step = expr[2] as unknown[];
    expect(step[0]).toBe('step');
    const dryingDefault = step[2]; // output before the first stop
    const rest = step.slice(3);
    const pairs: { at: number; out: Expr }[] = [];
    for (let i = 0; i + 1 < rest.length; i += 2) pairs.push({ at: rest[i] as number, out: rest[i + 1] });
    return { dryingDefault, pairs, hazard };
}

describe('glaze fade past z13', () => {
    it('leaves every WARNING band at full strength', () => {
        // Drying, charted-shallow, and the router-hazard caution band. If any
        // of these ever becomes a '*' expression, a shoal warning has been
        // made to fade out as the boat approaches it.
        const { dryingDefault, pairs, hazard } = stopOutputs(3, 5);
        expect(isFaded(dryingDefault)).toBe(false);
        expect(dryingDefault).toBe(0.55);
        for (const p of pairs.filter((x) => x.at < hazard)) {
            expect(isFaded(p.out)).toBe(false);
            expect(typeof p.out).toBe('number');
        }
    });

    it('fades every SAFE-WATER band, and only those', () => {
        const { pairs, hazard } = stopOutputs(3, 5);
        const safe = pairs.filter((x) => x.at >= hazard);
        expect(safe.length).toBeGreaterThanOrEqual(3);
        for (const p of safe) expect(isFaded(p.out)).toBe(true);
    });

    it('fades on ZOOM, from 13 to 15', () => {
        const { pairs, hazard } = stopOutputs(3, 5);
        const [, fade] = pairs.find((p) => p.at >= hazard)!.out as [string, number, unknown[]];
        const f = (pairs.find((p) => p.at >= hazard)!.out as unknown[])[2] as unknown[];
        expect(f[0]).toBe('interpolate');
        expect(f[2]).toEqual(['zoom']);
        // Floor is bounded from below by the brightness invariant: safe water
        // must outrank every caution wash, so 0.62 x floor > 0.36.
        expect(f.slice(3)).toEqual([13, 1, 15, 0.65]);
        expect(typeof fade).toBe('number');
    });

    it('never reaches zero — the wash still says "sailable"', () => {
        // A floor, not an off switch. At z15+ the glaze is quiet, not absent;
        // losing the GO verdict entirely inside a reef lagoon is not an
        // improvement over losing the imagery.
        const { pairs, hazard } = stopOutputs(3, 5);
        for (const p of pairs.filter((x) => x.at >= hazard)) {
            const [, base, fadeExpr] = p.out as [string, number, unknown[]];
            const floor = (fadeExpr as unknown[]).at(-1) as number;
            expect(floor).toBeGreaterThan(0);
            // Above the loudest caution wash (CAUTION_BAND_OPACITY 0.36), not
            // merely above zero — see the ordering test in
            // tests/enc/encDepthStyle.test.ts.
            expect(base * floor).toBeGreaterThan(0.36);
        }
    });

    it('holds when there is no distinct hazard depth', () => {
        // One-arg callers and the deep-draft case where hazard clamps to
        // safety: the caution band collapses, and the safe stops must still
        // fade while nothing below them does.
        const { dryingDefault, pairs, hazard } = stopOutputs(3, 3);
        expect(isFaded(dryingDefault)).toBe(false);
        expect(pairs.filter((x) => x.at >= hazard).every((p) => isFaded(p.out))).toBe(true);
        expect(pairs.filter((x) => x.at < hazard).every((p) => !isFaded(p.out))).toBe(true);
    });
});
