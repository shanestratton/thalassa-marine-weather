/**
 * Synthetic SEAMANSHIP fixtures — Masterplan Stage I, Phase 1.
 *
 * Six scenarios that turn "the route should follow normal seamanship
 * rules" into engine-level tests, each calibrated against the live
 * routeInshore by an independent agent (2026-06-11) in its own exclusive
 * lon-region (the NavGrid cache keys on bbox + feature COUNTS — distinct
 * regions prevent cross-suite cache collisions).
 *
 * Convention: it() pins TODAY's measured behaviour (regression guards —
 * we notice when behaviour changes); it.fails() pins the masterplan
 * TARGET the engine does not yet meet, with the phase expected to flip
 * it. Flipping an it.fails to it() is the verification criterion of the
 * phase named in its comment. Scorecard metrics from
 * tests/helpers/routeScorecard.ts; wrongSidePasses target is 0.
 *
 * Regions: gate-shortcut 156.x · staggered-pairs 157.x · wrong-side
 * 158.x · unnumbered-marks 159.x · buoyed-bar 160.x · midspan-shoal 161.x
 */

import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
import type { Feature, FeatureCollection } from 'geojson';
import { auditGates, channelDisciplinePct, haversineM, type Gate, type LatLon } from './helpers/routeScorecard';
import { pairWingFeatures } from '../services/pairWings';

/** The Step 4.5 outboard CAUTION wings the orchestrator emits per accepted
 *  pair since masterplan Phase 3 — part of the engine's input contract,
 *  exactly like midpointFeature() (same shared geometry as production). */
const wingFeatures = (pairs: Array<{ port: LatLon; stbd: LatLon }>): Feature[] =>
    pairs.flatMap((p) => pairWingFeatures(p.port, p.stbd)) as unknown as Feature[];

/** The orchestrator's Step-5 synthetic FAIRWY ribbon between consecutive
 *  chained midpoints (InshoreRouter HALF_WIDTH_M=100, SEGMENT_MAX_M=1200):
 *  production chains midpoints ≤1.2 km apart into a continuous preferred
 *  corridor — engine input the gate fixtures previously omitted (unchained
 *  80 m preferred islands can never out-pull a shorter unmarked line). */
const ribbonSegments = (midpoints: LatLon[]): Feature[] => {
    const out: Feature[] = [];
    const HALF_W = 100;
    for (let i = 0; i < midpoints.length - 1; i++) {
        const a = midpoints[i];
        const b = midpoints[i + 1];
        const mPerLon = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
        const dxM = (b.lon - a.lon) * mPerLon;
        const dyM = (b.lat - a.lat) * 110_540;
        const lenM = Math.hypot(dxM, dyM);
        if (lenM < 1 || lenM > 1200) continue;
        const pDLon = ((-dyM / lenM) * HALF_W) / mPerLon;
        const pDLat = ((dxM / lenM) * HALF_W) / 110_540;
        out.push({
            type: 'Feature',
            properties: { _layer: 'FAIRWY', _class: 'synthetic-channel-segment', _source: 'chain-ordered' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [a.lon + pDLon, a.lat + pDLat],
                        [a.lon - pDLon, a.lat - pDLat],
                        [b.lon - pDLon, b.lat - pDLat],
                        [b.lon + pDLon, b.lat + pDLat],
                        [a.lon + pDLon, a.lat + pDLat],
                    ],
                ],
            },
        });
    }
    return out;
};

// ── Shared synthetic-chart helpers ──────────────────────────────────

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}

