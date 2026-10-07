/**
 * Multi-leg trip chain (Shane 2026-07-17: "we need to get our LEGS
 * functioning") — the pure name helpers plus the localStorage-backed chain
 * operations: retro-badging leg 1 when leg 2 is born, trip-field survival
 * across plain overwrites, and the auto-heal that keeps a successor's locked
 * start welded to its predecessor's arrival.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    ordinalLegLabel,
    stripLegBadge,
    withLegBadge,
    legBadgeOrdinal,
    destNameFromRouteName,
    nextLegSeed,
    retroBadgeFirstLeg,
    healTripChain,
    groupTracesByTrip,
    traceToGpx,
    traceGpxFileName,
    saveTrace,
    loadSavedTraces,
    deleteTrace,
    rebaseSavedTraceChainAfterDelete,
    repairOrphanedSavedTraceChains,
    attachSavedTraceTombstoneLinks,
    getSavedTraceTombstones,
    persistLegVerdicts,
    LEG_VERDICTS_KEY,
    hydrateLegVerdicts,
    tripLegAnchorOrdinal,
    tripLegPlannedDestination,
    buildTripPassageRollups,
    type SavedTrace,
    type TracePoint,
} from '../services/routeTracer';
import { authScopedStorageKey } from '../services/authIdentityScope';
import { useTraceDraft } from '../components/map/useTraceDraft';
import { commitTraceSave, decideTraceSave, type TraceSaveDecision } from '../services/traceSave';
import {
    previousLegFor,
    reverseTapDecision,
    reversedCopyOf,
    reversedLegForSlot,
    slotCandidates,
} from '../services/tripReverse';

describe('trip-chain name helpers', () => {
    it('ordinalLegLabel speaks English ordinals, teens included', () => {
        expect(ordinalLegLabel(1)).toBe('1st Leg');
        expect(ordinalLegLabel(2)).toBe('2nd Leg');
        expect(ordinalLegLabel(3)).toBe('3rd Leg');
        expect(ordinalLegLabel(4)).toBe('4th Leg');
        expect(ordinalLegLabel(11)).toBe('11th Leg');
        expect(ordinalLegLabel(12)).toBe('12th Leg');
        expect(ordinalLegLabel(13)).toBe('13th Leg');
        expect(ordinalLegLabel(21)).toBe('21st Leg');
        expect(ordinalLegLabel(22)).toBe('22nd Leg');
        expect(ordinalLegLabel(23)).toBe('23rd Leg');
    });

    it('withLegBadge never stacks badges; strip/parse round-trip', () => {
        expect(withLegBadge('newport - woorim', 1)).toBe('newport - woorim (1st Leg)');
        expect(withLegBadge('newport - woorim (1st Leg)', 2)).toBe('newport - woorim (2nd Leg)');
        expect(stripLegBadge('woorim - timbuktu (2nd Leg)')).toBe('woorim - timbuktu');
        expect(legBadgeOrdinal('woorim - timbuktu (2nd Leg)')).toBe(2);
        expect(legBadgeOrdinal('woorim - timbuktu')).toBeNull();
    });

    it('destNameFromRouteName: badge stripped, hyphenated towns survive', () => {
        expect(destNameFromRouteName('newport - woorim')).toBe('woorim');
        expect(destNameFromRouteName('Kippa-Ring - Woorim (1st Leg)')).toBe('Woorim');
        expect(destNameFromRouteName('just a name')).toBeNull();
    });
});

const PTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -27.1, lon: 153.2 },
    { lat: -27.0, lon: 153.3 },
];

describe('trip ordinal anchoring (Cast Off seeds)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('tripLegAnchorOrdinal: a route knows its own position in the trip', () => {
        const { trace: leg1 } = saveTrace('newport - coral sea', PTS);
        const seed = nextLegSeed(leg1)!;
        const { trace: leg2 } = saveTrace(withLegBadge('coral sea - mackay', seed.ordinal), PTS, {
            tripId: seed.tripId,
            legOrdinal: seed.ordinal,
            destName: 'mackay',
        });
        retroBadgeFirstLeg(seed.tripId);

        // castOff() seeds the first in-voyage leg from this — the literal 1
        // it replaced handed a leg-2 voyage leg 1's destination (Shane
        // 2026-08-27: Cast Off "always shows the newport - coral sea 1st
        // leg").
        expect(tripLegAnchorOrdinal(leg2.id)).toBe(2);
        // Leg 1 and the trip id are the same trace — a materialised
        // "(Passage)" voyage anchors at 1 by construction.
        expect(tripLegAnchorOrdinal(leg1.id)).toBe(1);
        // Standalone / unknown / absent routes fall back to 1.
        expect(tripLegAnchorOrdinal('no-such-trace')).toBe(1);
        expect(tripLegAnchorOrdinal(null)).toBe(1);

        // The exact seed both call sites build: the route's OWN destination.
        expect(tripLegPlannedDestination(leg2.id, tripLegAnchorOrdinal(leg2.id))).toBe('mackay');
        // And depart-next-leg's anchor + completed formula reaches beyond
        // the plan → null, never a wrong port.
        expect(tripLegPlannedDestination(leg2.id, tripLegAnchorOrdinal(leg2.id) + 1)).toBeNull();
    });

    it('tripLegAnchorOrdinal: badge-parsed fallback when structural fields were dropped', () => {
        // adoptServerRoute-shaped trace: badged name, no tripId/legOrdinal
        // (the cloud round-trip can null the structural fields).
        const { trace } = saveTrace('coral sea - mackay (2nd Leg)', PTS);
        expect(tripLegAnchorOrdinal(trace.id)).toBe(2);
    });
});

describe('trip-chain storage operations', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('nextLegSeed: standalone route seeds leg 2 anchored at its arrival', () => {
        const { trace } = saveTrace('newport - woorim', PTS);
        const seed = nextLegSeed(trace)!;
        expect(seed.tripId).toBe(trace.id); // leg 1's id IS the trip id
        expect(seed.ordinal).toBe(2);
        expect(seed.fromName).toBe('woorim');
        expect(seed.anchor).toEqual(PTS[2]); // the EXACT final coordinates
    });

    it('nextLegSeed: chained leg increments; badge is the fallback ordinal', () => {
        const { trace } = saveTrace('woorim - mooloolaba (2nd Leg)', PTS, {
            tripId: 'trip-a',
            legOrdinal: 2,
            destName: 'mooloolaba',
        });
        expect(nextLegSeed(trace)!.ordinal).toBe(3);
        // Cloud round-trip shed the fields → the name badge still chains.
        const bare = { ...trace, tripId: undefined, legOrdinal: undefined, destName: undefined };
        const seed = nextLegSeed(bare)!;
        expect(seed.ordinal).toBe(3);
        expect(seed.fromName).toBe('mooloolaba');
    });

    it('retro-badge: leg 1 earns "(1st Leg)" + chain fields when the trip becomes real', () => {
        const { trace: leg1 } = saveTrace('newport - woorim', PTS);
        const renamed = retroBadgeFirstLeg(leg1.id)!;
        expect(renamed.name).toBe('newport - woorim (1st Leg)');
        expect(renamed.id).toBe(leg1.id); // same id — cloud upsert updates, not twins
        const stored = loadSavedTraces().find((t) => t.id === leg1.id)!;
        expect(stored.tripId).toBe(leg1.id);
        expect(stored.legOrdinal).toBe(1);
        expect(stored.destName).toBe('woorim');
        // Idempotent — a second call has nothing to do.
        expect(retroBadgeFirstLeg(leg1.id)).toBeNull();
    });

    it('plain overwrite keeps trip fields (a re-save never sheds membership)', () => {
        const { trace: root } = saveTrace('newport - woorim', PTS);
        retroBadgeFirstLeg(root.id);
        const { trace } = saveTrace('woorim - timbuktu (2nd Leg)', PTS, {
            tripId: root.id,
            legOrdinal: 2,
            destName: 'timbuktu',
        });
        saveTrace('woorim - timbuktu (2nd Leg)', PTS.slice(0, 2), { overwriteId: trace.id });
        const stored = loadSavedTraces().find((t) => t.id === trace.id)!;
        expect(stored.tripId).toBe(root.id);
        expect(stored.legOrdinal).toBe(2);
        expect(stored.destName).toBe('timbuktu');
    });

    it('auto-heal: moving leg 1 arrival drags leg 2 locked start with it', () => {
        const { trace: firstSave } = saveTrace('newport - woorim', PTS);
        const leg1 = retroBadgeFirstLeg(firstSave.id)!;
        const leg2start = PTS[2];
        saveTrace('woorim - mooloolaba (2nd Leg)', [leg2start, { lat: -26.7, lon: 153.1 }], {
            tripId: leg1.id,
            legOrdinal: 2,
            destName: 'mooloolaba',
        });
        // Edit leg 1: its arrival moves ~200 m.
        const moved = [...PTS.slice(0, 2), { lat: -27.002, lon: 153.302 }];
        const { trace: leg1b } = saveTrace(leg1.name, moved, { overwriteId: leg1.id });
        const msg = healTripChain(leg1b)!;
        expect(msg).toContain('start moved to match');
        const leg2 = loadSavedTraces().find((t) => t.legOrdinal === 2 && t.tripId === leg1.id)!;
        expect(leg2.points[0]).toEqual({ lat: -27.002, lon: 153.302 }); // welded
        expect(leg2.points[1]).toEqual({ lat: -26.7, lon: 153.1 }); // rest untouched
        // Already welded → nothing to heal.
        expect(healTripChain(leg1b)).toBeNull();
    });

    it('auto-heal is a no-op for standalone routes and chain tails', () => {
        const { trace } = saveTrace('newport - woorim', PTS);
        expect(healTripChain(trace)).toBeNull(); // no tripId
        const chainedRoot = retroBadgeFirstLeg(trace.id)!;
        const { trace: tail } = saveTrace('woorim - end (2nd Leg)', PTS, {
            tripId: chainedRoot.id,
            legOrdinal: 2,
        });
        expect(healTripChain(tail)).toBeNull(); // no successor
    });

    it('deleting leg 1 promotes every remaining leg and roots the trip at the old leg 2', () => {
        const { trace: firstSave } = saveTrace('newport - woorim', PTS);
        const leg1 = retroBadgeFirstLeg(firstSave.id)!;
        const { trace: leg2 } = saveTrace('woorim - mooloolaba (2nd Leg)', PTS, {
            tripId: leg1.id,
            legOrdinal: 2,
            destName: 'mooloolaba',
        });
        const { trace: leg3 } = saveTrace('mooloolaba - lady musgrave (3rd Leg)', PTS, {
            tripId: leg1.id,
            legOrdinal: 3,
            destName: 'lady musgrave',
        });

        const rebased = rebaseSavedTraceChainAfterDelete(loadSavedTraces(), leg1.id, '2026-07-26T00:00:00.000Z');
        const promoted = rebased.traces.find((trace) => trace.id === leg2.id)!;
        const following = rebased.traces.find((trace) => trace.id === leg3.id)!;

        expect(rebased.traces.map((trace) => trace.id)).not.toContain(leg1.id);
        expect(promoted).toMatchObject({
            tripId: leg2.id,
            legOrdinal: 1,
            name: 'woorim - mooloolaba (1st Leg)',
        });
        expect(following).toMatchObject({
            tripId: leg2.id,
            legOrdinal: 2,
            name: 'mooloolaba - lady musgrave (2nd Leg)',
        });
        expect(groupTracesByTrip(rebased.traces).map((group) => group.key)).not.toContain(leg1.id);
        expect(nextLegSeed(following)?.ordinal).toBe(3);
    });

    it('demotes a sole surviving leg to a normal standalone route', () => {
        const { trace: firstSave } = saveTrace('newport - woorim', PTS);
        const leg1 = retroBadgeFirstLeg(firstSave.id)!;
        const { trace: leg2 } = saveTrace('woorim - mooloolaba (2nd Leg)', PTS, {
            tripId: leg1.id,
            legOrdinal: 2,
        });

        const rebased = rebaseSavedTraceChainAfterDelete(loadSavedTraces(), leg1.id, '2026-07-26T00:00:00.000Z');
        expect(rebased.traces).toHaveLength(1);
        expect(rebased.traces[0]).toMatchObject({ id: leg2.id, name: 'woorim - mooloolaba' });
        expect(rebased.traces[0].tripId).toBeUndefined();
        expect(rebased.traces[0].legOrdinal).toBeUndefined();
        expect(nextLegSeed(rebased.traces[0])?.ordinal).toBe(2);
    });

    it('repairs a historical missing-root chain so a stranded second leg becomes first', () => {
        const orphanedLeg2 = {
            id: 'old-leg-2',
            name: 'woorim - mooloolaba (2nd Leg)',
            createdAt: '2026-07-25T00:00:00.000Z',
            points: PTS,
            tripId: 'deleted-leg-1',
            legOrdinal: 2,
        };
        const orphanedLeg3 = {
            id: 'old-leg-3',
            name: 'mooloolaba - lady musgrave (3rd Leg)',
            createdAt: '2026-07-25T01:00:00.000Z',
            points: PTS,
            tripId: 'deleted-leg-1',
            legOrdinal: 3,
        };

        const repaired = repairOrphanedSavedTraceChains([orphanedLeg3, orphanedLeg2], '2026-07-26T00:00:00.000Z');
        expect(repaired.changed).toHaveLength(2);
        expect(repaired.traces.find((trace) => trace.id === orphanedLeg2.id)).toMatchObject({
            tripId: orphanedLeg2.id,
            legOrdinal: 1,
            name: 'woorim - mooloolaba (1st Leg)',
        });
        expect(repaired.traces.find((trace) => trace.id === orphanedLeg3.id)).toMatchObject({
            tripId: orphanedLeg2.id,
            legOrdinal: 2,
            name: 'mooloolaba - lady musgrave (2nd Leg)',
        });
    });

    it('records a late mirror result on the delete fence for a future sync retry', () => {
        const { trace } = saveTrace('newport - woorim', PTS);
        // deleteTrace is deliberately async at the cloud boundary, while a
        // planned-route mirror may still be resolving in the background.
        expect(deleteTrace(trace.id)).toBe(true);

        expect(
            attachSavedTraceTombstoneLinks(trace.id, {
                plannedRouteId: 'planned_late_mirror',
                passageVoyageId: '123e4567-e89b-12d3-a456-426614174000',
            }),
        ).toBe(true);
        expect(getSavedTraceTombstones()[trace.id]).toMatchObject({
            plannedRouteId: 'planned_late_mirror',
            passageVoyageId: '123e4567-e89b-12d3-a456-426614174000',
        });
    });
});

describe('leg-verdict persistence (remount cold-cache fix, 2026-07-17)', () => {
    const verdict = {
        grade: 'clear' as const,
        issues: [],
        minDepthM: 8,
        minAt: null,
        needsTide: false,
        nudge: null,
        nudgeTo: null,
    };
    const FP = 'AU5BR001@12@2026-01-01@100@cloud-3';
    beforeEach(() => localStorage.clear());

    it('round-trips when keel + chart library match', () => {
        const cache = new Map([['a|b', verdict]]);
        persistLegVerdicts(cache, 2.4, false, FP);
        const back = hydrateLegVerdicts(2.4, false, FP)!;
        expect(back.get('a|b')?.grade).toBe('clear');
        expect(back.get('a|b')?.minDepthM).toBe(8);
    });

    it('a different keel, honesty flag, or chart version drops the lot', () => {
        persistLegVerdicts(new Map([['a|b', verdict]]), 2.4, false, FP);
        expect(hydrateLegVerdicts(2.6, false, FP)).toBeNull(); // draft changed
        expect(hydrateLegVerdicts(2.4, true, FP)).toBeNull(); // assumed flipped
        expect(hydrateLegVerdicts(2.4, false, FP + '|AU5XX009@1@2026-03-03@50@cloud-4')).toBeNull(); // chart installed
        expect(hydrateLegVerdicts(2.4, false, FP)).not.toBeNull(); // unchanged → survives
    });

    it('caps at the newest 500 entries and survives garbage', () => {
        const big = new Map(Array.from({ length: 620 }, (_, i) => [`k${i}`, verdict] as const));
        persistLegVerdicts(big, 2.4, false, FP);
        const back = hydrateLegVerdicts(2.4, false, FP)!;
        expect(back.size).toBe(500);
        expect(back.has('k619')).toBe(true); // newest kept
        expect(back.has('k0')).toBe(false); // oldest culled
        localStorage.setItem(authScopedStorageKey(LEG_VERDICTS_KEY), '{corrupt');
        expect(hydrateLegVerdicts(2.4, false, FP)).toBeNull();
    });
});

describe('groupTracesByTrip (shared by PLAN Trip box + card list)', () => {
    const FP = 'AU5BR001@12@2026-01-01@100@cloud-3';
    beforeEach(() => localStorage.clear());

    it('groups legs of one trip, ordinal-sorted, standalone routes stay singletons', () => {
        const { trace: firstSave } = saveTrace('newport - woorim', PTS);
        const root = retroBadgeFirstLeg(firstSave.id)!;
        saveTrace('woorim - mooloolaba (2nd Leg)', PTS, { tripId: root.id, legOrdinal: 2 });
        const { trace: solo } = saveTrace('bay run', PTS);
        // Feed newest-first (like loadSavedTraces returns) and out of leg order.
        const groups = groupTracesByTrip([...loadSavedTraces()]);
        const trip = groups.find((g) => g.key === root.id)!;
        expect(trip.legs.map((l) => l.legOrdinal)).toEqual([1, 2]); // ordinal-sorted
        expect(trip.label).toContain('2 legs');
        // First origin – FINAL destination, not leg 1's name (Shane 2026-09-08:
        // a Newport → Whitsundays passage was headed "Newport - Mackay").
        expect(trip.label).toBe('newport - mooloolaba (2 legs)');
        const standalone = groups.find((g) => g.key === solo.id)!;
        expect(standalone.legs).toHaveLength(1);
        expect(standalone.label).toBe('bay run');
    });

    it('badge-only legs (cloud shed the fields) still group + sort by name badge', () => {
        const a = { id: 'x1', name: 'a - b (1st Leg)', createdAt: '', points: PTS, tripId: 'x1' };
        const b = { id: 'x2', name: 'b - c (2nd Leg)', createdAt: '', points: PTS, tripId: 'x1' };
        // legOrdinal absent → falls back to the name badge ordinal.
        const groups = groupTracesByTrip([b, a] as never);
        expect(groups).toHaveLength(1);
        expect(groups[0].legs.map((l) => l.name)).toEqual(['a - b (1st Leg)', 'b - c (2nd Leg)']);
    });
});

describe('traceToGpx — chartplotter export', () => {
    const pts = [
        { lat: -27.2, lon: 153.1 },
        { lat: -27.15, lon: 153.18 },
        { lat: -27.1, lon: 153.25 },
    ];

    it('emits a GPX 1.1 <rte> with one <rtept> per pin, 6-dp coords', () => {
        const gpx = traceToGpx('Newport - Woorim', pts, '2026-07-17T00:00:00.000Z');
        expect(gpx).toContain('<gpx version="1.1"');
        expect(gpx).toContain('http://www.topografix.com/GPX/1/1');
        expect(gpx).toContain('<rte>');
        expect((gpx.match(/<rtept /g) || []).length).toBe(3);
        expect(gpx).toContain('lat="-27.200000" lon="153.100000"');
        expect(gpx).toContain('<name>WP-01</name>');
        expect(gpx).toContain('<name>WP-03</name>');
    });

    it('escapes XML in the route name and falls back when blank', () => {
        expect(traceToGpx('A & B <test>', pts, 'T')).toContain('<name>A &amp; B &lt;test&gt;</name>');
        expect(traceToGpx('   ', pts, 'T')).toContain('<name>Thalassa route</name>');
    });

    it('traceGpxFileName is filesystem-safe', () => {
        expect(traceGpxFileName('Newport - Woorim (2nd Leg)')).toBe('Newport-Woorim-2nd-Leg.gpx');
        expect(traceGpxFileName('  ')).toBe('thalassa-route.gpx');
    });
});

// ── Reversing legs (Shane 2026-10-07: "i can reverse the first leg. but i
//    cannot reverse the 2nd leg and so on"). Fictional places. Every save
//    below runs MapHub's own decision + commit (services/traceSave.ts). ──

const HARBOUR = { lat: -30.0, lon: 160.0 };
const BAY_POINT = { lat: -29.9, lon: 160.1 };
const SANDY_COVE = { lat: -29.8, lon: 160.2 };
const CAPE_GREY = { lat: -29.7, lon: 160.3 };
const line = (a: TracePoint, b: TracePoint): TracePoint[] => [
    { ...a },
    { lat: (a.lat + b.lat) / 2 + 0.003, lon: (a.lon + b.lon) / 2 },
    { ...b },
];

type Save = Extract<TraceSaveDecision, { kind: 'save' }>;

/** One tap of Save that is expected to land (no collision). */
function tapSave(name: string, points: TracePoint[], anchor: ReturnType<typeof nextLegSeed> = null): SavedTrace {
    const decision = decideTraceSave({ name, points, anchor, savedTraces: loadSavedTraces(), overwriteArm: null });
    expect(decision.kind).toBe('save');
    const { trace, persisted } = commitTraceSave(decision as Save, points);
    expect(persisted).toBe(true);
    return loadSavedTraces().find((t) => t.id === trace.id)!;
}

