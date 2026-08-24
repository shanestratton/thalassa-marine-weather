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
 *
 * HISTORY (2026-08-25): the first shipped shape nested the zoom interpolate
 * inside the step outputs — a position Mapbox forbids for ['zoom'] — so the
 * real Style.setPaintProperty rejected the whole property and the glaze
 * painted NOTHING over imagery for two days while this file, asserting the
 * malformed structure, stayed green. The tests are now SEMANTIC (evaluated
 * through evalExpr), plus one legality assertion that would have caught it.
 */
import { describe, expect, it } from 'vitest';
import { buildDepareSatelliteOpacity } from '../components/map/encDepthStyle';
import { assertZoomTopLevelOnly, evalExpr } from './enc/exprEval';

const opacity = (drval1: number, zoom: number, S = 3, H?: number): number =>
    evalExpr(buildDepareSatelliteOpacity(S, H), { props: { DRVAL1: drval1 }, zoom }) as number;

describe('glaze fade past z13', () => {
    it('is a paint expression Mapbox will actually accept', () => {
        // The bug this file failed to catch: ['zoom'] anywhere but the input
        // of the TOP-LEVEL step/interpolate makes setPaintProperty reject the
        // property, leaving the mount placeholder 0 — an invisible glaze.
        assertZoomTopLevelOnly(buildDepareSatelliteOpacity(3, 5));
        assertZoomTopLevelOnly(buildDepareSatelliteOpacity(3));
        // And the guard itself has teeth: the old malformed nesting throws.
        expect(() =>
            assertZoomTopLevelOnly([
                'case',
                true,
                [
                    'step',
                    ['get', 'DRVAL1'],
                    0.55,
                    3,
                    ['*', 0.62, ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 0.65]],
                ],
                0,
            ]),
        ).toThrow();
    });

    it('leaves every WARNING band at full strength across the fade', () => {
        // Drying (DRVAL1 < 0), charted-shallow, and the router-hazard caution
        // band. If any of these ever thins with zoom, a shoal warning has been
        // made to fade out as the boat approaches it.
        for (const zoom of [12, 13, 14, 15, 18]) {
            expect(opacity(-1, zoom, 3, 5)).toBe(0.55); // drying
            expect(opacity(1, zoom, 3, 5)).toBe(opacity(1, 12, 3, 5)); // charted-shallow
            expect(opacity(4, zoom, 3, 5)).toBe(opacity(4, 12, 3, 5)); // router-hazard caution
        }
    });

    it('fades every SAFE-WATER band, and only those, from z13 to z15', () => {
        for (const drval1 of [6, 25, 60]) {
            const atStart = opacity(drval1, 13, 3, 5);
            const atEnd = opacity(drval1, 15, 3, 5);
            const midway = opacity(drval1, 14, 3, 5);
            expect(atEnd).toBeLessThan(atStart);
            expect(midway).toBeLessThan(atStart);
            expect(midway).toBeGreaterThan(atEnd);
            // Floor 0.65: the z15 wash is exactly the z13 wash thinned 35%.
            expect(atEnd).toBeCloseTo(atStart * 0.65, 10);
        }
    });

    it('holds steady outside the fade window', () => {
        expect(opacity(25, 10, 3, 5)).toBe(opacity(25, 13, 3, 5)); // below start: full
        expect(opacity(25, 18, 3, 5)).toBe(opacity(25, 15, 3, 5)); // past end: floor
    });

    it('never reaches zero — the wash still says "sailable"', () => {
        // A floor, not an off switch — and above the loudest caution wash
        // (CAUTION_BAND_OPACITY 0.36) so safe water outranks every warning
        // even at the quiet end. Losing the GO verdict entirely inside a reef
        // lagoon is not an improvement over losing the imagery.
        for (const drval1 of [6, 25, 60]) {
            const faded = opacity(drval1, 18, 3, 5);
            expect(faded).toBeGreaterThan(0.36);
        }
    });

    it('holds when there is no distinct hazard depth', () => {
        // One-arg callers and the deep-draft case where hazard clamps to
        // safety: the caution band collapses, and the safe stops must still
        // fade while nothing below them does.
        expect(opacity(-1, 15, 3)).toBe(0.55);
        expect(opacity(1, 15, 3)).toBe(opacity(1, 12, 3));
        expect(opacity(25, 15, 3)).toBeCloseTo(opacity(25, 13, 3) * 0.65, 10);
    });
});
