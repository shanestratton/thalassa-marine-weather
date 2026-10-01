/**
 * Owner decision 10 (Shane, 2026-09-30): "Amber if a tide clears it".
 *
 * A shallow stretch of the route — charted depth under draft + UKC — is drawn
 * AMBER with its tide-window chip when SOME state of tide gives draft + UKC
 * over it, and RED only where no tide ever will (it dries 2 m, or needs more
 * tide than the place has). "Ever" is the highest tide the app knows there:
 * the tide station's highest height when the tide service says it, else the
 * top of the loaded tide curve. No tide data proves nothing, so the stretch
 * stays red, with a plain 'no tide data' chip (fail-safe). Drying water
 * follows the same arithmetic. Decision 9's survey stretches are amber
 * DASHES, so the two never look alike; hazard-buffer, uncharted, canal and
 * charts-disagree red stays red. ONE amber for 'needs tide' across the route
 * line, its chip and the lead overlay.
 *
 * Before decision 10 every charted-shallow stretch drew red, with an amber
 * chip beside it, and decision 9's survey amber was the same solid #ff9100 a
 * needs-tide stretch would have used.
 *
 * Serene Summer: draft 2.4 m, UKC 0.5 m — she needs 2.9 m of water.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('mapbox-gl', () => ({ default: { Marker: class {} } }));
vi.mock('../services/TideHeightService', async (orig) => ({
    ...(await orig<typeof import('../services/TideHeightService')>()),
    fetchTideCurve: async () => null,
}));
vi.mock('../services/routing/leadOverlayData', () => ({ leadGraphForView: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({ subscribe: vi.fn() }));

import {
    NEEDS_TIDE_AMBER,
    SURVEY_DASH,
    inshoreRouteFeatures,
    inshoreRouteLineLayers,
    inshoreRoutePieces,
    inshoreSegmentStates,
    routeTideDepths,
    surveyDashLayers,
    tideClears,
    tideLiftablePieces,
    type InshoreRouteMasks,
} from '../components/map/inshoreRouteState';
import {
    chipElement,
    curveHighestM,
    routeChipPlan,
    routeTideCurves,
    tideRunChips,
} from '../components/map/tideWindowChips';
import { AMBER_INK } from '../components/map/useChartLeadsLayer';
import { buildTideCurve, type TideCurve } from '../services/TideHeightService';
import type { ShallowRunInfo, SurveyRunInfo } from '../services/engine/types';

const DRAFT_M = 2.4;
const NEED_M = 2.9; // draft 2.4 + UKC 0.5

/** A 2.5 m-range tide on LAT: low 0.0 m, high 2.5 m, every 6 h 12 min. */
const DEPART_MS = Date.UTC(2026, 9, 1, 0, 0);
function tide(rangeM = 2.5): TideCurve {
    const step = (6 * 60 + 12) * 60;
    const t0 = DEPART_MS / 1000 - 3 * 3600;
    const extremes = Array.from({ length: 16 }, (_, k) => ({
        dt: t0 + k * step,
        date: '',
        height: k % 2 === 0 ? 0 : rangeM,
        type: (k % 2 === 0 ? 'Low' : 'High') as 'Low' | 'High',
    }));
    const curve = buildTideCurve({ status: 200, responseDatum: 'LAT', extremes });
    if (!curve) throw new Error('fixture tide did not build');
    return curve;
}

const poly = (n: number): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [153 + i * 0.01, -27.3]);
const all = (n: number, v: boolean): boolean[] => new Array(n).fill(v);

/** Three segments in a marked channel; the middle one crosses charted water `depthM` deep. */
function channelWithShallow(depthM: number, extra: Partial<InshoreRouteMasks> = {}): InshoreRouteMasks {
    return {
        polyline: poly(3),
        cautionMask: [false, true, false],
        canalMask: all(3, false),
        channelMask: all(3, true),
        offshoreMask: all(3, false),
        chartedShallowMask: [false, true, false],
        landPaintConflictMask: all(3, false),
        tideDepthM: [null, depthM, null],
        ...extra,
    };
}
const shallowRun = (depthM: number, extra: Partial<ShallowRunInfo> = {}): ShallowRunInfo => ({
    startSeg: 1,
    endSeg: 1,
    lengthM: 990,
    minDepthM: depthM,
    midLat: -27.3,
    midLon: 153.015,
    minAtLat: -27.3,
    minAtLon: 153.016,
    ...extra,
});
const survey = (reason: SurveyRunInfo['reason'], extra: Partial<SurveyRunInfo> = {}): SurveyRunInfo => ({
    reason,
    startSeg: 1,
    startT: 0,
    endSeg: 1,
    endT: 1,
    lengthM: 990,
    catzoc: null,
    midLat: -27.3,
    midLon: 153.015,
    ...extra,
});

