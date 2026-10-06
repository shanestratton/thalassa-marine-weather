/**
 * CloseInWindLayer — the Obs wind once the screen sits inside a forecast grid
 * cell or two (see closeInWind.ts for when, and why leaflet-velocity's geo
 * field fails there).
 *
 * The local wind is drawn in SCREEN space: one uniform flow across the whole
 * view, downwind, at an on-screen speed that grows with the wind, with a fixed
 * density. Everything else is the leaflet field's, on purpose, so the handover
 * reads as the same layer: a DOM overlay at z-index 400 with the same rim, a
 * CSS-pixel canvas, the same 1 px stroke, the same streak palette, and the
 * same frame recipe — keep `fade` of what is drawn ('destination-in' at the
 * 0.9 x fade alpha the library carries over from the previous frame), then
 * draw additively. Same 30 fps cadence, same 60-frame particle life.
 *
 * Panning carries the streaks with the water; a pinch rescales them about the
 * camera. prefers-reduced-motion draws a static arrow field and never starts
 * the animation loop. A hidden app stops the loop.
 */
import { CLOSE_IN_CALM_KT, closeInParticleCount, closeInScreenSpeed, type LocalWind } from './closeInWind';
import { windParticleColorForKt } from './windRamp';

export interface CloseInWindMap {
    getContainer(): HTMLElement;
    getCenter(): { lng: number; lat: number };
    getZoom(): number;
    getBearing?(): number;
    project(lngLat: [number, number]): { x: number; y: number };
    on(type: string, listener: () => void): unknown;
    off(type: string, listener: () => void): unknown;
}

export interface CloseInWindLayerOptions {
    /** The overlay's CSS filter — MapboxVelocityOverlay's PARTICLE_HALO. */
    filter?: string;
    /** MapboxVelocityOverlay's PARTICLE_FADE. */
    fade?: number;
    /** MapboxVelocityOverlay's PARTICLE_LINE_WIDTH. */
    lineWidth?: number;
    /** utils/deviceTier particleScale(). */
    tierScale?: number;
    reducedMotion?: boolean;
    frameRate?: number;
    random?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
}

interface Particle {
    x: number;
    y: number;
    age: number;
    /** Per-streak pace, 0.85-1.15. */
    k: number;
}

/** leaflet-velocity's particleAge as MapboxVelocityOverlay sets it. */
const MAX_AGE_FRAMES = 60;
/** The overlay's own opacity transition. */
const FADE_MS = 400;
/** Fraction of the gap to a new wind vector closed each frame (~0.4 s to settle at 30 fps). */
const EASE = 0.18;
const ARROW_SPACING_PX = 64;
const ARROW_LENGTH_PX = 20;
const ARROW_HEAD_PX = 5;
const ARROW_LINE_WIDTH = 1.5;

export class CloseInWindLayer {
    readonly element: HTMLDivElement;
    readonly map: CloseInWindMap;
    private readonly canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | null;
    private readonly fade: number;
    private readonly lineWidth: number;
    private readonly tierScale: number;
    private readonly reducedMotion: boolean;
    private readonly frameTime: number;
    private readonly random: () => number;
    private readonly requestFrame: (callback: FrameRequestCallback) => number;
    private readonly cancelFrame: (id: number) => void;

    private width = 0;
    private height = 0;
    private particles: Particle[] = [];
    private wind: LocalWind | null = null;
    private colour = '#ffffff';
    private vx = 0;
    private vy = 0;
    private targetVx = 0;
    private targetVy = 0;
    private frameId: number | null = null;
    private then = 0;
    private shown = false;
    private destroyed = false;
    private releaseTimers: Array<ReturnType<typeof setTimeout>> = [];
    private sizeObserver: ResizeObserver | null = null;
    /** Camera tracking: a geo anchor and where it was last drawn. */
    private anchor: { lng: number; lat: number } | null = null;
    private anchorPx = { x: 0, y: 0 };
    private anchorZoom = 0;
    private latticeOffset = { x: 0, y: 0 };

