/**
 * CurrentParticleLayer — Mapbox custom WebGL layer for ocean-current
 * particle animation. Forked from WindParticleLayer to escape wind-specific
 * tuning (60 m/s scale, 0.3 kt kill threshold, uniform spawn) that made
 * narrow ocean features like the East Australian Current invisible.
 *
 * Differences from WindParticleLayer:
 *   – No multi-hour timeline / texture blending. Currents are set one hour
 *     at a time via setCurrents(); scrubbing swaps the active hour.
 *   – No heatmap background. The Copernicus RIP/SLACK legend is rendered
 *     as a separate DOM chip — particles tell the direction story.
 *   – Speed-weighted spawn: particles concentrate where currents are fast
 *     (EAC, Gulf Stream, ACC) instead of distributing uniformly across
 *     stagnant gyres. Without this, a 50-cell EAC would only get ~20 of
 *     30k particles and disappear visually.
 *   – Land mask is REQUIRED (not optional). CMEMS land cells = (0,0) which
 *     would otherwise spawn static "stalled" particles all over the map.
 *   – Currents-tuned constants: 0.005 advection factor for m/s currents,
 *     0.02 kt kill threshold, 50k particles, 20-frame trails.
 *   – Color ramp matches the RIP/SLACK legend: blue→cyan→amber→red.
 *
 * Same wire-protocol with the rest of the app — implements
 * mapboxgl.CustomLayerInterface, called by the existing scrubber/UI.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('CurrentParticleLayer');

// ── Tunable constants ─────────────────────────────────────────────────
//
// Each is a deliberate departure from WindParticleLayer's wind defaults.
const NUM_PARTICLES = 50000;
const TRAIL_LENGTH = 20;
const FLOATS_PER_TRAIL_PT = 4; // x, y, speed (m/s), alpha
const FLOATS_PER_PARTICLE = TRAIL_LENGTH * FLOATS_PER_TRAIL_PT;
const TOTAL_POINTS = NUM_PARTICLES * TRAIL_LENGTH;

/** Per-frame displacement = u * SPEED_FACTOR * cosLat. Calibrated so a
 *  1 m/s real current advances ~0.005 normalized units/frame at the
 *  equator → particle crosses a 360° span in ~2 minutes at 15fps.
 *  This is 20× the WindParticleLayer factor (0.00025) which was tuned
 *  for 15 m/s wind. */
const SPEED_FACTOR = 0.005;

/** m/s threshold below which a particle is considered stalled and gets
 *  respawned. 0.01 m/s ≈ 0.02 kt — orders of magnitude lower than the
 *  wind layer's 0.3 kt because most of the open ocean is in this range
 *  and we still want particles there. */
const STALL_KILL_M_S = 0.01;

/** Probability per frame of a random respawn — keeps the field shuffled
 *  so you don't see the same trajectory pattern forever. */
const RANDOM_DROP_RATE = 0.003;

/** Particle color ramp boundaries (m/s). Below SLACK = deep blue,
 *  between SLACK and STRONG = amber gradient, above STRONG = bright red.
 *  Matches the RIP/SLACK legend chip in MapHub. */
const SPEED_SLACK_M_S = 0.1;
const SPEED_STRONG_M_S = 1.5;

const MAX_AGE_FRAMES = 200;

// ── Shaders ───────────────────────────────────────────────────────────

const PARTICLE_VERT = `
precision highp float;
attribute vec2 a_particle_pos;     // normalized [0,1] in grid space
attribute float a_particle_speed;  // m/s
attribute float a_particle_alpha;
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds;        // [south, north, west, east]
uniform float u_zoom;
uniform float u_lon_offset;        // for global-mode world copies
varying float v_speed;
varying float v_alpha;

const float PI = 3.14159265359;

vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    // u_grid_bounds.x = south, .y = north → ny=0 maps to south, ny=1 to north
    float lat = u_grid_bounds.x + a_particle_pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    float lon = u_grid_bounds.z + a_particle_pos.x * (u_grid_bounds.w - u_grid_bounds.z) + u_lon_offset;

    // Cull polar-degenerate zones and zero-alpha particles.
    if (lat < -85.0 || lat > 85.0 || a_particle_alpha <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }

    v_speed = a_particle_speed;
    v_alpha = a_particle_alpha;
    vec2 merc = toMercator(lon, lat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
    // 2.5px at zoom ≤3, growing to 5px at zoom ≥10. Matches user expectation
    // that zooming in shows finer detail.
    gl_PointSize = mix(2.5, 5.0, clamp((u_zoom - 3.0) / 7.0, 0.0, 1.0));
}`;

