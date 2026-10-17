import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTraceDraft } from '../components/map/useTraceDraft';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const keys = {
    pins: 'thalassa_trace_wip_pins',
    departureMs: 'thalassa_trace_departure_ms',
    name: 'thalassa_trace_wip_name',
    autoName: 'thalassa_trace_wip_auto_name',
    legAnchor: 'thalassa_trace_wip_leg_anchor',
    origin: 'thalassa_trace_wip_origin',
    destination: 'thalassa_trace_wip_dest',
    returnPlan: 'thalassa_trace_wip_return_plan',
    reversedFrom: 'thalassa_trace_wip_reversed_from',
    frameKind: 'thalassa_trace_wip_frame_kind',
    source: 'thalassa_trace_wip_source',
};

const BAY_POINT = { lat: -29.9, lon: 160.1 };
const SANDY_COVE = { lat: -29.8, lon: 160.2 };
const MIDWAY = { lat: -29.847, lon: 160.15 };
const PLAN = {
    sourceTripId: 'trip-out',
    sourceLabel: 'Harbour - Cape Grey',
    sourceLegIds: ['out-3', 'out-2', 'trip-out'],
    nextIndex: 2,
    chainFromId: null,
};

describe('useTraceDraft', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    const key = (base: string) => authScopedStorageKey(base, getAuthIdentityScope());

    it('commits a point-only edit only against the exact current draft epoch and source guard', () => {
        const { result } = renderHook(() => useTraceDraft());
        act(() => result.current.setCapturedCoords([BAY_POINT, SANDY_COVE]));
        const points = result.current.capturedCoords,
            epoch = result.current.getTraceEditEpoch();
        act(() => {
            expect(
                result.current.commitCheckedTracePoints(
                    epoch,
                    points,
                    (p) => [p[0], { ...MIDWAY, name: 'Wait' }, p[1]],
                    () => true,
                ),
            ).toBe(true);
        });
        expect(result.current.capturedCoords).toEqual([BAY_POINT, { ...MIDWAY, name: 'Wait' }, SANDY_COVE]);
        act(() =>
            expect(
                result.current.commitCheckedTracePoints(
                    epoch,
                    points,
                    () => [],
                    () => true,
                ),
            ).toBe(false),
        );
        const current = result.current.capturedCoords,
            currentEpoch = result.current.getTraceEditEpoch();
        act(() =>
            expect(
                result.current.commitCheckedTracePoints(
                    currentEpoch,
                    current,
                    () => [],
                    () => false,
                ),
            ).toBe(false),
        );
        expect(result.current.capturedCoords).toBe(current);
    });

    it('refuses queued A/B/A draft edits and a source that retires inside the React updater', () => {
        const { result } = renderHook(() => useTraceDraft());
        act(() => result.current.setCapturedCoords([BAY_POINT, SANDY_COVE]));
        const points = result.current.capturedCoords,
            epoch = result.current.getTraceEditEpoch();
        act(() => {
            result.current.setCapturedCoords([BAY_POINT, MIDWAY]);
            result.current.setCapturedCoords(points);
            expect(
                result.current.commitCheckedTracePoints(
                    epoch,
                    points,
                    () => [],
                    () => true,
                ),
            ).toBe(false);
        });
        expect(result.current.capturedCoords).toBe(points);
        const after = result.current.getTraceEditEpoch();
        let guardReads = 0;
        act(() =>
            expect(
                result.current.commitCheckedTracePoints(
                    after,
                    points,
                    () => [],
                    () => ++guardReads === 1,
                ),
            ).toBe(true),
        );
        expect(result.current.capturedCoords).toBe(points);
        expect(guardReads).toBeGreaterThan(1);
    });

    it('recovers only valid session-backed trace state', () => {
        sessionStorage.setItem(
            key(keys.pins),
            JSON.stringify([
                { lat: -26.8, lon: 153.1 },
                { lat: 91, lon: 153.2 },
            ]),
        );
        sessionStorage.setItem(key(keys.departureMs), String(Date.now() + 60_000));
        sessionStorage.setItem(key(keys.name), 'Mooloolaba - Noosa');
        sessionStorage.setItem(key(keys.autoName), 'Mooloolaba - Noosa');
        sessionStorage.setItem(
            key(keys.legAnchor),
            JSON.stringify({
                tripId: 'trip-1',
                ordinal: 2,
                fromName: 'Mooloolaba',
                anchor: { lat: -26.7, lon: 153.1 },
            }),
        );
        sessionStorage.setItem(key(keys.origin), JSON.stringify({ lat: -26.8, lon: 153.1, name: 'Mooloolaba' }));
        sessionStorage.setItem(key(keys.destination), JSON.stringify({ lat: -26.7, lon: 153.2 }));

        const { result } = renderHook(() => useTraceDraft());

        expect(result.current.capturedCoords).toEqual([{ lat: -26.8, lon: 153.1 }]);
        expect(result.current.departureMs).toBeGreaterThan(Date.now());
        expect(result.current.traceName).toBe('Mooloolaba - Noosa');
        expect(result.current.lastAutoNameRef.current).toBe('Mooloolaba - Noosa');
        expect(result.current.legAnchor?.ordinal).toBe(2);
        expect(result.current.traceOrigin?.name).toBe('Mooloolaba');
        expect(result.current.traceDest).toBeNull();
    });

    it('persists changes as a single per-tab draft', () => {
        const { result } = renderHook(() => useTraceDraft());
        const anchor = { tripId: 'trip-2', ordinal: 3, fromName: 'Noosa', anchor: { lat: -26.4, lon: 153.1 } };

        act(() => {
            result.current.setCapturedCoords([{ lat: -26.5, lon: 153.1 }]);
            result.current.setDepartureMs(1_900_000_000_000);
            result.current.setTraceName('Noosa - Hervey Bay');
            result.current.lastAutoNameRef.current = 'Noosa - Hervey Bay';
            result.current.setLegAnchor(anchor);
            result.current.setTraceOrigin({ lat: -26.5, lon: 153.1, name: 'Noosa' });
            result.current.setTraceDest({ lat: -25.3, lon: 152.9, name: 'Hervey Bay' });
        });

        expect(JSON.parse(sessionStorage.getItem(key(keys.pins)) ?? 'null')).toEqual([{ lat: -26.5, lon: 153.1 }]);
        expect(sessionStorage.getItem(key(keys.departureMs))).toBe('1900000000000');
        expect(sessionStorage.getItem(key(keys.name))).toBe('Noosa - Hervey Bay');
        expect(JSON.parse(sessionStorage.getItem(key(keys.legAnchor)) ?? 'null')).toEqual(anchor);
        expect(JSON.parse(sessionStorage.getItem(key(keys.origin)) ?? 'null')).toMatchObject({ name: 'Noosa' });
        expect(JSON.parse(sessionStorage.getItem(key(keys.destination)) ?? 'null')).toMatchObject({
            name: 'Hervey Bay',
        });
    });

    it('switches synchronously to B and rejects setters captured by A', () => {
        const accountAScope = getAuthIdentityScope();
        sessionStorage.setItem(authScopedStorageKey(keys.name, accountAScope), 'Account A private route');
        const accountBScope = setAuthIdentityScope('account-b');
        sessionStorage.setItem(authScopedStorageKey(keys.name, accountBScope), 'Account B route');
        setAuthIdentityScope('account-a');

        const { result } = renderHook(() => useTraceDraft());
        expect(result.current.traceName).toBe('Account A private route');
        const staleSetName = result.current.setTraceName;

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(result.current.traceName).toBe('Account B route');

        act(() => staleSetName('A late overwrite'));
        expect(result.current.traceName).toBe('Account B route');
        expect(sessionStorage.getItem(authScopedStorageKey(keys.name, accountAScope))).toBe('Account A private route');
        expect(sessionStorage.getItem(authScopedStorageKey(keys.name, accountBScope))).toBe('Account B route');
    });

    it('reverses geometry, endpoint frame and generated name together, including persistence', () => {
        const { result } = renderHook(() => useTraceDraft());
        const from = { lat: -21.1, lon: 149.2, name: 'Mackay Harbour' };
        const to = { lat: -20.2, lon: 148.8, name: 'Whitsundays' };
        act(() => {
            result.current.setCapturedCoords([from, to]);
            result.current.setTraceName('Mackay Harbour → Whitsundays');
            result.current.lastAutoNameRef.current = 'Mackay Harbour → Whitsundays';
            result.current.setTraceOrigin(from);
            result.current.setTraceDest(to);
        });
        act(() => result.current.reverseDirection());
        expect(result.current.capturedCoords).toEqual([to, from]);
        expect(result.current.traceName).toBe('Whitsundays → Mackay Harbour');
        expect(result.current.lastAutoNameRef.current).toBe('Whitsundays → Mackay Harbour');
        expect(result.current.traceOrigin).toEqual(to);
        expect(result.current.traceDest).toEqual(from);
        expect(sessionStorage.getItem(key(keys.name))).toBe('Whitsundays → Mackay Harbour');
        expect(JSON.parse(sessionStorage.getItem(key(keys.origin))!)).toEqual(to);
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Mackay Harbour → Whitsundays');
        expect(result.current.capturedCoords).toEqual([from, to]);
    });

    it('preserves custom titles and refuses to reverse locked trip legs', () => {
        const { result } = renderHook(() => useTraceDraft());
        const points = [
            { lat: -21.1, lon: 149.2 },
            { lat: -20.2, lon: 148.8 },
        ];
        act(() => {
            result.current.setCapturedCoords(points);
            result.current.setTraceName('Our winter holiday');
        });
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Our winter holiday');
        expect(result.current.capturedCoords).toEqual([...points].reverse());
        act(() => result.current.setLegAnchor({ tripId: 'trip', ordinal: 2, fromName: 'Port', anchor: points[1] }));
        act(() => result.current.reverseDirection());
        expect(result.current.capturedCoords).toEqual([...points].reverse());
    });

    it('rejects a reverse action captured by a previous account without changing the new account auto-name', () => {
        const { result } = renderHook(() => useTraceDraft());
        act(() =>
            result.current.setCapturedCoords([
                { lat: -21, lon: 149 },
                { lat: -20, lon: 148 },
            ]),
        );
        const staleReverse = result.current.reverseDirection;
        act(() => setAuthIdentityScope('account-b'));
        act(() => {
            result.current.setTraceName('B origin → B destination');
            result.current.lastAutoNameRef.current = 'B origin → B destination';
        });
        act(() => staleReverse());
        expect(result.current.traceName).toBe('B origin → B destination');
        expect(result.current.lastAutoNameRef.current).toBe('B origin → B destination');
    });

    it('strips the trip badge when an opened leg or passage is reversed (2026-10-07)', () => {
        const { result } = renderHook(() => useTraceDraft());
        act(() => {
            result.current.setCapturedCoords([BAY_POINT, MIDWAY, SANDY_COVE]);
            result.current.setTraceName('Bay Point - Sandy Cove (2nd Leg)');
        });
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Sandy Cove - Bay Point');
        act(() => result.current.setTraceName('Harbour - Cape Grey (Passage)'));
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Cape Grey - Harbour');
        act(() => result.current.setTraceName('Bay run (2nd Leg)'));
        act(() => result.current.reverseDirection());
        expect(result.current.traceName).toBe('Bay run');
    });

    it('marks a reversed draft with where it came from, until it is reversed back', () => {
        const { result } = renderHook(() => useTraceDraft());
        act(() => {
            result.current.setCapturedCoords([BAY_POINT, MIDWAY, SANDY_COVE]);
            result.current.setTraceName('Bay Point - Sandy Cove (2nd Leg)');
        });
        act(() => result.current.reverseDirection('Bay Point - Sandy Cove (Leg 2)'));
        expect(result.current.reversedFrom).toEqual({ label: 'Bay Point - Sandy Cove (Leg 2)', end: BAY_POINT });
        expect(JSON.parse(sessionStorage.getItem(key(keys.reversedFrom))!)).toEqual(result.current.reversedFrom);
        act(() => result.current.reverseDirection());
        expect(result.current.reversedFrom).toBeNull();
        // A draft with no name and no source still carries the warning.
        act(() => result.current.setTraceName(''));
        act(() => result.current.reverseDirection());
        expect(result.current.reversedFrom?.label).toBe('the outbound line');
    });

    it('keeps the return-trip cursor and reversal mark per account, and drops damaged ones', () => {
        const accountA = getAuthIdentityScope();
        sessionStorage.setItem(key(keys.returnPlan), JSON.stringify(PLAN));
        sessionStorage.setItem(key(keys.reversedFrom), JSON.stringify({ label: 'Leg 2', end: BAY_POINT }));
        const { result } = renderHook(() => useTraceDraft());
        expect(result.current.returnPlan).toEqual(PLAN);
        expect(result.current.reversedFrom).toEqual({ label: 'Leg 2', end: BAY_POINT });

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(result.current.returnPlan).toBeNull();
        expect(result.current.reversedFrom).toBeNull();
        expect(JSON.parse(sessionStorage.getItem(authScopedStorageKey(keys.returnPlan, accountA))!)).toEqual(PLAN);

        sessionStorage.setItem(key(keys.returnPlan), JSON.stringify({ ...PLAN, nextIndex: 9 }));
        const { result: reloaded } = renderHook(() => useTraceDraft());
        expect(reloaded.current.returnPlan).toBeNull();
    });

    it('fills a locked-start slot with a saved leg reversed — and only with a locked start', () => {
        const { result } = renderHook(() => useTraceDraft());
        const source = {
            id: 'out-2',
            name: 'Bay Point - Sandy Cove (2nd Leg)',
            createdAt: '2026-10-01T00:00:00.000Z',
            points: [BAY_POINT, MIDWAY, SANDY_COVE],
            tripId: 'trip-out',
            legOrdinal: 2,
        };
        act(() => result.current.setCapturedCoords([SANDY_COVE]));
        let filled = true;
        act(() => {
            filled = result.current.fillSlotWithReversed(source);
        });
        expect(filled).toBe(false);
        expect(result.current.capturedCoords).toEqual([SANDY_COVE]);

        const seed = { tripId: 'ret-1', ordinal: 2, fromName: 'Sandy Cove', anchor: { lat: -29.8001, lon: 160.2 } };
        act(() => result.current.setLegAnchor(seed));
        act(() => result.current.setReturnPlan({ ...PLAN, chainFromId: null }));
        act(() => {
            filled = result.current.fillSlotWithReversed(source);
        });
        expect(filled).toBe(true);
        expect(result.current.capturedCoords).toEqual([seed.anchor, MIDWAY, BAY_POINT]);
        expect(result.current.traceName).toBe('Sandy Cove - Bay Point');
        // The flipped name is the skipper's own words, not ours to re-geocode.
        expect(result.current.lastAutoNameRef.current).toBe('');
        expect(result.current.legAnchor).toEqual(seed);
        expect(result.current.reversedFrom).toEqual({ label: 'Bay Point - Sandy Cove (Leg 2)', end: BAY_POINT });
        expect(result.current.returnPlan).toEqual(PLAN);
        // The locked leg itself still never flips.
        act(() => result.current.reverseDirection());
        expect(result.current.capturedCoords).toEqual([seed.anchor, MIDWAY, BAY_POINT]);
    });

    it('declaring another route ends the return-trip flow and its note', () => {
        sessionStorage.setItem(key(keys.returnPlan), JSON.stringify(PLAN));
        sessionStorage.setItem(key(keys.reversedFrom), JSON.stringify({ label: 'Leg 2', end: BAY_POINT }));
        const { result } = renderHook(() => useTraceDraft());
        act(() => result.current.setLegAnchor(null));
        expect(result.current.returnPlan).toBeNull();
        expect(result.current.reversedFrom).toBeNull();
        expect(JSON.parse(sessionStorage.getItem(key(keys.returnPlan))!)).toBeNull();

        act(() => result.current.setReturnPlan(PLAN));
        act(() => result.current.clearReturnContext());
        expect(result.current.returnPlan).toBeNull();
    });
});