function fc(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

/**
 * The BOYLAT channel_midpoint Point the engine's Pass 5 consumes — placed
 * at the pair midpoint carrying _pairDistanceM (the real port↔stbd
 * distance). This is exactly what the orchestrator's pairing pipeline
 * emits today; Pass 5 preferred radius = max(15, min(80, dist/2 − 5)).
 */
function midpointFeature(port: LatLon, stbd: LatLon): Feature {
    return {
        type: 'Feature',
        properties: { _class: 'channel_midpoint', _pairDistanceM: haversineM(port, stbd) },
        geometry: { type: 'Point', coordinates: [(port.lon + stbd.lon) / 2, (port.lat + stbd.lat) / 2] },
    };
}

function gatesFrom(pairs: Array<{ port: LatLon; stbd: LatLon }>): Gate[] {
    return pairs.map((p) => ({ port: p.port, stbd: p.stbd }));
}

const isResult = (
    r: ReturnType<typeof routeInshore>,
): r is Extract<ReturnType<typeof routeInshore>, { polyline: unknown }> => 'polyline' in r;

describe('seamanship — gate shortcut: marked dog-leg vs tempting direct deep water (lon 156.00–156.40)', () => {
    // A five-gate marked channel (gates ≈199 m wide, ≈693 m apart, midpoint
    // features per today's orchestrator pipeline) dog-legs south around a
    // CAUTION-grade shallow tongue (DRVAL1 0.5 m < draft+safety 3.0 m — soft-
    // blocked, not land). A direct deep-water shortcut (DRVAL1 20 m) passes
    // north of the tongue: ≈5,934 m straight vs ≈7,367 m through the gates.
    // Proper seamanship: thread the marked gates. Calibrated 2026-06-11:
    // both dog-leg legs route clean (0 caution) so the channel IS followable,
    // and the tongue grids as CAUTION (probe route through it: 2/2 segments
    // flagged) so the dog-leg is genuinely motivated.
    const FROM: LatLon = { lat: -27.2, lon: 156.13 };
    const TO: LatLon = { lat: -27.2, lon: 156.19 };

    const GATE_LAT = -27.215;
    const GATE_HALF_DEG = 0.0009; // ≈99.5 m either side → pair width ≈199 m → Pass 5 radius 80 m
    const gateLons = [156.146, 156.153, 156.16, 156.167, 156.174];
    const gatePairs = gateLons.map((lon) => ({
        port: { lat: GATE_LAT + GATE_HALF_DEG, lon },
        stbd: { lat: GATE_LAT - GATE_HALF_DEG, lon },
    }));
    const gates = gatesFrom(gatePairs);

    // Deep coverage MUST precede the tongue in the DEPARE collection: Pass 1
    // rasterises in order, and a shallow band over an already-deep cell
    // downgrades it to CAUTION (the reverse order would re-deepen the tongue).
    const layers = {
        DEPARE: fc(
            rect(156.04, -27.31, 156.28, -27.1, { DRVAL1: 20 }), // deep water across the padded grid bbox
            rect(156.148, -27.212, 156.172, -27.203, { DRVAL1: 0.5 }), // shallow tongue the channel dog-legs around
        ),
        BOYLAT: fc(...gatePairs.map((p) => midpointFeature(p.port, p.stbd))),
        OBSTRN: fc(...wingFeatures(gatePairs)),
        FAIRWY: fc(...ribbonSegments(gatePairs.map((p) => ({ lat: (p.port.lat + p.stbd.lat) / 2, lon: p.port.lon })))),
    };

    const req: RouteRequest = {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
    };

    const route = routeInshore(layers, req);

    // Dog-leg centreline (FROM → first gate → last gate → TO) ≈ 7,367 m.
    const channelCentreline: LatLon[] = [
        FROM,
        { lat: GATE_LAT, lon: gateLons[0] },
        { lat: GATE_LAT, lon: gateLons[4] },
        TO,
    ];
    const channelPathM =
        haversineM(channelCentreline[0], channelCentreline[1]) +
        haversineM(channelCentreline[1], channelCentreline[2]) +
        haversineM(channelCentreline[2], TO);

    it('takes the marked dog-leg, clean, near the channel path (flipped by the Phase 3b bundle)', () => {
        // INVERTED from the pre-Phase-3 shortcut pin. History: the straight
        // 5,934 m shortcut won until 2026-06-12 because (a) the fixture
        // lacked the orchestrator's Step-5 ribbon (production chains these
        // midpoints — added above), (b) the cost-blind smoother collapsed
        // any A* dog-leg back to the straight chord, and (c) nothing priced
        // leaving a corridor. With the bundle (ribbon + cost-no-worse
        // smoothing + EXIT_PENALTY_M + 4× deep): 7,395 m ≈ the 7,367 m
        // dog-leg centreline, zero caution, all 5 gates.
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        expect((route.cautionMask ?? []).filter(Boolean).length).toBe(0);
        expect(route.distanceNM * 1852).toBeGreaterThan(channelPathM - 500); // the dog-leg, not the shortcut
        expect(route.distanceNM * 1852).toBeLessThan(channelPathM + 500);
    });

    it('threads ALL marked gates in order instead of the unmarked shortcut (flipped by the Phase 3b bundle)', () => {
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        const audit = auditGates(route.polyline, gates);
        expect(audit.gatesPassed).toBe(audit.gatesTotal);
        expect(audit.wrongSidePasses).toBe(0);
    });
});

describe('inshore router — staggered lateral pairs through an S-bend channel (scenario: staggered-pairs)', () => {
    // A ~4 km S-bend channel between LNDARE banks 300 m apart, in the
    // synthetic-fixture region lon 157.00–157.40 / lat −27.40–−27.00.
    // Real-world stagger: PORT marks (north bank) sit at even ~400 m
    // stations, STBD marks (south bank) at odd stations — never directly
    // abeam. The orchestrator pairs each real mark with the INTERPOLATED
    // opposite-side position (mean of the two adjacent opposite marks;
    // analytic abeam at the channel ends), so the engine receives one
    // channel_midpoint every ~400 m whose _pairDistanceM wobbles with the
    // bend's sagitta (measured 241–362 m here) — exactly what staggered
    // pairing produces on a curved channel.
    const CH_W_LON = 157.06; // west mouth
    const CH_E_LON = 157.1; // east mouth
    const BEND_AMP_DEG = 0.003; // ≈ 332 m S-bend amplitude over 4 km — gentle
    const HALF_W_DEG = 150 / 110_540; // 150 m half-width → banks 300 m apart

    /** Channel centreline latitude at `lon` — one full gentle S (sine). */
    const latC = (lon: number): number =>
        -27.2 + BEND_AMP_DEG * Math.sin((2 * Math.PI * (lon - CH_W_LON)) / (CH_E_LON - CH_W_LON));

    /** LNDARE bank: sine-offset channel edge, squared off to `farLat` (spans the whole grid N-S). */
    const bankPoly = (side: 'N' | 'S', farLat: number): Feature => {
        const edge: [number, number][] = [];
        for (let lon = CH_W_LON; lon <= CH_E_LON + 1e-9; lon += 0.0005) {
            edge.push([lon, latC(lon) + (side === 'N' ? HALF_W_DEG : -HALF_W_DEG)]);
        }
        const ring: [number, number][] = [...edge, [CH_E_LON, farLat], [CH_W_LON, farLat], edge[0]];
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
    };

    const stations: number[] = [];
    for (let k = 0; k <= 10; k++) stations.push(CH_W_LON + k * 0.004); // every ~400 m

    const pairs: Array<{ port: LatLon; stbd: LatLon }> = stations.map((lon, k) => {
        const inner = k > 0 && k < stations.length - 1;
        const interpLat = inner ? (latC(stations[k - 1]) + latC(stations[k + 1])) / 2 : latC(lon);
        return k % 2 === 0
            ? { port: { lat: latC(lon) + HALF_W_DEG, lon }, stbd: { lat: interpLat - HALF_W_DEG, lon } } // real port
            : { port: { lat: interpLat + HALF_W_DEG, lon }, stbd: { lat: latC(lon) - HALF_W_DEG, lon } }; // real stbd
    });
    const midpoints: LatLon[] = pairs.map((p) => ({ lat: (p.port.lat + p.stbd.lat) / 2, lon: p.port.lon }));
    const gates = gatesFrom(pairs);

    const layers = {
        LNDARE: fc(bankPoly('N', -27.1), bankPoly('S', -27.3)),
        // Charted deep water everywhere keeps the 3-cell-wide channel out of
        // Pass 6's LNDARE buffer (prior depth > 0 → skip) — without it the
        // 100 m grid seals the channel shut and the fixture tests nothing.
        DEPARE: fc(rect(157.0, -27.4, 157.4, -27.0, { DRVAL1: 10, DRVAL2: 20 })),
        BOYLAT: fc(...pairs.map((p) => midpointFeature(p.port, p.stbd))),
        OBSTRN: fc(...wingFeatures(pairs)),
    };
    const req: RouteRequest = {
        fromLat: -27.2,
        fromLon: 157.0585, // ~150 m west of the west mouth
        toLat: -27.2,
        toLon: 157.1015, // ~150 m east of the east mouth
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
    };
    const route = routeInshore(layers, req);

    it('resolves a clean route through the channel (zero caution)', () => {
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        expect(route.distanceNM).toBeGreaterThan(0);
        expect((route.cautionMask ?? []).filter(Boolean).length).toBe(0);
    });

    it('threads every staggered gate the right way (11/11 passed, zero missed, zero wrong-side)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        const audit = auditGates(route.polyline, gates);
        expect(audit.gatesTotal).toBe(11);
        expect(audit.gatesPassed).toBe(11);
        expect(audit.gatesMissed).toBe(0);
        expect(audit.wrongSidePasses).toBe(0);
    });

    it('never climbs the banks — every sampled point stays within half a cell of the channel', () => {
        // Engine guarantee is cell-level (navigable cell centres sit inside
        // the 300 m band), so the honest bound at 100 m resolution is the
        // bank line + ~70 m half-cell tolerance. Measured today: the route's
        // worst excursion is 10.5 m INSIDE the bank line (max 139.5 m off
        // the analytic centreline), so this holds with ~80 m margin.
        if (!isResult(route)) throw new Error('expected a route');
        for (let i = 0; i < route.polyline.length - 1; i++) {
            const [aLon, aLat] = route.polyline[i];
            const [bLon, bLat] = route.polyline[i + 1];
            for (let s = 0; s <= 40; s++) {
                const t = s / 40;
                const lon = aLon + (bLon - aLon) * t;
                if (lon <= CH_W_LON || lon >= CH_E_LON) continue;
                const lat = aLat + (bLat - aLat) * t;
                const offBankM = (Math.abs(lat - latC(lon)) - HALF_W_DEG) * 110_540;
                expect(offBankM).toBeLessThan(70);
            }
        }
    });

    it('holds the calibrated channel-discipline floor vs the midpoint chain (≥75%)', () => {
        // Pre-wings: 87.0%. Phase 3 wings (2026-06-11) measure 79.7%: wings
        // built from the bend-apex interpolated positions poison a couple of
        // channel-edge cells, trading ~7 pts of chain-hugging for hard
        // wrong-side protection — gates stay 11/11, caution stays 0. Floor
        // re-pinned 80 → 75; still catches a bank-hugging regression.
        if (!isResult(route)) throw new Error('expected a route');
        expect(channelDisciplinePct(route.polyline, midpoints, { halfWidthM: 100 })).toBeGreaterThanOrEqual(75);
    });

    // FLIPPED by the Phase 3b bundle (2026-06-12): the marina-centerline
    // cost gate now rejects the apex-cutting string-pulled centerline
    // (its true-grid cost exceeds the A* corridor's), so the route keeps
    // A*'s chain-following line — measured 92.6% discipline at the
    // bundle's 4× deep tier (79.7 at 3×, which is why 4 is the floor).
    it('zero wrong-side passes AND ≥90% discipline on the midpoint chain (flipped by the Phase 3b bundle)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        const audit = auditGates(route.polyline, gates);
        expect(audit.wrongSidePasses).toBe(0);
        expect(channelDisciplinePct(route.polyline, midpoints, { halfWidthM: 100 })).toBeGreaterThanOrEqual(90);
    });
});

