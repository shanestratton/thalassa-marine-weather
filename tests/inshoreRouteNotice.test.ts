/**
 * A route drawn over chart data that carries no bridge or overhead-line
 * layers says so next to the route (Phase 2a review, 2026-09-30): every cell
 * converted before schema 2 lacks them, and the route there was gated by the
 * curated bridge list alone — while the lead overlay already said "bridges
 * not in chart data".
 */
import { describe, expect, it } from 'vitest';
import {
    inshoreRouteCaveats,
    inshoreRouteNotice,
    savedInshoreRouteCaveats,
    surveyCaveats,
} from '../components/map/inshoreRouteNotice';
import type { SurveyRunInfo } from '../services/engine/types';
import { inshoreRouteToGeoJSON } from '../services/InshoreRouter';

describe('inshore route notice', () => {
    // Owner decision 8 (2026-09-30): route as normal, with a plain warning —
    // in a skipper's words (round 2), not "structure layers" or "schema".
    it('says plainly that bridges and power lines were not checked on the chart, but known bridges were', () => {
        const n = inshoreRouteNotice({
            stateMaskOk: true,
            structuresUnknownCells: ['OC-61-10ENB5'],
            ntmLockBanner: null,
        });
        expect(n?.severity).toBe('warn');
        expect(n?.title).toBe('Bridges and power lines not checked');
        expect(n?.message).toMatch(/^Bridges and power lines not checked on this chart — known bridges are\./);
        expect(n?.message).toMatch(/air draft/);
        expect(n?.message).not.toMatch(/schema|layer|data/i);
    });

    it('counts the charts', () => {
        const n = inshoreRouteNotice({
            stateMaskOk: true,
            structuresUnknownCells: ['A', 'B', 'C'],
            ntmLockBanner: null,
        });
        expect(n?.message).toMatch(
            /^Bridges and power lines not checked on 3 of the charts on this route — known bridges are\./,
        );
    });

    it('stays silent when every cell carries them', () => {
        expect(inshoreRouteNotice({ stateMaskOk: true, ntmLockBanner: null })).toBeNull();
        expect(inshoreRouteNotice({ stateMaskOk: true, structuresUnknownCells: [], ntmLockBanner: null })).toBeNull();
    });

    it('a broken classification, an inland pin and a notice lock still come first — and carry the caveat', () => {
        const lock = { severity: 'warn' as const, title: 'NtM', message: 'locked' };
        const gap = { structuresUnknownCells: ['A'] };
        const broken = inshoreRouteNotice({ stateMaskOk: false, ...gap, ntmLockBanner: lock });
        expect(broken?.title).toMatch(/verification/);
        expect(broken?.message).toMatch(/Bridges and power lines not checked on this chart/);
        // Fix-up (2026-09-30): the inland-trim notice and the NtM lock used to
        // REPLACE the caveat decision 8 says the route carries.
        const inland = inshoreRouteNotice({
            stateMaskOk: true,
            destinationInlandTrimM: 80,
            ...gap,
            ntmLockBanner: lock,
        });
        expect(inland?.title).toMatch(/inland/);
        expect(inland?.message).toMatch(/Bridges and power lines not checked on this chart/);
        const locked = inshoreRouteNotice({ stateMaskOk: true, ...gap, ntmLockBanner: lock });
        expect(locked?.title).toBe('NtM');
        expect(locked?.message).toMatch(/^locked Bridges and power lines not checked on this chart/);
        // With no caveat, the lock is shown exactly as it is.
        expect(inshoreRouteNotice({ stateMaskOk: true, ntmLockBanner: lock })).toBe(lock);
    });
});