// 127-PYD-3: a Plan Your Day frame (her start and the stop, "Plot by hand") must never bring back the
// straight bearing hint, not after a reload or a WebContent jetsam either, so its kind is kept beside
// the frame in sessionStorage; and a routed line from Plan Your Day says where it came from (127-C-b reads
// it). Fictional places on the Brittany coast.
describe('useTraceDraft: the frame kind and where the line came from (127-PYD-3)', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });
    const key = (base: string) => authScopedStorageKey(base, getAuthIdentityScope());
    const PORT = { lat: 47.7408, lon: -3.3627, name: 'Fixture Port' };
    const ANSE = { lat: 47.6512, lon: -3.4968, name: 'Fixture Anse' };

    function framed(kind: 'course' | 'day-plan') {
        const hook = renderHook(() => useTraceDraft());
        act(() => {
            hook.result.current.setTraceOrigin(PORT);
            hook.result.current.setTraceDest(ANSE);
            hook.result.current.setTraceFrameKind(kind);
        });
        return hook;
    }

    it('a day-plan frame round-trips through sessionStorage with its kind: after a reload the hint stays off', () => {
        const first = framed('day-plan');
        expect(first.result.current.traceFrameKind).toBe('day-plan');
        expect(sessionStorage.getItem(key(keys.frameKind))).toBe('day-plan');
        first.unmount();
        // A fresh mount reads the draft again, as a reload or a jetsam does.
        const { result } = renderHook(() => useTraceDraft());
        expect(result.current.traceDest).toEqual(ANSE);
        expect(result.current.traceFrameKind).toBe('day-plan');
    });

    it('a stored frame with no kind reads as day-plan (fail closed); no frame, no kind', () => {
        sessionStorage.setItem(key(keys.origin), JSON.stringify(PORT));
        sessionStorage.setItem(key(keys.destination), JSON.stringify(ANSE));
        expect(renderHook(() => useTraceDraft()).result.current.traceFrameKind).toBe('day-plan');
        sessionStorage.setItem(key(keys.frameKind), 'something else');
        expect(renderHook(() => useTraceDraft()).result.current.traceFrameKind).toBe('day-plan');
        sessionStorage.clear();
        sessionStorage.setItem(key(keys.frameKind), 'course');
        expect(renderHook(() => useTraceDraft()).result.current.traceFrameKind).toBeNull();
    });

    it("the course frame reads back 'course', and reversing keeps the kind", () => {
        const first = framed('course');
        act(() => first.result.current.setCapturedCoords([PORT, ANSE]));
        act(() => first.result.current.reverseDirection());
        expect(first.result.current.traceDest).toEqual(PORT);
        expect(first.result.current.traceFrameKind).toBe('course');
        first.unmount();
        expect(renderHook(() => useTraceDraft()).result.current.traceFrameKind).toBe('course');
    });

    it('every path that clears the frame clears its kind, setTraceDest(null) from MapHub included', () => {
        const a = framed('day-plan');
        act(() => {
            a.result.current.setTraceOrigin(null);
            a.result.current.setTraceDest(null);
        });
        expect(a.result.current.traceFrameKind).toBeNull();
        expect(sessionStorage.getItem(key(keys.frameKind))).toBe('');
        a.unmount();

        const anchor = {
            tripId: 'trip-b',
            ordinal: 2,
            fromName: 'Fixture Port',
            anchor: { lat: PORT.lat, lon: PORT.lon },
        };
        const b = framed('day-plan');
        act(() => b.result.current.setLegAnchor(anchor));
        const leg = {
            id: 'saved-leg',
            name: 'Fixture Anse - Fixture Port',
            createdAt: '2026-10-01T00:00:00.000Z',
            points: [ANSE, { lat: PORT.lat, lon: PORT.lon }],
        };
        let filled = false;
        act(() => {
            filled = b.result.current.fillSlotWithReversed(leg);
        });
        expect(filled).toBe(true);
        expect(b.result.current.traceDest).toBeNull();
        expect(b.result.current.traceFrameKind).toBeNull();
        b.unmount();

        const c = framed('day-plan');
        act(
            () =>
                void c.result.current.openReversedLeg({
                    points: [ANSE, PORT],
                    name: 'Fixture Anse - Fixture Port',
                    legAnchor: null,
                    reversedFrom: null,
                    returnPlan: null,
                }),
        );
        expect(c.result.current.traceFrameKind).toBeNull();
    });

    it('a routed line from Plan Your Day keeps saying so through a reload and a pin move; a new route or a clear ends it', () => {
        const first = renderHook(() => useTraceDraft());
        act(() => {
            first.result.current.setLegAnchor(null);
            first.result.current.setCapturedCoords([PORT, { lat: 47.7, lon: -3.42 }, ANSE]);
            first.result.current.setDraftSource('day-plan-route');
        });
        expect(sessionStorage.getItem(key(keys.source))).toBe('day-plan-route');
        first.unmount();
        const { result } = renderHook(() => useTraceDraft());
        expect(result.current.draftSource).toBe('day-plan-route');
        // Moving a pin: the line still came from the router.
        act(() =>
            result.current.setCapturedCoords((pins) => pins.map((p, i) => (i === 1 ? { lat: 47.69, lon: -3.43 } : p))),
        );
        expect(result.current.draftSource).toBe('day-plan-route');
        act(() => result.current.reverseDirection());
        expect(result.current.draftSource).toBe('day-plan-route');
        // Another route declared (every door calls setLegAnchor).
        act(() => result.current.setLegAnchor(null));
        expect(result.current.draftSource).toBeNull();
        expect(sessionStorage.getItem(key(keys.source))).toBe('');
        // Clear (no locked start) ends it too.
        act(() => result.current.setDraftSource('day-plan-route'));
        act(() => result.current.clearReturnContext());
        expect(result.current.draftSource).toBeNull();
        // A damaged value reads as nothing.
        sessionStorage.setItem(key(keys.source), 'elsewhere');
        expect(renderHook(() => useTraceDraft()).result.current.draftSource).toBeNull();
    });
});
