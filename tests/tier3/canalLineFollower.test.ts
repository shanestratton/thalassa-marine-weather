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

    it('prefers the charted canal graph over a supplied water-medial fallback', () => {
        const canal: LatLon[] = [
            [153, -27],
            [153, -26.99],
        ];
        const visualWaterCentre: LatLon[] = [
            [153.0004, -27],
            [153.0004, -26.995],
            [153.0004, -26.99],
        ];
        const route: LatLon[] = [
            [153, -27],
            [153, -26.995],
            [153, -26.99],
        ];

        const snapped = snapRouteToCanalLines(route, [canal], {
            routeRun: () => visualWaterCentre,
        });

        expect(snapped.polyline).toEqual([route[0], canal[0], canal[1], route[2]]);
        expect(snapped.onCanal).toEqual([false, true, true, false]);
    });

    it('falls back to a supplied water-medial route when the canal graph is disconnected', () => {
        const disconnectedCanals: LatLon[][] = [
            [
                [153, -27],
                [153, -26.999],
            ],
            [
                [153, -26.991],
                [153, -26.99],
            ],
        ];
        const visualWaterCentre: LatLon[] = [
            [153.0004, -27],
            [153.0004, -26.995],
            [153.0004, -26.99],
        ];
        const route: LatLon[] = [
            [153, -27],
            [153, -26.995],
            [153, -26.99],
        ];

        const snapped = snapRouteToCanalLines(route, disconnectedCanals, {
            routeRun: () => visualWaterCentre,
        });

        expect(snapped.polyline).toEqual(visualWaterCentre);
        expect(snapped.onCanal).toEqual([false, true, false]);
    });
});
