/**
 * The words for a route's dry stretches (package 125-05; Shane, 2026-10-08:
 * "better we just have red at the "dry" zones, rather than just shit caning
 * the whole route").
 *
 * Where no tide clears part of a route, the route is drawn anyway — red there
 * — and the planner says so instead of a hard stop: each stretch by name or
 * position, with its charted depth against draft + UKC and the tide (or that
 * there is no tide data). A saved plan says it again. Water no tide clears is
 * no longer a final refusal; a bridge the mast cannot clear still is.
 */
import { describe, expect, it } from 'vitest';
import {
    inshoreRouteCaveats,
    inshoreRouteNotice,
    isFinalInshoreRefusal,
    savedInshoreRouteCaveats,
} from '../components/map/inshoreRouteNotice';
import {
    DRY_RUN_CAVEAT_PREFIX,
    dryRunCaveat,
    dryRunFollowReason,
    isDryRunCaveat,
} from '../services/routing/dryRunWords';
import type { DryRun } from '../services/engine/types';

const run = (over: Partial<DryRun> = {}): DryRun => ({
    startSeg: 3,
    startT: 0.2,
    endSeg: 3,
    endT: 0.6,
    lengthM: 300,
    mid: [153.4015, -27.5],
    place: 'the Boat Passage',
    shallowestM: -2.2,
    deepestM: 0,
    draftM: 2.4,
    needM: 2.9,
    tide: { topM: 2.5, days: 14 },
    ...over,
});