/** Draw a route the way the planner does, for a given highest tide. */
function draw(r: InshoreRouteMasks, highestM: number | null, surveyRuns: SurveyRunInfo[] = []) {
    const states = inshoreSegmentStates(r);
    if (!states) throw new Error('masks did not verify');
    return inshoreRoutePieces(r.polyline, states, surveyRuns, r.chartedShallowSpans, {
        depthM: routeTideDepths(r),
        needM: NEED_M,
        highestM,
    }).map((p) => p.state);
}

function chips(runs: ShallowRunInfo[], curve: TideCurve | null, surveyRuns: SurveyRunInfo[] = []) {
    return tideRunChips({ plan: routeChipPlan(runs, surveyRuns), curve, draftM: DRAFT_M, departureMs: DEPART_MS })
        .chips;
}

describe('decision 10 — a shallow stretch a tide clears is amber, with its window', () => {
    it('a 1.5 m channel in a 2.5 m-range tide: amber, and its chip gives the window', () => {
        const curve = tide(2.5);
        expect(curveHighestM(curve)).toBeCloseTo(2.5, 6);
        // Needs +1.4 m; the tide reaches 2.5 m.
        expect(draw(channelWithShallow(1.5), curveHighestM(curve))).toEqual(['channel', 'tide', 'channel']);
        const out = chips([shallowRun(1.5)], curve);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('amber');
        expect(out[0].text).toMatch(/^clears (\d\d:\d\d–\d\d:\d\d|until \d\d:\d\d) ≈$/);
    });

    it('a 2 m drying bank: red — it needs +4.9 m and no tide here reaches it', () => {
        const curve = tide(2.5);
        expect(draw(channelWithShallow(-2), curveHighestM(curve))).toEqual(['channel', 'danger', 'channel']);
        const out = chips([shallowRun(-2)], curve);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('red');
        // RE-WORDED (round-4 review, 2026-09-30): "never clears" was untrue of
        // a curve of days — it says what the loaded days reach (this fixture
        // curve spans ~4 days; the app loads 14).
        expect(out[0].text).toBe('no tide in 4 days clears it — needs +4.9 m, highest 2.5 m');
        // Anchored on the shallowest spot, which is red whatever else the run is.
        expect([out[0].lon, out[0].lat]).toEqual([153.016, -27.3]);
    });

    it('drying water follows the same arithmetic: dries 0.3 m in a 3.5 m range is amber', () => {
        const curve = tide(3.5);
        expect(draw(channelWithShallow(-0.3), curveHighestM(curve))).toEqual(['channel', 'tide', 'channel']);
        expect(chips([shallowRun(-0.3)], curve)[0].tone).toBe('amber');
        // …and red in a 2.5 m range (needs +3.2 m).
        expect(draw(channelWithShallow(-0.3), 2.5)).toEqual(['channel', 'danger', 'channel']);
        expect(tideClears(-0.3, NEED_M, 3.2)).toBe(true);
        expect(tideClears(-0.3, NEED_M, 3.19)).toBe(false);
    });

    it('no tide data proves nothing: red, with a plain "no tide data" chip', () => {
        expect(draw(channelWithShallow(1.5), null)).toEqual(['channel', 'danger', 'channel']);
        const out = chips([shallowRun(1.5)], null);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('red');
        expect(out[0].text).toBe('no tide data — needs +1.4 m');
    });

    it('a backstop stretch off the caution mask follows the same rule', () => {
        const r: InshoreRouteMasks = {
            ...channelWithShallow(1.5),
            cautionMask: all(3, false),
            chartedShallowMask: all(3, false),
            tideDepthM: all(3, false).map(() => null),
            // The router marks a stretch its depth alone makes red (round-4
            // review, 2026-09-30); without the mark it is red whatever the tide.
            chartedShallowSpans: [
                { startSeg: 1, startT: 0.25, endSeg: 1, endT: 0.75, minDepthM: 1.5, tideLiftable: true },
            ],
        };
        expect(draw(r, 2.5)).toEqual(['channel', 'tide', 'channel']);
        expect(draw(r, null)).toEqual(['channel', 'danger', 'channel']);
        expect(
            draw({ ...r, chartedShallowSpans: [{ ...r.chartedShallowSpans![0], tideLiftable: undefined }] }, 2.5),
        ).toEqual(['channel', 'danger', 'channel']);
        expect(draw({ ...r, chartedShallowSpans: [{ ...r.chartedShallowSpans![0], minDepthM: -2 }] }, 2.5)).toEqual([
            'channel',
            'danger',
            'channel',
        ]);
    });

    it('hazard-buffer, uncharted, canal and charts-disagree red stay red whatever the tide', () => {
        // The engine ships no tide depth where a tide cannot change the red
        // (hazard buffer, a sample with no chart under it): tideDepthM null.
        expect(draw(channelWithShallow(1.5, { tideDepthM: [null, null, null] }), 2.5)).toEqual([
            'channel',
            'danger',
            'channel',
        ]);
        // An older or cloud route without the mask: red, as before decision 10.
        expect(draw(channelWithShallow(1.5, { tideDepthM: undefined }), 2.5)).toEqual(['channel', 'danger', 'channel']);
        // The canal's red and decision-1 water's red are not the tide's to lift.
        expect(draw(channelWithShallow(1.5, { canalMask: [false, true, false] }), 2.5)).toEqual([
            'channel',
            'danger',
            'channel',
        ]);
        expect(draw(channelWithShallow(1.5, { landPaintConflictMask: [false, true, false] }), 2.5)).toEqual([
            'channel',
            'danger',
            'channel',
        ]);
    });
});