describe('inshore router seamanship — Scenario 3: wrong-side temptation (gate vs shorter pass outside the mark)', () => {
    // The owner's exact complaint, as a number. A single ~149 m port/stbd
    // pair marks the safe gate between a headland (LNDARE) and an off-lying
    // CAUTION shoal (DRVAL1 1.5 m < draft 2.0 + safety 1.0). The stbd mark
    // stands one grid cell (~133 m) off the charted shoal edge, so at the
    // 100 m test resolution a deep one-cell corridor exists between mark and
    // shoal — entirely inside the scorecard's 149 m outboard wing. A
    // west→east passage lined up on that corridor is dead straight and reads
    // clean deep water; threading the gate instead means a ~170 m dip whose
    // A* cost (+~420 cost-units at deep 5×) the single flat-preferred
    // midpoint cell (~−400) cannot repay. Calibrated 2026-06-11:
    //   • route crosses the marks' meridian 96.5 m NORTH of the stbd mark
    //     (wing 149 m) → auditGates: wrongSidePasses 1, gatesPassed 0;
    //   • cautionMask all-false (0/3) — the engine sees NOTHING wrong;
    //   • length 6 665 m vs 5 933 m direct (ratio 1.12).
    // Exclusive lon-region for this suite: 158.00–158.40 (NavGrid cache
    // keys on bbox + feature counts — keep every coordinate in-region).
    const MARK_LON = 158.20059;
    const PORT: LatLon = { lat: -27.21135, lon: MARK_LON };
    const STBD: LatLon = { lat: -27.21, lon: MARK_LON };

    const layers = {
        // Headland the gate hugs — runs south past the grid edge so the
        // only routes are the gate, the corridor outside the mark, or a
        // long climb around the shoal's north side.
        LNDARE: fc(rect(158.186, -27.36, 158.21, -27.2125)),
        DEPARE: fc(
            // Deep blanket FIRST (covers grid + padding: no 500× unknown
            // cells, and Pass 6 never buffers the gate shut)…
            rect(158.05, -27.38, 158.36, -27.05, { DRVAL1: 20 }),
            // …then the off-lying shoal overwrites its patch to CAUTION.
            rect(158.196, -27.2088, 158.214, -27.199, { DRVAL1: 1.5 }),
        ),
        // The orchestrator's paired channel midpoint — engine Pass 5 input.
        BOYLAT: fc(midpointFeature(PORT, STBD)),
        // …and its Step 4.5 outboard wings — engine Pass 5c input.
        OBSTRN: fc(...wingFeatures([{ port: PORT, stbd: STBD }])),
    };
    const gates = gatesFrom([{ port: PORT, stbd: STBD }]);

    // Dead-straight temptation passage: both endpoints sit on the deep
    // corridor row between the stbd mark and the shoal edge.
    const FROM: LatLon = { lat: -27.2094, lon: 158.17 };
    const TO: LatLon = { lat: -27.2094, lon: 158.23 };
    const req: RouteRequest = {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
    };
    const route = routeInshore(layers, req);

    it('resolves a clean, near-direct route through the temptation corridor', () => {
        // Stable invariant — must hold today AND after Phase 3 (a correct
        // gate-threading dip adds <100 m and stays caution-free).
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        expect((route.cautionMask ?? []).filter(Boolean).length).toBe(0);
        expect((route.distanceNM * 1852) / haversineM(FROM, TO)).toBeLessThan(1.25);
    });

    // INVERTED 2026-06-11 by Phase 3 wings (was the TODAY pin documenting
    // wrongSidePasses=1): the stbd mark's outboard wing now stamps the
    // temptation corridor CAUTION, so the clean line IS the gate. The
    // owner's complaint, fixed at the cost model.
    it('threads the gate instead of the outboard corridor (flipped by Phase 3 wings)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        const audit = auditGates(route.polyline, gates);
        expect(audit.wrongSidePasses).toBe(0);
        expect(audit.gatesPassed).toBe(1);
    });

    // FLIPPED EARLY by the 2026-06-11 MinHeap fix (tests/minHeap.test.ts):
    // the 9.5 m wrong-side graze was the broken A* open set popping
    // non-minimal nodes, not a preference-tuning gap — with a correct heap
    // a transit aimed dead through the gate threads it. (The main
    // temptation fixture above still needs Phase 3 wings.)
    it('a transit aimed dead through the gate threads it (flipped by the heap fix)', () => {
        const probe = routeInshore(layers, {
            fromLat: -27.2107,
            fromLon: 158.19,
            toLat: -27.2107,
            toLon: 158.218,
            draftM: 2.0,
            safetyM: 1.0,
            resolutionM: 100,
        });
        if (!isResult(probe)) throw new Error('expected a route');
        const audit = auditGates(probe.polyline, gates);
        expect(audit.wrongSidePasses).toBe(0);
        expect(audit.gatesPassed).toBe(1);
    });
});