describe('inshore route caveats — what the route carries whatever notice shows (fix-up, 2026-09-30)', () => {
    it('the bridge caveat is a caveat of its own, for the planner’s persistent line', () => {
        expect(inshoreRouteCaveats({ structuresUnknownCells: ['A'] })).toEqual([
            expect.stringMatching(/^Bridges and power lines not checked on this chart — known bridges are\./),
        ]);
        expect(inshoreRouteCaveats({})).toEqual([]);
    });

    // Round 3 (2026-09-30): the route stops at the edge of the bank or the
    // land now (decision 7's limit is never drying), and says so plainly.
    it('a pin off the water is said plainly (decision 7): the route stops at its edge', () => {
        const drying = inshoreRouteNotice({
            stateMaskOk: true,
            pinOffWater: { destination: 'drying' },
            ntmLockBanner: null,
        });
        expect(drying?.title).toBe('Pin off the water');
        expect(drying?.message).toBe(
            'Your destination pin is on a drying bank — the route stops at its edge. It dries at low water.',
        );
        expect(inshoreRouteCaveats({ pinOffWater: { origin: 'land' } })).toEqual([
            "Your departure pin is on charted land — the route starts at the water's edge.",
        ]);
        expect(inshoreRouteCaveats({ pinOffWater: { destination: 'land' } })).toEqual([
            "Your destination pin is on charted land — the route stops at the water's edge.",
        ]);
        expect(inshoreRouteCaveats({ pinOffWater: { origin: 'drying' } })[0]).toMatch(
            /^Your departure pin is on a drying bank — the route starts at its edge\./,
        );
    });

    it('an inland trim already says the destination is on land: no second line for it', () => {
        expect(inshoreRouteCaveats({ destinationInlandTrimM: 80, pinOffWater: { destination: 'land' } })).toEqual([]);
    });
});

// Owner decision 9 (Shane, 2026-09-30): "Yes, amber on the route". The route
// says how much of it the survey may be out by more than the keel margin, how
// much is old or ungraded — and, decision 8's way, the charts whose survey
// quality was not checked at all.
const run = (reason: SurveyRunInfo['reason'], lengthM: number, extra: Partial<SurveyRunInfo> = {}): SurveyRunInfo => ({
    reason,
    startSeg: 0,
    startT: 0,
    endSeg: 0,
    endT: 1,
    lengthM,
    catzoc: null,
    midLat: -27.3,
    midLon: 153.2,
    ...extra,
});

describe('survey quality on the route (decision 9)', () => {
    it('says the margin stretches with the worst error, and the old or ungraded ones, in plain words', () => {
        const lines = surveyCaveats({
            surveyRuns: [
                run('survey-margin', 800, { catzoc: 4, errorM: 2.2 }),
                run('survey-margin', 500, { catzoc: 3, errorM: 1.1 }),
                run('survey-poor', 3000, { catzoc: 5 }),
                run('survey-ungraded', 1100),
                run('survey-unchecked', 9000, { cellIds: ['A'] }),
            ],
            surveyUncheckedCells: ['A'],
        });
        // No surveyAmber: this view draws no survey amber (a saved plan, the
        // tracer), so no colour is named (round-3 review, 2026-09-30).
        expect(lines).toEqual([
            'Survey may be out by up to 2.2 m on 1.3 km of this route — more than your keel margin there. Tide windows there are worked from the charted depth.',
            'Old or ungraded survey on 4.1 km of this route — the charted depth there has no stated accuracy.',
            'Survey quality not checked on this chart — its accuracy is not in the chart data.',
        ]);
        expect(lines.join(' ')).not.toMatch(/CATZOC|M_QUAL|layer|schema|amber/);
    });

    // Round-3 review (2026-09-30): "(marked amber)" was said whatever was
    // drawn — Newport → Tangalooma's 0.7 km of CATZOC D lies wholly under the
    // canal's red, 0 m amber. The words now follow what the map draws.
    // RE-PIN (owner decision 10, 2026-09-30): survey stretches are amber
    // DASHES, and the rest lies under red or needs-tide amber — the words
    // were "(marked amber)", "(marked amber where it is not already red)" and
    // "(under the red)". RE-PIN (round-4 review, 2026-09-30): amber DOTS —
    // the dashes were the lead overlay's own needs-tide pattern.
    it('names the dots only for the metres the map draws dotted', () => {
        const runs = [run('survey-poor', 700, { catzoc: 5 }), run('survey-margin', 1000, { errorM: 2.1 })];
        const say = (marginM: number, poorM: number) =>
            surveyCaveats({ surveyRuns: runs, surveyAmber: { marginM, poorM } });
        expect(say(0, 0)[0]).toMatch(/keel margin there \(inside the red or amber stretches\)\./);
        expect(say(0, 0)[1]).toMatch(/no stated accuracy \(inside the red or amber stretches\)\.$/);
        expect(say(1000, 700)[0]).toMatch(/keel margin there \(amber dots\)\./);
        expect(say(1000, 700)[1]).toMatch(/\(amber dots\)\.$/);
        expect(say(400, 220)[1]).toMatch(/\(amber dots where the line is not already red or amber\)\.$/);
    });

    it('is silent when the survey is good enough everywhere', () => {
        expect(surveyCaveats({ surveyRuns: [] })).toEqual([]);
        expect(inshoreRouteNotice({ stateMaskOk: true, surveyRuns: [], ntmLockBanner: null })).toBeNull();
    });

    it('rides the route’s caveats and the notice', () => {
        const n = inshoreRouteNotice({
            stateMaskOk: true,
            surveyRuns: [run('survey-poor', 450, { catzoc: 6 })],
            ntmLockBanner: null,
        });
        expect(n?.title).toBe('Survey quality');
        expect(n?.message).toMatch(/^Old or ungraded survey on 450 m of this route/);
        expect(inshoreRouteCaveats({ surveyUncheckedCells: ['A', 'B'] })).toEqual([
            'Survey quality not checked on 2 of the charts on this route — its accuracy is not in the chart data.',
        ]);
    });
});