describe('the line is coloured per segment, and every chip names the colour under it', () => {
    it('a red run holding a stretch some tide clears: red chip on its shallowest spot, amber chip on the amber', () => {
        const curve = tide(2.5);
        const r: InshoreRouteMasks = {
            polyline: poly(4),
            cautionMask: [false, true, true, false],
            canalMask: all(4, false),
            channelMask: all(4, true),
            offshoreMask: all(4, false),
            chartedShallowMask: [false, true, true, false],
            landPaintConflictMask: all(4, false),
            tideDepthM: [null, 1.5, -2, null],
        };
        const states = inshoreSegmentStates(r)!;
        const pieces = inshoreRoutePieces(r.polyline, states, [], [], {
            depthM: routeTideDepths(r),
            needM: NEED_M,
            highestM: curveHighestM(curve),
        });
        expect(pieces.map((p) => p.state)).toEqual(['channel', 'tide', 'danger', 'channel']);
        expect(pieces[1].depthM).toBe(1.5);
        const run = shallowRun(-2, { endSeg: 2, lengthM: 1980, midLon: 153.02, minAtLon: 153.025 });
        const out = tideRunChips({
            plan: routeChipPlan([run], [survey('survey-poor', { endSeg: 2, catzoc: 5 })]),
            curve,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            pieces,
        }).chips;
        expect(out.map((c) => c.tone)).toEqual(['red', 'amber']);
        expect(out[0].text).toBe('no tide in 4 days clears it — needs +4.9 m, highest 2.5 m · old or ungraded survey');
        expect(out[0].lon).toBe(153.025);
        expect(out[1].text).toMatch(/^clears (\d\d:\d\d–\d\d:\d\d|until \d\d:\d\d) ≈$/);
        // On the amber stretch, segment 1 (153.01–153.02).
        expect(out[1].lon).toBeGreaterThan(153.01);
        expect(out[1].lon).toBeLessThan(153.02);
    });
});

