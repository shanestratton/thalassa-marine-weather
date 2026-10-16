import type { VelocityGribRecord } from './windVelocityFrame';
import { WIND_MAX_MS, WIND_PARTICLE_COLORS, WIND_PARTICLE_COLORS_LIGHT, type WindPalette } from './windRamp';

type Point = { x: number; y: number };
type Position = { lng: number; lat: number };
export interface WindFieldMap {
    getContainer(): HTMLElement;
    getCenter(): Position;
    getZoom(): number;
    getBearing(): number;
    project(point: [number, number]): Point;
    unproject(point: [number, number]): Position;
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
}
export interface WindFieldOptions {
    palette?: WindPalette;
    filter?: string;
    lineWidth?: number;
    fade?: number;
    velocityScale: (zoom: number) => number;
    particleMultiplier: (zoom: number) => number;
    random?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
}
interface Flow extends Point {
    speed: number;
}
interface Particle extends Point {
    age: number;
}
const STEP = 16;
const FRAME_MS = 1000 / 30;
const MAX_AGE = 60;
const MAX_CANVAS_PIXELS = 16_000_000;
const fields = new WeakMap<WindFieldMap, MapboxWindField>();
/** Local diagnostics/renderer integration only; no global map or coordinate registry. */
export const mapboxWindField = (map: WindFieldMap): MapboxWindField | undefined => fields.get(map);