// Round 3 (2026-09-30): a saved plan kept decision 8's caveat (routeGeoJSON
// properties, __inshoreRouting.caveats) but nothing showed it again.
describe('a saved inshore route says its caveats again when it is shown', () => {
    const geo = (properties: Record<string, unknown>) => ({ properties: { source: 'inshore-router', ...properties } });

    it('rebuilds them from the saved route’s own facts', () => {
        const caveats = savedInshoreRouteCaveats({
            routeGeoJSON: geo({
                structuresUnknownCells: ['OC-61-10ENB5'],
                pinOffWater: { destination: 'drying' },
                surveyRuns: [run('survey-margin', 1500, { errorM: 1.4 })],
                surveyUncheckedCells: ['OC-61-051031'],
            }),
            __inshoreRouting: { status: 'success', caveats: ['stale words'] },
        });
        expect(caveats).toHaveLength(4);
        expect(caveats[0]).toMatch(/^Bridges and power lines not checked on this chart/);
        expect(caveats[1]).toMatch(/^Your destination pin is on a drying bank — the route stops at its edge/);
        expect(caveats[2]).toMatch(/^Survey may be out by up to 1\.4 m on 1\.5 km/);
        expect(caveats[3]).toMatch(/^Survey quality not checked on this chart/);
    });

    it('falls back to the saved lines as written, and never breaks on malformed data', () => {
        expect(savedInshoreRouteCaveats({ __inshoreRouting: { status: 'success', caveats: ['a', 3, ''] } })).toEqual([
            'a',
        ]);
        expect(savedInshoreRouteCaveats({ __inshoreRouting: { status: 'failed', caveats: ['a'] } })).toEqual([]);
        expect(savedInshoreRouteCaveats(null)).toEqual([]);
        expect(
            savedInshoreRouteCaveats({
                routeGeoJSON: geo({ structuresUnknownCells: 'x', pinOffWater: 'y', surveyRuns: [null, 7] }),
            }),
        ).toEqual([]);
        // Not an inshore route: nothing to say.
        expect(savedInshoreRouteCaveats({ routeGeoJSON: { properties: { source: 'isochrone' } } })).toEqual([]);
    });
});

