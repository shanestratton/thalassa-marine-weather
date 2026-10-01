/**
 * Decision 11 on the golden fixtures, with the destination nudged a few metres
 * (fix-up, 2026-10-01).
 *
 * Moving a pin a few metres shifts the 50 m grid by under a cell. At some
 * alignments the Newport origin was cut off from the bay (its entrance runs
 * between drying banks narrower than a cell), and a 2.5 m top refused
 * Newport → Tangalooma (destination 41–65 m east) and Newport → Rivergate
 * (20 and 67 m south) with "the only way through crosses water near
 * 27.204° S, 153.089° E, charted to dry 2.0 m" — the drying ground beside
 * Shane's home canal, named on the straight bridge from the cut-off pin —
 * while without the ceilings the same requests routed over none of that
 * water, or 130 m of clips. Measured on the crashed draft, each fixture in
 * its own process: Tangalooma k = 7–11 and Rivergate k = 3 and 10 refused.
 *
 * Serene Summer: 2.4 m draft, 0.5 m UKC — she needs 2.9 m.
 */
import { describe, expect, it } from 'vitest';
import { assembleLayers, loadFixture } from './helpers/corridorFixture';
import { routeInshore } from '../services/inshoreRouterEngine';
import type { TideCeiling } from '../services/engine/types';
import { noTideClearsRuns, noTideTotalM, tideCeilingLookup } from '../services/engine/tideCeiling';

/** A 2.5 m top in every 0.25° bucket over Moreton Bay. */
const ceilings: TideCeiling[] = [];
for (let lat = -28.0; lat <= -26.5; lat += 0.25)
    for (let lon = 152.75; lon <= 153.75; lon += 0.25) ceilings.push({ lat, lon, highestM: 2.5, days: 14 });
const lookup = tideCeilingLookup(ceilings);
/** One nudge: 0.00006° (≈ 6.7 m north–south, 5.9 m east–west). */
const STEP_DEG = 0.00006;

for (const [name, nudge, ks] of [
    ['tangalooma', 'east', [7, 8, 9, 10, 11]],
    ['rivergate', 'south', [3, 5, 10]],
] as const) {
    describe(`decision 11 — Newport → ${name}, destination nudged ${nudge}`, { timeout: 300_000 }, () => {
        const fx = loadFixture(`newport-${name}.corridor.json.gz`);
        const layers = assembleLayers(fx);
        for (const k of ks) {
            it(`k = ${k}: a route, over no more than a clip of water no tide clears`, () => {
                const base = { ...fx.request, draftM: 2.4, safetyM: 0.5 };
                const req =
                    nudge === 'east'
                        ? { ...base, toLon: base.toLon + k * STEP_DEG }
                        : { ...base, toLat: base.toLat - k * STEP_DEG };
                const today = routeInshore(layers, req);
                expect('error' in today ? today.error : 'routed').toBe('routed');
                const r = routeInshore(layers, { ...req, tideCeilings: ceilings });
                expect('error' in r ? `${r.code}: ${r.error}` : 'routed').toBe('routed');
                if ('error' in r || 'error' in today) return;
                // Without the ceilings it crossed at most a few runs of it…
                const todayM = noTideTotalM(noTideClearsRuns(layers, today.polyline, lookup, 2.9));
                expect(todayM).toBeLessThan(200);
                // …and with them, at most clips (each within 30 m between its
                // first and last proved samples — 50 m out to the band edges).
                for (const run of noTideClearsRuns(layers, r.polyline, lookup, 2.9))
                    expect(run.lengthM).toBeLessThanOrEqual(30);
            });
        }
    });
}