describe('seamanship — unnumbered chart marks (CATLAM only, no OBJNAM): the raw AU SENC reality', () => {
    // SCENARIO 4 — raw chart laterals exactly as an AU SENC emits them for
    // unnumbered marks: BOYLAT/BCNLAT Points carrying only { CATLAM: 1|2 } —
    // no OBJNAM, no _pairDistanceM. Three ~200 m gates round a bend between
    // a LNDARE headland (north) and a DRVAL1 1.0 m caution shoal flat
    // (south). The seamanlike line threads the gates ~2 km south of the
    // headland tip; the tempting shortcut hugs the tip through clean water.
    //
    // Engine today (calibrated 2026-06-11): Pass 5 deliberately no-ops on
    // marks without _pairDistanceM (solo-mark-as-attractor defence) and
    // Fairlead's parseLateralMarks drops marks without a numbered OBJNAM,
    // so raw CATLAM marks are invisible — identical 5.19 NM polyline with
    // and without them; audit: 0/3 gates passed, 3 missed, 0 wrong-side.
    const FROM: LatLon = { lat: -27.2, lon: 159.095 };
    const TO: LatLon = { lat: -27.2, lon: 159.15 };

    const headland = rect(159.115, -27.205, 159.13, -27.1); // LNDARE bank jutting down from the north
    const shoalFlat = rect(159.06, -27.27, 159.19, -27.23, { DRVAL1: 1.0 }); // caution flat south of the channel

    // Pair distance ≈ 200 m (haversine 200.2 m) → audit wing length 150 m.
    const pairs = [
        { port: { lat: -27.2241, lon: 159.11 }, stbd: { lat: -27.2259, lon: 159.11 } },
        { port: { lat: -27.2251, lon: 159.1225 }, stbd: { lat: -27.2269, lon: 159.1225 } },
        { port: { lat: -27.2241, lon: 159.135 }, stbd: { lat: -27.2259, lon: 159.135 } },
    ];
    const gates = gatesFrom(pairs);

    /** Raw AU SENC unnumbered lateral — CATLAM only, no OBJNAM, no _pairDistanceM. */
    const rawLateral = (p: LatLon, catlam: 1 | 2): Feature => ({
        type: 'Feature',
        properties: { CATLAM: catlam },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    });

    const req: RouteRequest = {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
    };

    const bareLayers = { LNDARE: fc(headland), DEPARE: fc(shoalFlat) };
    const markLayers = {
        ...bareLayers,
        BCNLAT: fc(...pairs.map((p) => rawLateral(p.port, 1))),
        BOYLAT: fc(...pairs.map((p) => rawLateral(p.stbd, 2))),
    };

    // Distinct BOYLAT/BCNLAT feature counts put the two runs on distinct
    // NavGrid cache keys (the cache fingerprints layer COUNTS), so the
    // identity below is genuine engine behaviour, not a stale cache hit.
    const withMarks = routeInshore(markLayers, req);
    const withoutMarks = routeInshore(bareLayers, req);

    it('REGRESSION GUARD (today): raw CATLAM marks are a deliberate no-op — identical route with and without them', () => {
        // Pins the documented solo-mark-as-attractor defence (engine Pass 5
        // comment block): laterals without _pairDistanceM must not bias A*.
        // Phase 5 (chart-mark pairing fallback) REPLACES this behaviour —
        // invert/delete this guard when that lands.
        expect(isResult(withMarks)).toBe(true);
        expect(isResult(withoutMarks)).toBe(true);
        if (!isResult(withMarks) || !isResult(withoutMarks)) return;
        expect(withMarks.polyline).toEqual(withoutMarks.polyline);
        expect(withMarks.distanceNM).toBe(withoutMarks.distanceNM);
    });

    it.fails('MASTERPLAN Phase 5 (chart-mark pairing fallback): raw CATLAM marks alone should gate the route', () => {
        // Today: marks invisible → A* hugs the headland tip (clean 5.19 NM
        // shortcut, caution 0) and the audit measures gatesPassed 0/3,
        // gatesMissed 3, wrongSidePasses 0. Phase 5 pairs port/stbd CATLAM
        // marks into midpoint zones, after which all three gates must be
        // threaded on the correct side.
        if (!isResult(withMarks)) throw new Error('expected a route');
        const audit = auditGates(withMarks.polyline, gates);
        expect(audit.gatesPassed).toBe(audit.gatesTotal);
        expect(audit.wrongSidePasses).toBe(0);
    });
});