/** Harbour → Bay Point → Sandy Cove → Cape Grey, plotted leg by leg. */
function plotOutbound(names = ['Harbour - Bay Point', 'Bay Point - Sandy Cove', 'Sandy Cove - Cape Grey']) {
    const leg1 = tapSave(names[0], line(HARBOUR, BAY_POINT));
    const leg2 = tapSave(names[1], line(BAY_POINT, SANDY_COVE), nextLegSeed(leg1));
    const leg3 = tapSave(names[2], line(SANDY_COVE, CAPE_GREY), nextLegSeed(leg2));
    const legs = [leg1.id, leg2.id, leg3.id].map((id) => loadSavedTraces().find((t) => t.id === id)!);
    expect(legs.map((t) => t.legOrdinal)).toEqual([1, 2, 3]);
    return legs;
}

/** The outbound rows exactly as stored, for a byte-for-byte comparison. */
function storedRows(ids: readonly string[]): string {
    const raw = JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_traced_routes_v1')) ?? '[]');
    return JSON.stringify(
        (raw as SavedTrace[]).filter((t) => ids.includes(t.id)).sort((a, b) => a.id.localeCompare(b.id)),
    );
}

/** Open a saved leg in the tracer the way 'load-saved' does, then tap ⇄. */
function openAndReverse(leg: SavedTrace) {
    const { result } = renderHook(() => useTraceDraft());
    act(() => {
        result.current.setLegAnchor(null);
        result.current.setCapturedCoords(leg.points);
        result.current.setTraceName(leg.name);
    });
    act(() => result.current.reverseDirection());
    return result;
}

