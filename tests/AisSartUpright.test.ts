/**
 * A distress beacon stays a ⊗ on a turned chart (127-11a, audit A5).
 *
 * IEC 62288 draws the AIS-SART mark upright. It shared the AIS boat layer,
 * whose icons turn with the chart ('map' alignment, so each boat points her
 * real way): at 45° the ⊗ became a ⊕, a different symbol. Beacons now have
 * their own layer on the same source, upright on screen ('viewport'), with the
 * same image, size and paint; the boat layer takes every other target. The AIS
 * switch, the tap and the weather bubble's "was that a target" test cover both
 * (useAisLayer, useAisStreamLayer, useMapInit). The browser spec renders it
 * for real (browser-tests/chart-orientation.spec.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    AIS_SART_LAYER,
    AIS_TARGET_ICON_IMAGE,
    AIS_TARGET_ICON_LAYERS,
    AIS_TARGET_ICON_SIZE,
} from '../components/map/aisDistressSymbol';

type Expr = unknown;
/** The few expression operators the AIS filters use, evaluated as Mapbox does. */
function evaluate(expr: Expr, props: Record<string, unknown>): unknown {
    if (!Array.isArray(expr)) return expr;
    const [op, ...args] = expr as [string, ...Expr[]];
    if (op === 'get') return props[args[0] as string] ?? null;
    if (op === 'coalesce') return args.map((a) => evaluate(a, props)).find((v) => v !== null) ?? null;
    if (op === '==') return evaluate(args[0], props) === evaluate(args[1], props);
    if (op === '!=') return evaluate(args[0], props) !== evaluate(args[1], props);
    if (op === '!') return !evaluate(args[0], props);
    throw new Error(`unexpected operator ${op}`);
}

const layer = (id: string) => AIS_TARGET_ICON_LAYERS.find((l) => l.id === id)!;

describe('AIS target icons: boats turn with the chart, a beacon stands upright', () => {
    it('two layers on the one AIS source: the boats, then the beacons above them', () => {
        expect(AIS_TARGET_ICON_LAYERS.map((l) => l.id)).toEqual(['ais-targets-circle', AIS_SART_LAYER]);
        expect(AIS_SART_LAYER).toBe('ais-targets-sart');
        for (const l of AIS_TARGET_ICON_LAYERS) expect(l).toMatchObject({ type: 'symbol', source: 'ais-targets' });
    });

    it('the beacon layer is upright on screen with the beacon’s own image, size and paint', () => {
        const boats = layer('ais-targets-circle');
        const sart = layer(AIS_SART_LAYER);
        expect(sart.layout['icon-rotation-alignment']).toBe('viewport');
        expect(sart.layout['icon-rotate']).toBe(0);
        expect(sart.layout['icon-image']).toBe(AIS_TARGET_ICON_IMAGE);
        expect(sart.layout['icon-size']).toBe(AIS_TARGET_ICON_SIZE);
        expect(sart.paint).toEqual(boats.paint);
        // The boats still point their real way, turning with the chart.
        expect(boats.layout['icon-rotation-alignment']).toBe('map');
        expect(boats.layout['icon-rotate']).toEqual(['coalesce', ['get', 'orientation'], 0]);
    });

    it('each target is drawn by exactly one of them', () => {
        const boats = layer('ais-targets-circle');
        const sart = layer(AIS_SART_LAYER);
        for (const iconKind of ['boat', 'dot', 'sart', undefined]) {
            const props = iconKind ? { iconKind } : {};
            expect(evaluate(boats.filter, props)).toBe(iconKind !== 'sart');
            expect(evaluate(sart.filter, props)).toBe(iconKind === 'sart');
        }
    });

    it('the chart adds them as they are, and a tap on a beacon is still a tap on a target', () => {
        const init = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(init).toMatch(/for \(const layer of AIS_TARGET_ICON_LAYERS\)/);
        // The weather bubble stands down for a beacon as for a boat.
        expect(init).toMatch(/existingMapLayerIds\(map, \['ais-targets-circle', AIS_SART_LAYER\]\)/);
    });
});
