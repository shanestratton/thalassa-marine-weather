/**
 * Grocery List rows in Ship's Stores (131-B14; binder audit STORES-12).
 *
 * A Grocery List buy put 'Added from Grocery List purchase <uuid>' in the
 * row's notes, and Stores showed it. The line stays (un-ticking finds the row
 * by it), but Stores reads it as a chip and shows no notes for it.
 */
import { describe, expect, it } from 'vitest';
import {
    GROCERY_BOUGHT_PREFIX,
    GROCERY_CHIP,
    GROCERY_RETAINED_PREFIX,
    groceryProvenance,
    storesNotes,
} from '../services/vessel/storesProvenance';

const PURCHASE = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

describe('a row the Grocery List made', () => {
    it('is told by its machine line, bought or retained after an un-tick', () => {
        expect(groceryProvenance({ description: `${GROCERY_BOUGHT_PREFIX}${PURCHASE}` })).toBe('bought');
        expect(groceryProvenance({ description: `${GROCERY_RETAINED_PREFIX}${PURCHASE}` })).toBe('retained');
        expect(groceryProvenance({ description: 'Bought in Nouméa, 2 tins dented' })).toBeNull();
        expect(groceryProvenance({ description: null })).toBeNull();
    });

    it('shows a chip in plain words, and no notes with an id in them', () => {
        expect(GROCERY_CHIP.bought).toBe('Bought on the Grocery List');
        expect(storesNotes({ description: `${GROCERY_BOUGHT_PREFIX}${PURCHASE}` })).toBeNull();
        expect(storesNotes({ description: `${GROCERY_RETAINED_PREFIX}${PURCHASE}` })).toBeNull();
        expect(storesNotes({ description: '  Part no. 2010PM-OR  ' })).toBe('Part no. 2010PM-OR');
        expect(storesNotes({ description: '' })).toBeNull();
    });

    it('uses the very lines the server writes (atomic purchase trigger)', () => {
        expect(GROCERY_BOUGHT_PREFIX).toBe('Added from Grocery List purchase ');
        expect(GROCERY_RETAINED_PREFIX).toBe('Stock retained after undoing Grocery List purchase ');
    });
});
