import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipLogEntry } from '../types/navigation';
const read = vi.hoisted(() => ({ remote: vi.fn(), pending: vi.fn() }));
vi.mock('../services/shiplog/VoyageSummary', () => ({ getVoyageEntries: read.remote }));
vi.mock('../services/shiplog/OfflineQueue', () => ({ getOfflineEntries: read.pending }));
import { setAuthIdentityScope, getAuthIdentityScope } from '../services/authIdentityScope';
import { readOwnTrackRoute } from '../services/routing/readOwnTrackRoute';
const entry = (i: number, more: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
    id: String(i),
    userId: 'a',
    voyageId: 'voyage-a',
    latitude: -27 + i * 0.0001,
    longitude: 153,
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    entryType: 'auto',
    source: 'device',
    isOnWater: true,
    positionFormatted: '',
    ...more,
});
beforeEach(() => {
    setAuthIdentityScope('a');
    read.remote.mockReset().mockResolvedValue([entry(0), entry(1), entry(2)]);
    read.pending.mockReset().mockResolvedValue([]);
});
describe('complete owner-only track projection', () => {
    it('requests complete archived history and merges the matching pending capture by operation id', async () => {
        read.pending.mockResolvedValue([entry(2, { clientOperationId: 'capture-2', latitude: -27.0005 }), entry(3)]);
        read.remote.mockResolvedValue([entry(0), entry(1), entry(2, { clientOperationId: 'capture-2' })]);
        const controller = new AbortController(),
            draft = await readOwnTrackRoute('voyage-a', getAuthIdentityScope(), controller.signal);
        expect(read.remote).toHaveBeenCalledWith(
            'voyage-a',
            true,
            expect.objectContaining({
                maxRows: 20_000,
                throwOnIncomplete: true,
                requireComplete: true,
                signal: controller.signal,
            }),
        );
        expect(draft.inputCount).toBe(4);
        expect(draft.points.at(-1)).toEqual({ lat: entry(3).latitude, lon: 153 });
    });
    it.each([
        { userId: 'b' },
        { voyageId: 'b' },
        { source: 'community_download' as const },
        { source: 'planned_route' as const },
        { isOnWater: false },
        { latitude: NaN },
    ])('rejects foreign, borrowed, land or damaged raw rows', async (patch) => {
        read.remote.mockResolvedValue([entry(0), entry(1, patch), entry(2)]);
        await expect(
            readOwnTrackRoute('voyage-a', getAuthIdentityScope(), new AbortController().signal),
        ).rejects.toThrow();
    });
    it('does not adopt a truncated or failed page as a shorter route', async () => {
        read.remote.mockRejectedValue(Error('Complete voyage history unavailable: row limit'));
        await expect(
            readOwnTrackRoute('voyage-a', getAuthIdentityScope(), new AbortController().signal),
        ).rejects.toThrow('Complete voyage');
    });
    it('rejects an account generation change after the read begins', async () => {
        read.remote.mockImplementation(async () => {
            setAuthIdentityScope('b');
            setAuthIdentityScope('a');
            return [entry(0), entry(1)];
        });
        await expect(
            readOwnTrackRoute('voyage-a', getAuthIdentityScope(), new AbortController().signal),
        ).rejects.toThrow('cancelled');
    });
});
