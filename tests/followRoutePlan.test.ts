import { describe, expect, it } from 'vitest';
import { buildFollowRoutePlanFromRoute } from '../services/shiplog/followRoutePlan';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';

describe('buildFollowRoutePlanFromRoute', () => {
    it('preserves dense geometry without turning every vertex into a waypoint marker', () => {
        const route: RouteOrTrack = {
            id: 'planned-1',
            label: 'Newport → Lady Musgrave',
            sublabel: 'Planned · 180 NM',
            points: [
                { lat: -27.5, lon: 153 },
                { lat: -26.8, lon: 152.7 },
                { lat: -23.9, lon: 152.4 },
            ],
            bbox: [152.4, -27.5, 153, -23.9],
            timestamp: Date.parse('2026-07-25T00:00:00.000Z'),
            distanceNm: 180,
            durationHours: 30,
            isLocal: false,
            kind: 'sea',
        };

        const plan = buildFollowRoutePlanFromRoute(route);

        expect(plan).toMatchObject({
            origin: 'Newport',
            destination: 'Lady Musgrave',
            originCoordinates: { lat: -27.5, lon: 153 },
            destinationCoordinates: { lat: -23.9, lon: 152.4 },
            distanceApprox: '180.0 NM',
            durationApprox: '30.0 hours',
            waypoints: [],
        });
        expect(plan?.routeGeoJSON?.geometry.coordinates).toEqual([
            [153, -27.5],
            [152.7, -26.8],
            [152.4, -23.9],
        ]);
    });
});
