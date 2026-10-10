/**
 * Phase 0 review (2026-09-29): the chart wins where it has drawn the same line.
 *
 * Phase 0 dropped chart NAVLNE CATNAV 2 transits 2383 and 3454 (Hamilton
 * Reach, 255.5°) from every lead path. But with the OSM overlay online, OSM
 * ways tagged `category=transit` lie right on top of them — 1050662196 (1 m
 * along 2383), 1050662408 (12 m, 2383), 1050662194 (15 m, 3454) and
 * 1050662407 (13 m, 3454) — and OSM lines were kept as leads, so the same
 * bearing lines came straight back: the preferred corridor, the depth rescue,
 * the lead snap, the land audit's vouched water, and in the tracer the
 * cardinal override that turns "wrong side of the cardinal" into an info.
 *
 * Real fixtures: newport-enc-cells.json.gz (OC-61-10ENB5 + RCS5) and the
 * Pi's OSM overlay for the same corridor, newport-pinkenba-osm.json.gz.
 */
import type { Feature, FeatureCollection, Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import { withNavLineLeadsOnly } from '../services/inshoreRouterEngine';
import { navLineLeads, osmNavLineLeads, parseLeadingLines } from '../services/leadingLine';
import { snapTraceTapToLead, tracerContextFromLayers, validateTraceLeg } from '../services/routeTracer';
import type { CardinalDisc } from '../services/tier3/cardinalClamp';
import { encLayer, osmOverlay } from './helpers/encCells';
import { lazy, REAL_AU_CHART_FIXTURES_RETIRED } from './helpers/retiredChartFixtures';

const CELLS = ['OC-61-10ENB5', 'OC-61-10RCS5'];
// Read on first use: the chart cells are retired, so only gated blocks call these.
const chartNavOf = lazy(() => CELLS.flatMap((id) => encLayer(id, 'NAVLNE')));
const chartRectrcOf = lazy(() => CELLS.flatMap((id) => encLayer(id, 'RECTRC')));
const osmNav = (osmOverlay('newport-pinkenba') as { navLines: FeatureCollection }).navLines.features;
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const rcid = (n: number) => chartNavOf().find((f) => f.properties?.rcid === n)!;
const osmId = (f: Feature) => f.properties?._osmId as number | undefined;

/** The four OSM ways that redraw the dropped chart transits. */
const OSM_TRANSIT_TWINS = [1050662194, 1050662196, 1050662407, 1050662408];
/** OSM "transit" ways that redraw chart LEADING lines (2376, 2920): kept. */
const OSM_TWINS_OF_CHART_LEADS = [1050662120, 1050662193, 1050662403];

/** The device merge: chart leads, then OSM through osmNavLineLeads. */
const mergedNavLine = (): Feature[] => [
    ...navLineLeads(chartNavOf(), 'NAVLNE'),
    ...osmNavLineLeads(osmNav, chartNavOf()),
];

// ── Independent geometry (deliberately NOT the production twin test) ──
const M_LAT = 110_540;
const mLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
const rings = (f: Feature): Position[][] =>
    f.geometry.type === 'LineString'
        ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiLineString'
          ? f.geometry.coordinates
          : [];
function segDist(p: Position, a: Position, b: Position): number {
    const k = mLon(a[1]);
    const bx = (b[0] - a[0]) * k,
        by = (b[1] - a[1]) * M_LAT,
        px = (p[0] - a[0]) * k,
        py = (p[1] - a[1]) * M_LAT;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
    return Math.hypot(px - bx * t, py - by * t);
}
const bearing = (a: Position, b: Position) =>
    (Math.atan2((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT) * 180) / Math.PI;
const angleDiff = (x: number, y: number) => {
    const d = Math.abs(x - y) % 180;
    return d > 90 ? 180 - d : d;
};
/** Metres of `line` running within `withinM` of, and parallel (≤10°) to, `target`. */
function alongsideM(line: Feature, target: Feature, withinM: number): number {
    let m = 0;
    for (const ring of rings(line))
        for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1],
                b = ring[i];
            const len = Math.hypot((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT);
            const n = Math.max(1, Math.ceil(len / 10));
            for (let s = 0; s < n; s++) {
                const t = (s + 0.5) / n;
                const p: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                const near = rings(target).some((tr) =>
                    tr.some(
                        (_, j) =>
                            j > 0 &&
                            segDist(p, tr[j - 1], tr[j]) <= withinM &&
                            angleDiff(bearing(a, b), bearing(tr[j - 1], tr[j])) <= 10,
                    ),
                );
                if (near) m += len / n;
            }
        }
    return m;
}

describe.skipIf(REAL_AU_CHART_FIXTURES_RETIRED)(
    'OSM navigation lines that redraw a chart clearing or transit line (real AU chart fixture retired; port: 127-C-a)',
    () => {
        it('the fixtures still hold the case: chart transits 2383 and 3454, with OSM twins on top', () => {
            expect(rcid(2383).properties?.CATNAV).toBe(2);
            expect(rcid(3454).properties?.CATNAV).toBe(2);
            expect(osmNav.map(osmId)).toEqual(expect.arrayContaining(OSM_TRANSIT_TWINS));
            for (const id of [1050662196, 1050662408])
                expect(alongsideM(osmNav.find((f) => osmId(f) === id)!, rcid(2383), 15)).toBeGreaterThan(1_000);
            for (const id of [1050662194, 1050662407])
                expect(alongsideM(osmNav.find((f) => osmId(f) === id)!, rcid(3454), 15)).toBeGreaterThan(1_000);
        });

        it('the merge drops exactly those four and keeps every other OSM line', () => {
            const kept = osmNavLineLeads(osmNav, chartNavOf()).map(osmId);
            expect(kept).toHaveLength(osmNav.length - OSM_TRANSIT_TWINS.length);
            for (const id of OSM_TRANSIT_TWINS) expect(kept).not.toContain(id);
            // "transit" ways that the chart says are LEADING lines stay (the chart decides).
            expect(kept).toEqual(expect.arrayContaining(OSM_TWINS_OF_CHART_LEADS));
            // The device merges also weigh RECTRC as a chart lead: same answer
            // here, and every kept line is the overlay's own, uncut.
            const withRectrc = osmNavLineLeads(osmNav, chartNavOf(), chartRectrcOf());
            expect(withRectrc.map(osmId)).toEqual(kept);
            for (const f of withRectrc) expect(osmNav).toContain(f);
        });

        it('no merged NAVLINE feature runs along 2383 or 3454', () => {
            // The chart's own lead 2379 runs ~30 m between the two transits, so
            // "within 30 m" cannot be the bound: it would forbid the real lead.
            expect(alongsideM(rcid(2379), rcid(2383), 25)).toBe(0);
            expect(alongsideM(rcid(2379), rcid(3454), 25)).toBe(0);
            const merged = mergedNavLine();
            for (const f of merged)
                for (const target of [2383, 3454])
                    expect(
                        alongsideM(f, rcid(target), 15),
                        `${f.properties?.rcid ?? osmId(f)} runs along chart transit ${target}`,
                    ).toBeLessThan(50);
        });

        it('routeInshore entry gives the same answer for a raw mixed assembly (all chart + all OSM)', () => {
            // The Pinkenba repro and other fixtures push raw chart NAVLNE and raw
            // OSM lines into NAVLINE; the engine's own gate must still drop the twins.
            const gated = withNavLineLeadsOnly({ NAVLINE: fc([...chartNavOf(), ...osmNav]) }).NAVLINE!.features;
            const key = (f: Feature) => String(f.properties?.rcid ?? osmId(f));
            expect(gated.map(key).sort()).toEqual(mergedNavLine().map(key).sort());
        });
    },
);

describe.skipIf(REAL_AU_CHART_FIXTURES_RETIRED)(
    'tracer: a wrong-side cardinal next to the dropped transits stays a DANGER (real AU chart fixture retired; port: 127-C-a)',
    () => {
        // A leg riding 20 m south of transit 2383 in Hamilton Reach, ~50 m from
        // the chart lead 2379 and RECTRC 2380 (beyond the tracer's 40 m "on the
        // lead" reach) but ~25 m from OSM twin 1050662408 (inside it). A north
        // cardinal sits 10 m north of the leg, so the leg passes its wrong side.
        const geometry = lazy(() => {
            const [, A, B] = rings(rcid(2383))[0];
            const k = mLon(A[1]);
            const len = Math.hypot((B[0] - A[0]) * k, (B[1] - A[1]) * M_LAT);
            const ux = ((B[0] - A[0]) * k) / len,
                uy = ((B[1] - A[1]) * M_LAT) / len;
            const [nx, ny] = [-uy, ux]; // south of the line (away from 2379)
            const at = (t: number, offM: number) => ({
                lon: A[0] + (B[0] - A[0]) * t + (nx * offM) / k,
                lat: A[1] + (B[1] - A[1]) * t + (ny * offM) / M_LAT,
            });
            const legA = at(0.6, 20),
                legB = at(0.75, 20);
            const cardinal: CardinalDisc = { ...at(0.67, 10), dir: 'n', radiusM: 100 };
            const bbox: [number, number, number, number] = [153.08, -27.46, 153.12, -27.43];
            const context = (navline: Feature[]) => {
                const ctx = tracerContextFromLayers(
                    { RECTRC: fc(chartRectrcOf()), NAVLINE: fc(navline) },
                    [],
                    bbox,
                    2,
                    {
                        skipGrid: true,
                    },
                );
                ctx.cardinals = [cardinal];
                return ctx;
            };
            const cardinalIssue = (ctx: ReturnType<typeof context>) =>
                validateTraceLeg(legA, legB, ctx).issues.filter((i) => i.message.includes('cardinal'));
            return { ny, context, cardinalIssue };
        });

        it('with the device merge', () => {
            const { ny, context, cardinalIssue } = geometry();
            expect(ny).toBeLessThan(0);
            const issues = cardinalIssue(context(mergedNavLine()));
            expect(issues).toHaveLength(1);
            expect(issues[0].severity).toBe('danger');
            expect(issues[0].message).toContain('wrong side of the north cardinal');
        });

        it('even when an assembler left the OSM twins in NAVLINE: OSM never holds the lead override', () => {
            const { context, cardinalIssue } = geometry();
            const ctx = context([...navLineLeads(chartNavOf(), 'NAVLNE'), ...osmNav]);
            expect(ctx.osmLeads?.length).toBeGreaterThan(0);
            expect(cardinalIssue(ctx).map((i) => i.severity)).toEqual(['danger']);
        });

        it('control: had the OSM twin carried chart authority, the danger would read as "the charted lead"', () => {
            const { context, cardinalIssue } = geometry();
            const ctx = context(mergedNavLine());
            const twin = parseLeadingLines([osmNav.find((f) => osmId(f) === 1050662408)!]);
            const issues = cardinalIssue({ ...ctx, leads: [...ctx.leads, ...twin] });
            expect(issues.map((i) => i.severity)).toEqual(['info']);
            expect(issues[0].message).toContain('on the charted lead');
        });
    },
);

describe('the twin rule takes only the stretch the chart claims (review 2026-09-29, probes C D F G)', () => {
    // It used to drop the WHOLE OSM line once 50 m of it (an absolute figure)
    // ran along a chart clearing or transit line, and it weighed only chart
    // NAVLNE leads against those, never RECTRC. Synthetic straight lines at
    // Moreton Bay's latitude; x runs east in metres, y north.
    const LAT = -27.45;
    const at = (x: number, y: number): Position => [153 + x / mLon(LAT), LAT + y / M_LAT];
    const line = (props: Record<string, unknown>, y: number, x0: number, x1: number, angDeg = 0): Feature => {
        const slope = Math.tan((angDeg * Math.PI) / 180);
        return {
            type: 'Feature',
            properties: props,
            geometry: { type: 'LineString', coordinates: [at(x0, y + x0 * slope), at(x1, y + x1 * slope)] },
        };
    };
    const osm = (id: number) => ({
        'seamark:type': 'navigation_line',
        'seamark:navigation_line:category': 'leading',
        _source: 'osm',
        _osmId: id,
    });
    const navlne = (CATNAV: number, id: number) => ({ acronym: 'NAVLNE', CATNAV, rcid: id });
    const lengthM = (f: Feature) =>
        rings(f).reduce(
            (sum, ring) =>
                sum +
                ring.reduce(
                    (m, p, i) =>
                        i === 0
                            ? m
                            : m + Math.hypot((p[0] - ring[i - 1][0]) * mLon(p[1]), (p[1] - ring[i - 1][1]) * M_LAT),
                    0,
                ),
            0,
        );

    it('D: a clearing line crossing a 3 km lead at 5 degrees takes only the stretch it runs along', () => {
        const lead = line(osm(1), 0, 0, 3000);
        const clearing = line(navlne(1, 2), -100, 0, 3000, 5);
        const kept = osmNavLineLeads([lead], [clearing]);
        expect(kept.map(osmId)).toEqual([1]);
        expect(lengthM(kept[0])).toBeGreaterThan(2_000);
        expect(lengthM(kept[0])).toBeLessThan(2_500);
        expect(alongsideM(kept[0], clearing, 25)).toBeLessThan(50);
    });

    it('F: a 60 m clearing stub beside a 3 km lead costs it the stretch beside the stub, not 3 km', () => {
        const lead = line(osm(1), 0, 0, 3000);
        const stub = line(navlne(1, 2), 10, 1000, 1060);
        const kept = osmNavLineLeads([lead], [stub]);
        expect(kept.map(osmId)).toEqual([1]);
        // The stub plus the 30 m reach round each end of it: about 120 m.
        expect(lengthM(kept[0])).toBeGreaterThan(2_850);
        expect(rings(kept[0])).toHaveLength(2);
        expect(alongsideM(kept[0], stub, 15)).toBeLessThan(20);
    });

    it('C: an OSM redraw of a RECTRC-only lead stays when a clearing line runs 25 m beside it', () => {
        const lead = line(osm(1), 0, 0, 2000);
        const clearing = line(navlne(1, 2), 25, 0, 2000);
        const rectrc = line({ acronym: 'RECTRC', CATTRK: 1, rcid: 3 }, 0, 0, 2000);
        expect(osmNavLineLeads([lead], [clearing])).toEqual([]); // no chart lead to weigh against: dropped
        expect(osmNavLineLeads([lead], [clearing], [rectrc])).toEqual([lead]); // the RECTRC wins
    });

    it('G: an OSM lead that runs on along a chart transit loses only the transit stretch', () => {
        const osmLead = line(osm(1), 0, 0, 2000);
        const chartLead = line(navlne(3, 1), 0, 0, 1500);
        const transit = line(navlne(2, 2), 0, 1500, 2000);
        const kept = osmNavLineLeads([osmLead], [chartLead, transit]);
        expect(kept.map(osmId)).toEqual([1]);
        expect(lengthM(kept[0])).toBeGreaterThan(1_400);
        expect(lengthM(kept[0])).toBeLessThan(1_550);
        expect(alongsideM(kept[0], transit, 15)).toBeLessThan(50);
    });

    it('keeps the input array and its lines when nothing is claimed, and never edits the input', () => {
        const lead = line(osm(1), 0, 0, 3000);
        const far = line(navlne(1, 2), 500, 0, 3000);
        const input = [lead];
        expect(osmNavLineLeads(input, [far])).toBe(input);
        const before = JSON.stringify(lead);
        osmNavLineLeads([lead], [line(navlne(1, 2), -100, 0, 3000, 5)]);
        expect(JSON.stringify(lead)).toBe(before);
    });

    it('the mixed-list gate passes a clipped line on, not the original', () => {
        const lead = line(osm(1), 0, 0, 3000);
        const clearing = line(navlne(1, 2), -100, 0, 3000, 5);
        const gated = navLineLeads([lead, clearing]);
        expect(gated).toHaveLength(1);
        expect(gated[0]).not.toBe(lead);
        expect(lengthM(gated[0])).toBeLessThan(2_500);
    });
});

describe('tracer: with no chart lead, an OSM lead never waives a cardinal (review 2026-09-29)', () => {
    // Pins the owner's choice. The cardinal override (ridingLeadAt) reads
    // CHART leads only, so where the only lead is an OSM line (no chart, or a
    // chart with no NAVLNE CATNAV 3 / RECTRC on that transit), a leg riding it
    // past a cardinal's wrong side reads DANGER, and a safe-side shave reads
    // the 90 m caution. Before Phase 0 every NAVLINE line, OSM included,
    // turned that danger into the green "on the charted lead" info. The tap
    // still snaps onto the OSM lead.
    const LAT = -27.005;
    const lon = (x: number) => 153 + x / mLon(LAT);
    const lat = (y: number) => LAT + y / M_LAT;
    const osmLead = (y: number): Feature => ({
        type: 'Feature',
        properties: {
            'seamark:type': 'navigation_line',
            'seamark:navigation_line:category': 'leading',
            _source: 'osm',
            _osmId: 77,
        },
        geometry: {
            type: 'LineString',
            coordinates: [
                [lon(-300), lat(y)],
                [lon(300), lat(y)],
            ],
        },
    });
    const context = (y: number) => {
        const ctx = tracerContextFromLayers(
            { NAVLINE: fc([osmLead(y)]) },
            [],
            [lon(-400), lat(-400), lon(400), lat(400)],
            2,
            { skipGrid: true },
        );
        ctx.cardinals = [{ lat: LAT, lon: 153, dir: 'n', radiusM: 100 }];
        return ctx;
    };

    it('reads the OSM line as tap-snap only', () => {
        const ctx = context(-110);
        expect(ctx.leads).toEqual([]);
        expect(ctx.osmLeads).toHaveLength(1);
        const snapped = snapTraceTapToLead(ctx, { lat: lat(-80), lon: lon(0) });
        expect(snapped && Math.abs(snapped.lat - lat(-110)) * M_LAT).toBeLessThan(1);
    });

    it('a leg riding the OSM lead past the wrong side of a north cardinal is a DANGER', () => {
        const ctx = context(-110);
        const v = validateTraceLeg({ lat: lat(-110), lon: lon(-200) }, { lat: lat(-110), lon: lon(200) }, ctx);
        const card = v.issues.filter((i) => i.message.includes('cardinal'));
        expect(card.map((i) => i.severity)).toEqual(['danger']);
        expect(card[0].message).toContain('wrong side of the north cardinal');
        expect(v.issues.some((i) => i.message.includes('on the charted lead'))).toBe(false);
    });

    it('a safe-side shave along the OSM lead is a caution, not silent', () => {
        const ctx = context(55);
        const v = validateTraceLeg({ lat: lat(55), lon: lon(-200) }, { lat: lat(55), lon: lon(200) }, ctx);
        const card = v.issues.filter((i) => i.message.includes('cardinal'));
        expect(card.map((i) => i.severity)).toEqual(['caution']);
    });
});
