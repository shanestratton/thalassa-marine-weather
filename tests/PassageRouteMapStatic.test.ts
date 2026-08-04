import { describe, expect, it } from 'vitest';
import { decimateRoute, encodePolyline } from '../components/passage/PassageRouteMap';

describe('PassageRouteMap static-image helpers', () => {
    it('encodes the canonical Google polyline test vector', () => {
        // Google's published example, given here in [lon, lat] GeoJSON order:
        // (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
        const points: [number, number][] = [
            [-120.2, 38.5],
            [-120.95, 40.7],
            [-126.453, 43.252],
        ];
        expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    });

    it('decimates to the requested count while keeping both endpoints', () => {
        const route: [number, number][] = Array.from({ length: 500 }, (_, i) => [153 + i * 0.001, -27 - i * 0.001]);
        const decimated = decimateRoute(route, 90);
        expect(decimated).toHaveLength(90);
        expect(decimated[0]).toEqual(route[0]);
        expect(decimated[decimated.length - 1]).toEqual(route[route.length - 1]);
    });

    it('returns short routes untouched', () => {
        const route: [number, number][] = [
            [153, -27],
            [153.1, -27.1],
        ];
        expect(decimateRoute(route, 160)).toEqual(route);
    });
});
