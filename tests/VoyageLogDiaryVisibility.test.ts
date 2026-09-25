import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'supabase/functions/voyage-log/index.ts'), 'utf8');

function diaryQuerySource(): string {
    const start = source.indexOf('const diarySelect =');
    const end = source.indexOf('if (entriesRes.error)', start);
    return source.slice(start, end);
}

describe('public Voyage Log diary visibility', () => {
    /** Both the paginated overview and selected-track preview execute this fenced query builder. */
    const awaitedDiaryChain = (): string => {
        const src = diaryQuerySource();
        const start = src.indexOf('return diaryQuery');
        const end = src.indexOf('const entriesRes =', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(src).toContain('makeDiaryQuery().range(from, to)');
        expect(src).toContain('makeDiaryQuery().limit(MAX_ENTRIES)');
        return src.slice(start, end);
    };

    it('shows only the owner’s explicitly published entries for a selected recorded track', () => {
        const diaryQuery = diaryQuerySource();
        const selectedTrackBranch = diaryQuery.slice(
            diaryQuery.indexOf('let diaryQuery = selectedTrackId'),
            diaryQuery.indexOf(": supabase.from('diary_entries')"),
        );

        expect(selectedTrackBranch).toContain(".eq('user_id', ownerId)");
        expect(selectedTrackBranch).toContain(".eq('voyage_id', selectedTrackId)");
        expect(awaitedDiaryChain()).toContain(".eq('is_public', true)");
        expect(diaryQuery).toContain("diaryQuery = diaryQuery.eq('boat_id', boatId)");
        expect(selectedTrackBranch.indexOf(".eq('voyage_id', selectedTrackId)")).toBeLessThan(
            diaryQuery.indexOf('.limit(MAX_ENTRIES)'),
        );
    });

    it('preserves the all-diary and legacy catch-all for explicitly published unassigned entries', () => {
        const diaryQuery = diaryQuerySource();
        const catchAllBranch = diaryQuery.slice(
            diaryQuery.indexOf(": supabase.from('diary_entries')"),
            diaryQuery.indexOf('if (boatId) diaryQuery'),
        );

        expect(catchAllBranch).toMatch(/\.in\(\s*'user_id',\s*entryUserIds,?\s*\)/);
        expect(awaitedDiaryChain()).toContain(".eq('is_public', true)");
        expect(catchAllBranch).not.toMatch(/\.(?:eq|neq|not)\('voyage_id'/);
    });

    it('returns the diary voyage id so public clients can retain selection context', () => {
        const entryAssembly = source.slice(source.indexOf('const entries ='), source.indexOf('// Named waypoints'));

        expect(entryAssembly).toContain('voyage_id: (e.voyage_id as string | null) ?? null');
        expect(entryAssembly).not.toContain('hiddenVoyageIds.has');
        expect(entryAssembly).not.toContain('landVoyageIds.has');
    });
});
