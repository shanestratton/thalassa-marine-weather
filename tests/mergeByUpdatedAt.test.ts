/**
 * Tests for mergeByUpdatedAt — the newest-wins merge that fixed the
 * stuck "1 Overdue" maintenance badge. These lock in the exact
 * regression: a fresh LOCAL record must beat a stale CLOUD record of
 * the same id, regardless of source order.
 */
import { describe, expect, it } from 'vitest';
import { mergeByUpdatedAt } from '../utils/mergeByUpdatedAt';

interface Row {
    id: string;
    updated_at?: string | null;
    label?: string;
}

const T1 = '2026-05-20T00:00:00.000Z'; // older
const T2 = '2026-05-20T01:00:00.000Z'; // newer

describe('mergeByUpdatedAt', () => {
    it('newer record wins on id conflict (local-fresh beats cloud-stale)', () => {
        const local: Row[] = [{ id: 'a', updated_at: T2, label: 'fresh-local' }];
        const cloud: Row[] = [{ id: 'a', updated_at: T1, label: 'stale-cloud' }];
        // Source order mirrors VesselHub: local first, cloud second —
        // this is the order that USED to lose (cloud overwrote local).
        const merged = mergeByUpdatedAt(local, cloud);
        expect(merged).toHaveLength(1);
        expect(merged[0].label).toBe('fresh-local');
    });

    it('newer record wins regardless of source order (cloud-fresh beats local-stale)', () => {
        const local: Row[] = [{ id: 'a', updated_at: T1, label: 'stale-local' }];
        const cloud: Row[] = [{ id: 'a', updated_at: T2, label: 'fresh-cloud' }];
        expect(mergeByUpdatedAt(local, cloud)[0].label).toBe('fresh-cloud');
        // Flip the argument order — winner must not change.
        expect(mergeByUpdatedAt(cloud, local)[0].label).toBe('fresh-cloud');
    });

    it('unions disjoint ids from all sources', () => {
        const local: Row[] = [{ id: 'a', updated_at: T1 }];
        const cloud: Row[] = [{ id: 'b', updated_at: T1 }];
        const merged = mergeByUpdatedAt(local, cloud);
        expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
    });

    it('a record WITH a timestamp beats one missing updated_at', () => {
        const withTs: Row[] = [{ id: 'a', updated_at: T1, label: 'has-ts' }];
        const noTs: Row[] = [{ id: 'a', label: 'no-ts' }];
        expect(mergeByUpdatedAt(noTs, withTs)[0].label).toBe('has-ts');
        expect(mergeByUpdatedAt(withTs, noTs)[0].label).toBe('has-ts');
    });

    it('equal timestamps — later source in the argument list wins (stable, last-write)', () => {
        const a: Row[] = [{ id: 'x', updated_at: T1, label: 'first' }];
        const b: Row[] = [{ id: 'x', updated_at: T1, label: 'second' }];
        // >= comparison means a same-timestamp record from a later
        // source replaces the earlier one. Deterministic, documented.
        expect(mergeByUpdatedAt(a, b)[0].label).toBe('second');
    });

    it('tolerates invalid / malformed updated_at by treating it as oldest', () => {
        const good: Row[] = [{ id: 'a', updated_at: T1, label: 'good' }];
        const garbage: Row[] = [{ id: 'a', updated_at: 'not-a-date', label: 'garbage' }];
        expect(mergeByUpdatedAt(garbage, good)[0].label).toBe('good');
    });

    it('skips records without a string id', () => {
        const rows = [{ id: 'a', updated_at: T1 }, { updated_at: T2 } as Row, null as unknown as Row];
        const merged = mergeByUpdatedAt(rows);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('a');
    });

    it('regression: a serviced maintenance task drops out of the overdue count', () => {
        // Reproduces the exact R&M bug. A task is overdue in the cloud
        // (next_due in the past, older updated_at). The user services
        // it locally — next_due advances to the future, updated_at
        // bumps. The merged view must reflect the FRESH local task so
        // the overdue filter no longer counts it.
        const past = '2026-05-01T00:00:00.000Z';
        const future = '2026-09-01T00:00:00.000Z';
        type Task = Row & { is_active: boolean; next_due_date: string };
        const cloud: Task[] = [{ id: 't1', updated_at: T1, is_active: true, next_due_date: past }];
        const local: Task[] = [{ id: 't1', updated_at: T2, is_active: true, next_due_date: future }];

        const merged = mergeByUpdatedAt(local, cloud);
        const now = Date.parse('2026-06-01T00:00:00.000Z');
        const overdue = merged.filter(
            (t) => t.is_active && t.next_due_date && Date.parse(t.next_due_date) < now,
        ).length;
        expect(overdue).toBe(0); // was 1 under the old "cloud wins" merge
    });
});