describe('a run a tide clears whose line is red for more than depth', () => {
    // Round 4 (2026-09-30), measured on the Newport → Rivergate golden: a
    // 6.4 km run over decision-1 water with 2 m charted in it got an amber
    // "clears …" chip over its red line.
    it('gets a red chip naming why, never a window over a red line', () => {
        const curve = tide(2.5);
        const r = channelWithShallow(2, { landPaintConflictMask: [false, true, false] });
        const states = inshoreSegmentStates(r)!;
        const pieces = inshoreRoutePieces(r.polyline, states, [], [], {
            depthM: routeTideDepths(r),
            needM: NEED_M,
            highestM: curveHighestM(curve),
        });
        expect(pieces.map((p) => p.state)).toEqual(['channel', 'danger', 'channel']);
        const chipsFor = (run: ShallowRunInfo) =>
            tideRunChips({
                plan: routeChipPlan([run], []),
                curve,
                draftM: DRAFT_M,
                departureMs: DEPART_MS,
                pieces,
            }).chips;
        expect(chipsFor(shallowRun(2, { chartsDisagree: true }))).toEqual([
            { lat: -27.3, lon: 153.015, text: 'Charts disagree · 2 m charted', tone: 'red' },
        ]);
        // RE-WORDED (round-4 review, 2026-09-30): "red for more than depth"
        // was jargon; the router's reason goes on the chip when it has one.
        expect(chipsFor(shallowRun(2))[0]).toMatchObject({ text: 'check the chart here', tone: 'red' });
        expect(chipsFor(shallowRun(2, { nearHazard: true }))[0]).toMatchObject({
            text: 'charted hazard close by — check the chart',
            tone: 'red',
        });
        expect(chipsFor(shallowRun(2, { partUncharted: true }))[0]).toMatchObject({
            text: 'part not charted — check the chart',
            tone: 'red',
        });
    });
});

describe('decision 9 beside decision 10 — survey stretches are amber DASHES', () => {
    it('a survey stretch over teal draws as its own dashed state', () => {
        const r: InshoreRouteMasks = {
            ...channelWithShallow(1.5),
            cautionMask: all(3, false),
            chartedShallowMask: all(3, false),
            channelMask: all(3, false),
            tideDepthM: [null, null, null],
        };
        expect(draw(r, 2.5, [survey('survey-ungraded')])).toEqual(['green', 'survey', 'green']);
        const states = inshoreSegmentStates(r)!;
        const features = inshoreRouteFeatures(inshoreRoutePieces(r.polyline, states, [survey('survey-ungraded')]));
        expect(features.map((f) => f.properties.safety)).toEqual(['green', 'survey', 'green']);
        // Dashes on the lead overlay's dark casing, in the one needs-tide amber —
        // never the solid line a needs-tide stretch draws.
        const [casing, dash] = surveyDashLayers('route-line');
        expect(casing.filter).toEqual(['==', ['get', 'safety'], 'survey']);
        expect(dash.filter).toEqual(['==', ['get', 'safety'], 'survey']);
        expect(casing.paint['line-color']).toBe(SURVEY_DASH.casing);
        expect(dash.paint['line-color']).toBe(NEEDS_TIDE_AMBER);
        expect(dash.paint['line-dasharray']).toEqual([...SURVEY_DASH.dasharray]);
        expect(dash.paint['line-dasharray'].length).toBeGreaterThan(0);
        // Round DOTS since the round-4 review (2026-09-30): the dashes were the
        // lead overlay's own needs-tide pattern, drawn under the very route.
        expect(dash.layout['line-cap']).toBe('round');
        expect(dash.paint['line-dasharray']).not.toEqual([1.6, 1.2]);
    });

    it('the map draws them: solid layers leave survey out, the dashed pair draws it', () => {
        const src = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(src).toContain('surveyDashLayers(');
        // The solid layers' table moved to inshoreRouteState on 2026-10-01
        // (shared with Auto's map): check what it builds, not its spelling.
        expect(src).toContain("inshoreRouteLineLayers('route-line')");
        const layers = inshoreRouteLineLayers('route-line');
        // Both tables pinned outright (2026-10-01 review: the core's entry
        // went unpinned behind a branch): the glow and the line draw needs
        // tide in THE amber, the thin core in its pale tint.
        const tideColour = (id: string): unknown => {
            const layer = layers.find((l) => l.id === id);
            expect(layer, id).toBeDefined();
            expect(layer!.filter).toContainEqual(['!=', ['get', 'safety'], 'survey']);
            const colours = layer!.paint['line-color'] as unknown[];
            const tide = colours.indexOf('tide');
            expect(tide).toBeGreaterThan(1);
            return colours[tide + 1];
        };
        expect(layers.map((l) => l.id)).toEqual(['route-glow', 'route-line-layer', 'route-core']);
        expect(tideColour('route-glow')).toBe(NEEDS_TIDE_AMBER);
        expect(tideColour('route-line-layer')).toBe(NEEDS_TIDE_AMBER);
        expect(tideColour('route-core')).toBe('#ffe0b2');
        expect(src).not.toContain('ntmlock');
    });

    it('ONE amber for needs tide: the route line, its chip and the lead overlay', () => {
        expect(NEEDS_TIDE_AMBER).toBe('#ff9100');
        expect(AMBER_INK).toBe(NEEDS_TIDE_AMBER);
        const el = chipElement('clears 09:40–15:10', 'amber');
        expect(el.style.color).toBe('rgb(255, 145, 0)');
        // A red chip names red water in the app's danger red, not amber.
        expect(chipElement('no tide data — needs +1.4 m', 'red').style.color).not.toBe('rgb(255, 145, 0)');
    });
});

