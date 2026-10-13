/**
 * Light's wind ink, drawn normally (128-LIGHT). Shane, 2026-10-13: "yes to
 * all of your questions for 128", on "The Light chart's 26 kt red: draw the
 * Light chart's wind ink normally (source-over) instead of the additive blend
 * that pales red over the sea".
 *
 * The REAL leaflet-velocity-ts Windy (not the lifecycle suite's mock), driven
 * frame by frame on a recording 2D context, through the one seam
 * MapboxVelocityOverlay owns (guardVelocityLayerStartup):
 *  - on Light, every particle stroke lands under 'source-over' and the fade
 *    before it is still the library's 'destination-in';
 *  - on a dark base (Obs, the phone, Relief + Sat, Hybrid) the canvas sees
 *    exactly the calls the unwrapped library makes, op for op and point for
 *    point: the same pixels, by construction.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import L from 'leaflet';
import { guardVelocityLayerStartup } from '../components/map/MapboxVelocityOverlay';
import {
    WIND_MAX_MS,
    WIND_PARTICLE_COLORS,
    WIND_PARTICLE_COLORS_LIGHT,
    type WindPalette,
} from '../components/map/windRamp';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

type WindyCtor = new (options: Record<string, unknown>) => {
    start(layer: unknown): unknown;
    stop(): void;
    evolve(): void;
    draw(): void;
    animationBucket?: unknown;
};
type CanvasBoundCtor = new (x0: number, y0: number, x1: number, y1: number) => unknown;
let Windy: WindyCtor;
let CanvasBound: CanvasBoundCtor;

beforeAll(async () => {
    // The plugin extends window.L as it loads, as in the app.
    (window as unknown as { L: typeof L }).L = L;
    await import('leaflet-velocity-ts');
    ({ Windy, CanvasBound } = window as unknown as { Windy: WindyCtor; CanvasBound: CanvasBoundCtor });
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** A 2D context that records what the canvas is asked to do, with the blend each stroke and fill lands under. */
class RecordingContext {
    log: string[] = [];
    #op = 'source-over';
    globalAlpha = 1;
    lineWidth = 1;
    fillStyle = '';
    strokeStyle = '';
    get globalCompositeOperation() {
        return this.#op;
    }
    set globalCompositeOperation(op: string) {
        this.#op = op;
    }
    fillRect(x: number, y: number, w: number, h: number) {
        this.log.push(`fill ${this.#op} ${this.fillStyle} ${this.globalAlpha.toFixed(4)} ${[x, y, w, h].join(',')}`);
    }
    clearRect() {
        this.log.push('clear');
    }
    beginPath() {
        this.log.push('begin');
    }
    moveTo(x: number, y: number) {
        this.log.push(`m ${x.toFixed(3)},${y.toFixed(3)}`);
    }
    lineTo(x: number, y: number) {
        this.log.push(`l ${x.toFixed(3)},${y.toFixed(3)}`);
    }
    stroke() {
        this.log.push(`stroke ${this.#op} ${this.strokeStyle} ${this.globalAlpha.toFixed(4)} ${this.lineWidth}`);
    }
}

/** A fictional 26 kt south-easterly over a 2 x 2 grid, as the GRIB U/V pair the field reads. */
function records() {
    const ms = (26 * 1852) / 3600;
    const header = (n: number) => ({
        parameterCategory: 2,
        parameterNumber: n,
        la1: 51,
        lo1: -2,
        dx: 1,
        dy: 1,
        nx: 2,
        ny: 2,
    });
    // From 135 degrees: the air moves north-west.
    const u = -ms * Math.SQRT1_2;
    const v = ms * Math.SQRT1_2;
    return [
        { header: header(2), data: [u, u, u, u] },
        { header: header(3), data: [v, v, v, v] },
    ];
}

/** Lehmer, so two runs place every particle in the same spot. */
function seed(s = 7) {
    vi.spyOn(Math, 'random').mockImplementation(() => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
    });
}

/**
 * Draw `frames` frames of the real Windy on a 64 x 48 canvas. `guard` passes it
 * through MapboxVelocityOverlay's seam as a layer of that palette; without it,
 * the library alone.
 */
