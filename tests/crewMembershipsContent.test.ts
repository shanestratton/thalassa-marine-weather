/**
 * Your memberships as content (2026-10-07 tidy-up): the Crew & Float Plan
 * page re-checks passage access when the rows change, not whenever a reload
 * hands back a new array with the same rows. Fictional people only.
 */
import { describe, expect, it } from 'vitest';
import type { CrewMember } from '../services/CrewService';
import {
    appendRowsNotListed,
    keepMembershipsIfUnchanged,
    membershipsContentKey,
} from '../components/crewManagement/membershipsContent';

const row = (id: string, overrides: Partial<CrewMember> = {}): CrewMember => ({
    id,
    owner_id: 'skipper-1',
    crew_user_id: 'crew-user',
    crew_email: 'crew@example.com',
    owner_email: 'skipper-1@example.com',
    shared_registers: ['stores', 'passage_chat'],
    permissions: {} as CrewMember['permissions'],
    status: 'accepted',
    role: 'deckhand',
    voyage_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
});

describe('membershipsContentKey', () => {
    it('reads the same for the same rows in a fresh array, in any order', () => {
        const rows = [row('row-a'), row('row-b')];
        expect(membershipsContentKey([row('row-a'), row('row-b')])).toBe(membershipsContentKey(rows));
        // An Undo puts a row back at the end.
        expect(membershipsContentKey([row('row-b'), row('row-a')])).toBe(membershipsContentKey(rows));
    });

    it('changes when a row comes or goes, or any field of one changes', () => {
        const key = membershipsContentKey([row('row-a')]);
        expect(membershipsContentKey([])).not.toBe(key);
        expect(membershipsContentKey([row('row-a'), row('row-b')])).not.toBe(key);
        expect(membershipsContentKey([row('row-a', { status: 'pending' })])).not.toBe(key);
        expect(membershipsContentKey([row('row-a', { voyage_id: 'voyage-1' })])).not.toBe(key);
        expect(membershipsContentKey([row('row-a', { shared_registers: ['stores'] })])).not.toBe(key);
        expect(membershipsContentKey([row('row-a', { role: 'co-skipper' })])).not.toBe(key);
        expect(membershipsContentKey([row('row-a', { updated_at: '2026-10-07T00:00:00.000Z' })])).not.toBe(key);
    });
});

describe('keepMembershipsIfUnchanged', () => {
    it('keeps the array it has when a reload brings back exactly the same rows', () => {
        const previous = [row('row-a'), row('row-b')];
        expect(keepMembershipsIfUnchanged(previous, [row('row-a'), row('row-b')])).toBe(previous);
    });

    it('takes the new array when anything differs, order included', () => {
        const previous = [row('row-a'), row('row-b')];
        const reordered = [row('row-b'), row('row-a')];
        expect(keepMembershipsIfUnchanged(previous, reordered)).toBe(reordered);
        const changed = [row('row-a'), row('row-b', { owner_email: 'renamed@example.com' })];
        expect(keepMembershipsIfUnchanged(previous, changed)).toBe(changed);
        const empty: CrewMember[] = [];
        expect(keepMembershipsIfUnchanged(previous, empty)).toBe(empty);
    });
});

describe('appendRowsNotListed', () => {
    it('puts back only the rows the list does not already hold', () => {
        // An Undo after a reload had already brought the row back: one card, not two.
        const list = [row('row-a'), row('row-b')];
        expect(appendRowsNotListed(list, [row('row-b'), row('row-c')]).map((r) => r.id)).toEqual([
            'row-a',
            'row-b',
            'row-c',
        ]);
    });

    it('keeps the same array when every row is already there', () => {
        const list = [row('row-a')];
        expect(appendRowsNotListed(list, [row('row-a')])).toBe(list);
        expect(appendRowsNotListed(list, [])).toBe(list);
    });
});