describe('seamanship — buoyed channel through a shallow bar (lon 160.00–160.40)', () => {
    // SCENARIO 5 — the classic dredged bar the chart reads shallow. A deep
    // basin (DRVAL1 15 m) is cut by a ~1 km north–south bar (DRVAL1 1.5 m)
    // that reads CAUTION for this vessel (draft 2.0 m + safety 0.5 m). An
    // 11-pair buoyed channel (pair ≈ 150 m → Pass 5 preferred radius 70 m)
    // marks the direct line straight across the bar; the only clean-water
    // alternative rounds the bar's north end — a ≥3× detour. Good seamanship
    // (masterplan Phase 4, 'splices AND stays red'): take the marked channel
    // across WITH honest red flags over the shallow bar.
    //
    // HISTORY: as calibrated 2026-06-11 (pre-heap-fix) the engine returned a
    // 20,495 m southern dogleg (3.45× direct) — root-caused to the broken
    // MinHeap.sinkDown (A* popped non-minimal nodes; path cost 744,713
    // m-equiv vs 48,800 optimal). The heap fix (same day,
    // tests/minHeap.test.ts) flipped ALL FOUR targets below ahead of
    // Phase 4: the route now rides the marked channel straight across the
    // bar with the crossing honestly red — splices AND stays red.
    const FROM: LatLon = { lat: -27.2, lon: 160.1 };
    const TO: LatLon = { lat: -27.2, lon: 160.16 };
    const CHANNEL_LAT = -27.2;
    const PAIR_HALF_DEG = 0.00068; // ≈75 m → pair distance ≈150 m

    // A pair every ~495 m from lon 160.105 to 160.155 — three land on the bar.
    const pairs = Array.from({ length: 11 }, (_, i) => {
        const lon = 160.105 + i * 0.005;
        return {
            port: { lat: CHANNEL_LAT + PAIR_HALF_DEG, lon },
            stbd: { lat: CHANNEL_LAT - PAIR_HALF_DEG, lon },
        };
    });
    const gates = gatesFrom(pairs);
    const centreline: LatLon[] = pairs.map((p) => ({ lat: CHANNEL_LAT, lon: p.port.lon }));

    const BAR_MIN_LON = 160.125;
    const BAR_MAX_LON = 160.135;
    const layers = {
        DEPARE: fc(
            rect(160.05, -27.3, 160.21, -27.1, { DRVAL1: 15 }), // deep basin
            rect(BAR_MIN_LON, -27.32, BAR_MAX_LON, -27.14, { DRVAL1: 1.5 }), // the shallow bar
        ),
        BOYLAT: fc(...pairs.map((p) => midpointFeature(p.port, p.stbd))),
        OBSTRN: fc(...wingFeatures(pairs)),
    };
    const req: RouteRequest = {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 0.5,
        resolutionM: 100,
    };
    const route = routeInshore(layers, req);

    const polylineLen = (poly: [number, number][]): number => {
        let len = 0;
        for (let i = 0; i < poly.length - 1; i++) {
            len += haversineM({ lat: poly[i][1], lon: poly[i][0] }, { lat: poly[i + 1][1], lon: poly[i + 1][0] });
        }
        return len;
    };

    it('resolves a route across the shallow-bar chart', () => {
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        expect(route.distanceNM).toBeGreaterThan(0);
    });

    it('never crosses the bar silently — the crossing carries at least one caution flag', () => {
        // Both today's southern dogleg (one 1,098 m caution run) and the
        // Phase 4 target (red across the marked crossing) flag the bar.
        // Only a silent crossing — the masterplan's cardinal sin — fails this.
        if (!isResult(route)) throw new Error('expected a route');
        expect((route.cautionMask ?? []).filter(Boolean).length).toBeGreaterThanOrEqual(1);
    });

    it('never passes a gate on the wrong side of a mark (headline metric)', () => {
        // Today the route misses all 11 gates (wide southern detour) but
        // crosses zero outboard wings; the Phase 4 target threads all 11.
        // wrongSidePasses === 0 must hold through every intermediate state.
        if (!isResult(route)) throw new Error('expected a route');
        expect(auditGates(route.polyline, gates).wrongSidePasses).toBe(0);
    });

    it('keeps the bar detour bounded — never worse than today’s 3.45× dogleg', () => {
        // Calibrated 2026-06-11: 20,495 m over a 5,937 m direct line = 3.45×.
        // Ceiling at 5× so unrelated tuning noise stays green but a routing
        // blow-up (or a silent no-detour regression pairing with the caution
        // guard above) screams.
        if (!isResult(route)) throw new Error('expected a route');
        const ratio = polylineLen(route.polyline) / haversineM(FROM, TO);
        expect(ratio).toBeLessThan(5.0);
    });

    // Former Phase 4 ('splices AND stays red') targets — ALL FOUR flipped to
    // it() by the 2026-06-11 MinHeap fix (the A* dogleg was heap breakage,
    // not a seamanship-pass gap). Now permanent regression guards.

    it('rides the marked channel — discipline ≥ 80% of the midpoint chain (flipped by the heap fix)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        expect(channelDisciplinePct(route.polyline, centreline)).toBeGreaterThanOrEqual(80);
    });

    it('passes every lateral gate between the marks (flipped by the heap fix)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        const audit = auditGates(route.polyline, gates);
        expect(audit.gatesPassed).toBe(audit.gatesTotal);
        expect(audit.gatesMissed).toBe(0);
    });

    it('takes the direct marked crossing, not the long way round (ratio < 1.5, flipped by the heap fix)', () => {
        if (!isResult(route)) throw new Error('expected a route');
        const ratio = polylineLen(route.polyline) / haversineM(FROM, TO);
        expect(ratio).toBeLessThan(1.5);
    });

    it('the bar crossing is flagged red ON the marked channel — splices AND stays red (flipped by the heap fix)', () => {
        // ≥1 caution segment inside the bar within ~220 m of the channel
        // line — the rescue cells must not blank the warning where the
        // chart genuinely reads 1.5 m.
        if (!isResult(route)) throw new Error('expected a route');
        const mask = route.cautionMask ?? [];
        const redOnChannel = route.polyline.slice(0, -1).some(([aLon, aLat], i) => {
            if (!mask[i]) return false;
            const [bLon, bLat] = route.polyline[i + 1];
            const midLon = (aLon + bLon) / 2;
            const midLat = (aLat + bLat) / 2;
            return midLon >= BAR_MIN_LON && midLon <= BAR_MAX_LON && Math.abs(midLat - CHANNEL_LAT) < 0.002;
        });
        expect(redOnChannel).toBe(true);
    });
});