describe('reversing a leg makes a new route and never edits the trip', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it.each([
        [2, 'Sandy Cove - Bay Point'],
        [3, 'Cape Grey - Sandy Cove'],
    ])(
        'a reversed copy of leg %i is standalone: Cast Off seeds it as leg 1 and its next leg is the 2nd',
        (legNumber, flipped) => {
            const index = legNumber - 1;
            const outbound = plotOutbound();
            const before = storedRows(outbound.map((t) => t.id));
            const draft = openAndReverse(outbound[index]);
            expect(draft.current.traceName).toBe(flipped);

            const copy = tapSave(draft.current.traceName, draft.current.capturedCoords, draft.current.legAnchor);
            expect(copy.tripId).toBeUndefined();
            expect(copy.legOrdinal).toBeUndefined();
            expect(copy.name).toBe(flipped);
            expect(copy.points).toEqual([...outbound[index].points].reverse());
            expect(copy.verification).toBeUndefined();
            // The stale badge used to make these say leg 2/3 and "Plot the 3rd/4th leg".
            expect(tripLegAnchorOrdinal(copy.id)).toBe(1);
            expect(nextLegSeed(copy)?.ordinal).toBe(2);
            expect(groupTracesByTrip(loadSavedTraces()).find((g) => g.key === copy.id)?.legs).toHaveLength(1);
            expect(storedRows(outbound.map((t) => t.id))).toBe(before);
        },
    );

    it('⇄ in a "Plot the next leg" draft fills the slot reversed and saves as that leg', () => {
        const outbound = plotOutbound();
        const before = storedRows(outbound.map((t) => t.id));
        // A day sail home from Cape Grey, then "Plot the 2nd leg from Sandy Cove".
        const first = reversedCopyOf(outbound[2]);
        const homeLeg1 = tapSave(first.name, first.points);
        const seed = nextLegSeed(homeLeg1)!;
        const { result } = renderHook(() => useTraceDraft());
        act(() => {
            result.current.setCapturedCoords([seed.anchor]);
            result.current.setTraceName(`${seed.fromName} - `);
            result.current.setLegAnchor(seed);
        });
        const traces = loadSavedTraces();
        const picks = slotCandidates(traces, seed.anchor, { previousLeg: previousLegFor(traces, seed) });
        expect(picks.map((t) => t.id)).toEqual([outbound[1].id]);
        let filled = false;
        act(() => {
            filled = result.current.fillSlotWithReversed(picks[0]);
        });
        expect(filled).toBe(true);
        expect(result.current.capturedCoords[0]).toEqual(seed.anchor);

        const leg2 = tapSave(result.current.traceName, result.current.capturedCoords, result.current.legAnchor);
        expect(leg2).toMatchObject({
            name: 'Sandy Cove - Bay Point (2nd Leg)',
            tripId: homeLeg1.id,
            legOrdinal: 2,
            destName: 'Bay Point',
        });
        expect(loadSavedTraces().find((t) => t.id === homeLeg1.id)?.name).toBe('Cape Grey - Sandy Cove (1st Leg)');
        expect(storedRows(outbound.map((t) => t.id))).toBe(before);
    });

    it.each(['Bay run', "Tour de l'île", '湾内クルーズ'])(
        'refuses to reverse the separator-less leg "%s (2nd Leg)" in place, so leg 3 never moves',
        (title) => {
            const outbound = plotOutbound(['Morning run', title, 'Cape run']);
            expect(outbound[1].name).toBe(`${title} (2nd Leg)`);
            const ids = outbound.map((t) => t.id);
            const before = storedRows(ids);
            const draft = openAndReverse(outbound[1]);
            // The badge is gone, so the copy no longer collides by name…
            expect(draft.current.traceName).toBe(title);
            // …and typing the leg's own name back is refused, armed or not.
            for (const overwriteArm of [null, outbound[1].id]) {
                expect(
                    decideTraceSave({
                        name: `${title} (2nd Leg)`,
                        points: draft.current.capturedCoords,
                        anchor: null,
                        savedTraces: loadSavedTraces(),
                        overwriteArm,
                    }),
                ).toMatchObject({
                    kind: 'refuse',
                    reason: `That's ${title} reversed — give the return run its own name`,
                });
            }
            expect(storedRows(ids)).toBe(before);
            expect(healTripChain(loadSavedTraces().find((t) => t.id === outbound[1].id)!)).toBeNull();

            // Saved under its own name it is a new route; leg 3 still departs leg 2's arrival.
            const copy = tapSave(draft.current.traceName, draft.current.capturedCoords);
            expect(copy.tripId).toBeUndefined();
            expect(storedRows(ids)).toBe(before);
            const leg3 = loadSavedTraces().find((t) => t.id === outbound[2].id)!;
            expect(leg3.points[0]).toEqual(SANDY_COVE);
        },
    );

    it('a reversed passage saves as one standalone route, the legs untouched', () => {
        const outbound = plotOutbound();
        const before = storedRows(outbound.map((t) => t.id));
        const rollup = buildTripPassageRollups(loadSavedTraces())[0];
        const { result } = renderHook(() => useTraceDraft());
        act(() => {
            result.current.setLegAnchor(null);
            result.current.setCapturedCoords(rollup.points);
            result.current.setTraceName(rollup.name);
        });
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Cape Grey - Harbour');
        const copy = tapSave(result.current.traceName, result.current.capturedCoords);
        expect(copy.tripId).toBeUndefined();
        expect(tripLegAnchorOrdinal(copy.id)).toBe(1);
        expect(storedRows(outbound.map((t) => t.id))).toBe(before);
    });

    it('builds a return trip from a 3-leg outbound trip with the exact save sequence', () => {
        const outbound = plotOutbound();
        const ids = outbound.map((t) => t.id);
        const before = storedRows(ids);

        // Return leg 1: leg 3 reversed, unanchored — a day sail until leg 2 exists.
        const first = reversedCopyOf(outbound[2]);
        const r1 = tapSave(first.name, first.points);
        expect(r1.tripId).toBeUndefined();
        // Return legs 2 and 3: each slot is the previous arrival, locked.
        const seed2 = nextLegSeed(r1)!;
        const slot2 = reversedLegForSlot(outbound[1], seed2.anchor)!;
        const r2 = tapSave(slot2.name, slot2.points, seed2);
        const seed3 = nextLegSeed(r2)!;
        const slot3 = reversedLegForSlot(outbound[0], seed3.anchor)!;
        const r3 = tapSave(slot3.name, slot3.points, seed3);

        const trip = groupTracesByTrip(loadSavedTraces()).find((g) => g.key === r1.id)!;
        expect(trip.legs.map((t) => t.id)).toEqual([r1.id, r2.id, r3.id]);
        expect(trip.legs.map((t) => t.legOrdinal)).toEqual([1, 2, 3]);
        expect(trip.legs.every((t) => t.tripId === r1.id)).toBe(true);
        expect(r1.id).not.toBe(outbound[0].id);
        expect(trip.legs.map((t) => t.name)).toEqual([
            'Cape Grey - Sandy Cove (1st Leg)',
            'Sandy Cove - Bay Point (2nd Leg)',
            'Bay Point - Harbour (3rd Leg)',
        ]);
        // Welded joints, by construction.
        for (let i = 0; i + 1 < trip.legs.length; i++) {
            expect(trip.legs[i + 1].points[0]).toEqual(trip.legs[i].points.at(-1));
        }
        const rollup = buildTripPassageRollups(loadSavedTraces()).find((r) => r.tripId === r1.id)!;
        expect(rollup.name).toBe('Cape Grey - Harbour (Passage)');
        expect(rollup.points).toHaveLength(7); // 3 + 3 + 3, two joints shared
        expect(rollup.points[0]).toEqual(CAPE_GREY);
        expect(rollup.points.at(-1)).toEqual(HARBOUR);
        // The outbound trip, byte for byte.
        expect(storedRows(ids)).toBe(before);
        expect(buildTripPassageRollups(loadSavedTraces()).find((r) => r.tripId === outbound[0].id)?.name).toBe(
            'Harbour - Cape Grey (Passage)',
        );
    });
});