/** The selected grid is north-to-south. Unknown corners stay unknown, including across 180°. */
export function sampleVelocity(records: VelocityGribRecord[] | null, lon: number, lat: number): Point | null {
    if (!records || records.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const [u, v] = records;
    const h = u.header;
    if (h.nx < 1 || h.ny < 1 || !(h.dx > 0) || !(h.dy > 0)) return null;
    let x = ((((lon - h.lo1) % 360) + 360) % 360) / h.dx;
    let y = (h.la1 - lat) / h.dy;
    const epsilon = 1e-7;
    const cyclic = h.nx * h.dx >= 360 - epsilon;
    if (x > h.nx - 1 + epsilon && !cyclic) return null;
    if (y < -epsilon || y > h.ny - 1 + epsilon) return null;
    x = Math.max(0, Math.min(x, cyclic ? h.nx : h.nx - 1));
    y = Math.max(0, Math.min(y, h.ny - 1));
    const x0 = Math.floor(x) % h.nx;
    const x1 = cyclic ? (x0 + 1) % h.nx : Math.min(x0 + 1, h.nx - 1);
    const y0 = Math.floor(y),
        y1 = Math.min(y0 + 1, h.ny - 1);
    const weights = [
        (1 - (x % 1)) * (1 - (y % 1)),
        (x % 1) * (1 - (y % 1)),
        (1 - (x % 1)) * (y % 1),
        (x % 1) * (y % 1),
    ];
    const indices = [y0 * h.nx + x0, y0 * h.nx + x1, y1 * h.nx + x0, y1 * h.nx + x1];
    let east = 0,
        north = 0;
    for (let i = 0; i < 4; i++) {
        if (!weights[i]) continue;
        if (!Number.isFinite(u.data[indices[i]]) || !Number.isFinite(v.data[indices[i]])) return null;
        east += u.data[indices[i]] * weights[i];
        north += v.data[indices[i]] * weights[i];
    }
    return { x: east, y: north };
}

/** One canvas, on the existing chart. Projection work is bounded to a 16px lattice at camera settles. */
export class MapboxWindField {
    readonly element: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D | null;
    private readonly random: () => number;
    private readonly requestFrame: (callback: FrameRequestCallback) => number;
    private readonly cancelFrame: (id: number) => void;
    private records: VelocityGribRecord[] | null = null;
    private particles: Particle[] = [];
    private vectors: Array<Flow | null> = [];
    private cols = 0;
    private rows = 0;
    private step = STEP;
    private width = 0;
    private height = 0;
    private left = 0;
    private top = 0;
    private anchor: Position = { lng: 0, lat: 0 };
    private anchorPx: Point = { x: 0, y: 0 };
    private zoom = 0;
    private bearing = 0;
    private frame: number | null = null;
    private then = 0;
    private destroyed = false;
    private observer: ResizeObserver | null = null;
    private square = false;
    constructor(
        readonly map: WindFieldMap,
        private readonly options: WindFieldOptions,
    ) {
        this.random = options.random ?? Math.random;
        this.requestFrame = options.requestFrame ?? requestAnimationFrame.bind(window);
        this.cancelFrame = options.cancelFrame ?? cancelAnimationFrame.bind(window);
        this.element = document.createElement('div');
        this.element.dataset.windField = 'true';
        this.element.setAttribute('aria-hidden', 'true');
        Object.assign(this.element.style, {
            position: 'absolute',
            inset: '0',
            zIndex: '400',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'opacity 0.4s ease',
            filter: options.filter ?? '',
        });
        this.canvas = document.createElement('canvas');
        Object.assign(this.canvas.style, { position: 'absolute', transformOrigin: '50% 50%' });
        this.element.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        map.getContainer().appendChild(this.element);
        fields.set(map, this);
        map.on('move', this.onMove);
        map.on('moveend', this.onSettle);
        map.on('resize', this.onSettle);
        document.addEventListener('visibilitychange', this.onVisibility);
        if (typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(this.onSettle);
            this.observer.observe(map.getContainer());
        }
        this.rebuild();
    }
    get particleCount(): number {
        return this.particles.length;
    }
    particlePositions(): Point[] {
        return this.particles.map(({ x, y }) => ({ x, y }));
    }
    /** Where a geographic point was drawn in the current canvas frame, before its camera CSS transform. */
    framePoint([lng, lat]: [number, number]): Point {
        const world = 512 * 2 ** this.zoom;
        const mercatorY = (latitude: number) =>
            0.5 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / (2 * Math.PI);
        const x = ((lng - this.anchor.lng) / 360) * world;
        const y = (mercatorY(lat) - mercatorY(this.anchor.lat)) * world;
        const a = (-this.bearing * Math.PI) / 180;
        return {
            x: this.anchorPx.x - this.left + x * Math.cos(a) - y * Math.sin(a),
            y: this.anchorPx.y - this.top + x * Math.sin(a) + y * Math.cos(a),
        };
    }
    setData(records: VelocityGribRecord[] | null): void {
        if (this.destroyed) return;
        this.records = records;
        this.rebuild();
    }
    private clear(): void {
        this.ctx?.clearRect(0, 0, this.width, this.height);
    }
    private stop(): void {
        if (this.frame !== null) this.cancelFrame(this.frame);
        this.frame = null;
        this.then = 0;
    }
    private get drawable(): boolean {
        return !this.destroyed && !document.hidden && !!this.ctx && !!this.records && this.width > 0 && this.height > 0;
    }
    private readonly onVisibility = (): void => {
        this.stop();
        this.clear();
        if (!document.hidden) this.rebuild();
    };
    private readonly onSettle = (): void => {
        if (!this.destroyed) this.rebuild();
    };
    private readonly onMove = (): void => {
        if (this.destroyed || !this.width) return;
        if (Math.abs(this.map.getBearing()) > 0.01 && !this.square) {
            this.rebuild();
            return;
        }
        const p = this.map.project([this.anchor.lng, this.anchor.lat]);
        const s = 2 ** (this.map.getZoom() - this.zoom);
        const angle = (-(this.map.getBearing() - this.bearing) * Math.PI) / 180;
        const cx = this.left + this.width / 2,
            cy = this.top + this.height / 2;
        const rx = this.anchorPx.x - cx,
            ry = this.anchorPx.y - cy;
        const tx = p.x - cx - s * (rx * Math.cos(angle) - ry * Math.sin(angle));
        const ty = p.y - cy - s * (rx * Math.sin(angle) + ry * Math.cos(angle));
        this.canvas.style.transform = `translate(${tx}px, ${ty}px) rotate(${(angle * 180) / Math.PI}deg) scale(${s})`;
    };
    private rebuild(): void {
        this.stop();
        const container = this.map.getContainer();
        const w = container.clientWidth,
            h = container.clientHeight;
        this.square = Math.abs(this.map.getBearing()) > 0.01;
        const side = Math.ceil(Math.hypot(w, h));
        this.width = w && h ? (this.square ? side : w) : 0;
        this.height = w && h ? (this.square ? side : h) : 0;
        this.left = (w - this.width) / 2;
        this.top = (h - this.height) / 2;
        // Preserve CSS stroke widths on Retina without an unbounded phone/desktop backing store.
        const rasterScale = Math.min(
            2,
            Math.max(1, window.devicePixelRatio || 1),
            this.width && this.height ? Math.sqrt(MAX_CANVAS_PIXELS / (this.width * this.height)) : 1,
            this.width ? 8192 / this.width : 1,
            this.height ? 8192 / this.height : 1,
        );
        this.canvas.width = Math.floor(this.width * rasterScale);
        this.canvas.height = Math.floor(this.height * rasterScale);
        this.ctx?.setTransform(rasterScale, 0, 0, rasterScale, 0, 0);
        this.clear();
        Object.assign(this.canvas.style, {
            width: `${this.width}px`,
            height: `${this.height}px`,
            left: `${this.left}px`,
            top: `${this.top}px`,
            transform: '',
        });
        this.anchor = this.map.getCenter();
        this.anchorPx = this.map.project([this.anchor.lng, this.anchor.lat]);
        this.zoom = this.map.getZoom();
        this.bearing = this.map.getBearing();
        this.particles = [];
        this.vectors = [];
        if (!this.drawable) return;
        const world = 512 * 2 ** this.zoom;
        const centreY =
            (0.5 - Math.log(Math.tan(Math.PI / 4 + (this.anchor.lat * Math.PI) / 360)) / (2 * Math.PI)) * world;
        const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world)));
        const area = Math.abs(
            (this.width / world) *
                2 *
                Math.PI *
                (latitude(centreY - this.height / 2) - latitude(centreY + this.height / 2)),
        );
        const scale = this.options.velocityScale(this.zoom) * area ** 0.4;
        // Large/rotated desktop fields retain coverage at a bounded raster and lattice resolution.
        this.step = Math.max(STEP, Math.ceil(Math.sqrt((this.width * this.height) / 62_500)));
        this.cols = Math.ceil(this.width / this.step) + 1;
        this.rows = Math.ceil(this.height / this.step) + 1;
        for (let row = 0; row < this.rows; row++)
            for (let col = 0; col < this.cols; col++) {
                const x = col * this.step + this.left,
                    y = row * this.step + this.top;
                const p = this.map.unproject([x, y]);
                const wind = sampleVelocity(this.records, p.lng, p.lat);
                if (!wind || Math.abs(p.lat) >= 85.1) {
                    this.vectors.push(null);
                    continue;
                }
                // A local projection derivative keeps equal east/north speeds at 45°,
                // including high latitudes. A five-degree secant visibly bends northward flow.
                const hl = p.lng < 0 ? 0.0001 : -0.0001,
                    hp = p.lat < 0 ? 0.0001 : -0.0001;
                const east = this.map.project([p.lng + hl, p.lat]);
                const north = this.map.project([p.lng, p.lat + hp]);
                const k = Math.cos((p.lat * Math.PI) / 180);
                const vx = (((east.x - x) / hl / k) * wind.x + ((north.x - x) / hp) * wind.y) * scale;
                const vy = (((east.y - y) / hl / k) * wind.x + ((north.y - y) / hp) * wind.y) * scale;
                this.vectors.push(
                    Number.isFinite(vx) && Number.isFinite(vy)
                        ? { x: vx, y: vy, speed: Math.hypot(wind.x, wind.y) }
                        : null,
                );
            }
        const cap = this.square ? Math.min(1, (1.6 * w * h) / (side * side)) : 1;
        const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? (devicePixelRatio || 1) ** (1 / 3) : 1;
        const count = Math.min(
            24_000,
            Math.ceil(Math.round(this.width * this.height * this.options.particleMultiplier(this.zoom) * cap) * mobile),
        );
        for (let i = 0; i < count; i++)
            this.particles.push({
                x: Math.floor(this.random() * this.width),
                y: Math.floor(this.random() * this.height),
                age: Math.floor(this.random() * MAX_AGE),
            });
        if (this.vectors.some(Boolean)) this.frame = this.requestFrame(this.tick);
    }
    private flowAt(x: number, y: number): Flow | null {
        if (x < 0 || y < 0 || x > this.width || y > this.height) return null;
        const col = Math.floor(x / this.step),
            row = Math.floor(y / this.step),
            a = x / this.step - col,
            b = y / this.step - row;
        const ids = [
            row * this.cols + col,
            row * this.cols + col + 1,
            (row + 1) * this.cols + col,
            (row + 1) * this.cols + col + 1,
        ];
        const weights = [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b];
        const out = { x: 0, y: 0, speed: 0 };
        for (let i = 0; i < 4; i++) {
            if (!weights[i]) continue;
            const v = this.vectors[ids[i]];
            if (!v) return null;
            out.x += v.x * weights[i];
            out.y += v.y * weights[i];
            out.speed += v.speed * weights[i];
        }
        return out;
    }
    private readonly tick = (time: number): void => {
        this.frame = null;
        if (!this.drawable) return;
        if (!this.then || time - this.then >= FRAME_MS) {
            this.then = time - (this.then ? (time - this.then) % FRAME_MS : 0);
            const ctx = this.ctx!;
            const fade = this.options.fade ?? 0.98;
            // Preserve the former field's carried alpha and separate Light/dark blend recipes.
            ctx.globalAlpha = fade * 0.9;
            ctx.globalCompositeOperation = 'destination-in';
            ctx.fillStyle = `rgba(0,0,0,${fade})`;
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.globalCompositeOperation = this.options.palette === 'light' ? 'source-over' : 'lighter';
            ctx.lineWidth = this.options.lineWidth ?? 1;
            const colours = this.options.palette === 'light' ? WIND_PARTICLE_COLORS_LIGHT : WIND_PARTICLE_COLORS;
            const buckets: Particle[][] = Array.from({ length: colours.length }, () => []);
            for (const p of this.particles) {
                p.age += 1;
                if (p.age > MAX_AGE) {
                    p.x = Math.floor(this.random() * this.width);
                    p.y = Math.floor(this.random() * this.height);
                    p.age = 0;
                }
                const wind = this.flowAt(p.x, p.y);
                if (!wind) {
                    p.age = MAX_AGE + 1;
                    continue;
                }
                buckets[
                    Math.min(colours.length - 1, Math.max(0, Math.floor((colours.length * wind.speed) / WIND_MAX_MS)))
                ].push(p);
            }
            buckets.forEach((bucket, i) => {
                if (!bucket.length) return;
                ctx.beginPath();
                ctx.strokeStyle = colours[i];
                for (const p of bucket) {
                    const v = this.flowAt(p.x, p.y)!;
                    ctx.moveTo(p.x, p.y);
                    p.x += v.x;
                    p.y += v.y;
                    ctx.lineTo(p.x, p.y);
                }
                ctx.stroke();
            });
        }
        this.frame = this.requestFrame(this.tick);
    };
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.stop();
        this.observer?.disconnect();
        this.map.off('move', this.onMove);
        this.map.off('moveend', this.onSettle);
        this.map.off('resize', this.onSettle);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.clear();
        this.particles = [];
        this.vectors = [];
        this.records = null;
        if (fields.get(this.map) === this) fields.delete(this.map);
        this.element.remove();
    }
}
