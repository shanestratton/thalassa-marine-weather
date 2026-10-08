/**
 * Following a route that is red where no tide clears it takes two taps
 * (package 125-05). The router no longer refuses such a route (Shane,
 * 2026-10-08: "better we just have red at the "dry" zones"); the deliberate
 * second tap is the routecheck's own — a red 'finding' row, "Tap again to
 * follow anyway" (build 124, services/traceVerification traceFollowStatus,
 * pages/log/LogSubComponents FollowRouteChoice) — never a second gate. Cast
 * Off stays advisory.
 *
 * An ordinary planner route has no trace and so no check of its own: the dry
 * stretches its saved notes carry (PassagePlanSave ROUTE_CAVEAT_LINE_PREFIX,
 * RouteOrTrack.caveats) are its finding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ vessel: { draft: 2.4 * 3.28084, estimatedFields: [] as string[] } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: settings.vessel } }) },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getRegistryFingerprint: () => 'chart-set-v1',
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { tracedRouteDirectUseStatus } from '../services/traceDirectUseGate';
import { dryRunCaveat, dryRunFollowReason } from '../services/routing/dryRunWords';
import { ROUTE_CAVEAT_LINE_PREFIX } from '../services/shiplog/PassagePlanSave';
import { buildFollowSheetChoices, plannedRouteDryReasons, type FollowSheetDeps } from '../pages/log/logPageDerive';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';
import type { DryRun } from '../services/engine/types';

const points = [
    { lat: -27.21, lon: 153.09 },
    { lat: -27.18, lon: 153.37 },
];
const dry: DryRun = {
    startSeg: 0,
    startT: 0.4,
    endSeg: 0,
    endT: 0.45,
    lengthM: 300,
    mid: [153.2, -27.2],
    place: 'the Boat Passage',
    shallowestM: -2.2,
    deepestM: 0,
    draftM: 2.4,
    needM: 2.9,
    tide: { topM: 2.5, days: 14 },
};
const caveat = dryRunCaveat([dry])!;

describe('125-05 — following a red route takes two taps', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('dry-follow-owner');
    });

    it('an ordinary planner route whose notes carry a dry stretch is a red finding until the second tap', () => {
        const red = tracedRouteDirectUseStatus({
            points,
            caveats: ['Survey quality not checked on this chart.', caveat],
        });
        expect(red).toMatchObject({ tone: 'finding', code: 'finding', blocked: true });
        expect(red.reason).toBe(dryRunFollowReason(caveat));
        expect(red.reason).toBe('Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m');
        // The second tap accepts it: it follows (Cast Off stays advisory).
        expect(tracedRouteDirectUseStatus({ points, caveats: [caveat] }, { acceptFinding: true })).toMatchObject({
            tone: 'finding',
            blocked: false,
        });
    });

    it('an ordinary route with no dry stretch follows on the first tap, as before', () => {
        expect(tracedRouteDirectUseStatus({ points })).toMatchObject({ tone: 'checked', blocked: false });
        expect(
            tracedRouteDirectUseStatus({
                points,
                caveats: ['Tide times not loaded — this route may cross water no tide clears. Check before you go.'],
            }),
        ).toMatchObject({ tone: 'checked', blocked: false });
    });

    it('the sheet shows such a row red before it is tapped, from the plan’s resident notes', () => {
        const entry = (voyageId: string, notes: string, source = 'planned_route') =>
            ({ voyageId, notes, source }) as unknown as ShipLogEntry;
        const reasons = plannedRouteDryReasons([
            entry('v-dry', `Newport → Tangalooma${'\n'}${ROUTE_CAVEAT_LINE_PREFIX}${caveat}`),
            entry('v-plain', `Newport → Rivergate${'\n'}${ROUTE_CAVEAT_LINE_PREFIX}Survey quality not checked.`),
            // A sailed track's notes are never a plan's finding.
            entry('v-sailed', `${ROUTE_CAVEAT_LINE_PREFIX}${caveat}`, 'gps'),
        ]);
        expect([...reasons.keys()]).toEqual(['v-dry']);
        const summary = (voyageId: string) =>
            ({ voyageId, totalDistanceNM: 20, isPlannedRoute: true }) as unknown as VoyageSummary;
        const deps: FollowSheetDeps = {
            tripByTraceId: () => new Map(),
            traceLinkByVoyageId: () => new Map(),
            followStatus: () => ({ tone: 'unchecked', code: 'none', reason: 'Not checked yet' }),
            traces: () => [],
        };
        const choices = buildFollowSheetChoices(
            [
                { summary: summary('v-dry'), reversible: false },
                { summary: summary('v-plain'), reversible: false },
                { summary: summary('v-traced'), reversible: false },
            ],
            new Map([['v-traced', 't1']]),
            deps,
            reasons,
        );
        expect(choices[0].followStatus).toEqual({
            tone: 'finding',
            code: 'finding',
            reason: 'Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m',
        });
        expect(choices[1].followStatus).toBeNull();
        // A traced route keeps its own check's status.
        expect(choices[2].followStatus).toMatchObject({ tone: 'unchecked' });
    });
});