// ── 2026-10-07 review: Save keeps a chained leg's locked start, so the leg
//    just saved is still a locked draft. ⇄ there must make a copy, never fill
//    the slot (that added a second leg 2 to the outbound trip). ──

const REEF = { lat: -29.95, lon: 160.25 };

/** Rows of `tripId` holding leg `ordinal`, structural or by badge. */
function legsAt(tripId: string, ordinal: number): SavedTrace[] {
    return loadSavedTraces().filter(
        (t) => (t.tripId ?? t.id) === tripId && (t.legOrdinal ?? legBadgeOrdinal(t.name) ?? 1) === ordinal,
    );
}

describe('⇄ on a chained leg that has just been saved', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    /** Harbour → Bay Point → Sandy Cove, plus a standalone route that also ends at Bay Point. */
    function setUp() {
        const leg1 = tapSave('Harbour - Bay Point', line(HARBOUR, BAY_POINT));
        const seed = nextLegSeed(leg1)!;
        const leg2 = tapSave('Bay Point - Sandy Cove', line(BAY_POINT, SANDY_COVE), seed);
        const foreign = tapSave('Reef - Bay Point', line(REEF, BAY_POINT));
        const ids = [leg1.id, leg2.id, foreign.id];
        // The tracer right after leg 2's Save: same pins, badged name, lock kept.
        const { result } = renderHook(() => useTraceDraft());
        act(() => {
            result.current.setCapturedCoords(leg2.points);
            result.current.setTraceName(leg2.name);
            result.current.setLegAnchor(seed);
        });
        return { leg1, leg2, foreign, seed, ids, draft: result };
    }

    it('makes a reversed copy, drops the lock, and leaves the outbound trip with one leg 2', () => {
        const { leg1, leg2, foreign, ids, draft } = setUp();
        const before = storedRows(ids);
        const tap = reverseTapDecision({
            traces: loadSavedTraces(),
            anchor: draft.current.legAnchor,
            points: draft.current.capturedCoords,
        });
        // The foreign route arrives at the locked start, but the slot is not empty.
        expect(tap).toMatchObject({
            kind: 'copy',
            detach: true,
            source: {
                label: 'Bay Point - Sandy Cove (Leg 2)',
                unchanged: 'Leg 2 of Harbour - Sandy Cove is unchanged',
            },
        });
        act(() => draft.current.reverseDirection(tap.kind === 'copy' ? tap.source?.label : null, { detach: true }));
        expect(draft.current.legAnchor).toBeNull();
        expect(draft.current.traceName).toBe('Sandy Cove - Bay Point');
        expect(draft.current.capturedCoords).toEqual([...leg2.points].reverse());
        expect(draft.current.reversedFrom?.label).toBe('Bay Point - Sandy Cove (Leg 2)');

        const copy = tapSave(draft.current.traceName, draft.current.capturedCoords, draft.current.legAnchor);
        expect(copy.tripId).toBeUndefined();
        expect(copy.legOrdinal).toBeUndefined();
        expect(storedRows(ids)).toBe(before);
        expect(legsAt(leg1.id, 2).map((t) => t.id)).toEqual([leg2.id]);
        const trip = groupTracesByTrip(loadSavedTraces()).find((g) => g.key === leg1.id)!;
        expect(trip.legs.map((t) => t.id)).toEqual([leg1.id, leg2.id]);
        const rollup = buildTripPassageRollups(loadSavedTraces()).find((r) => r.tripId === leg1.id)!;
        expect(rollup.points).toHaveLength(5);
        expect(rollup.points.at(-1)).toEqual(SANDY_COVE);
        expect(loadSavedTraces().find((t) => t.id === foreign.id)?.name).toBe('Reef - Bay Point');
    });

    it('Save refuses a NEW row in a slot that is already saved, however the draft got there', () => {
        const { leg1, leg2, foreign, seed, ids } = setUp();
        const before = storedRows(ids);
        // The old path: the foreign route reversed into the saved leg-2 slot.
        const filled = reversedLegForSlot(foreign, seed.anchor)!;
        // …and the older one: Clear, re-plot, rename.
        const replotted = line(BAY_POINT, REEF);
        for (const [name, points] of [
            [filled.name, filled.points],
            ['Bay Point - Elsewhere', replotted],
        ] as const) {
            for (const overwriteArm of [null, leg2.id]) {
                expect(
                    decideTraceSave({ name, points, anchor: seed, savedTraces: loadSavedTraces(), overwriteArm }),
                ).toMatchObject({
                    kind: 'refuse',
                    existing: { id: leg2.id },
                    reason: 'Leg 2 of this trip is already saved as "Bay Point - Sandy Cove (2nd Leg)" — keep that name to update it',
                });
            }
        }
        // Keeping the name is still an ordinary, confirmed update of leg 2 itself.
        expect(
            decideTraceSave({
                name: 'Bay Point - Sandy Cove',
                points: replotted,
                anchor: seed,
                savedTraces: loadSavedTraces(),
                overwriteArm: null,
            }),
        ).toMatchObject({ kind: 'confirm-overwrite', existing: { id: leg2.id } });
        expect(storedRows(ids)).toBe(before);
        expect(legsAt(leg1.id, 2)).toHaveLength(1);
    });

    it('after Clear back to the locked pin, ⇄ says the leg is saved instead of filling it', () => {
        const { leg2, seed, draft } = setUp();
        act(() => draft.current.setCapturedCoords([seed.anchor]));
        expect(
            reverseTapDecision({
                traces: loadSavedTraces(),
                anchor: draft.current.legAnchor,
                points: draft.current.capturedCoords,
            }),
        ).toMatchObject({ kind: 'slot-taken', ordinal: 2, occupant: { id: leg2.id } });
    });

    it('an empty slot still fills: the next leg from Sandy Cove', () => {
        const { leg2 } = setUp();
        const seed3 = nextLegSeed(leg2)!;
        const inbound = tapSave('Cape Grey - Sandy Cove', line(CAPE_GREY, SANDY_COVE));
        const tap = reverseTapDecision({ traces: loadSavedTraces(), anchor: seed3, points: [seed3.anchor] });
        expect(tap.kind === 'fill' ? tap.candidates.map((t) => t.id) : tap.kind).toEqual([inbound.id]);
    });
});