const PARTICLE_FRAG = `
precision highp float;
varying float v_speed;   // m/s
varying float v_alpha;
uniform float u_speed_slack;
uniform float u_speed_strong;

void main() {
    // Speed bucket: 0..1 mapping from SLACK to STRONG.
    float t = clamp((v_speed - u_speed_slack) / (u_speed_strong - u_speed_slack), 0.0, 1.0);

    // RIP/SLACK gradient: deep cyan/blue (slack) → cyan → amber → red (rip).
    vec3 slack = vec3(0.30, 0.55, 0.85);    // calm cyan-blue
    vec3 mid   = vec3(0.95, 0.85, 0.50);    // warm amber
    vec3 rip   = vec3(0.95, 0.35, 0.30);    // coral red
    vec3 color = t < 0.5
        ? mix(slack, mid, t * 2.0)
        : mix(mid, rip, (t - 0.5) * 2.0);

    // Alpha boosted with speed — slow particles dimmer, fast more visible.
    float alpha = v_alpha * mix(0.45, 0.9, t);
    gl_FragColor = vec4(color, alpha);
}`;

// ── Helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, label: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`[CurrentParticleLayer] failed to create ${label}`);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`[CurrentParticleLayer] ${label}: ${info}`);
    }
    return shader;
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error('[CurrentParticleLayer] failed to create program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[CurrentParticleLayer] link: ${info}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
}

interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── Main Layer ────────────────────────────────────────────────────────

export class CurrentParticleLayer implements mapboxgl.CustomLayerInterface {
    readonly id: string;
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    private map: mapboxgl.Map | null = null;
    private gl: WebGLRenderingContext | null = null;

    private program: WebGLProgram | null = null;
    private particleBuffer: WebGLBuffer | null = null;
    private particleVAO: WebGLVertexArrayObject | null = null;

    // Attribute / uniform locations
    private aPosLoc = -1;
    private aSpeedLoc = -1;
    private aAlphaLoc = -1;
    private uMatrixLoc: WebGLUniformLocation | null = null;
    private uGridBoundsLoc: WebGLUniformLocation | null = null;
    private uZoomLoc: WebGLUniformLocation | null = null;
    private uLonOffsetLoc: WebGLUniformLocation | null = null;
    private uSpeedSlackLoc: WebGLUniformLocation | null = null;
    private uSpeedStrongLoc: WebGLUniformLocation | null = null;

    // CPU-side particle state
    private trailData = new Float32Array(NUM_PARTICLES * FLOATS_PER_PARTICLE);
    private particleAges = new Int32Array(NUM_PARTICLES);

    // Current data
    private gridBounds: Bounds = { north: 0, south: 0, east: 0, west: 0 };
    private gridU: Float32Array | null = null;
    private gridV: Float32Array | null = null;
    private gridSpeed: Float32Array | null = null;
    private landMask: Uint8Array | null = null;
    private gridW = 0;
    private gridH = 0;
    private globalMode = false;

    /** Cumulative-speed array for weighted spawn (size = ocean cells + 1).
     *  spawnCDF[i] = sum of speeds in first i ocean cells. Inverse-CDF
     *  sample produces position weighted by speed. */
    private spawnCDF: Float32Array | null = null;
    /** Maps weighted-CDF index → flat grid index of the corresponding
     *  ocean cell. Skips land. */
    private spawnIndexMap: Int32Array | null = null;

    private _lastRenderTime = 0;
    private _onVisibilityChange: (() => void) | null = null;

    // Diagnostic counters mirrored to window for debugging.
    private _debugFrame = 0;

    constructor(id: string) {
        this.id = id;
    }

    // ── Mapbox lifecycle ──────────────────────────────────────────────

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        this.map = map;
        this.gl = gl;

