import { describe, expect, it } from 'vitest';
import { snapRouteToCanalLines } from '../../services/tier3/canalLineFollower';
import type { LatLon } from '../../services/routing/legContract';

describe('snapRouteToCanalLines', () => {
    it('does not snap across protected tier-2 channel vertices', () => {
        const canal: LatLon[] = [
            [153, -27],
            [153, -26.99],
            [153, -26.98],
            [153, -26.97],
            [153, -26.96],
        ];
        const protectedChannelVertex: LatLon = [153.0003, -26.98];
        const route: LatLon[] = [
            [153, -27],
            [153.0002, -26.99],
            protectedChannelVertex,
            [153.0002, -26.97],
            [153, -26.96],
        ];

        const snapped = snapRouteToCanalLines(route, [canal], {
            protectedVertices: [false, false, true, false, false],
        });

        expect(snapped.polyline).toContainEqual(protectedChannelVertex);
    });
});
