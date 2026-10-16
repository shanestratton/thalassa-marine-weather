/** Actual production Canvas2D field, deterministic frames, generated grids, no map/network. */
import { MapboxWindField, type WindFieldMap } from '../../components/map/MapboxWindField';
import { zoomCompensatedVelocityScale, zoomScaledParticleMultiplier } from '../../components/map/MapboxVelocityOverlay';
import type { VelocityGribRecord } from '../../components/map/windVelocityFrame';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const params = new URLSearchParams(location.search);
const large = params.has('large');
const variant = params.get('variant') ?? 'baseline';
const performanceRun = params.has('performance');
const mobile = params.has('mobile');
const width = performanceRun ? (mobile ? 375 : 1440) : large ? 1440 : 360;
const height = performanceRun ? (mobile ? 667 : 900) : large ? 835 : 240;
Object.assign(document.body.style, {
    margin: '12px',
    display: 'grid',
    gridTemplateColumns: `${width}px ${width}px`,
    gap: '16px',
    background: '#fff',
    fontFamily: 'sans-serif',
});
const states: Array<{
    field: MapboxWindField;
    frames: Map<number, FrameRequestCallback>;
    records: VelocityGribRecord[];
    section: HTMLElement;
}> = [];
const world = 512 * 2 ** 9;
const mercator = (lng: number, lat: number) => ({
    x: (lng + 180) / 360,
    y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
});
const centre = mercator(0, 0);
for (const [name, light, filtered] of [
    ['light-filter', true, true],
    ['light-bare', true, false],
    ['dark-filter', false, true],
    ['dark-bare', false, false],
] as const) {
    if (performanceRun && name !== (params.get('palette') === 'light' ? 'light-filter' : 'dark-filter')) continue;
    const section = document.createElement('section');
    section.dataset.case = name;
    const label = document.createElement('h2');
    label.textContent = name;
    label.style.fontSize = '14px';
    const container = document.createElement('div');
    Object.assign(container.style, {
        position: 'relative',
        width: `${width}px`,
        height: `${height}px`,
        overflow: 'hidden',
        background: light ? '#d9e8ea' : '#0d2b45',
    });
    section.append(label, container);
    document.body.append(section);
    const map: WindFieldMap = {
        getContainer: () => container,
        getCenter: () => ({ lng: 0, lat: 0 }),
        getZoom: () => 9,
        getBearing: () => 0,
        project: ([lng, lat]) => {
            const p = mercator(lng, lat);
            return { x: width / 2 + (p.x - centre.x) * world, y: height / 2 + (p.y - centre.y) * world };
        },
        unproject: ([x, y]) => ({
            lng: (centre.x + (x - width / 2) / world) * 360 - 180,
            lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * (centre.y + (y - height / 2) / world)))) * 180) / Math.PI,
        }),
        on: () => undefined,
        off: () => undefined,
    };
    let seed = 1,
        id = 0;
    const frames = new Map<number, FrameRequestCallback>();
    // Diagnostic wrappers select a native backing/context path, never change any ink values.
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const diagnosticGetContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        const context = Reflect.apply(
            originalGetContext,
            this,
            kind === '2d' && variant === 'readback' ? [kind, { willReadFrequently: true }] : [kind, ...args],
        );
        if (kind !== '2d' || !context || !['state', 'path'].includes(variant)) return context;
        const native = context as CanvasRenderingContext2D;
        let path = new Path2D();
        return new Proxy(native, {
            get(target, key) {
                if (variant === 'path') {
                    if (key === 'beginPath')
                        return () => {
                            path = new Path2D();
                        };
                    if (key === 'moveTo' || key === 'lineTo') return (x: number, y: number) => path[key](x, y);
                    if (key === 'stroke') return () => target.stroke(path);
                }
                if (variant === 'state' && (key === 'stroke' || key === 'fillRect'))
                    return (...values: unknown[]) => {
                        Reflect.apply(target[key], target, values);
                        target.restore();
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, key, value) {
                if (variant === 'state' && (key === 'strokeStyle' || key === 'fillStyle')) target.save();
                return Reflect.set(target, key, value, target);
            },
        });
    };
    HTMLCanvasElement.prototype.getContext = diagnosticGetContext as typeof originalGetContext;
    const field = new MapboxWindField(map, {
        palette: light ? 'light' : 'dark',
        filter: filtered
            ? light
                ? 'drop-shadow(0 0 0.75px rgba(255,255,255,0.7))'
                : 'drop-shadow(0 0 0.75px rgba(0,0,0,0.55))'
            : '',
        lineWidth: light ? 1.5 : 1,
        fade: 0.98,
        velocityScale: performanceRun ? zoomCompensatedVelocityScale : () => 0.02,
        particleMultiplier: performanceRun ? zoomScaledParticleMultiplier : () => 0.002,
        random: () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32,
        requestFrame: (callback) => {
            const next = ++id;
            frames.set(next, callback);
            return next;
        },
        cancelFrame: (next) => {
            frames.delete(next);
        },
    });
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    field.element.style.transition = 'none';
    field.element.style.opacity = '1';
    const records = [0, 1].map((component) => ({
        header: {
            nx: 2,
            ny: large ? 17 : 5,
            dx: large ? 4 : 2,
            dy: large ? 0.175 : 0.1,
            lo1: large ? -2 : -1,
            lo2: large ? 2 : 1,
            la1: large ? 1.4 : 0.2,
            la2: large ? -1.4 : -0.2,
            parameterCategory: 2,
            parameterNumber: component + 2,
            parameterNumberName: component ? 'V' : 'U',
        },
        data: Array.from({ length: large ? 34 : 10 }, (_, i) => {
            const speed = ((light && i < (large ? 16 : 4) ? 26 : 12) * 1852) / 3600;
            return large ? speed / Math.SQRT2 : component ? 0 : speed;
        }),
    }));
    states.push({ field, frames, records, section });
}
// Let the real ResizeObservers settle before the deterministic production frames.
await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
for (const state of states) {
    state.field.setData(state.records);
    const costs: number[] = [];
    const gaps: number[] = [];
    let prior = performance.now();
    for (let frame = 1; frame <= (performanceRun ? 120 : large ? 24 : 120); frame++) {
        if (large)
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const at = performance.now();
        if (frame > 1) gaps.push(at - prior);
        prior = at;
        const callbacks = [...state.frames.values()];
        state.frames.clear();
        callbacks.forEach((callback) => callback(frame * 40));
        costs.push(performance.now() - at);
    }
    state.section.dataset.performance = JSON.stringify({ costs, gaps, count: state.field.particleCount });
}
document.body.dataset.ready = 'true';
