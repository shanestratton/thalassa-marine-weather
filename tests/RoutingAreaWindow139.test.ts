import { describe, expect, it } from 'vitest';
import { routeInsideAreaWindow, routingAreaWindow } from '../services/routing/routingAreaWindow';
describe('route area source window', () => {
    it('covers both the actual engine padding and short-route lead envelope', () => {
        const small = routingAreaWindow({ lon: 0, lat: 0 }, { lon: 0.02, lat: 0 });
        expect(small[0]).toBeCloseTo(-0.1);
        expect(small[2]).toBeCloseTo(0.12);
        const large = routingAreaWindow({ lon: 0, lat: 0 }, { lon: 0.8, lat: 0 });
        expect(large[0]).toBeCloseTo(-0.4);
        expect(large[2]).toBeCloseTo(1.2);
    });
    it('rejects a finished postprocessor line escaping the read window', () => {
        const window = routingAreaWindow({ lon: 0, lat: 0 }, { lon: 0.02, lat: 0 });
        expect(
            routeInsideAreaWindow(
                [
                    [0, 0],
                    [0.02, 0],
                ],
                window,
            ),
        ).toBe(true);
        expect(
            routeInsideAreaWindow(
                [
                    [0, 0],
                    [0.01, 0.11],
                    [0.02, 0],
                ],
                window,
            ),
        ).toBe(false);
        expect(
            routeInsideAreaWindow(
                [
                    [0, 0],
                    [NaN, 0],
                ],
                window,
            ),
        ).toBe(false);
    });
    it('bounds WGS84 and explicitly refuses an unsupported dateline frame', () => {
        expect(() => routingAreaWindow({ lon: 179, lat: 0 }, { lon: -179, lat: 0 })).toThrow('dateline');
        expect(() => routingAreaWindow({ lon: 0, lat: 86 }, { lon: 0, lat: 85 })).toThrow();
        expect(routingAreaWindow({ lon: 179.95, lat: 0 }, { lon: 179.98, lat: 0 })[2]).toBe(180);
        expect(
            routeInsideAreaWindow(
                [
                    [179, 0],
                    [-179, 0],
                ],
                [-180, -1, 180, 1],
            ),
        ).toBe(false);
    });
});
