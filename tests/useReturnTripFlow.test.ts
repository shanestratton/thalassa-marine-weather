/**
 * "⇄ Plan the return trip" (Shane 2026-10-07): a NEW trip home, one checked
 * leg at a time, driven through the same draft and the same Save decision the
 * tracer uses. The outbound trip and the plan being followed are never
 * written. Fictional places.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const linkSpies = vi.hoisted(() => ({
    setPlanLinkWithRetry: vi.fn(),
    queuePlanLinkIntent: vi.fn(),
    publishFollowedRouteDetailed: vi.fn(),
}));
vi.mock('../services/shiplog/planLinkIntent', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/shiplog/planLinkIntent')>()),
    setPlanLinkWithRetry: linkSpies.setPlanLinkWithRetry,
    queuePlanLinkIntent: linkSpies.queuePlanLinkIntent,
}));
vi.mock('../services/shiplog/publishFollowedRoute', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/shiplog/publishFollowedRoute')>()),
    publishFollowedRouteDetailed: linkSpies.publishFollowedRouteDetailed,
}));

import { useTraceDraft } from '../components/map/useTraceDraft';
import { useReturnTripFlow } from '../components/map/useReturnTripFlow';
import {
    buildTripPassageRollups,
    deleteTrace,
    groupTracesByTrip,
    loadSavedTraces,
    nextLegSeed,
    saveTrace,
    traceAsVoyagePlan,
    type SavedTrace,
    type TracePoint,
} from '../services/routeTracer';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { commitTraceSave, decideTraceSave, type TraceSaveDecision } from '../services/traceSave';
import { followedSavedRouteIds } from '../services/tripReverse';
import { useFollowRouteStore } from '../stores/followRouteStore';

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

function plotOutbound(): SavedTrace[] {
    const tap = (name: string, points: TracePoint[], anchor: ReturnType<typeof nextLegSeed>) => {
        const decision = decideTraceSave({ name, points, anchor, savedTraces: loadSavedTraces(), overwriteArm: null });
        return commitTraceSave(decision as Save, points).trace;
    };
    const leg1 = tap('Harbour - Bay Point', line(HARBOUR, BAY_POINT), null);
    const leg2 = tap('Bay Point - Sandy Cove', line(BAY_POINT, SANDY_COVE), nextLegSeed(leg1));
    tap('Sandy Cove - Cape Grey', line(SANDY_COVE, CAPE_GREY), nextLegSeed(leg2));
    const trip = groupTracesByTrip(loadSavedTraces()).find((g) => g.key === leg1.id)!;
    expect(trip.legs).toHaveLength(3);
    return trip.legs;
}

function storedRows(ids: readonly string[]): string {
    const raw = JSON.parse(localStorage.getItem(authScopedStorageKey('thalassa_traced_routes_v1')) ?? '[]');
    return JSON.stringify(
        (raw as SavedTrace[]).filter((t) => ids.includes(t.id)).sort((a, b) => a.id.localeCompare(b.id)),
    );
}

function followedState(): string {
    const { voyagePlan, routeCoords, voyageId, isFollowing, startedAt } = useFollowRouteStore.getState();
    return JSON.stringify({
        voyagePlan,
        routeCoords,
        voyageId,
        isFollowing,
        startedAt,
        stored: localStorage.getItem(authScopedStorageKey('thalassa_follow_route')),
    });
}

function mount(flash = vi.fn()) {
    const hook = renderHook(() => {
        const draft = useTraceDraft();
        const flow = useReturnTripFlow(draft, { flash });
        return { draft, flow };
    });
    return { ...hook, flash };
}

type Harness = ReturnType<typeof mount>['result'];

/** Save exactly as the tracer's Save button does, then tell the flow. */
function tapSave(result: Harness): SavedTrace {
    const { draft } = result.current;
    const follow = useFollowRouteStore.getState();
    const decision = decideTraceSave({
        name: draft.traceName,
        points: draft.capturedCoords,
        anchor: draft.legAnchor,
        savedTraces: loadSavedTraces(),
        overwriteArm: null,
        followedIds: followedSavedRouteIds(loadSavedTraces(), follow),
    });
    expect(decision.kind).toBe('save');
    const { trace, persisted } = commitTraceSave(decision as Save, draft.capturedCoords);
    expect(persisted).toBe(true);
    act(() => {
        result.current.flow.onSaved(trace);
    });
    return loadSavedTraces().find((t) => t.id === trace.id)!;
}