describe('a stretch that is both — the more serious wins, one chip', () => {
    it('needs tide and survey: amber (solid), one chip with the window first', () => {
        const curve = tide(2.5);
        const s = [survey('survey-margin', { errorM: 1.0 })];
        expect(draw(channelWithShallow(1.5), curveHighestM(curve), s)).toEqual(['channel', 'tide', 'channel']);
        const out = chips([shallowRun(1.5)], curve, s);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('amber');
        // "survey ±1.0 m" since the round-4 review (2026-09-30): the long
        // words wrapped a 220 px chip to four lines.
        expect(out[0].text).toMatch(/^clears .* · survey ±1\.0 m$/);
    });

    it('no tide clears it and survey: red, one chip that says both', () => {
        const curve = tide(2.5);
        const s = [survey('survey-poor', { catzoc: 5 })];
        expect(draw(channelWithShallow(-2), curveHighestM(curve), s)).toEqual(['channel', 'danger', 'channel']);
        const out = chips([shallowRun(-2)], curve, s);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('red');
        expect(out[0].text).toBe('no tide in 4 days clears it — needs +4.9 m, highest 2.5 m · old or ungraded survey');
    });
});

describe('"ever" is the highest tide the app knows there', () => {
    it('the top of the loaded curve over its full span, not only the 24 h window', () => {
        // Neaps now, springs in four days: the curve's own top counts.
        const base = DEPART_MS / 1000;
        const extremes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((k) => ({
            dt: base + k * 6 * 3600,
            date: '',
            height: k % 2 === 0 ? 0.4 : k >= 15 ? 2.6 : 1.8,
            type: (k % 2 === 0 ? 'Low' : 'High') as 'Low' | 'High',
        }));
        const curve = buildTideCurve({ status: 200, responseDatum: 'LAT', extremes })!;
        expect(curveHighestM(curve)).toBeCloseTo(2.6, 6);
        // A curve without the station's figure is swept.
        const bare: TideCurve = { ...curve, maxHeightM: undefined };
        expect(curveHighestM(bare)!).toBeGreaterThan(2.59);
        // Needs +2.4 m: never inside 24 h (neaps reach 1.8 m) — amber all the
        // same, the chip saying there is no window today.
        const out = chips([shallowRun(0.5)], curve);
        expect(out[0].tone).toBe('amber');
        expect(out[0].text).toBe('needs +2.4 m — no window in 24 h');
    });
});

// ── Round-4 review (2026-09-30) ─────────────────────────────────────────

/** A tide of `rangeM` over `days` days from a day before departure. */
function tideOver(rangeM: number, days: number): TideCurve {
    const step = (6 * 60 + 12) * 60;
    const t0 = DEPART_MS / 1000 - 24 * 3600;
    const n = Math.ceil((days * 24 * 3600) / step) + 1;
    const extremes = Array.from({ length: n }, (_, k) => ({
        dt: t0 + k * step,
        date: '',
        height: k % 2 === 0 ? 0 : rangeM,
        type: (k % 2 === 0 ? 'Low' : 'High') as 'Low' | 'High',
    }));
    return buildTideCurve({ status: 200, responseDatum: 'LAT', extremes })!;
}

