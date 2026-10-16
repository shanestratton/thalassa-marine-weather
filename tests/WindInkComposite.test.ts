import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapboxWindField } from '../components/map/MapboxWindField';
import { zoomCompensatedVelocityScale, zoomScaledParticleMultiplier } from '../components/map/MapboxVelocityOverlay';
import { windParticleColorForKt } from '../components/map/windRamp';
import { fieldRecords, InkContext, windFieldHarness } from './helpers/windFieldHarness';

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});
describe('the actual native field blend recipe', () => {
    for (const palette of ['light', 'dark'] as const)
        it(`${palette} keeps trails, colour, stroke width and blend`, () => {
            const h = windFieldHarness();
            const ctx = new InkContext();
            vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
            const field = new MapboxWindField(h.map, {
                palette,
                fade: 0.98,
                lineWidth: palette === 'light' ? 1.5 : 1,
                velocityScale: zoomCompensatedVelocityScale,
                particleMultiplier: zoomScaledParticleMultiplier,
                requestFrame: h.requestFrame,
                cancelFrame: h.cancelFrame,
                random: () => 0.5,
            });
            field.setData(fieldRecords((26 * 1852) / 3600, 0));
            h.step(40);
            h.step(80);
            const fills = ctx.log.filter((x) => x.kind === 'fill'),
                strokes = ctx.log.filter((x) => x.kind === 'stroke');
            expect(fills).toHaveLength(2);
            expect(fills.every((x) => x.op === 'destination-out' && x.colour === '#000000')).toBe(true);
            for (const fill of fills) {
                // Destination-out preserves old premultiplied colour and multiplies alpha by 1-A.
                expect(1 - fill.alpha).toBeCloseTo(0.98 * (0.98 * 0.9), 12);
            }
            expect(strokes.length).toBeGreaterThan(0);
            expect(
                strokes.every(
                    (x) =>
                        x.op === (palette === 'light' ? 'source-over' : 'lighter') &&
                        x.width === (palette === 'light' ? 1.5 : 1) &&
                        x.alpha === 0.98 * 0.9 &&
                        x.colour === windParticleColorForKt(26, palette),
                ),
            ).toBe(true);
            const before = ctx.log.length;
            field.setData(null);
            h.step(120);
            expect(ctx.log.slice(before).some((x) => x.kind === 'stroke')).toBe(false);
            expect(ctx.log.at(-1)?.kind).toBe('clear');
            field.destroy();
        });
});