describe('125-05 — a dry stretch is named with its depth against draft + UKC', () => {
    it('one stretch, the tide known: where, how much it dries, the need and the tide', () => {
        expect(dryRunCaveat([run()])).toBe(
            'Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m (2.4 m draft + 0.5 m under the keel); ' +
                'the highest tide in the next 14 days is 2.5 m, so no tide clears it. Check it on the chart before you go.',
        );
    });

    it('no tide data is said, never a refusal (a global app: a fictional Wadden harbour)', () => {
        expect(
            dryRunCaveat([
                run({ place: 'Meerhaven Gat', mid: [6.103, 53.45], shallowestM: -1.2, deepestM: 0, tide: null }),
            ]),
        ).toBe(
            'Red on this route: Meerhaven Gat dries 1.2 m and you need 2.9 m (2.4 m draft + 0.5 m under the keel); ' +
                'there is no tide data for it, so no tide can be shown to clear it. Check it on the chart before you go.',
        );
    });

    it('water that never dries but no tide clears says its charted range', () => {
        expect(
            dryRunCaveat([
                run({ place: 'Drying Flats', shallowestM: 0, deepestM: 0.3, tide: { topM: 2.41, days: 1 } }),
            ]),
        ).toBe(
            'Red on this route: Drying Flats is charted 0–0.3 m and you need 2.9 m (2.4 m draft + 0.5 m under the keel); ' +
                'the highest tide in the next 1 day is 2.4 m, so no tide clears it. Check it on the chart before you go.',
        );
        expect(dryRunCaveat([run({ shallowestM: null, deepestM: 0.3 })])).toMatch(
            /^Red on this route: the Boat Passage is charted no deeper than 0\.3 m and you need 2\.9 m/,
        );
    });

    it('several stretches: each named, three at most, the need said once', () => {
        const runs = [
            run(),
            run({ place: 'Drying Flats', shallowestM: 0, deepestM: 0.3, tide: null }),
            run({ place: 'water near 27.410° S, 153.180° E', shallowestM: -0.6, deepestM: 0 }),
            run({ place: 'the Bar', shallowestM: -1, deepestM: 0 }),
            run({ place: 'the Spit', shallowestM: -1, deepestM: 0 }),
        ];
        expect(dryRunCaveat([runs[0], runs[2]])).toBe(
            'Red on this route — 2 stretches no tide clears (you need 2.9 m: 2.4 m draft + 0.5 m under the keel): ' +
                'the Boat Passage dries 2.2 m (highest tide 2.5 m in the next 14 days); ' +
                'water near 27.410° S, 153.180° E dries 0.6 m (highest tide 2.5 m in the next 14 days). ' +
                'Check them on the chart before you go.',
        );
        // With no tide data for one, nothing proves no tide clears it
        // (review fix-up, 2026-10-09): dry stretches, and how many have none.
        expect(dryRunCaveat(runs.slice(0, 2))).toBe(
            'Red on this route — 2 dry stretches, 1 with no tide data (you need 2.9 m: 2.4 m draft + 0.5 m under the keel): ' +
                'the Boat Passage dries 2.2 m (highest tide 2.5 m in the next 14 days); ' +
                'Drying Flats is charted 0–0.3 m (no tide data). Check them on the chart before you go.',
        );
        expect(dryRunCaveat(runs)).toMatch(
            /^Red on this route — 5 dry stretches, 1 with no tide data \(you need 2\.9 m/,
        );
        expect(dryRunCaveat(runs)).toMatch(/: the Boat Passage dries 2\.2 m .*; and 2 more\. Check them on the chart/);
        expect(dryRunCaveat(runs)!.match(/dries|is charted/g)).toHaveLength(3);
    });

    it('nothing to say without a stretch, and malformed ones are left out', () => {
        expect(dryRunCaveat([])).toBeNull();
        expect(dryRunCaveat(undefined)).toBeNull();
        expect(dryRunCaveat([run({ needM: Number.NaN })])).toBeNull();
    });

    it('the follow gate recognises the line and shortens it to the row’s reason', () => {
        const one = dryRunCaveat([run()])!;
        expect(isDryRunCaveat(one)).toBe(true);
        expect(one.startsWith(DRY_RUN_CAVEAT_PREFIX)).toBe(true);
        expect(dryRunFollowReason(one)).toBe('Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m');
        const two = dryRunCaveat([run(), run({ place: 'Drying Flats' })])!;
        expect(dryRunFollowReason(two)).toBe('Red on this route — 2 stretches no tide clears');
        // No tide data (a fictional Wadden harbour): never "no tide clears".
        const wadden = dryRunCaveat([
            run({ place: 'Meerhaven Gat', shallowestM: -0.2, tide: null }),
            run({ place: 'Oosterslenk', shallowestM: -0.3, tide: null }),
        ])!;
        expect(dryRunFollowReason(wadden)).toBe('Red on this route — 2 dry stretches, no tide data');
        expect(wadden).not.toMatch(/no tide clears/);
        expect(isDryRunCaveat('Tide times not loaded — this route may cross water no tide clears.')).toBe(false);
    });
});

describe('125-05 — the route notes and the notice', () => {
    it('is the route’s first note after the harbour water, and titles the notice', () => {
        const caveats = inshoreRouteCaveats({ dryRuns: [run()], structuresUnknownCells: ['OC-61-10ENB5'] });
        expect(caveats[0]).toMatch(/^Red on this route: the Boat Passage dries 2\.2 m/);
        expect(caveats[1]).toMatch(/^Bridges and power lines not checked/);
        const notice = inshoreRouteNotice({
            stateMaskOk: true,
            dryRuns: [run()],
            structuresUnknownCells: ['OC-61-10ENB5'],
            ntmLockBanner: null,
        });
        expect(notice?.title).toBe('No tide clears part of this route');
        expect(notice?.message).toMatch(/^Red on this route: the Boat Passage dries 2\.2 m/);
    });

    it('titles a stretch with no tide data as that, never "no tide clears" (review fix-up, 2026-10-09)', () => {
        const title = (dryRuns: DryRun[], tideCheck?: 'not-loaded') =>
            inshoreRouteNotice({ stateMaskOk: true, dryRuns, ...(tideCheck ? { tideCheck } : {}), ntmLockBanner: null })
                ?.title;
        const wadden = run({ place: 'Meerhaven Gat', mid: [6.103, 53.45], shallowestM: -0.2, tide: null });
        expect(title([wadden])).toBe('No tide data for part of this route');
        expect(title([wadden, run({ place: 'Oosterslenk', tide: null })])).toBe('No tide data for part of this route');
        expect(title([run(), wadden])).toBe('Red on part of this route');
        // The tide times did not load: that title says why.
        expect(title([wadden], 'not-loaded')).toBe('Tide times not loaded');
    });

    it('water no tide clears is no longer a final refusal; a bridge the mast cannot clear still is', () => {
        expect(isFinalInshoreRefusal('no-tide-clears')).toBe(false);
        expect(isFinalInshoreRefusal('air-draft-blocked')).toBe(true);
    });

    it('a saved route says it again from its own facts, and ignores malformed ones', () => {
        const geo = (properties: Record<string, unknown>) => ({
            properties: { source: 'inshore-router', ...properties },
        });
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo({ dryRuns: [run()] }) })).toEqual([dryRunCaveat([run()])]);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo({ dryRuns: 'x' }) })).toEqual([]);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo({ dryRuns: [{ place: 'x' }, null] }) })).toEqual([]);
        // A plan refused for water no tide clears by build 124 or earlier
        // drew no route: its refusal is still its only explanation (review
        // fix-up, 2026-10-09), until it is routed again.
        expect(
            savedInshoreRouteCaveats({
                __inshoreRouting: { status: 'failed', errorCode: 'no-tide-clears', error: 'No route for 2.4 m draft' },
            }),
        ).toEqual(['No route for 2.4 m draft']);
        expect(
            savedInshoreRouteCaveats({
                __inshoreRouting: { status: 'failed', errorCode: 'no-path', error: 'No route found' },
            }),
        ).toEqual([]);
    });
});