describe('each shallow stretch is judged by the tide of its OWN place (round-4 review)', () => {
    // One curve's top used to colour every stretch of the route, however far
    // from where it was fetched: the Brisbane River mouth's bank, 25 km from
    // Bramble Bay, was drawn from Bramble Bay's. Three 1.5 m stretches in
    // three 0.25° tide buckets: a 2.5 m range, a 1.0 m range, and no curve.
    const r: InshoreRouteMasks = {
        polyline: [
            [153.0, -27.3],
            [153.01, -27.3],
            [153.49, -27.3],
            [153.5, -27.3],
            [153.74, -27.3],
            [153.75, -27.3],
        ],
        cautionMask: [true, false, true, false, true],
        canalMask: all(5, false),
        channelMask: all(5, false),
        offshoreMask: all(5, false),
        chartedShallowMask: [true, false, true, false, true],
        landPaintConflictMask: all(5, false),
        tideDepthM: [1.5, null, 1.5, null, 1.5],
    };
    const setup = () => {
        const curves = routeTideCurves(
            new Map([
                ['-27.25,153', tideOver(2.5, 14)],
                ['-27.25,153.5', tideOver(1.0, 14)],
            ]),
        );
        const highestAt = (lon: number, lat: number): number | null => {
            const c = curves.at(lon, lat);
            return c ? curveHighestM(c) : null;
        };
        const states = inshoreSegmentStates(r)!;
        // The route-wide top (2.5 m, the first curve's) no longer decides:
        // the place's own does.
        const pieces = inshoreRoutePieces(r.polyline, states, [], [], {
            depthM: routeTideDepths(r),
            needM: NEED_M,
            highestM: 2.5,
            highestAt,
        });
        return { curves, states, pieces };
    };

    it('amber only where that place’s tide clears it; red where it does not, or none is loaded', () => {
        expect(setup().pieces.map((p) => p.state)).toEqual(['tide', 'green', 'danger', 'green', 'danger']);
    });

    it('the chips say the same, place by place', () => {
        const { curves, states, pieces } = setup();
        const run = (seg: number, lon: number): ShallowRunInfo =>
            shallowRun(1.5, { startSeg: seg, endSeg: seg, midLon: lon, minAtLon: lon });
        const out = tideRunChips({
            plan: routeChipPlan([run(0, 153.005), run(2, 153.495), run(4, 153.745)], []),
            curves,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            pieces,
            liftable: tideLiftablePieces(r.polyline, states, [], routeTideDepths(r), NEED_M),
        }).chips;
        expect(out.map((c) => c.tone)).toEqual(['amber', 'red', 'red']);
        expect(out[0].text).toMatch(/^clears /);
        // RE-PINNED 14 → 13 days (decision 11 fix-up, 2026-10-01): the top is
        // read from the departure on, never a tide already past — this curve
        // starts a day before it, as the proxy's do (yesterday 00:00).
        expect(out[1].text).toBe('no tide in 13 days clears it — needs +1.4 m, highest 1.0 m');
        expect(out[2].text).toBe('tide times not loaded here — needs +1.4 m');
    });

    it('a stretch that runs into a place with a smaller range is judged by the smaller', () => {
        const long: InshoreRouteMasks = {
            ...r,
            polyline: [
                [153.0, -27.3],
                [153.2, -27.3],
            ],
            cautionMask: [true],
            canalMask: [false],
            channelMask: [false],
            offshoreMask: [false],
            chartedShallowMask: [true],
            landPaintConflictMask: [false],
            tideDepthM: [1.5],
        };
        // 153.0 → 153.2 crosses from the 2.5 m bucket into the 1.0 m one (153.125+).
        const drawn = inshoreRoutePieces(long.polyline, inshoreSegmentStates(long)!, [], [], {
            depthM: routeTideDepths(long),
            needM: NEED_M,
            highestM: 2.5,
            highestAt: (lon) => (lon < 153.125 ? 2.5 : 1.0),
        });
        expect(drawn.map((p) => p.state)).toEqual(['danger']);
    });
});

