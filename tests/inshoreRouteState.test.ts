/**
 * The inshore route's colours and tide chips (fix-up for Phase 2a round 2,
 * 2026-09-30).
 *
 * MEASURED on the production-shape goldens: 15.7 km of newport-shane's 18.9 km
 * of caution lay on tier-2 marked-channel segments; the renderer drew them
 * YELLOW ("the marks ARE the depth authority") and keyed the tide chips on
 * rendered red, so ~3 km of track shallower than draft + UKC — 71 m of it
 * drying on the Rivergate route — showed neither red nor a chip. Round 2 had
 * removed the grid's lead and fairway rescues precisely so this water would
 * read 'needs tide' (owner decision 6; leads never override depth).
 *
 * Owner decision 10 (Shane, 2026-09-30: "Amber if a tide clears it"): the
 * per-segment state below is the colour with NO tide data — every
 * charted-shallow segment 'danger'. The planner draws such a segment
 * needs-tide amber where some tide gives draft + UKC over it
 * (inshoreRoutePieces' tide; tests/routeTideColour.test.ts), and decision
 * 9's survey stretches as amber dashes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('mapbox-gl', () => ({ default: { Marker: class {} } }));
vi.mock('../services/TideHeightService', async (orig) => ({
    ...(await orig<typeof import('../services/TideHeightService')>()),
    fetchTideCurve: async () => null,
}));

import {
    inshoreRoutePieces,
    inshoreSegmentStates,
    surveyAmberMetres,
    type InshoreSegmentState,
} from '../components/map/inshoreRouteState';
import {
    CHIP_MAX_WIDTH_PX,
    chipElement,
    coarserLandPaintLabel,
    routeChipPlan,
    surveyChipLabel,
    tideChipRuns,
} from '../components/map/tideWindowChips';
import type { ShallowRunInfo, SurveyRunInfo } from '../services/engine/types';

const poly = (n: number): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [153 + i * 0.01, -27.3]);
const all = (n: number, v: boolean): boolean[] => new Array(n).fill(v);
const run = (startSeg: number, endSeg: number, extra: Partial<ShallowRunInfo> = {}): ShallowRunInfo => ({
    startSeg,
    endSeg,
    lengthM: 600,
    minDepthM: 1,
    midLat: -27.3,
    midLon: 153.01,
    ...extra,
});

describe('inshoreSegmentStates — charted-shallow water beats a marked channel’s yellow', () => {
    const base = (n: number) => ({
        polyline: poly(n),
        cautionMask: all(n, false),
        canalMask: all(n, false),
        channelMask: all(n, false),
        offshoreMask: all(n, false),
    });

    // Decision 10 (2026-09-30): red with no tide data; amber where a tide
    // clears it (tests/routeTideColour.test.ts).
    it('a caution segment the chart calls shallow reads RED inside a marked channel', () => {
        const r = {
            ...base(3),
            channelMask: all(3, true),
            cautionMask: [false, true, false],
            chartedShallowMask: [false, true, false],
        };
        expect(inshoreSegmentStates(r)).toEqual(['channel', 'danger', 'channel']);
    });

    it('uncharted (or undepthed conflict) caution inside a marked channel stays YELLOW, as before', () => {
        const r = {
            ...base(3),
            channelMask: all(3, true),
            cautionMask: [false, true, false],
            chartedShallowMask: all(3, false),
        };
        expect(inshoreSegmentStates(r)).toEqual(['channel', 'channel', 'channel']);
    });

    it('without a chartedShallowMask (a cloud / older route) its charted shallow runs decide', () => {
        const r = {
            ...base(4),
            channelMask: all(4, true),
            cautionMask: [false, true, true, false],
            shallowRuns: [run(1, 2)],
        };
        expect(inshoreSegmentStates(r)).toEqual(['channel', 'danger', 'danger', 'channel']);
        // A run with no charted depth is not charted-shallow.
        expect(inshoreSegmentStates({ ...r, shallowRuns: [run(1, 2, { minDepthM: null })] })).toEqual(
            all(4, true).map(() => 'channel'),
        );
    });

    it('the rest of the precedence is unchanged: canal red, open caution red, offshore blue, else green', () => {
        const r = {
            ...base(4),
            canalMask: [true, false, false, false],
            cautionMask: [false, true, false, false],
            offshoreMask: [false, false, true, false],
        };
        expect(inshoreSegmentStates(r)).toEqual(['danger', 'danger', 'offshore', 'green']);
    });

    it('missing or mismatched masks are unverified (null), never "all normal"', () => {
        expect(inshoreSegmentStates({ ...base(3), canalMask: undefined })).toBeNull();
        expect(inshoreSegmentStates({ ...base(3), cautionMask: all(2, false) })).toBeNull();
    });
});

describe('tideChipRuns — chips follow the charted-shallow runs, not the rendered colour', () => {
    it('a charted run under a yellow channel still gets its window; an uncharted one never does', () => {
        const { windowed } = tideChipRuns([run(0, 2), run(0, 2, { minDepthM: null })]);
        expect(windowed).toHaveLength(1);
        expect(windowed[0].minDepthM).toBe(1);
    });

    // Round-3 review (2026-09-30): the NtM-lock skip is gone with the
    // 'ntmlock' segment state, which nothing has produced since the lock UI
    // was removed (owner call 2026-07-02) — its test covered a state that
    // could not occur.

    it('a decision-1 endpoint tail is labelled, never windowed', () => {
        const tail = run(5, 6, {
            minDepthM: null,
            endpointTail: 'destination',
            coarserLandPaint: true,
            finestDepthM: 10,
        });
        const out = tideChipRuns([tail]);
        expect(out.windowed).toHaveLength(0);
        expect(out.landPaint).toEqual([tail]);
        // Round 3 (2026-09-30): words a punter reads in one second. Was
        // "needs tide — a coarser chart shows land here (finest survey 10.0 m)",
        // then "Charts disagree — detailed survey shows 10 m, another chart
        // shows land" (~70 characters, off a phone screen: round-3 review).
        expect(coarserLandPaintLabel(tail)).toBe('Charts disagree · 10 m charted');
        expect(coarserLandPaintLabel({ ...tail, finestDepthM: 8.5 })).toBe('Charts disagree · 8.5 m charted');
        expect(coarserLandPaintLabel(tail)).not.toMatch(/coarser|finest|needs tide/);
    });
});

describe('chips fit a phone screen (round-3 review, 2026-09-30)', () => {
    it('each reason is short, and the chip wraps inside 220 px instead of running off the map', () => {
        const parts = [
            coarserLandPaintLabel(run(0, 1, { minDepthM: null, finestDepthM: 12.5, coarserLandPaint: true })),
            surveyChipLabel({ reason: 'survey-margin', errorM: 12.3 })!,
            surveyChipLabel({ reason: 'survey-poor' })!,
            'needs +12.9 m — no window in 24 h (NtM survey)',
            'clears 09:40–15:10 ≈',
        ];
        for (const p of parts) expect(p.length, p).toBeLessThanOrEqual(48);
        const el = chipElement(parts.join(' · '));
        expect(el.style.maxWidth).toBe(`${CHIP_MAX_WIDTH_PX}px`);
        expect(CHIP_MAX_WIDTH_PX).toBeLessThanOrEqual(240);
        expect(el.style.whiteSpace).toBe('normal');
    });
});

// Owner decision 9 (Shane, 2026-09-30): "Yes, amber on the route".
const survey = (
    reason: SurveyRunInfo['reason'],
    start: number,
    end: number,
    extra: Partial<SurveyRunInfo> = {},
): SurveyRunInfo => ({
    reason,
    startSeg: Math.floor(start),
    startT: start - Math.floor(start),
    endSeg: Math.floor(end) === end ? end - 1 : Math.floor(end),
    endT: Math.floor(end) === end ? 1 : end - Math.floor(end),
    lengthM: Math.round((end - start) * 1000),
    catzoc: null,
    midLat: -27.3,
    midLon: 153 + ((start + end) / 2) * 0.01,
    ...extra,
});

// Decision 10 (2026-09-30): survey stretches are amber DASHES ('survey'),
// never the solid amber of a stretch that needs tide ('tide').
describe('inshoreRoutePieces — survey stretches drawn as dashes, cut at their exact ends', () => {
    const states = (n: number, s: InshoreSegmentState) => new Array<InshoreSegmentState>(n).fill(s);

    it('without survey stretches: one piece per run of a state, exactly the per-segment colours', () => {
        const mask: InshoreSegmentState[] = ['green', 'green', 'channel', 'danger', 'danger', 'green'];
        const pieces = inshoreRoutePieces(poly(6), mask);
        expect(pieces.map((p) => [p.state, p.coordinates.length])).toEqual([
            ['green', 3],
            ['channel', 2],
            ['danger', 3],
            ['green', 2],
        ]);
    });

    it('an ungraded stretch from 1.5 to 3.25 draws dashes there only, over teal and yellow', () => {
        const mask: InshoreSegmentState[] = ['green', 'green', 'channel', 'channel', 'green'];
        const pieces = inshoreRoutePieces(poly(5), mask, [survey('survey-ungraded', 1.5, 3.25)]);
        expect(pieces.map((p) => p.state)).toEqual(['green', 'survey', 'channel', 'green']);
        const amber = pieces[1].coordinates;
        expect(amber[0][0]).toBeCloseTo(153.015, 9);
        expect(amber[amber.length - 1][0]).toBeCloseTo(153.0325, 9);
        // The pieces join end to end: the line is the route's own geometry.
        for (let i = 1; i < pieces.length; i++) {
            expect(pieces[i].coordinates[0]).toEqual(pieces[i - 1].coordinates[pieces[i - 1].coordinates.length - 1]);
        }
    });

    it('red stays red (the more serious colour); not-checked is never drawn', () => {
        const pieces = inshoreRoutePieces(poly(3), ['danger', 'danger', 'green'], [survey('survey-poor', 0, 3)]);
        expect(pieces.map((p) => p.state)).toEqual(['danger', 'survey']);
        expect(inshoreRoutePieces(poly(2), states(2, 'green'), [survey('survey-unchecked', 0, 2)])).toHaveLength(1);
        expect(inshoreRoutePieces(poly(2), states(2, 'green'), [survey('survey-unchecked', 0, 2)])[0].state).toBe(
            'green',
        );
    });
});

describe('route chips — one chip per stretch, the most serious reason first', () => {
    it('a survey stretch over a tide run rides its chip, after the window; alone it gets its own', () => {
        const plan = routeChipPlan(
            [run(2, 3)],
            [
                survey('survey-margin', 1.5, 4, { errorM: 2.2 }),
                survey('survey-ungraded', 7, 9),
                survey('survey-margin', 12, 12.1, { errorM: 1.1 }), // 100 m: amber, no chip
                survey('survey-unchecked', 13, 15),
            ],
        );
        expect(plan.windowed).toHaveLength(1);
        // "survey ±2.2 m" since the round-4 review (2026-09-30): the long
        // words wrapped a 220 px chip to four lines after a tide reason.
        expect(plan.windowed[0].survey).toEqual(['survey ±2.2 m']);
        expect(plan.survey).toEqual([{ lat: -27.3, lon: 153.08, labels: ['old or ungraded survey'] }]);
    });

    it('touching stretches are one stretch, their reasons most serious first', () => {
        const plan = routeChipPlan(
            [],
            [
                survey('survey-margin', 0, 2, { errorM: 1.3 }),
                survey('survey-poor', 2, 3, { catzoc: 5 }),
                survey('survey-margin', 3, 4, { errorM: 2.4 }),
            ],
        );
        expect(plan.survey).toHaveLength(1);
        expect(plan.survey[0].labels).toEqual(['old or ungraded survey', 'survey ±2.4 m']);
    });

    it('a decision-1 tail carries the survey words too', () => {
        const tail = run(5, 6, {
            minDepthM: null,
            endpointTail: 'destination',
            coarserLandPaint: true,
            finestDepthM: 10,
        });
        const plan = routeChipPlan([tail], [survey('survey-ungraded', 5, 7)]);
        expect(plan.landPaint).toEqual([{ run: tail, survey: ['old or ungraded survey'] }]);
        expect(surveyChipLabel({ reason: 'survey-unchecked' })).toBeNull();
    });
});

// Round-3 review (2026-09-30): the caveat said "(marked amber)" whatever the
// map drew; Newport → Tangalooma's 0.7 km of CATZOC D lies wholly under the
// canal's red. The planner now measures what it draws amber.
describe('surveyAmberMetres — the metres the map draws as survey dashes', () => {
    it('a survey stretch wholly under red draws none; over teal it all does; by caveat', () => {
        const runs = [survey('survey-poor', 0, 1), survey('survey-margin', 1, 2, { errorM: 2.1 })];
        expect(surveyAmberMetres(poly(3), ['danger', 'danger', 'green'], runs)).toEqual({ marginM: 0, poorM: 0 });
        const all = surveyAmberMetres(poly(3), ['green', 'channel', 'green'], runs);
        expect(all.poorM).toBeGreaterThan(980);
        expect(all.poorM).toBeLessThan(1000);
        expect(all.marginM).toBeGreaterThan(980);
        expect(surveyAmberMetres(poly(3), null, runs)).toEqual({ marginM: 0, poorM: 0 });
    });
});

// Round-3 review (2026-09-30): decision-1 water (a finer never-drying band
// under a coarser chart's land paint — shallow water, never deep) drew yellow
// inside a marked channel, like a deep buoyed channel.
describe('decision-1 water in a marked channel is red, not yellow', () => {
    it('a caution segment over land-paint conflict water reads RED inside a channel', () => {
        const r = {
            polyline: poly(3),
            cautionMask: [false, true, false],
            canalMask: all(3, false),
            channelMask: all(3, true),
            offshoreMask: all(3, false),
            chartedShallowMask: all(3, false),
            landPaintConflictMask: [false, true, false],
        };
        expect(inshoreSegmentStates(r)).toEqual(['channel', 'danger', 'channel']);
        // Without the mask (an older route) it stays as it was.
        expect(inshoreSegmentStates({ ...r, landPaintConflictMask: undefined })).toEqual([
            'channel',
            'channel',
            'channel',
        ]);
    });
});