/**
 * Package 125-05b (Shane, 2026-10-08: "tried to do a route from the newport
 * canals to tangalooma, i got some message about it being dry at both
 * ends????"): a pin on drying ground gets the route run on to it, the dry
 * tail red and named — one sentence per end, in place of "the route stops at
 * its edge", the "It dries at low water" truth kept. The tide is the tail's
 * own: when the boat floats over it on today's tide (DryRun.floats, worked by
 * the app from the loaded curve), else the highest tide known, else no tide
 * data. The times are the phone's clock.
 */
describe('125-05b — a pin’s red tail, one sentence per end', () => {
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
    const NOW = at(9, 6, 0); // Fri 9 Oct 2026, 06:00
    const pinRun = (over: Partial<DryRun> = {}): DryRun =>
        run({
            startSeg: 7,
            startT: 0,
            endSeg: 8,
            endT: 1,
            lengthM: 182,
            mid: [-40.0041, -27.0],
            place: 'Kestrel Sands',
            shallowestM: -0.4,
            deepestM: 0,
            tide: null,
            pin: { end: 'destination', at: 'on' },
            ...over,
        });
    const NEED = 'and you need 2.9 m (2.4 m draft + 0.5 m under the keel)';
    const ON_SAND = `Red on this route: your destination pin is on a drying bank — the last 180 m to it dries 0.4 m ${NEED}`;

    it('no tide data: the red tail, the need, and that there is no tide data — the drying kept', () => {
        expect(
            inshoreRouteCaveats({ pinOffWater: { destination: 'drying' }, dryRuns: [pinRun()], nowMs: NOW }),
        ).toEqual([`${ON_SAND}; there is no tide data for it. It dries at low water.`]);
    });

    it('the tide that floats the boat over it, today, tomorrow or by its date', () => {
        const says = (floats: DryRun['floats'], nowMs = NOW, floatsWorkedMs: number | undefined = NOW) =>
            inshoreRouteCaveats({
                pinOffWater: { destination: 'drying' },
                dryRuns: [
                    pinRun({
                        tide: { topM: 3.5, days: 14 },
                        floats,
                        ...(floatsWorkedMs === undefined ? {} : { floatsWorkedMs }),
                    }),
                ],
                nowMs,
            })[0];
        expect(says({ fromMs: at(9, 13, 10), toMs: at(9, 16, 40) })).toBe(
            `${ON_SAND}; you float over it from about 13:10 to 16:40 on today's tide. It dries at low water.`,
        );
        expect(says({ fromMs: at(10, 1, 5), toMs: at(10, 3, 50) })).toMatch(
            /; you float over it from about 01:05 to 03:50 on tomorrow's tide\. It dries at low water\.$/,
        );
        expect(says({ fromMs: at(11, 14, 0), toMs: at(11, 15, 30) })).toMatch(
            /; you float over it from about 14:00 to 15:30 on the tide of Sun 11 Oct\./,
        );
        // Already floating when you leave.
        expect(says({ fromMs: at(9, 6, 0), toMs: at(9, 8, 20), open: true })).toMatch(
            /; you float over it until about 08:20 on today's tide\./,
        );
        // No window in the next 24 hours, though a tide in the 14 days floats it.
        expect(says(null)).toBe(
            `${ON_SAND}; no tide floats you over it in the next 24 hours (the highest in the next 14 days is 3.5 m). It dries at low water.`,
        );
        // Worked for a departure later on: its 24 hours are the ones after you leave.
        expect(says(null, NOW, at(10, 7, 0))).toMatch(
            /; no tide floats you over it in the 24 hours after you leave \(the highest in the next 14 days is 3\.5 m\)\./,
        );
        // No window worked (the router's own result): the highest tide, and look it up.
        expect(says(undefined)).toBe(
            `${ON_SAND}; the highest tide in the next 14 days is 3.5 m — check the tide times for when you float over it. It dries at low water.`,
        );
    });

    // Review fix-up, 2026-10-09: the first window after the departure can
    // close before a boat reaches its destination — Newport to a beach pin
    // five hours away, leaving at 08:00, named only 08:30–11:00 and never the
    // evening tide it could use. Every window in the day is named.
    it('names the day’s later windows too: the first may close before you arrive', () => {
        const says = (floats: DryRun['floats']) =>
            inshoreRouteCaveats({
                pinOffWater: { destination: 'drying' },
                dryRuns: [pinRun({ tide: { topM: 3.5, days: 14 }, floats, floatsWorkedMs: NOW })],
                nowMs: NOW,
            })[0];
        expect(
            says({ fromMs: at(9, 8, 30), toMs: at(9, 11, 0), later: [{ fromMs: at(9, 20, 45), toMs: at(9, 23, 15) }] }),
        ).toBe(
            `${ON_SAND}; you float over it from about 08:30 to 11:00 on today's tide, and again from about 20:45 to 23:15. It dries at low water.`,
        );
        // Three, the last after midnight: its day said.
        expect(
            says({
                fromMs: at(9, 6, 0),
                toMs: at(9, 7, 40),
                open: true,
                later: [
                    { fromMs: at(9, 18, 20), toMs: at(9, 20, 30) },
                    { fromMs: at(10, 5, 50), toMs: at(10, 7, 10) },
                ],
            }),
        ).toMatch(
            /; you float over it until about 07:40 on today's tide, again from about 18:20 to 20:30, and from about 05:50 to 07:10 on tomorrow's tide\. It dries at low water\.$/,
        );
    });

    // Review fix-up, 2026-10-09: a saved plan kept its windows as worked and
    // said them in the present tense when it was reopened — a window from
    // Friday read as current on Thursday, and "no tide floats you over it in
    // the next 24 hours", worked at neaps, read at springs.
    it('a plan reopened later: closed windows dropped, a stale "none" never said', () => {
        const says = (floats: DryRun['floats'], nowMs: number) =>
            inshoreRouteCaveats({
                pinOffWater: { destination: 'drying' },
                dryRuns: [pinRun({ tide: { topM: 3.5, days: 14 }, floats, floatsWorkedMs: NOW })],
                nowMs,
            })[0];
        const LOOK_UP = `${ON_SAND}; the highest tide in the next 14 days is 3.5 m — check the tide times for when you float over it. It dries at low water.`;
        const day = {
            fromMs: at(9, 13, 10),
            toMs: at(9, 16, 40),
            later: [{ fromMs: at(10, 1, 30), toMs: at(10, 4, 50) }],
        };
        // Reopened the evening it was planned: the afternoon window has closed.
        expect(says(day, at(9, 18, 0))).toMatch(
            /; you float over it from about 01:30 to 04:50 on tomorrow's tide\. It dries at low water\.$/,
        );
        // Reopened inside a window: you float over it until it closes.
        expect(says(day, at(9, 14, 0))).toMatch(
            /; you float over it until about 16:40 on today's tide, and again from about 01:30 to 04:50 on tomorrow's tide\./,
        );
        // Every window closed, or the day it was worked for long gone: look the tide up.
        expect(says(day, at(10, 5, 0))).toBe(LOOK_UP);
        expect(says({ fromMs: at(16, 13, 10), toMs: at(16, 16, 40) }, at(15, 9, 0))).toBe(LOOK_UP);
        // "None in the next 24 hours", worked on Friday at neaps, read on Thursday at springs.
        expect(says(null, at(15, 9, 0))).toBe(LOOK_UP);
        // …and a "none" with no record of when it was worked is never said.
        expect(
            inshoreRouteCaveats({
                pinOffWater: { destination: 'drying' },
                dryRuns: [pinRun({ tide: { topM: 3.5, days: 14 }, floats: null })],
                nowMs: NOW,
            })[0],
        ).toBe(LOOK_UP);
    });

    it('no tide in the days loaded floats it: said, never a window', () => {
        expect(
            inshoreRouteCaveats({
                pinOffWater: { destination: 'drying' },
                dryRuns: [pinRun({ tide: { topM: 2.5, days: 14 } })],
                nowMs: NOW,
            }),
        ).toEqual([
            `${ON_SAND}; the highest tide in the next 14 days is 2.5 m, so no tide floats you over it. It dries at low water.`,
        ]);
    });

    it('the departure end, water no tide clears, and a pin in water beyond a drying band', () => {
        expect(
            inshoreRouteCaveats({
                pinOffWater: { origin: 'drying' },
                dryRuns: [pinRun({ startSeg: 0, endSeg: 0, pin: { end: 'origin', at: 'on' } })],
                nowMs: NOW,
            }),
        ).toEqual([
            `Red on this route: your departure pin is on a drying bank — the first 180 m from it dries 0.4 m ${NEED}; there is no tide data for it. It dries at low water.`,
        ]);
        // Water that never dries but no tide clears: no "dries at low water".
        expect(
            inshoreRouteCaveats({
                pinOffWater: { destination: 'no-tide' },
                dryRuns: [pinRun({ lengthM: 1083, shallowestM: 0, deepestM: 0.3, tide: { topM: 2.5, days: 14 } })],
                nowMs: NOW,
            }),
        ).toEqual([
            `Red on this route: your destination pin is in water no tide clears for your boat — the last 1.1 km to it is charted 0–0.3 m ${NEED}; the highest tide in the next 14 days is 2.5 m, so no tide floats you over it.`,
        ]);
        // A fictional Wadden harbour behind 800 m of flats: the pin is water.
        const flats = pinRun({
            lengthM: 798,
            mid: [5.306, 53.4],
            place: 'the Hoogsand Flats',
            shallowestM: -1.2,
            pin: { end: 'destination', at: 'beyond' },
        });
        expect(inshoreRouteCaveats({ dryRuns: [flats], nowMs: NOW })).toEqual([
            `Red on this route: the way in to your destination pin crosses 800 m of the Hoogsand Flats, which dries 1.2 m, ${NEED}; there is no tide data for it.`,
        ]);
        expect(
            inshoreRouteCaveats({ dryRuns: [{ ...flats, pin: { end: 'origin', at: 'beyond' } }], nowMs: NOW })[0],
        ).toMatch(
            /^Red on this route: the way out from your departure pin crosses 800 m of the Hoogsand Flats, which dries 1\.2 m,/,
        );
    });

    it('dry at both ends: one sentence for each, after the stretches between them — never "stops at its edge"', () => {
        const caveats = inshoreRouteCaveats({
            pinOffWater: { origin: 'drying', destination: 'drying' },
            dryRuns: [pinRun({ startSeg: 0, endSeg: 0, pin: { end: 'origin', at: 'on' } }), run(), pinRun()],
            structuresUnknownCells: ['OC-99-SYN001'],
            nowMs: NOW,
        });
        expect(caveats).toHaveLength(4);
        // The stretch between: the general line, which never names a pin's tail.
        expect(caveats[0]).toBe(dryRunCaveat([run()]));
        expect(caveats[1]).toMatch(/^Red on this route: your departure pin is on a drying bank — the first 180 m/);
        expect(caveats[2]).toMatch(/^Red on this route: your destination pin is on a drying bank — the last 180 m/);
        expect(caveats[3]).toMatch(/^Bridges and power lines not checked/);
        expect(caveats.join(' ')).not.toMatch(/stops at its edge|starts at its edge/);
        expect(dryRunCaveat([pinRun()])).toBeNull();
    });

    it('a pin whose tail could not be drawn (charted land in the way) keeps its honest words', () => {
        expect(inshoreRouteCaveats({ pinOffWater: { destination: 'drying' } })).toEqual([
            'Your destination pin is on a drying bank — the route stops at its edge. It dries at low water.',
        ]);
    });

    it('titles the notice by what the tail’s tide says', () => {
        const title = (dryRuns: DryRun[]) =>
            inshoreRouteNotice({
                stateMaskOk: true,
                pinOffWater: { destination: 'drying' },
                dryRuns,
                ntmLockBanner: null,
            })?.title;
        expect(title([pinRun()])).toBe('No tide data for part of this route');
        expect(title([pinRun({ tide: { topM: 2.5, days: 14 } })])).toBe('No tide clears part of this route');
        // A tide floats the boat over it: red all the same, never "no tide clears".
        expect(
            title([pinRun({ tide: { topM: 3.5, days: 14 }, floats: { fromMs: at(9, 13, 10), toMs: at(9, 16, 40) } })]),
        ).toBe('Red on part of this route');
    });

    it('the follow gate reads the tail’s sentence as a red finding — two taps to follow', () => {
        const line = inshoreRouteCaveats({
            pinOffWater: { destination: 'drying' },
            dryRuns: [pinRun()],
            nowMs: NOW,
        })[0];
        expect(isDryRunCaveat(line)).toBe(true);
        expect(dryRunFollowReason(line)).toBe(
            'Red on this route: your destination pin is on a drying bank — the last 180 m to it dries 0.4 m and you need 2.9 m',
        );
    });

    it('a saved plan says it again, its window kept; malformed pin facts give no words', () => {
        const geo = (properties: Record<string, unknown>) => ({
            properties: { source: 'inshore-router', ...properties },
        });
        const floats = { fromMs: at(9, 13, 10), toMs: at(9, 16, 40) };
        const tail = pinRun({ tide: { topM: 3.5, days: 14 }, floats, floatsWorkedMs: NOW });
        const saved = savedInshoreRouteCaveats(
            { routeGeoJSON: geo({ pinOffWater: { destination: 'drying' }, dryRuns: [tail] }) },
            NOW,
        );
        expect(saved).toEqual([
            `${ON_SAND}; you float over it from about 13:10 to 16:40 on today's tide. It dries at low water.`,
        ]);
        // Its later window and when it was worked are kept (review fix-up,
        // 2026-10-09) — and reopened next Thursday, its day long gone, the
        // plan says to look the tide up instead of Friday's windows.
        const both = pinRun({
            tide: { topM: 3.5, days: 14 },
            floats: { ...floats, later: [{ fromMs: at(10, 1, 30), toMs: at(10, 4, 50) }] },
            floatsWorkedMs: NOW,
        });
        const plan = { routeGeoJSON: geo({ pinOffWater: { destination: 'drying' }, dryRuns: [both] }) };
        expect(savedInshoreRouteCaveats(plan, NOW)[0]).toMatch(
            /; you float over it from about 13:10 to 16:40 on today's tide, and again from about 01:30 to 04:50 on tomorrow's tide\./,
        );
        expect(savedInshoreRouteCaveats(plan, at(15, 9, 0))[0]).toMatch(
            /; the highest tide in the next 14 days is 3\.5 m — check the tide times for when you float over it\./,
        );
        // Malformed: a pin end that is neither, a window that is not one.
        expect(
            savedInshoreRouteCaveats(
                { routeGeoJSON: geo({ dryRuns: [{ ...tail, pin: { end: 'x', at: 'on' } }] }) },
                NOW,
            ),
        ).toEqual([]);
        expect(
            savedInshoreRouteCaveats(
                {
                    routeGeoJSON: geo({
                        pinOffWater: { destination: 'drying' },
                        dryRuns: [{ ...tail, floats: { fromMs: 'x', toMs: 3 } }],
                    }),
                },
                NOW,
            )[0],
        ).toMatch(/the highest tide in the next 14 days is 3\.5 m — check the tide times/);
    });
});
