import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseInWindLayer, type CloseInWindMap } from '../components/map/CloseInWindLayer';
import { closeInParticleCount, closeInScreenSpeed } from '../components/map/closeInWind';

type Listener = () => void;

interface FakeContext {
    ops: string[];
    strokes: string[];
    segments: Array<[number, number, number, number]>;
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    globalCompositeOperation: string;
    lineWidth: number;
    lineCap: string;
    beginPath: () => void;
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    stroke: () => void;
    fillRect: (x: number, y: number, w: number, h: number) => void;
    clearRect: (x: number, y: number, w: number, h: number) => void;
    drawImage: (...args: unknown[]) => void;
}

function fakeContext(): FakeContext {
    let pen: [number, number] = [0, 0];
    const ctx: FakeContext = {
        ops: [],
        strokes: [],
        segments: [],
        fillStyle: '',
        strokeStyle: '',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        lineWidth: 1,
        lineCap: 'butt',
        beginPath: () => ctx.ops.push('beginPath'),
        moveTo: (x, y) => {
            pen = [x, y];
        },
        lineTo: (x, y) => {
            ctx.segments.push([pen[0], pen[1], x, y]);
            pen = [x, y];
        },
        stroke: () => {
            ctx.strokes.push(ctx.strokeStyle);
            ctx.ops.push(`stroke:${ctx.globalCompositeOperation}`);
        },
        fillRect: () =>
            ctx.ops.push(`fill:${ctx.globalCompositeOperation}:${ctx.fillStyle}:${ctx.globalAlpha.toFixed(3)}`),
        clearRect: () => ctx.ops.push('clear'),
        drawImage: () => ctx.ops.push(`drawImage:${ctx.globalCompositeOperation}`),
    };
    return ctx;
}

let ctx: FakeContext;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function harness(size = { w: 390, h: 844 }) {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => size.w });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => size.h });
    document.body.appendChild(container);
    const listeners = new Map<string, Set<Listener>>();
    const camera = { x: 0, y: 0, zoom: 14, bearing: 0 };
    const map: CloseInWindMap & { emit: (event: string) => void; listenerTotal: () => number } = {
        getContainer: () => container,
        getCenter: () => ({ lng: 148.72, lat: -20.27 }),
        getZoom: () => camera.zoom,
        getBearing: () => camera.bearing,
        // A fixed screen point for the anchor, shifted by the camera pan.
        project: () => ({ x: 195 + camera.x, y: 422 + camera.y }),
        on: (event: string, fn: Listener) => {
            const set = listeners.get(event) ?? new Set<Listener>();
            set.add(fn);
            listeners.set(event, set);
        },
        off: (event: string, fn: Listener) => {
            listeners.get(event)?.delete(fn);
        },
        emit: (event: string) => {
            for (const fn of [...(listeners.get(event) ?? [])]) fn();
        },
        listenerTotal: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    };
    return { container, map, camera, size };
}

function seeded(seed = 42): () => number {
    let s = seed;
    return () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
    };
}

function options(patch: Record<string, unknown> = {}) {
    return {
        filter: 'drop-shadow(0 0 0.75px rgba(0, 0, 0, 0.55))',
        fade: 0.98,
        lineWidth: 1,
        tierScale: 1,
        reducedMotion: false,
        random: seeded(),
        requestFrame: (cb: FrameRequestCallback) => {
            nextFrame += 1;
            frames.set(nextFrame, cb);
            return nextFrame;
        },
        cancelFrame: (id: number) => {
            frames.delete(id);
        },
        ...patch,
    };
}

