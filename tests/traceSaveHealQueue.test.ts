/**
 * Moving leg N's arrival drags leg N+1's first pin with it (healTripChain),
 * which voids leg N+1's check. Build 124 (B4 trigger 3): the heal reports
 * WHICH leg it moved, and that leg is queued for a background re-check rather
 * than silently turning amber.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../services/traceBackgroundCheck', () => ({ enqueueTraceChecks: queue.enqueue }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { healTripChainDetailed, loadSavedTraces, saveTrace } from '../services/routeTracer';
import { commitTraceSave } from '../services/traceSave';

// Fictional: Chesapeake Bay, a two-leg trip (US).
const leg1 = [
    { lat: 38.977, lon: -76.483 },
    { lat: 38.87, lon: -76.38 },
];
const leg2 = [
    { lat: 38.87, lon: -76.38 },
    { lat: 38.785, lon: -76.222 },
];

describe('healTripChain reports the leg it moved, and that leg is queued', () => {
    beforeEach(() => {
        localStorage.clear();
        queue.enqueue.mockClear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('heal-owner');
    });

    const seedTrip = () => {
        const first = saveTrace('Annapolis - Thomas Point (1st Leg)', leg1).trace;
        saveTrace(first.name, leg1, { overwriteId: first.id, tripId: first.id, legOrdinal: 1 });
        const second = saveTrace('Thomas Point - St Michaels (2nd Leg)', leg2, {
            tripId: first.id,
            legOrdinal: 2,
        }).trace;
        return { first: loadSavedTraces().find((t) => t.id === first.id)!, second };
    };

    it('healTripChainDetailed returns the healed id and the old message', () => {
        const { first, second } = seedTrip();
        const moved = saveTrace(first.name, [leg1[0], { lat: 38.88, lon: -76.39 }], {
            overwriteId: first.id,
        }).trace;
        const healed = healTripChainDetailed(moved);
        expect(healed).toEqual({ healedId: second.id, message: `"${second.name}" start moved to match` });
        expect(loadSavedTraces().find((t) => t.id === second.id)?.points[0]).toEqual({ lat: 38.88, lon: -76.39 });
        expect(healTripChainDetailed(loadSavedTraces().find((t) => t.id === first.id)!)).toBeNull();
    });

    it('commitTraceSave hands the healed leg to the background re-check', () => {
        const { first, second } = seedTrip();
        const result = commitTraceSave({ kind: 'save', finalName: first.name, existing: first }, [
            leg1[0],
            { lat: 38.88, lon: -76.39 },
        ]);
        expect(result.healedId).toBe(second.id);
        expect(result.healed).toBe(`"${second.name}" start moved to match`);
        expect(queue.enqueue).toHaveBeenCalledWith([second.id], 'heal');
    });

    it('queues nothing when nothing moved', () => {
        const { first } = seedTrip();
        const result = commitTraceSave({ kind: 'save', finalName: first.name, existing: first }, leg1);
        expect(result.healedId).toBeNull();
        expect(queue.enqueue).not.toHaveBeenCalled();
    });
});