// Phase 2b (2026-10-01): a route whose canal water came from the phone's
// offline pack or the Pi's stale copy says so, with the date and the OSM
// credit — next to the route, on the notice, and again on the saved plan.
describe('the offline water pack on the route (owner decision 2)', () => {
    const SAVED = new Date(2026, 8, 28, 12).getTime();
    const geo = (properties: Record<string, unknown>) => ({ properties: { source: 'inshore-router', ...properties } });

    it('is a caveat of its own, first, and the notice names it', () => {
        const caveats = inshoreRouteCaveats({
            waterPack: { source: 'pack', dataAsOf: SAVED, missing: ['destination'], offline: true },
            structuresUnknownCells: [],
        });
        expect(caveats[0]).toMatch(
            /^Canal and marina water on this route came from the harbour water saved on this phone on 28 Sep \(© OpenStreetMap contributors\)/,
        );
        expect(caveats[1]).toBe(
            "Harbour water for the destination isn't saved on this phone, so that end was routed on the charts alone.",
        );
        const notice = inshoreRouteNotice({
            stateMaskOk: true,
            waterPack: { source: 'pack', dataAsOf: SAVED, missing: [] },
            ntmLockBanner: null,
        });
        expect(notice?.title).toBe('Saved harbour water');
        expect(notice?.message).toMatch(/saved on this phone on 28 Sep/);
    });

    it('an online route, or one with no water-pack facts, says nothing new', () => {
        expect(inshoreRouteCaveats({ waterPack: { source: 'online', missing: [] } })).toEqual([]);
        expect(inshoreRouteCaveats({})).toEqual([]);
        expect(inshoreRouteNotice({ stateMaskOk: true, ntmLockBanner: null })).toBeNull();
    });

    it('a saved route rebuilds the words from its own facts, and ignores malformed ones', () => {
        expect(
            savedInshoreRouteCaveats({
                routeGeoJSON: geo({ waterPack: { source: 'pi-stale', dataAsOf: SAVED, missing: [] } }),
            })[0],
        ).toMatch(/^Canal and marina water came from the boat's Pi, saved 28 Sep/);
        // Malformed facts: no words, or only the words the valid part
        // supports — each pinned exactly (2026-10-02; the loop's disjunctive
        // checks passed vacuously on []).
        const dateless =
            'Canal and marina water on this route came from the harbour water saved on this phone (© OpenStreetMap contributors), not a live download. Check it against the chart.';
        const said = (waterPack: unknown) => savedInshoreRouteCaveats({ routeGeoJSON: geo({ waterPack }) });
        expect(said('pack')).toEqual([]);
        expect(said({ source: 'satellite', missing: [] })).toEqual([]);
        expect(said({ source: 'pack', missing: 'departure' })).toEqual([dateless]);
        expect(said({ source: 'pack', dataAsOf: 'yesterday', missing: ['harbour'] })).toEqual([dateless]);
        expect(said({ source: 'none', missing: ['destination'], offline: 'yes' })).toEqual([
            "Harbour water for the destination couldn't be downloaded and isn't saved on this phone, so that end was routed on the charts alone.",
        ]);
    });

    it('a saved route keeps whether the phone was offline, and says so again in the same words', () => {
        expect(
            savedInshoreRouteCaveats({
                routeGeoJSON: geo({ waterPack: { source: 'none', missing: ['destination'], offline: true } }),
            }),
        ).toEqual([
            "Harbour water for the destination isn't saved on this phone, so that end was routed on the charts alone.",
        ]);
    });
});

// Shane 2026-10-03: a shallow pin goes direct, amber; where no straight line
// passes, its tail keeps the charted way and the route says why (fix-up
// review: the note had no title of its own, the voyage form never said it,
// and a saved plan lost it).
describe('a shallow pin whose tail is not direct', () => {
    const geo = (properties: Record<string, unknown>) => ({ properties: { source: 'inshore-router', ...properties } });
    const tail = { depthM: 1.2, needsM: 1.7, direct: false, why: "a charted hazard's keep-out" };
    const line =
        "Your departure pin is in 1.2 m charted water — the route starts there and needs +1.7 m of tide. It leaves through its charted water, not in a straight line: a straight line would cross a charted hazard's keep-out.";

    it('alone, the notice is titled for it', () => {
        const n = inshoreRouteNotice({ stateMaskOk: true, pinTail: { origin: tail }, ntmLockBanner: null });
        expect(n).toEqual({ severity: 'warn', title: 'Shallow pin', message: line });
    });

    it('names the tail’s shallowest water when it lies off the pin', () => {
        expect(
            inshoreRouteCaveats({ pinTail: { destination: { ...tail, needsM: 1.4, leastM: 1.5, depthM: 2 } } }),
        ).toEqual([
            "Your destination pin is in 2.0 m charted water — the route ends there and needs +1.4 m of tide (its way in crosses 1.5 m). It arrives through its charted water, not in a straight line: a straight line would cross a charted hazard's keep-out.",
        ]);
    });

    it('a saved route says it again from its own facts, and ignores malformed ones', () => {
        const feature = inshoreRouteToGeoJSON(
            {
                polyline: [
                    [153.2, -27.4],
                    [153.21, -27.41],
                ],
                distanceNM: 0.8,
                cellsUsed: ['AU123'],
                elapsedMs: 20,
                pinTail: { origin: tail },
            },
            { lat: -27.4, lon: 153.2 },
            { lat: -27.41, lon: 153.21 },
        );
        expect(savedInshoreRouteCaveats({ routeGeoJSON: feature })).toEqual([line]);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo({ pinTail: { origin: tail } }) })).toEqual([line]);
        expect(
            savedInshoreRouteCaveats({
                routeGeoJSON: geo({ pinTail: { origin: { ...tail, depthM: 'shallow' }, destination: 7 } }),
            }),
        ).toEqual([]);
        // A direct tail needs no note, saved or not.
        expect(
            savedInshoreRouteCaveats({ routeGeoJSON: geo({ pinTail: { origin: { ...tail, direct: true } } }) }),
        ).toEqual([]);
    });
});