beforeEach(() => {
    ctx = fakeContext();
    frames = new Map();
    nextFrame = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D,
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('CloseInWindLayer', () => {
    it('mounts one overlay with the same stacking, rim and fade-in as the leaflet field', () => {
        const { container, map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        const el = container.firstElementChild as HTMLDivElement;
        expect(el).toBe(layer.element);
        expect(el.style.position).toBe('absolute');
        expect(el.style.zIndex).toBe('400');
        expect(el.style.pointerEvents).toBe('none');
        expect(el.style.filter).toBe('drop-shadow(0 0 0.75px rgba(0, 0, 0, 0.55))');
        expect(el.style.transition).toContain('opacity 0.4s');
        expect(el.style.opacity).toBe('1');
        const canvas = el.querySelector('canvas')!;
        // CSS-pixel canvas, as leaflet-velocity's: the same 1 px stroke look.
        expect(canvas.width).toBe(390);
        expect(canvas.height).toBe(844);
        layer.destroy();
    });

    it('moves every streak the same way, downwind on screen, at the mapped on-screen speed', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 }); // from the SE: the air moves NW, up-left on a north-up chart
        const perFrame = closeInScreenSpeed(8) / 30;
        expect(layer.velocity.x).toBeCloseTo(-perFrame * Math.SQRT1_2, 6);
        expect(layer.velocity.y).toBeCloseTo(-perFrame * Math.SQRT1_2, 6);
        ctx.segments = [];
        layer.stepFrame();
        expect(ctx.segments.length).toBe(layer.particleCount);
        for (const [x0, y0, x1, y1] of ctx.segments) {
            const dx = x1 - x0;
            const dy = y1 - y0;
            expect(Math.atan2(dy, dx)).toBeCloseTo(Math.atan2(-1, -1), 6);
            // Per-streak pace varies a little (0.85-1.15) so the flow does not read as a sliding texture.
            expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(perFrame * 0.85 - 1e-9);
            expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(perFrame * 1.15 + 1e-9);
        }
        layer.destroy();
    });

    it('the chart turns: the flow re-aims at once, from the same wind, with no new reading (127-11a, A2)', () => {
        const { map, camera } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 }); // from the SE: up-left on a north-up chart
        const setWind = vi.spyOn(layer, 'setWind');
        const perFrame = closeInScreenSpeed(8) / 30;
        // Turned to 90° (east at the top), the NW-going air runs down-left on screen.
        camera.bearing = 90;
        map.emit('rotate');
        for (let i = 0; i < 60; i += 1) layer.stepFrame();
        expect(setWind).not.toHaveBeenCalled();
        expect(layer.velocity.x).toBeCloseTo(-perFrame * Math.SQRT1_2, 3);
        expect(layer.velocity.y).toBeCloseTo(perFrame * Math.SQRT1_2, 3);
        layer.destroy();
        expect(map.listenerTotal()).toBe(0);
    });

    it('mirrors leaflet-velocity frame by frame: 0.98 fade at its carried 0.882 alpha, then additive strokes', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        ctx.ops = [];
        layer.stepFrame();
        expect(ctx.ops[0]).toBe('fill:destination-in:rgba(0, 0, 0, 0.98):0.882');
        expect(ctx.ops.at(-1)).toBe('stroke:lighter');
        expect(ctx.globalAlpha).toBeCloseTo(0.882, 6);
        expect(ctx.lineWidth).toBe(1);
        layer.destroy();
    });

    it('keeps the streak palette: white below 20 kt, the warning hues from the reef line up', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 5, fromDeg: 135 });
        layer.stepFrame();
        expect(ctx.strokes.at(-1)).toBe('#ffffff');
        layer.setWind({ kt: 18, fromDeg: 135 });
        layer.stepFrame();
        expect(ctx.strokes.at(-1)).toBe('#ffffff');
        layer.setWind({ kt: 22, fromDeg: 135 });
        layer.stepFrame();
        expect(ctx.strokes.at(-1)).toBe('#ee7a0b');
        layer.setWind({ kt: 25, fromDeg: 135 });
        layer.stepFrame();
        expect(ctx.strokes.at(-1)).toBe('#e63020');
        layer.destroy();
    });

    it('holds a fixed density whatever the speed, scaled by the device tier', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options({ tierScale: 0.7 }));
        layer.show();
        layer.setWind({ kt: 3, fromDeg: 90 });
        const light = layer.particleCount;
        expect(light).toBe(closeInParticleCount(390, 844, 3, 0.7));
        layer.setWind({ kt: 18, fromDeg: 90 });
        expect(layer.particleCount).toBe(light);
        layer.destroy();
    });

    it('Calm: a sparse, near-still field', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 90 });
        const breeze = layer.particleCount;
        layer.setWind({ kt: 0.4, fromDeg: null });
        expect(layer.particleCount).toBeLessThan(breeze * 0.5);
        for (let i = 0; i < 40; i += 1) layer.stepFrame();
        expect(Math.hypot(layer.velocity.x, layer.velocity.y)).toBeLessThan(0.15);
        layer.destroy();
    });

    it('eases a change of direction instead of snapping every streak at once', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 10, fromDeg: 270 }); // westerly: streaks run right
        expect(layer.velocity.x).toBeGreaterThan(0);
        layer.setWind({ kt: 10, fromDeg: 90 }); // easterly: streaks run left
        layer.stepFrame();
        expect(layer.velocity.x).toBeGreaterThan(-closeInScreenSpeed(10) / 30);
        for (let i = 0; i < 60; i += 1) layer.stepFrame();
        expect(layer.velocity.x).toBeCloseTo(-closeInScreenSpeed(10) / 30, 3);
        layer.destroy();
    });

    it('runs on a 30 fps cadence and pauses while the app is hidden', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        expect(frames.size).toBe(1);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(frames.size).toBe(0);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(frames.size).toBe(1);
        layer.destroy();
        expect(frames.size).toBe(0);
        Reflect.deleteProperty(document, 'hidden');
    });

    it('keeps the streaks on the water while the chart pans', () => {
        const { map, camera } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        const before = layer.particlePositions().slice(0, 5);
        camera.x = 20;
        camera.y = -10;
        map.emit('move');
        const after = layer.particlePositions().slice(0, 5);
        after.forEach((p, i) => {
            expect(p.x).toBeCloseTo(before[i].x + 20, 6);
            expect(p.y).toBeCloseTo(before[i].y - 10, 6);
        });
        expect(ctx.ops).toContain('drawImage:copy');
        layer.destroy();
    });

    it('prefers-reduced-motion: a static arrow field, no animation loop', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options({ reducedMotion: true }));
        layer.show();
        layer.setWind({ kt: 12, fromDeg: 180 }); // southerly: arrows point up the screen
        expect(frames.size).toBe(0);
        expect(ctx.ops.filter((op) => op.startsWith('stroke')).length).toBeGreaterThan(0);
        const shafts = ctx.segments.filter(([x0, , x1]) => Math.abs(x1 - x0) < 1e-6);
        expect(shafts.length).toBeGreaterThan(20);
        for (const [, y0, , y1] of shafts) expect(y1).toBeLessThan(y0);
        expect(ctx.strokes.every((colour) => colour === '#ffffff')).toBe(true);
        // A settle redraws it; still no loop.
        ctx.segments = [];
        map.emit('move');
        expect(ctx.segments.length).toBeGreaterThan(0);
        expect(frames.size).toBe(0);
        layer.destroy();
    });

    it('hands over with a delayed fade, can be called back mid-fade, and leaves nothing behind', () => {
        vi.useFakeTimers();
        const { container, map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        const done = vi.fn();
        layer.release(600, done);
        vi.advanceTimersByTime(599);
        expect(layer.element.style.opacity).toBe('1');
        vi.advanceTimersByTime(1);
        expect(layer.element.style.opacity).toBe('0');
        // Zoomed back in during the fade: the same layer comes back.
        layer.show();
        vi.advanceTimersByTime(2000);
        expect(done).not.toHaveBeenCalled();
        expect(container.contains(layer.element)).toBe(true);
        layer.release(600, done);
        vi.advanceTimersByTime(1000);
        expect(done).toHaveBeenCalledOnce();
        expect(container.contains(layer.element)).toBe(false);
        expect(map.listenerTotal()).toBe(0);
        expect(frames.size).toBe(0);
    });

    it('a lost local wind clears the streaks at once and stops the loop, instead of freezing the last frame', () => {
        // Review 2026-10-06: the screen centre left the grid (or the boat feed
        // died) and the last frame stayed painted, frozen, panning with the chart.
        const { map, camera } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 12, fromDeg: 135 });
        for (let i = 0; i < 10; i += 1) layer.stepFrame();
        ctx.ops = [];
        layer.setWind(null);
        expect(ctx.ops).toContain('clear');
        expect(layer.particleCount).toBe(0);
        expect(frames.size).toBe(0);
        ctx.ops = [];
        for (let i = 0; i < 120; i += 1) layer.stepFrame();
        camera.x = 30;
        map.emit('move');
        map.emit('resize');
        expect(ctx.ops.filter((op) => op.startsWith('stroke'))).toHaveLength(0);
        expect(ctx.ops).not.toContain('drawImage:copy');
        expect(layer.particleCount).toBe(0);
        expect(frames.size).toBe(0);
        // The wind comes back: the field and the loop come back with it.
        layer.setWind({ kt: 12, fromDeg: 135 });
        expect(layer.particleCount).toBe(closeInParticleCount(390, 844, 12, 1));
        expect(frames.size).toBe(1);
        expect(layer.velocity.y).toBeLessThan(0);
        layer.destroy();
    });

    it('reduced motion: a lost local wind clears the arrows too', () => {
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options({ reducedMotion: true }));
        layer.show();
        layer.setWind({ kt: 12, fromDeg: 180 });
        ctx.ops = [];
        ctx.segments = [];
        layer.setWind(null);
        expect(ctx.ops).toContain('clear');
        expect(ctx.segments).toHaveLength(0);
        layer.destroy();
    });

    it('stops the loop while the chart is kept alive hidden at 0x0, and resumes at size', () => {
        // App.tsx keeps Obs mounted under display:none while The Glass shows.
        const { map, size } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        expect(frames.size).toBe(1);
        size.w = 0;
        size.h = 0;
        map.emit('resize');
        expect(frames.size).toBe(0);
        size.w = 390;
        size.h = 844;
        map.emit('resize');
        expect(frames.size).toBe(1);
        expect(layer.particleCount).toBe(closeInParticleCount(390, 844, 8, 1));
        layer.destroy();
        expect(frames.size).toBe(0);
    });

    it('destroy is immediate and idempotent', () => {
        const { container, map } = harness();
        const layer = new CloseInWindLayer(map, options());
        layer.show();
        layer.setWind({ kt: 8, fromDeg: 135 });
        layer.destroy();
        layer.destroy();
        expect(container.children).toHaveLength(0);
        expect(map.listenerTotal()).toBe(0);
        expect(frames.size).toBe(0);
    });
});

// The desk's Light base (127-DESKMAP-b): white streaks vanish on a pale sea.
describe('CloseInWindLayer on a light base', () => {
    it('draws in the light palette’s dark ink, and the warning hue from the reef line up', async () => {
        const { WIND_PARTICLE_COLORS_LIGHT } = await import('../components/map/windRamp');
        const { map } = harness();
        const layer = new CloseInWindLayer(map, options({ reducedMotion: true, palette: 'light' }));
        layer.show();
        layer.setWind({ kt: 12, fromDeg: 180 });
        expect(ctx.strokes.length).toBeGreaterThan(0);
        expect(new Set(ctx.strokes)).toEqual(new Set([WIND_PARTICLE_COLORS_LIGHT[0]]));
        ctx.strokes = [];
        layer.setWind({ kt: 26, fromDeg: 180 });
        expect(new Set(ctx.strokes)).toEqual(new Set([WIND_PARTICLE_COLORS_LIGHT[26]]));
        layer.destroy();
    });
});
