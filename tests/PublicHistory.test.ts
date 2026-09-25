import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    isRetiredPublicLiveVoyage,
    mapPublicHistory,
    publicOverviewPointBudget,
    readCompletePublicPages,
} from '../supabase/functions/_shared/public-history';

describe('complete public cruising history', () => {
    it('exhausts more than 5000 rows even when the server silently clamps pages below the requested size', async () => {
        const rows = Array.from({ length: 12_037 }, (_, index) => ({ id: `row-${index}` }));
        const readPage = vi.fn(async (from: number, to: number) => ({
            data: rows.slice(from, Math.min(from + 317, to + 1)),
            error: null,
        }));
        const result = await readCompletePublicPages(readPage, { maxRows: 20_000, key: (row) => row.id });
        expect(result).toEqual(rows);
        expect(readPage).toHaveBeenLastCalledWith(rows.length, rows.length + 999);
    });

    it('does not report a partial prefix as all history when a later page fails', async () => {
        const readPage = vi
            .fn()
            .mockResolvedValueOnce({ data: [{ id: 'first' }], error: null })
            .mockResolvedValueOnce({ data: null, error: new Error('network unavailable') });
        await expect(
            readCompletePublicPages(readPage, { maxRows: 10, key: (row: { id: string }) => row.id }),
        ).rejects.toThrow('completely');
    });

    it('rejects unavailable data and repeated identities rather than confusing either with an empty history', async () => {
        for (const response of [
            { data: null, error: null },
            { data: [{ id: 'same' }, { id: 'same' }], error: null },
            { data: [{ id: '' }], error: null },
        ]) {
            await expect(
                readCompletePublicPages(async () => response, { maxRows: 10, key: (row) => row.id }),
            ).rejects.toThrow();
        }
    });

    it('probes the envelope boundary and fails explicitly if more history exists', async () => {
        const exact = vi
            .fn()
            .mockResolvedValueOnce({ data: [{ id: '1' }, { id: '2' }], error: null })
            .mockResolvedValueOnce({ data: [], error: null });
        await expect(
            readCompletePublicPages(exact, { maxRows: 2, pageSize: 2, key: (row: { id: string }) => row.id }),
        ).resolves.toHaveLength(2);
        const truncated = vi
            .fn()
            .mockResolvedValueOnce({ data: [{ id: '1' }, { id: '2' }], error: null })
            .mockResolvedValueOnce({ data: [{ id: '3' }], error: null });
        await expect(
            readCompletePublicPages(truncated, { maxRows: 2, pageSize: 2, key: (row: { id: string }) => row.id }),
        ).rejects.toThrow('envelope');
    });

    it('limits concurrent work but retains every trip/post and its ordering', async () => {
        let active = 0;
        let maximum = 0;
        const result = await mapPublicHistory(
            Array.from({ length: 20 }, (_, index) => index),
            async (value) => {
                active += 1;
                maximum = Math.max(maximum, active);
                await Promise.resolve();
                active -= 1;
                return value * 2;
            },
        );
        expect(result).toEqual(Array.from({ length: 20 }, (_, index) => index * 2));
        expect(maximum).toBe(3);
    });

    it('allocates a fair overview budget without ever losing a trip endpoint', () => {
        expect(publicOverviewPointBudget(5, 10_000)).toBe(2000);
        expect(publicOverviewPointBudget(6000, 10_000)).toBe(2);
        expect(publicOverviewPointBudget(0, 10_000)).toBe(0);
    });

    it('does not revive a retired live shadow when its separate purge failed', () => {
        const retired = new Set(['archived-trip', 'deleted-trip', 'discarded-trip']);
        const liveRows = [
            { voyage_id: 'archived-trip' },
            { voyage_id: 'deleted-trip' },
            { voyage_id: ' discarded-trip ' },
            { voyage_id: 'new-trip' },
        ];
        expect(liveRows.filter((row) => !isRetiredPublicLiveVoyage(row.voyage_id, retired))).toEqual([
            { voyage_id: 'new-trip' },
        ]);
        expect(isRetiredPublicLiveVoyage(null, retired)).toBe(false);
    });
});

describe('public overview endpoint fences', () => {
    const source = readFileSync('supabase/functions/voyage-log/index.ts', 'utf8');

    it('reads each authorised actual trip within the publication window, then decimates per voyage', () => {
        expect(source).toContain("trips.filter((trip) => trip.kind === 'track')");
        expect(source).toContain('mapPublicHistory(overviewTrips');
        expect(source).toContain('voyageId: trip.id');
        expect(source).toContain('since: trackSince');
        expect(source).toContain('publicPointBudget: overviewPointBudget');
        expect(source).toContain('decimatePublicVoyages(selectedFullTrack, MAX_PUBLIC_TRACK_POINTS)');
        expect(source).not.toContain("const selectedFullTrack = tripSelection.mode === 'all-diary' ? []");
    });

    it('preserves privacy, scope, and real-track-only fences', () => {
        expect(source).toContain(".eq('user_id', ownerId)");
        expect(source).toContain("query = query.eq('boat_id', boatId)");
        expect(source).toContain(".or('archived.is.null,archived.eq.false')");
        expect(source).toContain('hiddenVoyageIds.has');
        expect(source).toContain(".startsWith('planned_')");
        expect(source).toContain("return diaryQuery.eq('is_public', true)");
        expect(source).toContain('readCompletePublicPages<PublicDiaryRow>');
        expect(source).toContain('makeDiaryQuery().range(from, to)');
    });

    it('reads retirement authority completely before live data and fences only live shadows, not restored history', () => {
        const retirement = source.slice(
            source.indexOf('const retiredLiveVoyageIds ='),
            source.indexOf('const landVoyageIds ='),
        );
        expect(retirement).toContain('await readCompletePublicPages');
        expect(retirement).toContain(".from('live_track_retirements')");
        expect(retirement).toContain(".eq('user_id', ownerId)");
        expect(retirement).toContain('.range(from, to)');
        expect(retirement).not.toContain('catch');
        expect(source.indexOf('const retiredLiveVoyageIds =')).toBeLessThan(source.indexOf('const fetchLiveTail ='));

        const liveTail = source.slice(source.indexOf('const fetchLiveTail ='), source.indexOf('const vesselRes ='));
        expect(liveTail).toContain(".eq('user_id', ownerId)");
        expect(liveTail).toContain("query = query.eq('boat_id', boatId)");
        expect(liveTail).toContain('!isRetiredPublicLiveVoyage(vid, retiredLiveVoyageIds)');
        const activeSeed = source.slice(
            source.indexOf('let activeRowVoyageId'),
            source.indexOf('const currentVoyageId ='),
        );
        expect(activeSeed).toContain('!isRetiredPublicLiveVoyage(id, retiredLiveVoyageIds)');

        // Retirement is permanent for the ephemeral shadow. It must not
        // hide durable history that the skipper explicitly restores later.
        const durableTrack = source.slice(
            source.indexOf('const fetchTrack ='),
            source.indexOf('const fetchLiveTail ='),
        );
        expect(durableTrack).not.toContain('retiredLiveVoyageIds');
    });

    it('carries waypoint voyage identity and coverage metadata without publishing a planned route in the overview', () => {
        const waypoints = source.slice(source.indexOf('const waypoints ='), source.indexOf('// ── Passage:'));
        expect(waypoints).toContain('voyage_id: (p.voyage_id as string | null) ?? null');
        expect(source).toMatch(/tripSelection\.mode !== 'all-diary' &&\s*\(!passage/);
        expect(source).toContain('history_since: trackSince');
        expect(source).toContain('complete: trackVisibilityReadable');
    });
});