describe('return trip, leg by leg', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-a');
        useFollowRouteStore.getState().stopFollowing();
    });

    it('builds the whole trip home across 3 legs without touching the outbound trip or the followed plan', () => {
        const outbound = plotOutbound();
        const ids = outbound.map((t) => t.id);
        // The boat is following outbound leg 2.
        useFollowRouteStore
            .getState()
            .startFollowing(
                traceAsVoyagePlan(outbound[1].name, outbound[1].points),
                'planned-leg-2',
                outbound[1].points,
            );
        const before = storedRows(ids);
        const followedBefore = followedState();
        const { result, flash } = mount();

        let opened: TracePoint[] | null = null;
        act(() => {
            opened = result.current.flow.start(outbound[0].id);
        });
        expect(opened).toEqual([...outbound[2].points].reverse());
        expect(result.current.draft.legAnchor).toBeNull();
        expect(result.current.draft.traceName).toBe('Cape Grey - Sandy Cove');
        expect(result.current.draft.reversedFrom?.label).toBe('Sandy Cove - Cape Grey (Leg 3)');
        expect(result.current.flow.progress).toEqual({ leg: 1, of: 3, saved: false });
        expect(result.current.flow.nextReturnLeg).toBeNull();
        expect(flash).toHaveBeenLastCalledWith(expect.stringMatching(/^Return leg 1 of 3/));

        const r1 = tapSave(result);
        expect(r1.tripId).toBeUndefined(); // leg 1 is a day sail until leg 2 exists
        expect(result.current.flow.nextReturnLeg).toEqual({ j: 2, k: 3 });

        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.legAnchor).toMatchObject({ tripId: r1.id, ordinal: 2, anchor: SANDY_COVE });
        expect(result.current.draft.capturedCoords[0]).toEqual(SANDY_COVE);
        expect(result.current.draft.capturedCoords.at(-1)).toEqual(BAY_POINT);
        expect(result.current.draft.traceName).toBe('Sandy Cove - Bay Point');
        expect(result.current.flow.progress).toEqual({ leg: 2, of: 3, saved: false });
        const r2 = tapSave(result);

        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.capturedCoords.at(-1)).toEqual(HARBOUR);
        let done: string | null = null;
        const r3 = (() => {
            const { draft } = result.current;
            const decision = decideTraceSave({
                name: draft.traceName,
                points: draft.capturedCoords,
                anchor: draft.legAnchor,
                savedTraces: loadSavedTraces(),
                overwriteArm: null,
            });
            const { trace } = commitTraceSave(decision as Save, draft.capturedCoords);
            act(() => {
                done = result.current.flow.onSaved(trace);
            });
            return trace;
        })();
        expect(done).toBe('return trip saved — 3 legs');
        expect(result.current.draft.returnPlan).toBeNull();
        expect(result.current.flow.nextReturnLeg).toBeNull();

        const home = groupTracesByTrip(loadSavedTraces()).find((g) => g.key === r1.id)!;
        expect(home.legs.map((t) => t.id)).toEqual([r1.id, r2.id, r3.id]);
        expect(home.legs.map((t) => t.legOrdinal)).toEqual([1, 2, 3]);
        expect(buildTripPassageRollups(loadSavedTraces()).find((r) => r.tripId === r1.id)?.name).toBe(
            'Cape Grey - Harbour (Passage)',
        );
        expect(storedRows(ids)).toBe(before);
        expect(followedState()).toBe(followedBefore);
        expect(linkSpies.setPlanLinkWithRetry).not.toHaveBeenCalled();
        expect(linkSpies.queuePlanLinkIntent).not.toHaveBeenCalled();
        expect(linkSpies.publishFollowedRouteDetailed).not.toHaveBeenCalled();
    });

    it('lets the skipper stop after any leg, keeping what was saved', () => {
        const outbound = plotOutbound();
        const before = storedRows(outbound.map((t) => t.id));
        const { result, flash } = mount();
        act(() => {
            result.current.flow.start(outbound[0].id);
        });
        const r1 = tapSave(result);
        act(() => {
            result.current.flow.openNext();
        });
        tapSave(result);
        act(() => result.current.flow.stop());
        expect(result.current.draft.returnPlan).toBeNull();
        expect(result.current.flow.nextReturnLeg).toBeNull();
        expect(result.current.flow.progress).toBeNull();
        expect(flash).toHaveBeenLastCalledWith('Return trip stopped — the legs you saved are kept');
        expect(groupTracesByTrip(loadSavedTraces()).find((g) => g.key === r1.id)?.legs).toHaveLength(2);
        expect(storedRows(outbound.map((t) => t.id))).toBe(before);
    });

    it('survives a reload mid-flow', () => {
        const outbound = plotOutbound();
        const first = mount();
        act(() => {
            first.result.current.flow.start(outbound[0].id);
        });
        const r1 = tapSave(first.result);
        first.unmount();

        const { result } = mount();
        expect(result.current.flow.nextReturnLeg).toEqual({ j: 2, k: 3 });
        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.legAnchor?.tripId).toBe(r1.id);
        expect(result.current.draft.capturedCoords.at(-1)).toEqual(BAY_POINT);
    });

    it('starts from a middle leg: home from Sandy Cove is legs 2 then 1', () => {
        const outbound = plotOutbound();
        const { result } = mount();
        act(() => {
            result.current.flow.start(outbound[0].id, 2);
        });
        expect(result.current.draft.traceName).toBe('Sandy Cove - Bay Point');
        expect(result.current.flow.progress).toEqual({ leg: 1, of: 2, saved: false });
        tapSave(result);
        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.capturedCoords.at(-1)).toEqual(HARBOUR);
    });

    it('a one-leg return is just a reversed copy with no flow', () => {
        const outbound = plotOutbound();
        const { result, flash } = mount();
        act(() => {
            result.current.flow.start(outbound[0].id, 1);
        });
        expect(result.current.draft.traceName).toBe('Bay Point - Harbour');
        expect(result.current.draft.returnPlan).toBeNull();
        expect(flash).toHaveBeenLastCalledWith(
            'Reversed copy — Leg 1 of Harbour - Cape Grey is unchanged. Set a departure for the trip home',
        );
    });

    it('never carries the outbound departure into a return leg', () => {
        const outbound = plotOutbound();
        const { result, flash } = mount();
        // Departure set while the outbound trip was on screen: tomorrow, early.
        const outboundDeparture = Date.now() + 20 * 3_600_000;
        act(() => {
            result.current.draft.setDepartureMs(outboundDeparture);
        });
        expect(result.current.draft.departureMs).toBe(outboundDeparture);
        act(() => {
            result.current.flow.start(outbound[0].id);
        });
        expect(result.current.draft.departureMs).toBeNull();
        expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('set a departure for the trip home'));
        // The skipper's own departure for return leg 1 does not ride on to leg 2:
        // leg 2 leaves later, from somewhere else.
        const homeDeparture = Date.now() + 30 * 3_600_000;
        act(() => {
            result.current.draft.setDepartureMs(homeDeparture);
        });
        tapSave(result);
        expect(result.current.draft.departureMs).toBe(homeDeparture);
        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.legAnchor?.ordinal).toBe(2);
        expect(result.current.draft.departureMs).toBeNull();
    });

    it('ends the flow out loud when the next outbound leg was deleted', () => {
        const outbound = plotOutbound();
        const { result, flash } = mount();
        act(() => {
            result.current.flow.start(outbound[0].id);
        });
        tapSave(result);
        deleteTrace(outbound[1].id);
        act(() => {
            expect(result.current.flow.openNext()).toBeNull();
        });
        expect(flash).toHaveBeenLastCalledWith('Leg 2 of Harbour - Cape Grey was deleted — return trip stopped');
        expect(result.current.draft.returnPlan).toBeNull();
    });

    it('leaves the slot empty and says why when a joint no longer meets', () => {
        const outbound = plotOutbound();
        const { result, flash } = mount();
        act(() => {
            result.current.flow.start(outbound[0].id);
        });
        tapSave(result);
        // The skipper moved outbound leg 2's arrival a mile off (an edit to
        // the source mid-flow; nothing ripples back to the saved return leg).
        const moved = [...outbound[1].points];
        moved[2] = { lat: SANDY_COVE.lat + 1 / 60, lon: SANDY_COVE.lon };
        saveTrace(outbound[1].name, moved, { overwriteId: outbound[1].id });
        act(() => {
            result.current.flow.openNext();
        });
        expect(result.current.draft.capturedCoords).toEqual([SANDY_COVE]);
        expect(result.current.draft.legAnchor?.ordinal).toBe(2);
        expect(result.current.draft.reversedFrom).toBeNull();
        expect(flash).toHaveBeenLastCalledWith(
            'Leg 2 of Harbour - Cape Grey no longer ends where this return leg starts (1.0 NM apart) — plot this leg by hand',
        );
        // The flow carries on once that leg is saved.
        expect(result.current.flow.progress).toEqual({ leg: 2, of: 3, saved: false });
    });
});
