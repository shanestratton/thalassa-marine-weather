/** Actual native field camera tracking: fictional points, no network or second map. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    sameSeenAt,
    zoomCompensatedVelocityScale,
    zoomScaledParticleMultiplier,
} from '../components/map/MapboxVelocityOverlay';
import { MapboxWindField } from '../components/map/MapboxWindField';
import { fieldRecords, InkContext, windFieldHarness } from './helpers/windFieldHarness';

type Point = { x: number; y: number };
function applyCss(transform: string, origin: Point, point: Point): Point {
    let p = { x: point.x - origin.x, y: point.y - origin.y };
    const ops = [...transform.matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)];
    for (const [, op, args] of ops.reverse()) {
        const values = args.split(',').map(parseFloat);
        if (op === 'translate') p = { x: p.x + values[0], y: p.y + (values[1] ?? 0) };
        if (op === 'scale') p = { x: p.x * values[0], y: p.y * values[0] };
        if (op === 'rotate') {
            const a = (values[0] * Math.PI) / 180;
            p = { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
        }
    }
    return { x: p.x + origin.x, y: p.y + origin.y };
}
afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});
describe('the actual native canvas follows the chart during pan, pinch and turn', () => {
    for (const [lat, lng, zoom] of [
        [69.65, 18.96, 9],
        [48.38, -4.49, 11],
        [-16.8, 179.9, 10],
    ])
        for (const bearing of [0, 37, 90, 180, 270])
            for (const scale of [1, 1.6])
                it(`${lat} latitude, ${bearing} degrees, scale ${scale}: nine real frame points within one pixel`, () => {
                    const h = windFieldHarness(390, 844, lng, lat, zoom, 37);
                    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new InkContext() as never);
                    const field = new MapboxWindField(h.map, {
                        velocityScale: zoomCompensatedVelocityScale,
                        particleMultiplier: zoomScaledParticleMultiplier,
                        requestFrame: h.requestFrame,
                        cancelFrame: h.cancelFrame,
                    });
                    field.setData(fieldRecords());
                    h.camera.lng += (23 / (512 * 2 ** zoom)) * 360;
                    h.camera.lat -= 0.004;
                    h.camera.zoom += Math.log2(scale);
                    h.camera.bearing = bearing;
                    h.emit('move');
                    const canvas = field.canvas,
                        left = parseFloat(canvas.style.left),
                        top = parseFloat(canvas.style.top);
                    for (const x of [0.05, 0.5, 0.95])
                        for (const y of [0.05, 0.5, 0.95]) {
                            const geo = h.map.unproject([390 * x, 844 * y]);
                            const p = field.framePoint([geo.lng, geo.lat]);
                            const css = applyCss(
                                canvas.style.transform,
                                { x: left + canvas.width / 2, y: top + canvas.height / 2 },
                                { x: left + p.x, y: top + p.y },
                            );
                            const expected = h.map.project([geo.lng, geo.lat]);
                            expect(Math.abs(css.x - expected.x)).toBeLessThan(1);
                            expect(Math.abs(css.y - expected.y)).toBeLessThan(1);
                        }
                    field.destroy();
                });
});

describe('sameSeenAt: “is she on screen” is re-measured after a turn (A3)', () => {
    const at = { lat: -16.8, lon: 179.9, centre: { lat: -16.8, lng: 179.9 }, zoom: 14, bearing: 0 };
    it('the same spot under the same camera is the same', () => {
        expect(sameSeenAt(at, { ...at })).toBe(true);
    });
    it('a camera that only turned is a different camera', () => {
        expect(sameSeenAt(at, { ...at, bearing: 90 })).toBe(false);
    });
});
