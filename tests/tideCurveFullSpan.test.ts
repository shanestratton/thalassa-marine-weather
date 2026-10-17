import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/weather/api/worldtides', () => ({ fetchWorldTides: vi.fn() }));
import { clearTideCache, fetchTideCurve, tideCurveBucket } from '../services/TideHeightService';
import { fetchWorldTides } from '../services/weather/api/worldtides';

describe('informational WorldTides cannot become a routing curve', () => {
    beforeEach(() => {
        clearTideCache();
        vi.clearAllMocks();
    });
    it.each([undefined, 3, 14, 40])(
        'refuses short/full/out-of-policy spans (%s days) before upstream access',
        async (days) => {
            const now = Date.now();
            expect(await fetchTideCurve(-27.3011, 153.1122, now, now + 24 * 3600_000, { days })).toBeNull();
            expect(
                await fetchTideCurve(-27.3011, 153.1122, now + 9 * 3600_000, now + 33 * 3600_000, { days }),
            ).toBeNull();
            expect(fetchWorldTides).not.toHaveBeenCalled();
        },
    );
    it('keeps chart-derived positions in their existing coarse privacy buckets', () => {
        expect(tideCurveBucket(-22.3011, 166.4233)).toBe('-22.25,166.5');
        expect(tideCurveBucket(38.9734, -76.4521)).toBe('39,-76.5');
    });
});