describe('the highest tide is read over the 14 days the app loads (round-4 review)', () => {
    it('red words name the days the top was read over, never "never"', () => {
        const out = chips([shallowRun(-2)], tideOver(2.5, 14));
        // RE-PINNED 14 → 13 days (decision 11 fix-up, 2026-10-01): read from
        // the departure on; the curve's first day (from yesterday 00:00, as
        // the proxy anchors it) is past.
        expect(out[0]).toMatchObject({
            tone: 'red',
            text: 'no tide in 13 days clears it — needs +4.9 m, highest 2.5 m',
        });
    });
});

describe('a run no tide could draw amber says why — curve or no curve (round-4 review)', () => {
    // MEASURED on the Rivergate golden: 6,369 m all under the overview's land
    // paint over a wet band (decision-1 water). Offline its chip read "no
    // tide data — needs +0.6 m", as if a tide could fix it.
    const run = shallowRun(2, { chartsDisagree: true });
    const say = (curve: TideCurve | null, extra: Partial<ShallowRunInfo> = {}, canal = false) =>
        tideRunChips({
            plan: routeChipPlan([{ ...run, ...extra }], []),
            curve,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            tideSafetyM: 0.2,
            liftable: [],
            ...(canal ? { canalMask: [false, true, false] } : {}),
        }).chips;

    it('offline: "Charts disagree", not "no tide data — needs +0.6 m"', () => {
        expect(say(null)).toEqual([{ lat: -27.3, lon: 153.015, text: 'Charts disagree · 2 m charted', tone: 'red' }]);
        // …and the same with a curve.
        expect(say(tide(2.5))[0].text).toBe('Charts disagree · 2 m charted');
    });

    it('each reason in its own words', () => {
        const plain = { chartsDisagree: undefined };
        expect(say(null, { ...plain, nearHazard: true })[0].text).toBe('charted hazard close by — check the chart');
        expect(say(null, { ...plain, partUncharted: true })[0].text).toBe('part not charted — check the chart');
        expect(say(null, plain, true)[0].text).toBe('canal · 2 m charted');
    });

    it('a run some tide could lift, offline, still says "no tide data"', () => {
        const r = channelWithShallow(1.5);
        const liftable = tideLiftablePieces(r.polyline, inshoreSegmentStates(r)!, [], routeTideDepths(r), NEED_M);
        expect(liftable).toHaveLength(1);
        const out = tideRunChips({
            plan: routeChipPlan([shallowRun(1.5)], []),
            curve: null,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            liftable,
        }).chips;
        expect(out[0]).toMatchObject({ tone: 'red', text: 'no tide data — needs +1.4 m' });
    });
});

describe('every amber stretch has its chip (round-4 review)', () => {
    it('a stretch under a chip run’s 200 m gets its own window chip', () => {
        const curve = tide(2.5);
        const r = channelWithShallow(1.5, {
            polyline: [
                [153, -27.3],
                [153.0003, -27.3],
                [153.0009, -27.3],
                [153.0012, -27.3],
            ],
        });
        const pieces = inshoreRoutePieces(r.polyline, inshoreSegmentStates(r)!, [], [], {
            depthM: routeTideDepths(r),
            needM: NEED_M,
            highestM: curveHighestM(curve),
        });
        expect(pieces.map((p) => p.state)).toEqual(['channel', 'tide', 'channel']);
        // ~59 m: no shallow run (they start at 200 m), yet it is amber.
        const out = tideRunChips({
            plan: routeChipPlan([], []),
            curve,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            pieces,
        }).chips;
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('amber');
        expect(out[0].text).toMatch(/^clears /);
        expect(out[0].lon).toBeGreaterThan(153.0003);
        expect(out[0].lon).toBeLessThan(153.0009);
    });
});

