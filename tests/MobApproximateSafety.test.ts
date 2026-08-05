import { describe, expect, it } from 'vitest';

import { buildMobAccuracyCircle } from '../components/map/useMobMarker';
import { calculateDistance } from '../utils/navigationCalculations';

describe('MOB approximate search geometry', () => {
    it('draws a closed geodesic search circle at the reported uncertainty radius', () => {
        const feature = buildMobAccuracyCircle({
            fixLat: -27,
            fixLon: 153,
            fixAccuracy: 250,
            activatedAt: Date.now(),
        });
        const ring = feature.geometry.coordinates[0];

        expect(ring).toHaveLength(73);
        expect(ring[0]).toEqual(ring.at(-1));
        const radiusM = calculateDistance(-27, 153, ring[0][1], ring[0][0]) * 1852;
        expect(radiusM).toBeGreaterThan(245);
        expect(radiusM).toBeLessThan(255);
    });
});