        const vs = compileShader(gl, gl.VERTEX_SHADER, PARTICLE_VERT, 'particle vert');
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, PARTICLE_FRAG, 'particle frag');
        this.program = linkProgram(gl, vs, fs);

        this.aPosLoc = gl.getAttribLocation(this.program, 'a_particle_pos');
        this.aSpeedLoc = gl.getAttribLocation(this.program, 'a_particle_speed');
        this.aAlphaLoc = gl.getAttribLocation(this.program, 'a_particle_alpha');
        this.uMatrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
        this.uGridBoundsLoc = gl.getUniformLocation(this.program, 'u_grid_bounds');
        this.uZoomLoc = gl.getUniformLocation(this.program, 'u_zoom');
        this.uLonOffsetLoc = gl.getUniformLocation(this.program, 'u_lon_offset');
        this.uSpeedSlackLoc = gl.getUniformLocation(this.program, 'u_speed_slack');
        this.uSpeedStrongLoc = gl.getUniformLocation(this.program, 'u_speed_strong');

        this.particleBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.trailData.byteLength, gl.DYNAMIC_DRAW);

        // VAO for WebGL2 — speeds up state changes during render.
        const gl2 = gl as WebGL2RenderingContext;
        if (gl2.createVertexArray) {
            this.particleVAO = gl2.createVertexArray();
            gl2.bindVertexArray(this.particleVAO);
            this.bindAttributes(gl);
            gl2.bindVertexArray(null);
        }

        // Resume render loop when the page becomes visible again — render()
        // gates triggerRepaint behind !document.hidden so the loop dies on
        // backgrounding without this hook.
        this._onVisibilityChange = () => {
            if (!document.hidden && this.gridU) this.map?.triggerRepaint();
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        log.info(`onAdd — ${NUM_PARTICLES.toLocaleString()} particles × ${TRAIL_LENGTH} trail`);
    }

    private bindAttributes(gl: WebGLRenderingContext): void {
        const STRIDE = FLOATS_PER_TRAIL_PT * 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        if (this.aPosLoc >= 0) {
            gl.enableVertexAttribArray(this.aPosLoc);
            gl.vertexAttribPointer(this.aPosLoc, 2, gl.FLOAT, false, STRIDE, 0);
        }
        if (this.aSpeedLoc >= 0) {
            gl.enableVertexAttribArray(this.aSpeedLoc);
            gl.vertexAttribPointer(this.aSpeedLoc, 1, gl.FLOAT, false, STRIDE, 2 * 4);
        }
        if (this.aAlphaLoc >= 0) {
            gl.enableVertexAttribArray(this.aAlphaLoc);
            gl.vertexAttribPointer(this.aAlphaLoc, 1, gl.FLOAT, false, STRIDE, 3 * 4);
        }
    }

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }
        if (this.program) gl.deleteProgram(this.program);
        if (this.particleBuffer) gl.deleteBuffer(this.particleBuffer);
        const gl2 = gl as WebGL2RenderingContext;
        if (this.particleVAO && gl2.deleteVertexArray) gl2.deleteVertexArray(this.particleVAO);
        this.program = null;
        this.particleBuffer = null;
        this.particleVAO = null;
        this.gl = null;
        this.map = null;
    }

    // ── Public API ────────────────────────────────────────────────────

    /** Set the active hour's u/v + bounds + land mask. Triggers a particle
     *  respawn weighted by the new speed field. */
    setCurrents(
        u: Float32Array,
        v: Float32Array,
        width: number,
        height: number,
        bounds: Bounds,
        landMask: Uint8Array,
    ): void {
        if (u.length !== width * height || v.length !== width * height) {
            log.warn(`size mismatch: u=${u.length} v=${v.length} expected=${width * height}`);
            return;
        }
        if (landMask.length !== width * height) {
            log.warn(`land mask size mismatch: ${landMask.length} expected=${width * height}`);
            return;
        }
        this.gridU = u;
        this.gridV = v;
        this.gridW = width;
        this.gridH = height;
        this.gridBounds = { ...bounds };
        this.landMask = landMask;
        this.globalMode = Math.abs(bounds.east - bounds.west) >= 359;

        // Pre-compute scalar speed for the grid (used by particle alpha + spawn).
        const size = width * height;
        const speed = new Float32Array(size);
        for (let i = 0; i < size; i++) speed[i] = Math.hypot(u[i], v[i]);
        this.gridSpeed = speed;

        this.buildSpawnCDF();
        this.respawnAllParticles();
        this.map?.triggerRepaint();
    }

    // ── Speed-weighted spawn ──────────────────────────────────────────

    /** Build cumulative-speed CDF for ocean cells. Higher-speed cells get
     *  more weight → particles concentrate in EAC / Gulf Stream / ACC. */
    private buildSpawnCDF(): void {
        const speed = this.gridSpeed;
        const mask = this.landMask;
        if (!speed || !mask) return;
        const n = speed.length;

        // First pass: count ocean cells.
        let oceanCount = 0;
        for (let i = 0; i < n; i++) if (mask[i] === 0) oceanCount++;
        if (oceanCount === 0) {
            this.spawnCDF = null;
            this.spawnIndexMap = null;
            return;
        }

        // Second pass: build weighted CDF.
        // Weight = speed^1.4 + small uniform — pure speed weighting starves
        // slow ocean of particles, the uniform floor keeps gyres populated.
        const cdf = new Float32Array(oceanCount);
        const indexMap = new Int32Array(oceanCount);
        let cum = 0;
        let j = 0;
        const FLOOR = 0.05; // keeps slow ocean visible
        for (let i = 0; i < n; i++) {
            if (mask[i] === 1) continue; // land
            const w = Math.pow(speed[i], 1.4) + FLOOR;
            cum += w;
            cdf[j] = cum;
            indexMap[j] = i;
            j++;
        }
        this.spawnCDF = cdf;
        this.spawnIndexMap = indexMap;
        log.info(`spawn CDF built: ${oceanCount.toLocaleString()} ocean cells, total weight=${cum.toFixed(0)}`);
    }

    /** Sample a (nx, ny) position weighted by speed^1.4. */
    private weightedSpawn(): [number, number] {
        const cdf = this.spawnCDF;
        const indexMap = this.spawnIndexMap;
        const w = this.gridW;
        const h = this.gridH;
        if (!cdf || !indexMap || cdf.length === 0 || w === 0 || h === 0) {
            return [Math.random(), Math.random()];
        }
        const total = cdf[cdf.length - 1];
        const r = Math.random() * total;

        // Binary search the CDF.
        let lo = 0;
        let hi = cdf.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cdf[mid] < r) lo = mid + 1;
            else hi = mid;
        }
        const flatIdx = indexMap[lo];
        const row = Math.floor(flatIdx / w);
        const col = flatIdx % w;

        // Add a small jitter within the cell so particles don't snap to grid.
        const nxBase = (col + Math.random()) / w;
        // Grid is row-major north→south, so row 0 = north, row h-1 = south.
        // ny normalized to bounds [south, north] so ny=0 → south.
        const nyBase = 1 - (row + Math.random()) / h;
        return [nxBase, nyBase];
    }

    private respawnAllParticles(): void {
        const data = this.trailData;
        const ages = this.particleAges;
        for (let i = 0; i < NUM_PARTICLES; i++) {
            const [px, py] = this.weightedSpawn();
            const base = i * FLOATS_PER_PARTICLE;
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                data[offset] = px;
                data[offset + 1] = py;
                data[offset + 2] = 0;
                data[offset + 3] = 0;
            }
            data[base + 3] = 0.9; // head alpha
            ages[i] = Math.floor(Math.random() * MAX_AGE_FRAMES);
        }
    }

    // ── Per-frame physics ─────────────────────────────────────────────

    private sampleAt(nx: number, ny: number): [number, number, number] {
        const u = this.gridU;
        const v = this.gridV;
        const speed = this.gridSpeed;
        if (!u || !v || !speed) return [0, 0, 0];
        const w = this.gridW;
        const h = this.gridH;
        // Bilinear in normalized grid space. ny=0 = south, ny=1 = north,
        // but grid is row-major north→south so flip ny when reading rows.
        const cnx = Math.max(0, Math.min(0.99999, nx));
        const cny = Math.max(0, Math.min(0.99999, ny));
        const gy = (1 - cny) * (h - 1);
        const gx = cnx * (w - 1);
        const x0 = gx | 0;
        const y0 = gy | 0;
        const x1 = Math.min(x0 + 1, w - 1);
        const y1 = Math.min(y0 + 1, h - 1);
        const fx = gx - x0;
        const fy = gy - y0;
        const i00 = y0 * w + x0;
        const i10 = y0 * w + x1;
        const i01 = y1 * w + x0;
        const i11 = y1 * w + x1;
        const ulx = u[i00] * (1 - fx) + u[i10] * fx;
        const uhx = u[i01] * (1 - fx) + u[i11] * fx;
        const us = ulx * (1 - fy) + uhx * fy;
        const vlx = v[i00] * (1 - fx) + v[i10] * fx;
        const vhx = v[i01] * (1 - fx) + v[i11] * fx;
        const vs = vlx * (1 - fy) + vhx * fy;
        return [us, vs, Math.hypot(us, vs)];
    }

    private isLandAt(nx: number, ny: number): boolean {
        const mask = this.landMask;
        if (!mask) return false;
        const w = this.gridW;
        const h = this.gridH;
        const col = Math.min(w - 1, Math.max(0, Math.floor(nx * w)));
        const row = Math.min(h - 1, Math.max(0, Math.floor((1 - ny) * h)));
        return mask[row * w + col] === 1;
    }

    private advectParticles(): void {
        const data = this.trailData;
        const ages = this.particleAges;
        const b = this.gridBounds;
        const latSpan = b.north - b.south;

        for (let i = 0; i < NUM_PARTICLES; i++) {
            const base = i * FLOATS_PER_PARTICLE;

            // Shift trail history (head index = base, oldest = base + (TL-1)*5).
            for (let t = TRAIL_LENGTH - 1; t > 0; t--) {
                const dst = base + t * FLOATS_PER_TRAIL_PT;
                const src = base + (t - 1) * FLOATS_PER_TRAIL_PT;
                data[dst] = data[src];
                data[dst + 1] = data[src + 1];
                data[dst + 2] = data[src + 2];
            }

            let x = data[base];
            let y = data[base + 1];
            const [u, v, speedMS] = this.sampleAt(x, y);

            // Scale displacement by cos(latitude) to prevent Mercator polar
            // acceleration making particles unrealistically fast at high lat.
            const latDeg = b.south + y * latSpan;
            const cosLat = Math.max(0.1, Math.cos((latDeg * Math.PI) / 180));
            x += u * SPEED_FACTOR * cosLat;
            y += v * SPEED_FACTOR * cosLat;

            // Global wrap on longitude (we span -180 to 180 in globalMode).
            if (this.globalMode) {
                if (x > 1) x -= 1;
                if (x < 0) x += 1;
            }

            ages[i]++;
            const stalled = speedMS < STALL_KILL_M_S;
            const oob = y < 0.05 || y > 0.95; // trim ±81° (close to projection limit)
            const onLand = this.isLandAt(x, y);
            const aged = ages[i] >= MAX_AGE_FRAMES;
            const dropped = Math.random() < RANDOM_DROP_RATE;

            if (stalled || oob || onLand || aged || dropped) {
                const [rx, ry] = this.weightedSpawn();
                for (let t = 0; t < TRAIL_LENGTH; t++) {
                    const offset = base + t * FLOATS_PER_TRAIL_PT;
                    data[offset] = rx;
                    data[offset + 1] = ry;
                    data[offset + 2] = 0;
                    data[offset + 3] = 0;
                }
                data[base + 3] = 0.9;
                ages[i] = 0;
                continue;
            }

            // Wrote new head position.
            data[base] = x;
            data[base + 1] = y;
            data[base + 2] = speedMS;

            // Trail alpha fade — head bright, tail nearly invisible.
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                const fadeRatio = 1 - t / TRAIL_LENGTH;
                data[offset + 3] = 0.92 * fadeRatio;
            }
        }
    }

    // ── Render ────────────────────────────────────────────────────────

    render(gl: WebGLRenderingContext, matrixOrOptions: unknown): void {
        // Throttle to ~15fps when the map is idle. While Mapbox is animating
        // its own camera we draw every frame to avoid bail-frame flashing.
        // (See WindParticleLayer for the long version of this logic.)
        const map = this.map;
        const animating = map ? map.isMoving() || map.isZooming() || map.isEasing() : false;
        const now = performance.now();
        const elapsed = now - this._lastRenderTime;
        if (!animating && elapsed < 66) {
            if (!document.hidden) setTimeout(() => this.map?.triggerRepaint(), 66 - elapsed);
            return;
        }
        this._lastRenderTime = now;

        if (!this.program || !this.particleBuffer || !this.gridU || !matrixOrOptions) {
            if (!document.hidden && !animating) setTimeout(() => this.map?.triggerRepaint(), 66);
            return;
        }

        // Extract matrix — handle both Mapbox (flat) and MapLibre v3 (object).
        let rawMatrix = matrixOrOptions;
        if (
            matrixOrOptions &&
            typeof matrixOrOptions === 'object' &&
            !ArrayBuffer.isView(matrixOrOptions) &&
            !Array.isArray(matrixOrOptions)
        ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const opts = matrixOrOptions as any;
            rawMatrix =
                opts.defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix ?? opts.projectionMatrix;
        }
        if (!rawMatrix) return;

        let mat: Float32Array;
        if (rawMatrix instanceof Float32Array) {
            mat = rawMatrix;
        } else {
            mat = new Float32Array(Array.from(rawMatrix as ArrayLike<number>));
        }
        if (mat.length !== 16) return;

        // Save GL state we'll mutate, restore at end.
        const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);

        this.advectParticles();

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        gl.useProgram(this.program);
        if (this.uMatrixLoc) gl.uniformMatrix4fv(this.uMatrixLoc, false, mat);
        if (this.uGridBoundsLoc) {
            gl.uniform4f(
                this.uGridBoundsLoc,
                this.gridBounds.south,
                this.gridBounds.north,
                this.gridBounds.west,
                this.gridBounds.east,
            );
        }
        if (this.uZoomLoc && this.map) gl.uniform1f(this.uZoomLoc, this.map.getZoom());
        if (this.uSpeedSlackLoc) gl.uniform1f(this.uSpeedSlackLoc, SPEED_SLACK_M_S);
        if (this.uSpeedStrongLoc) gl.uniform1f(this.uSpeedStrongLoc, SPEED_STRONG_M_S);

        // Bind VAO if available, otherwise set attributes directly.
        const gl2 = gl as WebGL2RenderingContext;
        const prevVAO = gl2.getParameter ? gl2.getParameter(gl2.VERTEX_ARRAY_BINDING) : null;
        if (gl2.bindVertexArray && this.particleVAO) {
            gl2.bindVertexArray(this.particleVAO);
        } else {
            this.bindAttributes(gl);
        }

        // Re-upload particle buffer (positions changed via advectParticles).
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.trailData);

        // Draw 3 world copies in global mode for seamless antimeridian.
        const worldOffsets = this.globalMode ? [-360, 0, 360] : [0];
        for (const offset of worldOffsets) {
            if (this.uLonOffsetLoc) gl.uniform1f(this.uLonOffsetLoc, offset);
            gl.drawArrays(gl.POINTS, 0, TOTAL_POINTS);
        }

        if (gl2.bindVertexArray) gl2.bindVertexArray(prevVAO);

        gl.useProgram(prevProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
        if (prevBlend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);

        // Mirror state for diagnostics.
        this._debugFrame++;
        if (this._debugFrame % 60 === 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const w = window as any;
            w.__currentDebug = {
                frame: this._debugFrame,
                hasData: !!this.gridU,
                bounds: { ...this.gridBounds },
                w: this.gridW,
                h: this.gridH,
                globalMode: this.globalMode,
                landCount: this.landMask ? this.landMask.reduce((a, b) => a + b, 0) : null,
                cdfTotal: this.spawnCDF ? this.spawnCDF[this.spawnCDF.length - 1] : null,
                cam: this.map
                    ? {
                          zoom: this.map.getZoom(),
                          center: this.map.getCenter().toArray(),
                          isMoving: this.map.isMoving(),
                          isEasing: this.map.isEasing(),
                          isZooming: this.map.isZooming(),
                      }
                    : null,
            };
        }

        // Schedule next paint (skipped while Mapbox is RAF-ing us anyway).
        if (document.hidden || animating) return;
        setTimeout(() => this.map?.triggerRepaint(), 66);
    }
}