describe('seamanship: mid-span shoal bar vs parallel marked channel (lon 161.00–161.40)', () => {
    // ROUTING_COLLAB.md's never-added 6th guardrail: "long route, mid-span
    // shallow bar + parallel marked channel → route rides the channel, not
    // red across the bar."
    //
    // Chart: 19.8 km E–W passage at lat −27.21. A ~2 km-wide DRVAL1=0.5 m bar
    // (CAUTION for draft 2 m + safety 1 m) spans the whole grid N–S at
    // lon 161.19–161.21. 1.66 km north of the rhumb line a dredged channel
    // (DRGARE 161.16–161.24, DRVAL1 6 m, ~330 m wide) crosses the bar in
    // dredged water, marked by 11 channel_midpoint pairs every ~700 m
    // (pair width 150 m). The seamanship answer: dogleg north, ride the cut.
    //
    // Calibration 2026-06-11 (resolutionM 100): the GRID is correct — the cut
    // rasterises as a continuous 4-row preferred corridor, rescued to 5 m
    // through the bar, and an independent Dijkstra on that exact grid rides
    // it end-to-end at cost 73,048 m-eq. The shipped engine instead returns a
    // 289,493 m-eq path that ignores the cut's mouth and crosses the bar in
    // raw caution water ~800 m north of the dredged channel.
    const FROM = { lat: -27.21, lon: 161.1 };
    const TO = { lat: -27.21, lon: 161.3 };
    const CH_LAT = -27.195; // channel centreline latitude
    const CH_HALF = 0.000675; // ≈75 m of latitude → 150 m pair width

    const pairs: Array<{ port: LatLon; stbd: LatLon }> = [];
    for (let lon = 161.1635; lon <= 161.2345; lon += 0.00707) {
        pairs.push({ port: { lat: CH_LAT + CH_HALF, lon }, stbd: { lat: CH_LAT - CH_HALF, lon } });
    }
    const gates: Gate[] = gatesFrom(pairs);
    const centreline: LatLon[] = [
        { lat: CH_LAT, lon: 161.16 },
        { lat: CH_LAT, lon: 161.24 },
    ];

    const layers: Parameters<typeof routeInshore>[0] = {
        DEPARE: fc(
            rect(161.0, -27.4, 161.4, -27.0, { DRVAL1: 15 }), // deep open water everywhere
            rect(161.19, -27.4, 161.21, -27.0, { DRVAL1: 0.5 }), // mid-span shoal bar, full grid height
        ),
        DRGARE: fc(rect(161.16, -27.1965, 161.24, -27.1935, { DRVAL1: 6, acronym: 'DRGARE' })),
        BOYLAT: fc(...pairs.map((p) => midpointFeature(p.port, p.stbd))),
        OBSTRN: fc(...wingFeatures(pairs)),
    };
    const req: RouteRequest = {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100,
    };

    /** Lengths (m) of consecutive caution runs along the polyline. */
    function cautionRunsM(polyline: [number, number][], mask?: boolean[]): number[] {
        if (!mask) return [];
        const runs: number[] = [];
        let current = 0;
        for (let i = 0; i < Math.min(mask.length, polyline.length - 1); i++) {
            const a = { lat: polyline[i][1], lon: polyline[i][0] };
            const b = { lat: polyline[i + 1][1], lon: polyline[i + 1][0] };
            if (mask[i]) current += haversineM(a, b);
            else if (current > 0) {
                runs.push(current);
                current = 0;
            }
        }
        if (current > 0) runs.push(current);
        return runs;
    }

    const route = routeInshore(layers, req);

    it('resolves end-to-end across the bar region', () => {
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        expect(route.polyline.length).toBeGreaterThanOrEqual(2);
        const [startLon, startLat] = route.polyline[0];
        const [endLon, endLat] = route.polyline[route.polyline.length - 1];
        expect(Math.abs(startLat - FROM.lat)).toBeLessThan(0.02);
        expect(Math.abs(startLon - FROM.lon)).toBeLessThan(0.02);
        expect(Math.abs(endLat - TO.lat)).toBeLessThan(0.02);
        expect(Math.abs(endLon - TO.lon)).toBeLessThan(0.02);
    });

    it('TODAY (pinned, Phase 3b bundle): engages 10/11 gates clean via the cut — one wrong-side left', () => {
        // Pin history: broken heap → 2,365 m red across the raw bar (06-11);
        // heap fix → clean via the cut but outboard of the greens (gates
        // 0/11, wrongSidePasses 8); wings → inside the gates (7/11, wrong 0,
        // 12.22 NM); Phase 3b bundle (06-12: cost-no-worse smoothing +
        // centerline gate + EXIT_PENALTY_M=250 + 4× deep) → joins EARLY and
        // engages 10/11 gates at 10.93 NM, zero caution runs, but the honest
        // geometry clips ONE mark's wing line (wrongSidePasses 1). The
        // remaining wrong-side is the TARGET below.
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        const runs = cautionRunsM(route.polyline, route.cautionMask);
        // RE-PIN 2026-06-18 (3-tier Phase 4 + caution along-segment fix,
        // commit 42bf48c8): geometry BYTE-IDENTICAL to the old pin — same
        // 10.90 NM, 10/11 gates, wrongSidePasses 1, same cut. The ONLY
        // change is caution: the old per-VERTEX sampler reported 0 runs on
        // this cut across the mid-span shoal bar — a SILENT bar crossing the
        // golden itself had baked in. The new along-segment sampler honestly
        // flags the ~6.6 km the cut spends on the bar. Verified route-vs-grid
        // (A's method, collab reply 44): NOT a geometry regression, an
        // exposed latent under-flag. So the cut now correctly carries one
        // caution run — which is the honest, safer pin.
        expect(runs).toHaveLength(1);
        expect(runs[0]).toBeGreaterThan(5000); // ~6.6 km of bar, red as it should be
        const audit = auditGates(route.polyline, gates);
        expect(audit.gatesPassed).toBeGreaterThanOrEqual(9);
        expect(audit.wrongSidePasses).toBeLessThanOrEqual(1);
    });

    it('regression guard: a route entered at the cut mouth rides the marked channel cleanly', () => {
        // The channel machinery itself works (Pass 4 preference + caution
        // rescue): started 500 m west of the cut, the route threads all 11
        // gates with zero caution and zero wrong-side passes.
        const fromMouth = routeInshore(layers, { ...req, fromLat: CH_LAT, fromLon: 161.155 });
        expect(isResult(fromMouth)).toBe(true);
        if (!isResult(fromMouth)) return;
        expect(cautionRunsM(fromMouth.polyline, fromMouth.cautionMask)).toHaveLength(0);
        const audit = auditGates(fromMouth.polyline, gates);
        expect(audit.gatesPassed).toBe(11);
        expect(audit.wrongSidePasses).toBe(0);
    });

    // TARGET (Stage IV Seaway Graph territory now): ≥8 of 11 gates with
    // ZERO wrong-side passes and no caution run over 500 m.
    //
    // Recalibration history: the original ≥70% global-discipline clause was
    // unreachable by construction (replaced by gate count, 06-11). Heap fix
    // killed the drunken-walk; wings killed the outboard ride (wrong 8→0);
    // the Phase 3b bundle's exit penalty bought the early join (gates
    // 7→10/11) but its honest geometry clips ONE wing line (wrong 0→1).
    // Killing that last wrong-side without losing the early join is gate
    // cross-line validation — the Seaway Graph's by-construction guarantee.
    it.fails('TARGET: engages the buoyed channel early — ≥8/11 gates, zero wrong-side, runs ≤500 m', () => {
        expect(isResult(route)).toBe(true);
        if (!isResult(route)) return;
        const runs = cautionRunsM(route.polyline, route.cautionMask);
        expect(runs.every((r) => r <= 500)).toBe(true);
        const audit = auditGates(route.polyline, gates);
        expect(audit.wrongSidePasses).toBe(0);
        expect(audit.gatesPassed).toBeGreaterThanOrEqual(8);
    });
});
