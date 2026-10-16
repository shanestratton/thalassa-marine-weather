/** Actual production Canvas2D field, deterministic frames, generated grids, no map/network. */
import { MapboxWindField, type WindFieldMap } from '../../components/map/MapboxWindField';
import type { VelocityGribRecord } from '../../components/map/windVelocityFrame';
if (!import.meta.env.DEV) throw Error('Development fixture only');
Object.assign(document.body.style, {
    margin: '12px',
    display: 'grid',
    gridTemplateColumns: '360px 360px',
    gap: '16px',
    background: '#fff',
    fontFamily: 'sans-serif',
});
const states: Array<{
    field: MapboxWindField;
    frames: Map<number, FrameRequestCallback>;
    records: VelocityGribRecord[];
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
    const section = document.createElement('section');
    section.dataset.case = name;
    const label = document.createElement('h2');
    label.textContent = name;
    label.style.fontSize = '14px';
    const container = document.createElement('div');
    Object.assign(container.style, {
        position: 'relative',
        width: '360px',
        height: '240px',
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
            return { x: 180 + (p.x - centre.x) * world, y: 120 + (p.y - centre.y) * world };
        },
        unproject: ([x, y]) => ({
            lng: (centre.x + (x - 180) / world) * 360 - 180,
            lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * (centre.y + (y - 120) / world)))) * 180) / Math.PI,
        }),
        on: () => undefined,
        off: () => undefined,
    };
    let seed = 1,
        id = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const field = new MapboxWindField(map, {
        palette: light ? 'light' : 'dark',
        filter: filtered
            ? light
                ? 'drop-shadow(0 0 0.75px rgba(255,255,255,0.7))'
                : 'drop-shadow(0 0 0.75px rgba(0,0,0,0.55))'
            : '',
        lineWidth: light ? 1.5 : 1,
        fade: 0.98,
        velocityScale: () => 0.02,
        particleMultiplier: () => 0.002,
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
    field.element.style.transition = 'none';
    field.element.style.opacity = '1';
    const records = [0, 1].map((component) => ({
        header: {
            nx: 2,
            ny: 5,
            dx: 2,
            dy: 0.1,
            lo1: -1,
            lo2: 1,
            la1: 0.2,
            la2: -0.2,
            parameterCategory: 2,
            parameterNumber: component + 2,
            parameterNumberName: component ? 'V' : 'U',
        },
        data: Array.from({ length: 10 }, (_, i) => (component ? 0 : ((light && i < 4 ? 26 : 12) * 1852) / 3600)),
    }));
    states.push({ field, frames, records });
}
// Let the real ResizeObservers settle before the deterministic production frames.
await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
for (const state of states) {
    state.field.setData(state.records);
    for (let frame = 1; frame <= 120; frame++) {
        const callbacks = [...state.frames.values()];
        state.frames.clear();
        callbacks.forEach((callback) => callback(frame * 40));
    }
}
document.body.dataset.ready = 'true';