describe('a run a tide clears in part: its red says why too (round-4 review)', () => {
    it('amber window on the amber, and a red chip naming why the rest is red', () => {
        const curve = tide(2.5);
        const r: InshoreRouteMasks = {
            polyline: poly(4),
            cautionMask: [false, true, true, false],
            canalMask: all(4, false),
            channelMask: all(4, true),
            offshoreMask: all(4, false),
            chartedShallowMask: [false, true, true, false],
            landPaintConflictMask: [false, false, true, false],
            tideDepthM: [null, 1.5, null, null],
        };
        const states = inshoreSegmentStates(r)!;
        const pieces = inshoreRoutePieces(r.polyline, states, [], [], {
            depthM: routeTideDepths(r),
            needM: NEED_M,
            highestM: curveHighestM(curve),
        });
        expect(pieces.map((p) => p.state)).toEqual(['channel', 'tide', 'danger', 'channel']);
        const out = tideRunChips({
            plan: routeChipPlan([shallowRun(1.5, { endSeg: 2, lengthM: 1980, chartsDisagree: true })], []),
            curve,
            draftM: DRAFT_M,
            departureMs: DEPART_MS,
            pieces,
        }).chips;
        expect(out.map((c) => [c.tone, c.text.split(' ')[0]])).toEqual([
            ['red', 'Charts'],
            ['amber', 'clears'],
        ]);
        // The red chip on the red (segment 2), the amber on the amber (segment 1).
        expect(out[0].lon).toBeGreaterThan(153.02);
        expect(out[1].lon).toBeLessThan(153.02);
    });
});

describe('the planner colours the tide against the router’s own draft + UKC (round-4 review)', () => {
    it('the router ships it and the planner reads it', () => {
        const planner = readFileSync('components/map/usePassagePlanner.ts', 'utf8');
        expect(planner).toContain('inshoreRes.tideNeedM');
        expect(planner).toContain('needM: tideNeedM');
        expect(readFileSync('services/inshoreRouterEngine.ts', 'utf8')).toContain('tideNeedM: req.draftM + safetyM');
    });
});

describe('decision 11 fix-up (2026-10-01) — a band some tide clears is not "no tide clears it"', () => {
    // The router routes a 0–2 m band at a 2.5 m top (2 + 2.5 ≥ 2.9: nothing
    // proved), and the chip on that same water said "no tide in 14 days
    // clears it", reading the band's 0 m end — the skipper saw the router
    // take water the app said no tide clears. Still red (decision 10: its
    // 0 m end needs more than the tide), but worded for what it is.
    it('a 0–2 m band at a 2.5 m top: red, "its 0 m end needs +2.9 m … check the chart"', () => {
        const curve = tide(2.5);
        expect(draw(channelWithShallow(0), curveHighestM(curve))).toEqual(['channel', 'danger', 'channel']);
        const out = chips([shallowRun(0, { deepestM: 2 })], curve);
        expect(out).toHaveLength(1);
        expect(out[0].tone).toBe('red');
        expect(out[0].text).toBe('charted 0–2 m: its 0 m end needs +2.9 m, highest 2.5 m — check the chart');
    });

    it('a drying band (−2..0) is still water no tide clears, and says so', () => {
        const out = chips([shallowRun(-2, { deepestM: 0 })], tide(2.5));
        expect(out[0].text).toBe('no tide in 4 days clears it — needs +4.9 m, highest 2.5 m');
    });

    it('a top read from the departure on: yesterday’s higher tide is not counted', () => {
        // The curve starts 30 h before the departure (the proxy anchors it at
        // yesterday 00:00) with a 3.5 m high then; from the departure on its
        // highs reach 2.5 m. A tide that has already happened must not lift
        // the top.
        const step = (6 * 60 + 12) * 60;
        const t0 = DEPART_MS / 1000 - 30 * 3600;
        const extremes = Array.from({ length: 20 }, (_, k) => ({
            dt: t0 + k * step,
            date: '',
            height: k % 2 === 0 ? 0 : k === 1 ? 3.5 : 2.5,
            type: (k % 2 === 0 ? 'Low' : 'High') as 'Low' | 'High',
        }));
        const curve = buildTideCurve({ status: 200, responseDatum: 'LAT', extremes });
        if (!curve) throw new Error('fixture tide did not build');
        expect(curveHighestM(curve)).toBeCloseTo(3.5, 6);
        expect(curveHighestM(curve, DEPART_MS)).toBeCloseTo(2.5, 2);
        const out = chips([shallowRun(-0.5, { deepestM: 0 })], curve);
        // 2.9 + 0.5 = 3.4 m: the past 3.5 m high would have cleared it.
        expect(out[0].tone).toBe('red');
        expect(out[0].text).toMatch(/^no tide in \d+ days? clears it — needs \+3\.4 m, highest 2\.5 m$/);
    });
});
