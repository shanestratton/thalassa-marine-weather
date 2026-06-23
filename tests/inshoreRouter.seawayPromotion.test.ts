import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get: async () => ({ status: 599, data: null }) } }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: async () => [], listCells: () => [] }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: async () => null }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => false, baseUrl: 'http://test.invalid' },
}));
vi.mock('../services/OsmRouteOverlayService', () => ({ getOsmRouteOverlay: async () => null }));

import { seawayPromotionBlockReason } from '../services/InshoreRouter';

describe('Seaway promotion guard', () => {
    it('keeps engine tier routes when a canal/marina red mask is present', () => {
        expect(seawayPromotionBlockReason({ canalMask: [false, true, false] })).toBe(
            'tier-1 canal/marina mask present',
        );
    });

    it('keeps engine tier routes when the Newport egress gate chain is present', () => {
        expect(
            seawayPromotionBlockReason({
                debug: { threeTier: 'egress-channel×4 → tier2:chain×4 | tier3:passthrough +canalsnap' },
            }),
        ).toBe('engine egress-channel gate chain present');
    });

    it('allows graph promotion for plain inshore routes without a protected tier contract', () => {
        expect(seawayPromotionBlockReason({ debug: { threeTier: 'tier3:passthrough' } })).toBeNull();
    });
});