    constructor(map: CloseInWindMap, options: CloseInWindLayerOptions = {}) {
        this.map = map;
        this.fade = options.fade ?? 0.98;
        this.lineWidth = options.lineWidth ?? 1;
        this.tierScale = options.tierScale ?? 1;
        this.reducedMotion = options.reducedMotion ?? false;
        this.frameTime = 1000 / (options.frameRate ?? 30);
        this.random = options.random ?? Math.random;
        const raf = typeof requestAnimationFrame === 'function';
        this.requestFrame =
            options.requestFrame ??
            ((callback) =>
                raf
                    ? requestAnimationFrame(callback)
                    : (setTimeout(() => callback(performance.now()), this.frameTime) as unknown as number));
        this.cancelFrame =
            options.cancelFrame ??
            ((id) => (raf ? cancelAnimationFrame(id) : clearTimeout(id as unknown as ReturnType<typeof setTimeout>)));

        const element = document.createElement('div');
        element.style.position = 'absolute';
        element.style.inset = '0';
        element.style.zIndex = '400';
        element.style.pointerEvents = 'none';
        element.style.opacity = '0';
        element.style.transition = `opacity ${FADE_MS / 1000}s ease`;
        if (options.filter) element.style.filter = options.filter;
        element.dataset.closeInWind = 'true';
        element.dataset.motion = this.reducedMotion ? 'static' : 'flow';
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.inset = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        element.appendChild(canvas);
        this.element = element;
        this.canvas = canvas;
        this.ctx = null;
    }

    private get calm(): boolean {
        return !this.wind || this.wind.kt < CLOSE_IN_CALM_KT;
    }

    /** Current motion, CSS px per frame (eased toward the wind). */
    get velocity(): { x: number; y: number } {
        return { x: this.vx, y: this.vy };
    }

    get particleCount(): number {
        return this.particles.length;
    }

    particlePositions(): Array<{ x: number; y: number }> {
        return this.particles.map(({ x, y }) => ({ x, y }));
    }

    /** Fade in (or come back mid-fade-out). */
    show(): void {
        if (this.destroyed) return;
        this.clearRelease();
        const container = this.map.getContainer();
        if (this.element.parentNode !== container) {
            container.appendChild(this.element);
            this.map.on('move', this.onMove);
            this.map.on('moveend', this.onMoveEnd);
            this.map.on('resize', this.onResize);
            document.addEventListener('visibilitychange', this.onVisibility);
            if (typeof ResizeObserver !== 'undefined') {
                this.sizeObserver = new ResizeObserver(() => this.onResize());
                this.sizeObserver.observe(container);
            }
            this.resize();
            this.resetAnchor();
        }
        // Commit opacity 0 first so the transition runs.
        void this.element.offsetWidth;
        this.element.style.opacity = '1';
        this.shown = true;
        if (this.reducedMotion) this.drawStatic();
        else this.startLoop();
    }

    /** The local wind, or null for none (nothing drawn). */
    setWind(wind: LocalWind | null): void {
        if (this.destroyed) return;
        const first = this.wind === null;
        this.wind = wind ? { kt: wind.kt, fromDeg: wind.fromDeg } : null;
        const kt = wind?.kt ?? 0;
        this.colour = windParticleColorForKt(kt);
        const perFrame = (closeInScreenSpeed(kt) * this.frameTime) / 1000;
        const calm = !wind || kt < CLOSE_IN_CALM_KT || wind.fromDeg === null;
        // Calm with no direction keeps drifting the way it was going, slowly.
        const heading = calm && (wind?.fromDeg ?? null) === null ? this.currentScreenAngle() : this.screenAngle(wind!);
        this.targetVx = wind ? Math.cos(heading) * perFrame : 0;
        this.targetVy = wind ? Math.sin(heading) * perFrame : 0;
        if (first) {
            this.vx = this.targetVx;
            this.vy = this.targetVy;
        }
        this.fitPopulation();
        if (this.reducedMotion && this.shown) this.drawStatic();
    }

    /** Hand over to the leaflet field: wait `delayMs` while it fades in, fade out, then destroy. */
    release(delayMs: number, onDone?: () => void): void {
        if (this.destroyed) return;
        this.clearRelease();
        this.releaseTimers.push(
            setTimeout(() => {
                this.element.style.opacity = '0';
                this.releaseTimers.push(
                    setTimeout(() => {
                        this.destroy();
                        onDone?.();
                    }, FADE_MS),
                );
            }, delayMs),
        );
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.shown = false;
        this.clearRelease();
        this.stopLoop();
        this.map.off('move', this.onMove);
        this.map.off('moveend', this.onMoveEnd);
        this.map.off('resize', this.onResize);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.sizeObserver?.disconnect();
        this.sizeObserver = null;
        this.element.parentNode?.removeChild(this.element);
        this.particles = [];
    }