describe('two saved routes with one name', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it('a separator-less return trip cannot make "Overwrite?" reach the other trip', () => {
        // Outbound: "Bay run (1st Leg)" + "Bay run (2nd Leg)".
        const out1 = tapSave('Bay run', line(HARBOUR, BAY_POINT));
        const out2 = tapSave('Bay run', line(BAY_POINT, SANDY_COVE), nextLegSeed(out1));
        expect(loadSavedTraces().find((t) => t.id === out1.id)?.name).toBe('Bay run (1st Leg)');
        expect(out2.name).toBe('Bay run (2nd Leg)');
        // Return: leg 1 keeps the bare name; leg 2 is refused as "Bay run (2nd Leg)" and renamed.
        const back1 = reversedCopyOf(out2);
        const r1 = tapSave(back1.name, back1.points);
        expect(r1.name).toBe('Bay run');
        const seed = nextLegSeed(r1)!;
        const slot = reversedLegForSlot(out1, seed.anchor)!;
        expect(
            decideTraceSave({
                name: slot.name,
                points: slot.points,
                anchor: seed,
                savedTraces: loadSavedTraces(),
                overwriteArm: null,
            }).kind,
        ).toBe('refuse');
        tapSave('Home', slot.points, seed);
        // The retro badge now gives the return trip's leg 1 the outbound leg 1's name.
        const twins = loadSavedTraces().filter((t) => t.name === 'Bay run (1st Leg)');
        expect(twins.map((t) => t.id).sort()).toEqual([out1.id, r1.id].sort());
        const ids = loadSavedTraces().map((t) => t.id);
        const before = storedRows(ids);

        // Edit either leg 1 and save it under that name: refused, armed or not.
        for (const twin of twins) {
            const nudged = twin.points.map((p, i) => (i === 1 ? { lat: p.lat + 0.001, lon: p.lon } : p));
            for (const overwriteArm of [null, out1.id, r1.id]) {
                expect(
                    decideTraceSave({
                        name: 'Bay run (1st Leg)',
                        points: nudged,
                        anchor: null,
                        savedTraces: loadSavedTraces(),
                        overwriteArm,
                    }),
                ).toMatchObject({
                    kind: 'refuse',
                    reason: '2 saved routes are called "Bay run (1st Leg)" — give this one its own name',
                });
            }
        }
        expect(storedRows(ids)).toBe(before);
    });

    it('a chained leg still updates its own row when another trip shares its name', () => {
        const a1 = tapSave('Harbour - Bay Point', line(HARBOUR, BAY_POINT));
        const seedA = nextLegSeed(a1)!;
        const a2 = tapSave('Bay run', line(BAY_POINT, SANDY_COVE), seedA);
        // A second trip's leg 2 with the same name, as another device might sync it.
        const b1 = tapSave('Reef - Cape Grey', line(REEF, CAPE_GREY));
        saveTrace('Bay run (2nd Leg)', line(CAPE_GREY, SANDY_COVE), { tripId: b1.id, legOrdinal: 2 });
        expect(loadSavedTraces().filter((t) => t.name === 'Bay run (2nd Leg)')).toHaveLength(2);
        const edited = line(BAY_POINT, { lat: SANDY_COVE.lat, lon: SANDY_COVE.lon + 0.01 });
        const decision = decideTraceSave({
            name: 'Bay run',
            points: edited,
            anchor: seedA,
            savedTraces: loadSavedTraces(),
            overwriteArm: null,
        });
        expect(decision).toMatchObject({ kind: 'confirm-overwrite', existing: { id: a2.id } });
        const armed = decideTraceSave({
            name: 'Bay run',
            points: edited,
            anchor: seedA,
            savedTraces: loadSavedTraces(),
            overwriteArm: a2.id,
        });
        expect(armed).toMatchObject({ kind: 'save', existing: { id: a2.id } });
    });
});
