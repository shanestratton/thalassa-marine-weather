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
