/**
 * The saved-routes running order, now shared by three surfaces.
 *
 * Shane 2026-08-27: "passage first. then the first leg, then the second leg.
 * then the day sail." 2026-08-30 he asked for that layout on the PLAN tab's
 * saved-routes modal and the cast-off "Following a route?" sheet as well —
 * three lists sorting routes three ways is how a skipper stops trusting any
 * of them.
 */
import { describe, expect, it } from 'vitest';
import { demoteOrphanLegs, orderSavedRouteRows, type SavedRoutePickerRow } from '../services/savedRouteOrder';

const row = (p: Partial<SavedRoutePickerRow> & { id: string }): SavedRoutePickerRow => ({
    name: p.id,
    detail: null,
    kind: 'standalone',
    groupKey: p.id,
    stamp: 0,
    ...p,
});

const ids = (rows: SavedRoutePickerRow[]) => rows.map((r) => r.id);

describe('running order', () => {
    it('puts a passage above its own legs, in leg order', () => {
        const out = orderSavedRouteRows([
            row({ id: 'leg2', kind: 'leg', groupKey: 't1', legOrdinal: 2, stamp: 10 }),
            row({ id: 'passage', kind: 'passage', groupKey: 't1', stamp: 10 }),
            row({ id: 'leg1', kind: 'leg', groupKey: 't1', legOrdinal: 1, stamp: 10 }),
        ]);
        expect(ids(out)).toEqual(['passage', 'leg1', 'leg2']);
    });

    it('orders groups by their NEWEST member, newest first', () => {
        const out = orderSavedRouteRows([
            row({ id: 'old', groupKey: 'a', stamp: 100 }),
            row({ id: 'newLeg', kind: 'leg', groupKey: 'b', legOrdinal: 1, stamp: 500 }),
            row({ id: 'newPassage', kind: 'passage', groupKey: 'b', stamp: 200 }),
        ]);
        // Group b wins on its newest member (500), even though its passage row
        // is older than group a's only row.
        expect(ids(out)).toEqual(['newPassage', 'newLeg', 'old']);
    });

    it('breaks a stamp tie deterministically, so the list cannot reshuffle', () => {
        // An unstable sort would let rows swap between renders under the
        // skipper's thumb.
        const input = [row({ id: 'b', groupKey: 'b', stamp: 7 }), row({ id: 'a', groupKey: 'a', stamp: 7 })];
        expect(ids(orderSavedRouteRows(input))).toEqual(['a', 'b']);
        expect(ids(orderSavedRouteRows([...input].reverse()))).toEqual(['a', 'b']);
    });

    it('puts a day sail after the legs of the same group', () => {
        const out = orderSavedRouteRows([
            row({ id: 'daysail', kind: 'standalone', groupKey: 't1', stamp: 5 }),
            row({ id: 'leg', kind: 'leg', groupKey: 't1', legOrdinal: 1, stamp: 5 }),
            row({ id: 'passage', kind: 'passage', groupKey: 't1', stamp: 5 }),
        ]);
        expect(ids(out)).toEqual(['passage', 'leg', 'daysail']);
    });

    it('does not mutate its input', () => {
        const input = [row({ id: 'b', stamp: 1 }), row({ id: 'a', stamp: 9 })];
        orderSavedRouteRows(input);
        expect(ids(input)).toEqual(['b', 'a']);
    });
});

describe('orphan legs', () => {
    it('demotes a leg whose passage is not in the list', () => {
        // A ↳ row under no passage is an arrow pointing at nothing. The first
        // draft of the tracer adapter emitted exactly this.
        const out = demoteOrphanLegs([row({ id: 'lonely', kind: 'leg', groupKey: 'missing', legOrdinal: 1 })]);
        expect(out[0].kind).toBe('standalone');
    });

    it('leaves a leg alone when its passage IS present', () => {
        const out = demoteOrphanLegs([
            row({ id: 'p', kind: 'passage', groupKey: 't1' }),
            row({ id: 'l', kind: 'leg', groupKey: 't1', legOrdinal: 1 }),
        ]);
        expect(out.map((r) => r.kind)).toEqual(['passage', 'leg']);
    });

    it('is generic over any orderable row, not just picker rows', () => {
        // The PLAN library sorts its OWN item type; converting to a common
        // shape and back would be a second place for the two to disagree.
        const items = [{ key: 'x', kind: 'leg' as const, groupKey: 'gone', stamp: 1 }];
        expect(demoteOrphanLegs(items)[0].kind).toBe('standalone');
        expect(orderSavedRouteRows(items)).toHaveLength(1);
    });
});