    /** One animation frame: the test seam, and the loop's body. */
    stepFrame(): void {
        if (!this.wind || this.width <= 0 || this.height <= 0) return;
        this.vx += (this.targetVx - this.vx) * EASE;
        this.vy += (this.targetVy - this.vy) * EASE;
        const ctx = this.ctx;
        if (ctx) {
            ctx.globalCompositeOperation = 'destination-in';
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.9 * this.fade;
            ctx.strokeStyle = this.colour;
            // Calm streaks barely move: round caps keep them as soft dots
            // rather than sub-pixel slivers the fade erases.
            ctx.lineCap = this.calm ? 'round' : 'butt';
            ctx.beginPath();
        }
        for (const p of this.particles) {
            p.age += 1;
            if (p.age > MAX_AGE_FRAMES || p.x < 0 || p.y < 0 || p.x > this.width || p.y > this.height) this.spawn(p);
            const nx = p.x + this.vx * p.k;
            const ny = p.y + this.vy * p.k;
            if (ctx) {
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(nx, ny);
            }
            p.x = nx;
            p.y = ny;
        }
        ctx?.stroke();
    }

    // ── internals ──

    private screenAngle(wind: LocalWind): number {
        const bearing = this.map.getBearing?.() ?? 0;
        const toDeg = (wind.fromDeg ?? 0) + 180 - (Number.isFinite(bearing) ? bearing : 0);
        // Compass (clockwise from up) → canvas angle (clockwise from +x, y down).
        return ((toDeg - 90) * Math.PI) / 180;
    }

    private currentScreenAngle(): number {
        return this.vx === 0 && this.vy === 0 ? -Math.PI / 2 : Math.atan2(this.vy, this.vx);
    }

    private spawn(p: Particle): void {
        p.x = this.random() * this.width;
        p.y = this.random() * this.height;
        p.age = 0;
    }

    private fitPopulation(): void {
        const target = closeInParticleCount(this.width, this.height, this.wind?.kt ?? 0, this.tierScale);
        if (this.particles.length > target) this.particles.length = target;
        while (this.particles.length < target) {
            this.particles.push({
                x: this.random() * this.width,
                y: this.random() * this.height,
                // leaflet-velocity starts each particle part-way through its life.
                age: Math.floor(this.random() * MAX_AGE_FRAMES),
                k: 0.85 + 0.3 * this.random(),
            });
        }
    }

    private resize(): void {
        const container = this.map.getContainer();
        const width = Math.round(container.clientWidth);
        const height = Math.round(container.clientHeight);
        if (width === this.width && height === this.height && this.ctx) return;
        this.width = width;
        this.height = height;
        // CSS pixels, as leaflet-velocity's canvas: the same 1 px stroke look,
        // and a ninth of the fade fill a 3x backing store would cost per frame.
        this.canvas.width = width;
        this.canvas.height = height;
        // A resize resets the context state; re-apply it.
        this.ctx = this.canvas.getContext('2d');
        if (this.ctx) {
            this.ctx.lineWidth = this.lineWidth;
            this.ctx.fillStyle = `rgba(0, 0, 0, ${this.fade})`;
            // The library fades at the alpha it drew with the frame before.
            this.ctx.globalAlpha = 0.9 * this.fade;
        }
        this.particles = [];
        this.fitPopulation();
        if (this.reducedMotion && this.shown) this.drawStatic();
    }

    private resetAnchor(): void {
        try {
            const c = this.map.getCenter();
            this.anchor = { lng: c.lng, lat: c.lat };
            this.anchorPx = this.map.project([c.lng, c.lat]);
            this.anchorZoom = this.map.getZoom();
        } catch {
            this.anchor = null;
        }
    }

