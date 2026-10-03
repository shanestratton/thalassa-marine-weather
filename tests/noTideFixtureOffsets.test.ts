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
import { auditUnvouchedHardLand } from '../services/engine/safetyAudit';

/** A 2.5 m top in every 0.25° bucket over Moreton Bay. */
const ceilings: TideCeiling[] = [];
for (let lat = -28.0; lat <= -26.5; lat += 0.25)
    for (let lon = 152.75; lon <= 153.75; lon += 0.25) ceilings.push({ lat, lon, highestM: 2.5, days: 14 });
const lookup = tideCeilingLookup(ceilings);
/** One nudge: 0.00006° (≈ 6.7 m north–south, 5.9 m east–west). */
const STEP_DEG = 0.00006;

/**
 * RE-PIN (D12 fix-up, 2026-10-03; owner decision 12, Shane: "Trust the
 * detailed chart"; each fixture measured in its own process, against HEAD
 * 7f230264 too). This file never checked LAND. At the alignments below, HEAD's
 * "routes" without the ceilings and with them crossed 857–875 m of unvouched
 * charted land at 153.108° E, 27.210° S (the canal estate east of the pin):
 * the canal entrance is still cut off from the bay there, and the permissive
 * policy these fixtures use bridged it over land. The production policy
 * (strict) refuses such a route: 'hard-land-crossing' at HEAD, measured at
 * Tangalooma k = 7 and 10 and Rivergate k = 10.
 *
 * Decision 12 makes the harbour cell's charted water north of the canal mouth
 * plain deep water instead of 'charts disagree' caution, so the same bridge
 * now runs north-east across the canal mouth's drying flats (dries 2.0 m) to
 * reach it. Without the ceilings (Tangalooma k = 7–11, Rivergate k = 10):
 * 519–549 m of water no tide clears and 1.2–1.4 km of charted land. With
 * them: refused 'no-tide-clears' — never a route over that water, so
 * decision 11 holds — except Tangalooma k = 7, which now routes with no
 * charted land at all, where HEAD's crossed 874 m (and the production policy
 * refused it). The production policy refuses the others (measured: strict
 * gives 'hard-land-crossing' without the ceilings, 'no-tide-clears' with).
 *
 * The cut-off itself is the grid's (the entrance runs between drying banks
 * narrower than a cell) and predates decision 12; it is left for its own
 * fix. Pinned here: which alignments are cut off, that a cut-off one is
 * refused rather than routed over drying ground or land, and that every
 * route crosses at most clips of water no tide clears and no more charted
 * land than it did.
 *
 * RE-PIN (2026-10-04, the component bridge's label fix; measured against
 * HEAD cfb5980a, each fixture in one process): that was its own fix. The cut
 * off canal pocket is exactly what the component bridge joins to the bay —
 * and the bridge skipped every pocket whose bay was numbered 0, as Moreton
 * Bay is on these grids. Bridged, no alignment is cut off. With the ceilings
 * (permissive, as here, and strict, as the app routes): Tangalooma k = 8–11
 * and Rivergate k = 10 route instead of refusing 'no-tide-clears', across at
 * most a 30 m clip of water no tide clears and 0–49 m of charted land.
 * Without them they take the same routes, where they crossed 1.2–1.4 km of
 * charted land and 548–559 m of drying ground (strict refused them
 * 'hard-land-crossing'). The land: 25–49 m at the Newport canal
 * mouth (153.0934° E, 27.2028° S) for Tangalooma k = 8–10 and 23 m at the
 * river mouth for Rivergate k = 10 — the two spots the Rivergate limit
 * below already allows. Tangalooma k = 11 crosses none. The planner and
 * Auto still refuse a route with any land away from the pins.
 */
const CUT_OFF: Record<string, readonly number[]> = { tangalooma: [], rivergate: [] };
/** The longest charted-land run a routed alignment may cross (m): the ~50 m
 * at the Newport canal mouth and the river mouth that Rivergate's k = 3 and
 * 5 cross at HEAD too (49–50 m and 25–42 m measured), and Tangalooma's
 * k = 8–10 at the canal mouth since the label fix (25–49 m). */
const MAX_LAND_RUN_M: Record<string, number> = { tangalooma: 50, rivergate: 50 };

for (const [name, nudge, ks] of [
    ['tangalooma', 'east', [7, 8, 9, 10, 11]],
    ['rivergate', 'south', [3, 5, 10]],
] as const) {
    describe(`decision 11 — Newport → ${name}, destination nudged ${nudge}`, { timeout: 300_000 }, () => {
        const fx = loadFixture(`newport-${name}.corridor.json.gz`);
        const layers = assembleLayers(fx);
        for (const k of ks) {
            const cutOff = CUT_OFF[name].includes(k);
            it(`k = ${k}: ${cutOff ? 'cut off — refused, never routed over water no tide clears' : 'a route, over no more than a clip of water no tide clears'}`, () => {
                const base = { ...fx.request, draftM: 2.4, safetyM: 0.5 };
                const req =
                    nudge === 'east'
                        ? { ...base, toLon: base.toLon + k * STEP_DEG }
                        : { ...base, toLat: base.toLat - k * STEP_DEG };
                const today = routeInshore(layers, req);
                expect('error' in today ? today.error : 'routed').toBe('routed');
                const r = routeInshore(layers, { ...req, tideCeilings: ceilings });
                if (cutOff) {
                    expect('error' in r ? r.code : 'routed').toBe('no-tide-clears');
                    return;
                }
                expect('error' in r ? `${r.code}: ${r.error}` : 'routed').toBe('routed');
                if ('error' in r || 'error' in today) return;
                // Without the ceilings it crossed at most a few runs of it (not
                // Tangalooma k = 7: its permissive bridge crosses 519 m, see the
                // header; with the ceilings it is clean)…
                if (name === 'rivergate') {
                    const todayM = noTideTotalM(noTideClearsRuns(layers, today.polyline, lookup, 2.9));
                    expect(todayM).toBeLessThan(200);
                }
                // …and with them, at most clips (each within 30 m between its
                // first and last proved samples — 50 m out to the band edges).
                for (const run of noTideClearsRuns(layers, r.polyline, lookup, 2.9))
                    expect(run.lengthM).toBeLessThanOrEqual(30);
                expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBeLessThanOrEqual(MAX_LAND_RUN_M[name]);
            });
        }
    });
}
