import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapboxWindField, sampleVelocity } from '../components/map/MapboxWindField';
import { zoomCompensatedVelocityScale, zoomScaledParticleMultiplier } from '../components/map/MapboxVelocityOverlay';
import { fieldRecords, InkContext, windFieldHarness } from './helpers/windFieldHarness';

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});
function setup(lat = 40, lng = 0, bearing = 0, width = 390, height = 844) {
    const h = windFieldHarness(width, height, lng, lat, 5, bearing);
    const ctx = new InkContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const field = new MapboxWindField(h.map, {
        velocityScale: zoomCompensatedVelocityScale,
        particleMultiplier: zoomScaledParticleMultiplier,
        requestFrame: h.requestFrame,
        cancelFrame: h.cancelFrame,
        random: () => 0.5,
    });
    field.setData(fieldRecords());
    return { ...h, field, ctx };
}
describe('native field sampling and ownership', () => {
    it('wraps the antimeridian, interpolates north-to-south rows and never fills missing wind with calm', () => {
        const records = fieldRecords();
        records[0].data[0] = 0;
        records[0].data[1] = 10;
        expect(sampleVelocity(records, -175, 80)).toEqual({ x: 5, y: 4 });
        expect(sampleVelocity(records, 185, 80)).toEqual({ x: 5, y: 4 });
        expect(sampleVelocity(records, 181, 0)).toEqual(sampleVelocity(records, -179, 0));
        records[0].data[1] = NaN;
        expect(sampleVelocity(records, -175, 80)).toBeNull();
        expect(sampleVelocity(records, -180, 80)).toEqual({ x: 0, y: 4 });
        expect(sampleVelocity(records, 0, 85)).toBeNull();
        expect(sampleVelocity(null, 0, 0)).toBeNull();
    });
    it('has one owned RAF even for ID zero, clears lost data and removes every listener on destroy', () => {
        const h = setup();
        expect(h.callbacks.size).toBe(1);
        h.field.setData(fieldRecords(4, 2));
        expect(h.callbacks.size).toBe(1);
        h.step(40);
        expect(h.callbacks.size).toBe(1);
        h.field.setData(null);
        expect(h.callbacks.size).toBe(0);
        expect(h.field.particleCount).toBe(0);
        h.field.setData(fieldRecords());
        expect(h.callbacks.size).toBe(1);
        h.field.destroy();
        h.field.destroy();
        expect(h.callbacks.size).toBe(0);
        expect([...h.listeners.values()].every((x) => x.size === 0)).toBe(true);
        expect(h.container.children).toHaveLength(0);
        h.field.setData(fieldRecords());
        expect(h.callbacks.size).toBe(0);
    });
    it('pauses hidden/zero-size charts and resumes measured charts with current data', () => {
        const h = setup();
        const hidden = vi.spyOn(document, 'hidden', 'get');
        hidden.mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(h.callbacks.size).toBe(0);
        hidden.mockReturnValue(false);
        document.dispatchEvent(new Event('visibilitychange'));
        expect(h.callbacks.size).toBe(1);
        h.size.width = h.size.height = 0;
        h.emit('resize');
        expect(h.callbacks.size).toBe(0);
        expect(h.field.canvas.width).toBe(0);
        h.size.width = 390;
        h.size.height = 844;
        h.emit('resize');
        expect(h.callbacks.size).toBe(1);
        h.field.destroy();
    });
    it('retains the whole wind field on a rotated 4K display while bounding projection work and backing pixels', () => {
        const h = setup(40, 0, 37, 3840, 2160);
        expect(h.field.canvas.style.width).toBe(`${Math.ceil(Math.hypot(3840, 2160))}px`);
        expect(h.field.canvas.width * h.field.canvas.height).toBeLessThanOrEqual(16_000_000);
        expect(h.field.canvas.width).toBeGreaterThan(0);
        expect(h.field.particleCount).toBeGreaterThan(0);
        expect(h.field.particleCount).toBeLessThanOrEqual(24_000);
        // Constructor has no grid; only the selected-data rebuild projects the bounded lattice.
        expect(vi.mocked(h.map.unproject).mock.calls.length).toBeLessThan(65_000);
        h.field.destroy();
    });
    it('draws crisp Retina ink at the same CSS width and particle density with a bounded backing store', () => {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3);
        const h = setup();
        expect(h.field.canvas.width).toBe(780);
        expect(h.field.canvas.style.width).toBe('390px');
        expect(h.ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
        expect(h.field.particleCount).toBe(Math.round(390 * 844 * zoomScaledParticleMultiplier(5)));
        h.size.width = 3000;
        h.size.height = 2000;
        h.emit('resize');
        expect(h.field.canvas.width * h.field.canvas.height).toBeLessThanOrEqual(16_000_000);
        h.field.destroy();
    });
    it('bounds projection work to camera settles and keeps particle density/speed ramps through zoom', () => {
        const h = setup();
        expect(h.field.particleCount).toBe(Math.round(390 * 844 * zoomScaledParticleMultiplier(5)));
        vi.mocked(h.map.unproject).mockClear();
        for (let i = 1; i <= 8; i++) h.step(i * 40);
        expect(h.map.unproject).not.toHaveBeenCalled();
        h.camera.zoom = 9;
        h.emit('move');
        expect(h.field.canvas.style.transform).toContain('scale(16)');
        expect(h.map.unproject).not.toHaveBeenCalled();
        h.emit('moveend');
        expect(h.field.particleCount).toBe(Math.round(390 * 844 * zoomScaledParticleMultiplier(9)));
        h.field.destroy();
    });
    for (const [lat, lng] of [
        [70, 19],
        [48, -4],
        [-17, 179.9],
    ])
        for (const bearing of [0, 37, 127])
            it(`preserves east/north flow at ${lat} latitude and ${bearing}° bearing`, () => {
                const h = setup(lat, lng, bearing);
                const before = h.field.particlePositions()[0];
                h.step(40);
                const after = h.field.particlePositions()[0];
                const angle = (-bearing * Math.PI) / 180;
                const expected = {
                    x: 8 * Math.cos(angle) + 4 * Math.sin(angle),
                    y: 8 * Math.sin(angle) - 4 * Math.cos(angle),
                };
                const actual = { x: after.x - before.x, y: after.y - before.y };
                const dot =
                    (actual.x * expected.x + actual.y * expected.y) /
                    Math.hypot(actual.x, actual.y) /
                    Math.hypot(expected.x, expected.y);
                expect(dot).toBeGreaterThan(0.999999);
                h.field.destroy();
            });
    for (const bearing of [0, 37, 180])
        it(`equal NE wind remains 45° at 80°N, rotated ${bearing}°`, () => {
            const h = setup(80, 0, bearing);
            h.field.setData(fieldRecords(8, 8, -180, 85));
            const before = h.field.particlePositions()[0];
            h.step(40);
            const after = h.field.particlePositions()[0];
            const actual = Math.atan2(after.y - before.y, after.x - before.x);
            const expected = ((-45 - bearing) * Math.PI) / 180;
            expect(Math.cos(actual - expected)).toBeGreaterThan(0.999999);
            h.field.destroy();
        });
    it('centres the rotated square, caps population at 1.6x and recentres after phone orientation change', () => {
        const h = setup(40, 0, 37);
        const side = Math.ceil(Math.hypot(390, 844));
        expect(h.field.canvas.width).toBe(side);
        expect(h.field.particleCount).toBeLessThanOrEqual(
            Math.round(1.6 * 390 * 844 * zoomScaledParticleMultiplier(5)),
        );
        const left = h.field.canvas.style.left;
        h.size.width = 844;
        h.size.height = 390;
        h.emit('resize');
        expect(h.field.canvas.width).toBe(side);
        expect(h.field.canvas.style.left).not.toBe(left);
        h.camera.bearing = 52;
        h.emit('move');
        expect(Number(h.field.canvas.style.transform.match(/rotate\(([^d]+)/)?.[1])).toBeCloseTo(-15);
        h.field.destroy();
    });
});