function drawFrames(palette: WindPalette | null, frames = 4) {
    seed();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const ctx = new RecordingContext();
    const canvas = { getContext: () => ctx };
    const windy = new Windy({
        canvas,
        data: records(),
        maxVelocity: WIND_MAX_MS,
        velocityScale: 0.01,
        particleAge: 60,
        opacity: 0.98,
        particleMultiplier: 1 / 150,
        frameRate: 30,
        particlelineWidth: palette === 'light' ? 1.5 : 1,
        colorScale: palette === 'light' ? WIND_PARTICLE_COLORS_LIGHT : WIND_PARTICLE_COLORS,
    });
    if (palette) {
        // The velocity layer as MapboxVelocityOverlay creates it: its palette
        // stamped, then guarded; Leaflet's first draw makes its Windy.
        const layer = {
            __palette: palette,
            _windy: undefined as typeof windy | undefined,
            onDrawLayer() {
                this._windy = windy;
            },
        };
        guardVelocityLayerStartup(layer as never);
        layer.onDrawLayer();
    }
    // The map's view, as leaflet-velocity's own Layer hands it to start().
    windy.start({
        canvasBound: new CanvasBound(0, 0, 64, 48),
        mapBound: { width: 0.1, height: 0.075 },
        canvasToMap: (x: number, y: number) => [-2 + x / 640, 51 - y / 640],
        distort: (
            _lon: number,
            _lat: number,
            _x: number,
            _y: number,
            scale: number,
            wind: { u: number; v: number },
        ) => {
            wind.u *= scale;
            wind.v *= -scale;
            return wind;
        },
    });
    for (let f = 0; f < frames; f++) {
        windy.evolve();
        windy.draw();
    }
    return ctx.log;
}

describe('the wind field’s ink blend (leaflet-velocity-ts, unforked)', () => {
    it('the library alone strokes additively after its fade: the blend 128 changes on Light', () => {
        const log = drawFrames(null);
        const strokes = log.filter((line) => line.startsWith('stroke'));
        expect(strokes.length).toBeGreaterThan(0);
        expect(new Set(strokes.map((line) => line.split(' ')[1]))).toEqual(new Set(['lighter']));
        expect(
            log.filter((line) => line.startsWith('fill')).every((line) => line.startsWith('fill destination-in')),
        ).toBe(true);
    });

    it('on Light every particle stroke is drawn normally (source-over), in the light inks; the fade is the library’s', () => {
        const log = drawFrames('light');
        const strokes = log.filter((line) => line.startsWith('stroke'));
        expect(strokes.length).toBeGreaterThan(0);
        for (const stroke of strokes) {
            const [, op, ink, alpha, width] = stroke.split(' ');
            expect(op, stroke).toBe('source-over');
            expect(WIND_PARTICLE_COLORS_LIGHT).toContain(ink);
            // 0.9 x the 0.98 fade, as the library sets it; Light's 1.5 px.
            expect(alpha).toBe('0.8820');
            expect(width).toBe('1.5');
        }
        // The 26 kt red is what the field draws here.
        expect(strokes.some((line) => line.includes(WIND_PARTICLE_COLORS_LIGHT[26]))).toBe(true);
        const fills = log.filter((line) => line.startsWith('fill'));
        expect(fills).toHaveLength(4);
        for (const fill of fills) expect(fill.startsWith('fill destination-in rgba(0, 0, 0, 0.98)'), fill).toBe(true);
    });

    it('a restart (a pan or a zoom) makes a new particle bucket, and its strokes are still drawn normally', () => {
        seed();
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        const ctx = new RecordingContext();
        const windy = new Windy({
            canvas: { getContext: () => ctx },
            data: records(),
            maxVelocity: WIND_MAX_MS,
            opacity: 0.98,
            particleMultiplier: 1 / 150,
            colorScale: WIND_PARTICLE_COLORS_LIGHT,
        });
        const layer = { __palette: 'light', _windy: windy, onDrawLayer: () => undefined };
        guardVelocityLayerStartup(layer as never);
        layer.onDrawLayer();
        const view = {
            canvasBound: new CanvasBound(0, 0, 64, 48),
            mapBound: { width: 0.1, height: 0.075 },
            canvasToMap: (x: number, y: number) => [-2 + x / 640, 51 - y / 640],
            distort: (...args: unknown[]) => args[5],
        };
        windy.start(view);
        const first = windy.animationBucket;
        windy.stop();
        windy.start(view);
        expect(windy.animationBucket).not.toBe(first);
        windy.evolve();
        windy.draw();
        const strokes = ctx.log.filter((line) => line.startsWith('stroke'));
        expect(strokes.length).toBeGreaterThan(0);
        expect(new Set(strokes.map((line) => line.split(' ')[1]))).toEqual(new Set(['source-over']));
    });

    it('a dark base (Obs, the phone, Relief + Sat, Hybrid) draws exactly what the library draws: every call, every point', () => {
        const library = drawFrames(null, 6);
        const guarded = drawFrames('dark', 6);
        expect(guarded.length).toBeGreaterThan(50);
        expect(guarded).toEqual(library);
        expect(guarded.filter((line) => line.startsWith('stroke')).every((line) => line.includes(' lighter '))).toBe(
            true,
        );
    });
});
