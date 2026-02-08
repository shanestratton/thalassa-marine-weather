
interface Particle {
    lat: number;
    lon: number;
    age: number;
    maxAge: number;
    trail: { x: number, y: number }[];
}

export class ParticleEngine {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private particles: Particle[] = [];
    private requestRef: number | null = null;
    private map: any;
    private activeLayer: 'wind' | 'waves' | 'rain' = 'wind';
    private sampleValue: (lat: number, lon: number, type: string) => number | null;
    private sampleDir: (lat: number, lon: number) => number;

    // Optimization: Dynamic particle count based on device capability
    private particleCount = 2000; // BOOSTED: 600 → 2000 for high visibility
    private isFastMode = false;
    private dpr = 1;

    // Frame Throttling & Battery Saving
    private lastFrameTime = 0;
    private fpsInterval = 1000 / 30; // Cap at 30 FPS for battery conservation
    private isVisible = true;
    private reducedMotion = false;
    private reducedMotionQuery: MediaQueryList | null = null;

    constructor(canvas: HTMLCanvasElement, map: any, sampleVal: any, sampleDir: any) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: true })!;
        this.map = map;
        this.sampleValue = sampleVal;
        this.sampleDir = sampleDir;
        this.dpr = window.devicePixelRatio || 1;

        // --- 1. DEVICE CAPABILITY DETECTION ---
        // Reduce load on mobile or low-concurrency devices
        const isLowPower = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
        const isHighRes = this.dpr > 2;

        if (isLowPower) {
            this.particleCount = 800; // BOOSTED: 300 → 800 for visibility
            this.fpsInterval = 1000 / 20; // 20 FPS throttle
        } else if (isHighRes) {
            this.particleCount = 1400; // BOOSTED: 450 → 1400 for retina
        }

        // --- 2. VISIBILITY API INTEGRATION ---
        // Stop rendering completely when tab is backgrounded
        document.addEventListener('visibilitychange', this.handleVisibilityChange);

        // --- 3. REDUCED MOTION PREFERENCE ---
        this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.reducedMotion = this.reducedMotionQuery.matches;
        this.reducedMotionQuery.addEventListener('change', this.handleReducedMotionChange);

        this.initParticles();
    }

    private handleVisibilityChange = () => {
        if (document.hidden) {
            this.stop();
            this.isVisible = false;
        } else {
            this.isVisible = true;
            this.start();
        }
    }

    private handleReducedMotionChange = (e: MediaQueryListEvent) => {
        this.reducedMotion = e.matches;
        if (this.reducedMotion) {
            this.stop();
            // Render one static frame
            this.renderStaticFrame();
        } else {
            this.start();
        }
    }

    private initParticles() {
        if (!this.map || !this.map.getBounds) return;

        const bounds = this.map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

        this.particles = [];
        for (let i = 0; i < this.particleCount; i++) {
            this.particles.push(this.createParticle(sw, ne));
        }
    }

    private createParticle(sw: any, ne: any): Particle {
        const latBuffer = (ne.lat - sw.lat) * 0.1;
        const lonBuffer = (ne.lng - sw.lng) * 0.1;

        const lat = (sw.lat - latBuffer) + Math.random() * (ne.lat - sw.lat + latBuffer * 2);
        const lon = (sw.lng - lonBuffer) + Math.random() * (ne.lng - sw.lng + lonBuffer * 2);

        return {
            lat,
            lon,
            age: Math.random() * 100,
            maxAge: 60 + Math.random() * 60, // Reduced max age to recycle particles faster
            trail: []
        };
    }

    public setFastMode(on: boolean) {
        this.isFastMode = on;
        if (on) {
            const width = this.canvas.width / this.dpr;
            const height = this.canvas.height / this.dpr;
            this.ctx.clearRect(0, 0, width, height);
        }
    }

    public setLayer(layer: 'wind' | 'waves' | 'rain' | 'global-wind') {
        // Ignore global-wind since particles aren't used for that layer
        if (layer === 'global-wind') return;

        this.activeLayer = layer as 'wind' | 'waves' | 'rain';
        this.particles.forEach(p => p.trail = []);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.sync = this.sync.bind(this); // Ensure context
        this.sync();
    }

    public sync = () => {
        this.particles.forEach(p => p.trail = []);
    }

    public start() {
        if (this.reducedMotion) {
            // Render a single static frame instead of animating
            this.renderStaticFrame();
            return;
        }
        if (!this.requestRef && this.isVisible) {
            this.lastFrameTime = performance.now();
            this.animate(this.lastFrameTime);
        }
    }

    public stop() {
        if (this.requestRef) {
            cancelAnimationFrame(this.requestRef);
            this.requestRef = null;
        }
    }

    // Cleanup listener when component unmounts
    public destroy() {
        this.stop();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        if (this.reducedMotionQuery) {
            this.reducedMotionQuery.removeEventListener('change', this.handleReducedMotionChange);
        }
    }

    // Render a single static snapshot of particle positions
    private renderStaticFrame() {
        try {
            const width = this.canvas.width / this.dpr;
            const height = this.canvas.height / this.dpr;
            this.ctx.save();
            this.ctx.scale(this.dpr, this.dpr);
            this.ctx.clearRect(0, 0, width, height);

            this.particles.forEach(p => {
                const val = this.sampleValue(p.lat, p.lon, this.activeLayer);
                if (!val || val < 0.1) return;
                const pt = this.map.latLngToContainerPoint([p.lat, p.lon]);
                if (pt.x < -10 || pt.x > width + 10 || pt.y < -10 || pt.y > height + 10) return;
                const color = this.getParticleColor(val);
                this.ctx.beginPath();
                this.ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
                this.ctx.fillStyle = color;
                this.ctx.fill();
            });

            this.ctx.restore();
        } catch {
            this.ctx.restore();
        }
    }

    private getParticleColor(val: number): string {
        const a = 0.9; // BOOSTED ALPHA: 0.55 → 0.9 for vivid visibility
        if (this.activeLayer === 'wind') {
            // ENHANCED COLOR PALETTE with higher saturation
            if (val < 3) return `rgba(200, 200, 200, 0.7)`;           // Bright gray (brighter)
            if (val < 8) return `rgba(59, 130, 246, ${a})`;           // Vivid blue
            if (val < 15) return `rgba(16, 185, 129, ${a})`;          // Neon emerald (was green-500)
            if (val < 25) return `rgba(234, 179, 8, ${a})`;           // Bright yellow
            if (val < 35) return `rgba(249, 115, 22, ${a})`;          // Hot orange
            if (val < 45) return `rgba(239, 68, 68, ${a + 0.05})`;    // Glowing red
            return `rgba(217, 70, 239, ${a + 0.1})`;                  // Electric fuchsia (storm)
        } else if (this.activeLayer === 'waves') {
            const wa = 0.85; // BOOSTED: 0.6 → 0.85
            if (val < 2) return `rgba(59, 130, 246, ${wa})`;
            if (val < 6) return `rgba(14, 165, 233, ${wa})`;
            if (val < 12) return `rgba(99, 102, 241, ${wa})`;
            return `rgba(236, 72, 153, ${wa})`;
        } else if (this.activeLayer === 'rain') {
            return `rgba(96, 165, 250, 0.85)`;  // BOOSTED: 0.6 → 0.85
        } else {
            return `rgba(96, 165, 250, 0.85)`;
        }
    }

    private animate = (timestamp: number) => {
        if (!this.isVisible) return;

        // CRITICAL CHECK: Ensure map is still initialized and has panes.
        // Prevents "Cannot read properties of undefined (reading '_leaflet_pos')" error on unmount.
        // Leaflet deletes _mapPane when map.remove() is called.
        if (!this.map || (this.map._mapPane === undefined && this.map.getPane && !this.map.getPane('mapPane'))) {
            this.stop();
            return;
        }

        this.requestRef = requestAnimationFrame(this.animate);

        const elapsed = timestamp - this.lastFrameTime;

        // Throttling logic
        if (elapsed < this.fpsInterval) return;

        this.lastFrameTime = timestamp - (elapsed % this.fpsInterval);

        try {
            const width = this.canvas.width / this.dpr;
            const height = this.canvas.height / this.dpr;

            this.ctx.save();
            this.ctx.scale(this.dpr, this.dpr);

            if (this.isFastMode) {
                this.ctx.clearRect(0, 0, width, height);
                this.ctx.restore();
                return;
            }

            // Optimization: Use clearRect instead of fillRect with alpha for trails
            this.ctx.clearRect(0, 0, width, height);

            this.ctx.lineCap = 'butt';
            this.ctx.lineJoin = 'round';
            this.ctx.globalCompositeOperation = 'source-over';

            const bounds = this.map.getBounds();
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();
            const latBuffer = (ne.lat - sw.lat) * 0.1;
            const lonBuffer = (ne.lng - sw.lng) * 0.1;

            const zoom = this.map.getZoom();

            const latStepBase = 0.0016 * Math.pow(2, 8 - zoom);
            const MAX_TRAIL_LENGTH = 20;

            this.particles.forEach(p => {
                if (p.age >= p.maxAge || p.lat < sw.lat - latBuffer || p.lat > ne.lat + latBuffer || p.lon < sw.lng - lonBuffer || p.lon > ne.lng + lonBuffer) {
                    const np = this.createParticle(sw, ne);
                    Object.assign(p, np);
                    p.age = 0;
                    return;
                }

                const val = this.sampleValue(p.lat, p.lon, this.activeLayer);

                if (!val || val < 0.1) {
                    p.age += 5;
                    return;
                }

                if (this.activeLayer === 'rain') {
                    // Rain Logic
                    const fallSpeed = 0.006 * Math.pow(2, 8 - zoom) * (0.8 + Math.random() * 0.4);
                    p.lat -= fallSpeed;
                    p.age += 1;

                    const pt = this.map.latLngToContainerPoint([p.lat, p.lon]);
                    // Boundary check container space to avoid drawing off-canvas
                    if (pt.x < -10 || pt.x > width + 10 || pt.y < -10 || pt.y > height + 10) return;

                    const dropLen = 5 + (val * 2);

                    this.ctx.beginPath();
                    this.ctx.strokeStyle = `rgba(96, 165, 250, ${Math.min(val * 0.3, 0.9)})`; // BOOSTED opacity
                    this.ctx.lineWidth = 2.0; // THICKER: 1.5 → 2.0
                    this.ctx.moveTo(Math.round(pt.x), Math.round(pt.y));
                    this.ctx.lineTo(Math.round(pt.x), Math.round(pt.y - dropLen));
                    this.ctx.stroke();

                } else {
                    // Wind/Wave Logic
                    const dirFrom = this.sampleDir(p.lat, p.lon);

                    // CORRECTED DIRECTION: Flow WITH the wind
                    const rad = (dirFrom - 90 + 180) * (Math.PI / 180);
                    const u = Math.cos(rad);
                    const v = Math.sin(rad);

                    const speedFactor = Math.min(val, 60) * (this.activeLayer === 'waves' ? 0.3 : 0.8);

                    p.lat -= v * latStepBase * speedFactor;
                    p.lon += u * latStepBase * speedFactor;
                    p.age++;

                    const pt = this.map.latLngToContainerPoint([p.lat, p.lon]);

                    if (p.trail.length === 0) {
                        const startLen = 3;
                        for (let i = startLen; i > 0; i--) {
                            const px = pt.x - (u * i * 3);
                            const py = pt.y - (v * i * 3);
                            p.trail.push({ x: px, y: py });
                        }
                    }

                    // Push current point
                    p.trail.unshift({ x: pt.x, y: pt.y });
                    if (p.trail.length > MAX_TRAIL_LENGTH) {
                        p.trail.pop();
                    }

                    const color = this.getParticleColor(val);

                    if (p.trail.length > 2) {
                        const head = p.trail[0];
                        const tail = p.trail[p.trail.length - 1];

                        const dx = head.x - tail.x;
                        const dy = head.y - tail.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);

                        if (dist > 1 && dist < 300) {
                            this.ctx.beginPath();
                            this.ctx.strokeStyle = color;
                            this.ctx.lineWidth = 1.5; // THICKER: 1.0 → 1.5 for visibility 
                            this.ctx.moveTo(head.x, head.y);

                            for (let i = 1; i < p.trail.length - 1; i++) {
                                const xc = (p.trail[i].x + p.trail[i + 1].x) / 2;
                                const yc = (p.trail[i].y + p.trail[i + 1].y) / 2;
                                this.ctx.quadraticCurveTo(p.trail[i].x, p.trail[i].y, xc, yc);
                            }
                            this.ctx.lineTo(tail.x, tail.y);
                            this.ctx.stroke();
                        }
                    }
                }
            });

            this.ctx.restore();
        } catch (e: any) {
            // Suppress the Leaflet internal destruction error if it happens during animation frame race condition
            if (e.message && (e.message.includes('_leaflet_pos') || e.message.includes('undefined'))) {
                this.stop();
                this.ctx.restore();
                return;
            }
            this.ctx.restore();
        }
    }
}
