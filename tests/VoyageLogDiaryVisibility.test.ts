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
    /**
     * The awaited query chain only — from `await diaryQuery` to the row cap.
     *
     * The public-only filter used to be asserted as the literal string
     * "diaryQuery.eq('is_public', true)", which broke the moment the call was
     * chained onto the next line instead of written inline. The filter itself
     * never changed. What actually matters is that `.eq('is_public', true)`
     * lands INSIDE the chain that gets awaited — so that is what we assert,
     * tolerant of formatting but still red if the filter is deleted or hoisted
     * out of the executed query.
     */
    const awaitedDiaryChain = (): string => {
        const src = diaryQuerySource();
        const start = src.indexOf('const entriesRes = await diaryQuery');
        const end = src.indexOf('.limit(MAX_ENTRIES)', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
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

        expect(catchAllBranch).toContain(".in('user_id', entryUserIds)");
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