    private readonly onMove = (): void => {
        if (!this.anchor) return;
        let p: { x: number; y: number };
        let zoom: number;
        try {
            p = this.map.project([this.anchor.lng, this.anchor.lat]);
            zoom = this.map.getZoom();
        } catch {
            return;
        }
        const s = Math.pow(2, zoom - this.anchorZoom);
        if (!Number.isFinite(s) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
        // Carry each streak with the water: scale about the anchor, then pan.
        for (const q of this.particles) {
            q.x = p.x + (q.x - this.anchorPx.x) * s;
            q.y = p.y + (q.y - this.anchorPx.y) * s;
        }
        this.latticeOffset = {
            x: p.x + (this.latticeOffset.x - this.anchorPx.x) * s,
            y: p.y + (this.latticeOffset.y - this.anchorPx.y) * s,
        };
        const ctx = this.ctx;
        if (ctx && !this.reducedMotion) {
            try {
                // The trails go with them, in one copy of the canvas onto itself.
                ctx.globalCompositeOperation = 'copy';
                ctx.globalAlpha = 1;
                ctx.drawImage(
                    this.canvas,
                    0,
                    0,
                    this.width,
                    this.height,
                    p.x - this.anchorPx.x * s,
                    p.y - this.anchorPx.y * s,
                    this.width * s,
                    this.height * s,
                );
            } catch {
                ctx.clearRect(0, 0, this.width, this.height);
            }
            ctx.globalAlpha = 0.9 * this.fade;
            ctx.globalCompositeOperation = 'lighter';
        }
        this.anchorPx = p;
        this.anchorZoom = zoom;
        if (this.reducedMotion && this.shown) this.drawStatic();
    };

    private readonly onMoveEnd = (): void => {
        // Re-anchor at the new centre so the anchor never drifts far off screen.
        this.onMove();
        this.resetAnchor();
    };

    private readonly onResize = (): void => {
        if (this.destroyed) return;
        this.resize();
        this.resetAnchor();
    };

    private readonly onVisibility = (): void => {
        if (typeof document === 'undefined') return;
        if (document.hidden) this.stopLoop();
        else if (this.shown && !this.reducedMotion) this.startLoop();
    };

    private startLoop(): void {
        if (this.frameId !== null || this.destroyed || this.reducedMotion) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        this.then = 0;
        const tick: FrameRequestCallback = (time) => {
            this.frameId = this.requestFrame(tick);
            if (this.then === 0) this.then = time;
            const elapsed = time - this.then;
            // leaflet-velocity's own throttle: a fixed 30 fps step.
            if (elapsed > this.frameTime) {
                this.then = time - (elapsed % this.frameTime);
                this.stepFrame();
            }
        };
        this.frameId = this.requestFrame(tick);
    }

    private stopLoop(): void {
        if (this.frameId !== null) this.cancelFrame(this.frameId);
        this.frameId = null;
    }

    private clearRelease(): void {
        for (const timer of this.releaseTimers) clearTimeout(timer);
        this.releaseTimers = [];
    }

    /** prefers-reduced-motion: a still lattice of arrows (dots for Calm), carried with the water. */
    private drawStatic(): void {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, this.width, this.height);
        if (!this.wind) return;
        const calm = this.wind.kt < CLOSE_IN_CALM_KT || this.wind.fromDeg === null;
        const angle = calm ? 0 : this.screenAngle(this.wind);
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const mod = (v: number) => ((v % ARROW_SPACING_PX) + ARROW_SPACING_PX) % ARROW_SPACING_PX;
        const ox = mod(this.latticeOffset.x);
        const oy = mod(this.latticeOffset.y);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = this.colour;
        ctx.fillStyle = this.colour;
        ctx.lineWidth = ARROW_LINE_WIDTH;
        ctx.beginPath();
        let row = 0;
        for (let y = oy; y < this.height + ARROW_SPACING_PX; y += ARROW_SPACING_PX, row += 1) {
            // Offset alternate rows so the lattice does not read as a grid of columns.
            const shift = row % 2 ? ARROW_SPACING_PX / 2 : 0;
            for (let x = ox + shift - ARROW_SPACING_PX; x < this.width + ARROW_SPACING_PX; x += ARROW_SPACING_PX) {
                if (calm) {
                    if (row % 2 === 0) ctx.fillRect(x - 1, y - 1, 2, 2);
                    continue;
                }
                const tx = x + (ux * ARROW_LENGTH_PX) / 2;
                const ty = y + (uy * ARROW_LENGTH_PX) / 2;
                ctx.moveTo(x - (ux * ARROW_LENGTH_PX) / 2, y - (uy * ARROW_LENGTH_PX) / 2);
                ctx.lineTo(tx, ty);
                for (const side of [-1, 1]) {
                    const a = angle + Math.PI + side * (Math.PI / 6);
                    ctx.moveTo(tx, ty);
                    ctx.lineTo(tx + Math.cos(a) * ARROW_HEAD_PX, ty + Math.sin(a) * ARROW_HEAD_PX);
                }
            }
        }
        ctx.stroke();
        ctx.lineWidth = this.lineWidth;
        ctx.fillStyle = `rgba(0, 0, 0, ${this.fade})`;
    }
}
