import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: { rpc: h.rpc },
}));
import { communityLanesNear } from '../services/communityRoutes';

beforeEach(() => h.rpc.mockReset());
describe('approved community prior snapshots', () => {
    it('refreshes the approval boundary even when the display ghost cache still contains a lane', async () => {
        const bbox: [number, number, number, number] = [152, -28, 154, -26];
        h.rpc.mockResolvedValueOnce({
            data: [
                {
                    id: 'old',
                    name: 'lane',
                    points: [
                        [-27, 153],
                        [-27.01, 153],
                    ],
                    draft_m: 2,
                },
            ],
        });
        expect(await communityLanesNear(bbox)).toHaveLength(1);
        h.rpc.mockResolvedValueOnce({ data: [] });
        expect(await communityLanesNear(bbox)).toHaveLength(1);
        expect(h.rpc).toHaveBeenCalledTimes(1);
        expect(await communityLanesNear(bbox, { fresh: true })).toEqual([]);
        expect(h.rpc).toHaveBeenCalledTimes(2);
        expect(h.rpc).toHaveBeenLastCalledWith('traced_routes_near', { w: 152, s: -28, e: 154, n: -26 });
    });
    it('rejects a malformed interior point whole rather than joining the remaining ends', async () => {
        h.rpc.mockResolvedValue({
            data: [
                {
                    id: 'bad',
                    name: 'lane',
                    points: [
                        [-27, 153],
                        ['bad', 153],
                        [-27.01, 153],
                    ],
                    draft_m: 2,
                },
            ],
        });
        expect(await communityLanesNear([150, -29, 155, -25], { fresh: true })).toEqual([]);
    });
});
