import mapboxgl from 'mapbox-gl';
import type { WindGrid } from '../../services/weather/windField';

const MAX_SPEED = 60.0;
const NUM_PARTICLES = 15000;
const MAX_AGE = 120;
const SPEED_FACTOR = 0.00002;
const MS_TO_KNOTS = 1.94384;
const VELOCITY_KILL_THRESHOLD = 0.3; // knots — kill particles in convergence zones
const RANDOM_DROP_RATE = 0.005; // 0.5% chance per frame of spontaneous respawn
const TRAIL_LENGTH = 24;
const FLOATS_PER_TRAIL_PT = 4;
const FLOATS_PER_PARTICLE = TRAIL_LENGTH * FLOATS_PER_TRAIL_PT;
const TOTAL_POINTS = NUM_PARTICLES * TRAIL_LENGTH;

interface WindBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

/** Single timestep of wind data for the timeline. */
interface WindTimestep {
    u: Float32Array;
    v: Float32Array;
}

// ── Shaders ───────────────────────────────────────────────────

// ── Heatmap shaders (wind speed colored quad) ─────────────────

const HEATMAP_VERT = `
precision highp float;
attribute vec2 a_pos; // normalized 0..1 grid position
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds; // south, north, west, east

varying vec2 v_uv;

const float PI = 3.14159265359;

vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    v_uv = a_pos;
    float lat = u_grid_bounds.x + a_pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    float lon = u_grid_bounds.z + a_pos.x * (u_grid_bounds.w - u_grid_bounds.z);
    // Clamp latitude to Mapbox's max (±85.05°) to prevent infinite Mercator y
    lat = clamp(lat, -85.05, 85.05);
    vec2 merc = toMercator(lon, lat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
}`;

const HEATMAP_FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_speed_tex;
uniform float u_opacity;

vec3 windColorRamp(float speed) {
    // Windy-style dark-to-bright ramp matching wind speed in knots
    vec3 darkblue  = vec3(0.05, 0.10, 0.30);
    vec3 blue      = vec3(0.10, 0.30, 0.60);
    vec3 teal      = vec3(0.05, 0.55, 0.55);
    vec3 green     = vec3(0.20, 0.70, 0.20);
    vec3 yellow    = vec3(0.85, 0.85, 0.10);
    vec3 orange    = vec3(0.90, 0.45, 0.05);
    vec3 red       = vec3(0.85, 0.10, 0.10);
    vec3 magenta   = vec3(0.75, 0.10, 0.50);

    float t;
    if (speed < 3.0) {
        t = speed / 3.0;
        return mix(darkblue, blue, t);
    } else if (speed < 8.0) {
        t = (speed - 3.0) / 5.0;
        return mix(blue, teal, t);
    } else if (speed < 15.0) {
        t = (speed - 8.0) / 7.0;
        return mix(teal, green, t);
    } else if (speed < 25.0) {
        t = (speed - 15.0) / 10.0;
        return mix(green, yellow, t);
    } else if (speed < 35.0) {
        t = (speed - 25.0) / 10.0;
        return mix(yellow, orange, t);
    } else if (speed < 50.0) {
        t = (speed - 35.0) / 15.0;
        return mix(orange, red, t);
    } else {
        t = smoothstep(50.0, 70.0, speed);
        return mix(red, magenta, t);
    }
}

void main() {
    float speed = texture2D(u_speed_tex, vec2(fract(v_uv.x), v_uv.y)).r * 120.0;
    vec3 color = windColorRamp(speed);
    gl_FragColor = vec4(color, u_opacity);
}`;

// ── Particle shaders (white streams on top of heatmap) ────────

const PARTICLE_VERT = `
precision highp float;
attribute vec2 a_particle_pos;
attribute float a_particle_speed;
attribute float a_particle_alpha;
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds;
uniform vec4 u_bbox;
uniform float u_zoom;
varying float v_speed;
varying float v_alpha;

const float PI = 3.14159265359;

vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    float lat = u_grid_bounds.x + a_particle_pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    float lon = u_grid_bounds.z + a_particle_pos.x * (u_grid_bounds.w - u_grid_bounds.z);

    if (lon < u_bbox.x || lon > u_bbox.z || lat < u_bbox.y || lat > u_bbox.w || a_particle_alpha <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }

    v_speed = a_particle_speed;
    v_alpha = a_particle_alpha;
    vec2 merc = toMercator(lon, lat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
    gl_PointSize = mix(2.5, 6.0, clamp((u_zoom - 3.0) / 7.0, 0.0, 1.0));
}`;

const PARTICLE_FRAG = `
precision highp float;
varying float v_speed;
varying float v_alpha;

void main() {
    // White particles with subtle brightness boost for faster wind
    float brightness = 0.85 + 0.15 * smoothstep(5.0, 40.0, v_speed);
    gl_FragColor = vec4(vec3(brightness), v_alpha * 0.9);
}`;

// ── Helpers ───────────────────────────────────────────────────

function compileShader(
    gl: WebGLRenderingContext,
    type: number,
    source: string,
    label: string,
): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`[WindParticleLayer] Failed to create ${label}`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`[WindParticleLayer] ${label}: ${log}`);
    }
    return shader;
}

function linkProgram(
    gl: WebGLRenderingContext,
    vs: WebGLShader,
    fs: WebGLShader,
    label: string,
): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error(`[WindParticleLayer] Failed to create ${label} program`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[WindParticleLayer] ${label}: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
}

// ── Main Layer Class ──────────────────────────────────────────

export class WindParticleLayer implements mapboxgl.CustomLayerInterface {
    readonly id: string;
    readonly type: 'custom' = 'custom';
    readonly renderingMode: '2d' = '2d';

    private map: mapboxgl.Map | null = null;
    private gl: WebGLRenderingContext | null = null;

    // Particle shader locations
    private program: WebGLProgram | null = null;
    private particleBuffer: WebGLBuffer | null = null;
    private aParticlePosLoc: number = -1;
    private aParticleSpeedLoc: number = -1;
    private aParticleAlphaLoc: number = -1;
    private uMatrixLoc: WebGLUniformLocation | null = null;
    private uGridBoundsLoc: WebGLUniformLocation | null = null;
    private uBboxLoc: WebGLUniformLocation | null = null;
    private uZoomLoc: WebGLUniformLocation | null = null;
    private uWindTex0Loc: WebGLUniformLocation | null = null;
    private uWindTex1Loc: WebGLUniformLocation | null = null;
    private uTimeBlendLoc: WebGLUniformLocation | null = null;

    // Heatmap shader locations
    private heatmapProgram: WebGLProgram | null = null;
    private heatmapQuadBuffer: WebGLBuffer | null = null;
    private heatmapIndexBuffer: WebGLBuffer | null = null;
    private speedTexture: WebGLTexture | null = null;
    private heatmapAPos: number = -1;
    private heatmapUMatrix: WebGLUniformLocation | null = null;
    private heatmapUGridBounds: WebGLUniformLocation | null = null;
    private heatmapUSpeedTex: WebGLUniformLocation | null = null;
    private heatmapUOpacity: WebGLUniformLocation | null = null;
    private heatmapGridW: number = 0;
    private heatmapGridH: number = 0;

    // Wind textures: pair for current interpolation (GPU path, future use)
    private windTexture0: WebGLTexture | null = null;
    private windTexture1: WebGLTexture | null = null;
    private windTexWidth: number = 0;
    private windTexHeight: number = 0;

    // Trail buffer
    private trailData: Float32Array;
    private particleAges: Int32Array;

    // ── Timeline: all timesteps stored as CPU arrays ──
    private windTimeline: WindTimestep[] = [];
    private windGridWidth: number = 0;
    private windGridHeight: number = 0;
    private totalHours: number = 0;

    // Current interpolation state (fractional hour → smooth blend)
    private forecastHour: number = 0;     // float, e.g. 4.5
    private blendFactor: number = 0;      // 0.0–1.0 between hourA and hourB
    private hourIdxA: number = 0;         // floor index into windTimeline
    private hourIdxB: number = 0;         // ceil index into windTimeline

    private dataBounds: WindBounds = { south: -85, north: 85, west: -180, east: 180 };
    private gridBounds = { south: -85.0, north: 85.0, west: -180.0, east: 180.0 };
    private currentGrid: WindGrid | null = null;
    private pendingGrid: { grid: WindGrid; hour: number } | null = null;
    private maxObservedSpeed: number = 0;

    /**
     * Global mode: true when the grid covers the full 360° longitude range.
     * Enables X-axis texture REPEAT and particle wrapping at the antimeridian.
     */
    private globalMode: boolean = false;

    getMaxSpeed(): number {
        return this.maxObservedSpeed;
    }

    /** Returns the current fractional forecast hour. */
    getForecastHour(): number {
        return this.forecastHour;
    }

    constructor(id: string = 'wind-particles') {
        this.id = id;

        this.trailData = new Float32Array(NUM_PARTICLES * FLOATS_PER_PARTICLE);
        this.particleAges = new Int32Array(NUM_PARTICLES);

        for (let i = 0; i < NUM_PARTICLES; i++) {
            const px = Math.random();
            const py = Math.random();
            const base = i * FLOATS_PER_PARTICLE;
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                this.trailData[offset] = px;
                this.trailData[offset + 1] = py;
                this.trailData[offset + 2] = 0;
                this.trailData[offset + 3] = 0;
            }
            this.trailData[base + 3] = 0.85;
            this.particleAges[i] = Math.floor(Math.random() * MAX_AGE);
        }
    }

    // ── WebGL init ────────────────────────────────────────────

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        this.map = map;
        this.gl = gl;

        const vs = compileShader(gl, gl.VERTEX_SHADER, PARTICLE_VERT, 'particle-vert');
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, PARTICLE_FRAG, 'particle-frag');
        this.program = linkProgram(gl, vs, fs, 'particle');

        this.aParticlePosLoc = gl.getAttribLocation(this.program, 'a_particle_pos');
        this.aParticleSpeedLoc = gl.getAttribLocation(this.program, 'a_particle_speed');
        this.aParticleAlphaLoc = gl.getAttribLocation(this.program, 'a_particle_alpha');
        this.uMatrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
        this.uGridBoundsLoc = gl.getUniformLocation(this.program, 'u_grid_bounds');
        this.uBboxLoc = gl.getUniformLocation(this.program, 'u_bbox');
        this.uZoomLoc = gl.getUniformLocation(this.program, 'u_zoom');
        this.uWindTex0Loc = gl.getUniformLocation(this.program, 'u_wind_texture_0');
        this.uWindTex1Loc = gl.getUniformLocation(this.program, 'u_wind_texture_1');
        this.uTimeBlendLoc = gl.getUniformLocation(this.program, 'u_time_blend');

        const buf = gl.createBuffer();
        if (!buf) throw new Error('[WindParticleLayer] Failed to create particle buffer');
        this.particleBuffer = buf;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.trailData, gl.DYNAMIC_DRAW);

        // Create the pair of wind textures for interpolation
        this.windTexture0 = gl.createTexture();
        this.windTexture1 = gl.createTexture();

        // ── Heatmap program ──
        const hvs = compileShader(gl, gl.VERTEX_SHADER, HEATMAP_VERT, 'heatmap-vert');
        const hfs = compileShader(gl, gl.FRAGMENT_SHADER, HEATMAP_FRAG, 'heatmap-frag');
        this.heatmapProgram = linkProgram(gl, hvs, hfs, 'heatmap');
        this.heatmapAPos = gl.getAttribLocation(this.heatmapProgram, 'a_pos');
        this.heatmapUMatrix = gl.getUniformLocation(this.heatmapProgram, 'u_matrix');
        this.heatmapUGridBounds = gl.getUniformLocation(this.heatmapProgram, 'u_grid_bounds');
        this.heatmapUSpeedTex = gl.getUniformLocation(this.heatmapProgram, 'u_speed_tex');
        this.heatmapUOpacity = gl.getUniformLocation(this.heatmapProgram, 'u_opacity');

        // Heatmap quad — simple fullscreen grid placeholder (will rebuild on data load)
        this.heatmapQuadBuffer = gl.createBuffer();
        this.heatmapIndexBuffer = gl.createBuffer();
        this.speedTexture = gl.createTexture();

        console.log(`[WindParticleLayer] Initialized: ${NUM_PARTICLES}×${TRAIL_LENGTH} = ${TOTAL_POINTS} points`);

        if (this.pendingGrid) {
            const { grid, hour } = this.pendingGrid;
            this.pendingGrid = null;
            this.setGrid(grid, hour);
        }
    }

    // ── Data loading ──────────────────────────────────────────

    /**
     * Load a full WindGrid and build the timeline of all hourly timesteps.
     * Accepts a fractional starting hour for smooth initial positioning.
     */
    setGrid(grid: WindGrid, hour: number = 0): void {
        this.currentGrid = grid;

        if (!this.gl) {
            this.pendingGrid = { grid, hour };
            return;
        }

        this.dataBounds = {
            north: grid.north, south: grid.south,
            east: grid.east, west: grid.west,
        };
        this.gridBounds = { ...this.dataBounds };
        this.windGridWidth = grid.width;
        this.windGridHeight = grid.height;
        this.totalHours = grid.totalHours;

        // Detect global mode: full 360° longitude coverage
        this.globalMode = Math.abs(grid.east - grid.west) >= 359;

        // Build timeline: store all hourly U/V arrays
        this.windTimeline = [];
        const size = grid.width * grid.height;

        for (let h = 0; h < grid.totalHours; h++) {
            const uSrc = grid.u[h];
            const vSrc = grid.v[h];
            if (!uSrc || !vSrc) continue;

            const u = new Float32Array(size);
            u.set(uSrc.subarray(0, size));
            const v = new Float32Array(size);
            v.set(vSrc.subarray(0, size));
            this.windTimeline.push({ u, v });
        }

        this.totalHours = this.windTimeline.length;
        console.log(`[WindParticleLayer] Timeline loaded: ${this.totalHours} timesteps, ${grid.width}×${grid.height}`);

        // Compute max speed across ALL timesteps for legend
        let gridMax = 0;
        for (const ts of this.windTimeline) {
            for (let i = 0; i < size; i++) {
                const spd = Math.sqrt(ts.u[i] * ts.u[i] + ts.v[i] * ts.v[i]) * MS_TO_KNOTS;
                if (spd > gridMax) gridMax = spd;
            }
        }
        this.maxObservedSpeed = gridMax;

        // ── Upload speed texture for heatmap ──
        this._uploadSpeedTexture(grid);

        // Set initial hour and upload first pair of textures
        this.setForecastHour(hour);
        this.respawnAllParticles();
    }

    /** Build and upload the scalar speed texture + heatmap mesh for current grid. */
    private _uploadSpeedTexture(grid: WindGrid): void {
        const gl = this.gl;
        if (!gl || !this.speedTexture) return;

        const w = grid.width;
        const h = grid.height;
        const size = w * h;

        // Compute speed from first timestep U/V
        const u0 = grid.u[0];
        const v0 = grid.v[0];
        const speedData = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
            const spd = Math.sqrt(u0[i] * u0[i] + v0[i] * v0[i]) * MS_TO_KNOTS;
            speedData[i] = Math.round(Math.min(255, (spd / 120.0) * 255)); // encode 0-120kt range
        }

        // Set alignment to 1 for non-RGBA textures (LUMINANCE = 1 byte/pixel)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

        gl.bindTexture(gl.TEXTURE_2D, this.speedTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // Always use REPEAT on S (longitude) for global seamless tiling
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, speedData);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Restore default alignment
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

        this.heatmapGridW = w;
        this.heatmapGridH = h;

        // Quad spanning 3 world copies: X from -1 to 2, Y from 0 to 1
        // fract() in the fragment shader handles UV wrapping
        const quadVerts = new Float32Array([
            -1.0, 0.0,   // bottom-left  (1 world west)
            2.0, 0.0,   // bottom-right (2 worlds east)
            -1.0, 1.0,   // top-left
            2.0, 1.0,   // top-right
        ]);
        console.log('[Heatmap] Uploading multi-world quad: x=[-1..2], y=[0..1]');

        gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmapQuadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    }

    /**
     * Upload a single timestep's data to a specific WebGL texture.
     * Used internally to populate texture0 and texture1.
     */
    private uploadWindTexture(tex: WebGLTexture, u: Float32Array, v: Float32Array): void {
        const gl = this.gl;
        if (!gl) return;

        const w = this.windGridWidth;
        const h = this.windGridHeight;
        const size = w * h;

        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // Enable float linear filtering if available
        gl.getExtension('OES_texture_float_linear');
        // Global mode: REPEAT on S (longitude) for seamless antimeridian wrapping
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
            this.globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        // Always CLAMP on T (latitude) — no wrapping over poles
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Try float textures if supported, otherwise encode into Uint8
        const floatExt = gl.getExtension('OES_texture_float');
        if (floatExt) {
            const floatData = new Float32Array(size * 4);
            for (let i = 0; i < size; i++) {
                const off = i * 4;
                floatData[off] = u[i];
                floatData[off + 1] = v[i];
                floatData[off + 2] = 0;
                floatData[off + 3] = 1;
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, floatData);

            // Check if the upload actually worked (texImage2D doesn't throw on failure)
            const err = gl.getError();
            if (err !== gl.NO_ERROR) {
                console.warn(`[WindParticleLayer] Float texture failed (GL error ${err}), using Uint8 fallback`);
                this._uploadUint8Texture(gl, tex, u, v, w, h, size);
            }
        } else {
            this._uploadUint8Texture(gl, tex, u, v, w, h, size);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);

        this.windTexWidth = w;
        this.windTexHeight = h;
    }

    /** Encode U/V as Uint8 RGBA texture (works on all GPUs). */
    private _uploadUint8Texture(
        gl: WebGLRenderingContext, tex: WebGLTexture,
        u: Float32Array, v: Float32Array,
        w: number, h: number, size: number,
    ): void {
        const rgba = new Uint8Array(size * 4);
        const inv = 255.0 / (2.0 * MAX_SPEED);
        for (let i = 0; i < size; i++) {
            const o = i * 4;
            rgba[o] = Math.round(Math.max(0, Math.min(255, (u[i] + MAX_SPEED) * inv)));
            rgba[o + 1] = Math.round(Math.max(0, Math.min(255, (v[i] + MAX_SPEED) * inv)));
            rgba[o + 2] = 0; rgba[o + 3] = 255;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }

    /**
     * Set the forecast hour as a FLOAT for smooth interpolation.
     * e.g., setForecastHour(4.5) blends 50/50 between hour 4 and hour 5.
     * Does NOT respawn particles — they smoothly transition.
     */
    setForecastHour(hour: number): void {
        if (this.windTimeline.length === 0) return;

        const maxIdx = this.totalHours - 1;
        const clamped = Math.max(0, Math.min(hour, maxIdx));
        this.forecastHour = clamped;

        // Compute bracketing indices and blend factor
        this.hourIdxA = Math.floor(clamped);
        this.hourIdxB = Math.min(this.hourIdxA + 1, maxIdx);
        this.blendFactor = clamped - this.hourIdxA;

        // Upload the pair of bracketing textures to GPU
        const tsA = this.windTimeline[this.hourIdxA];
        const tsB = this.windTimeline[this.hourIdxB];
        if (tsA && this.windTexture0) this.uploadWindTexture(this.windTexture0, tsA.u, tsA.v);
        if (tsB && this.windTexture1) this.uploadWindTexture(this.windTexture1, tsB.u, tsB.v);
    }

    /** Convenience: set integer hour (backward-compatible with setHour). */
    setHour(hour: number): void {
        this.setForecastHour(hour);
    }

    /** Set wind data for a single timestep (backward compat). */
    setWindData(
        uData: Float32Array,
        vData: Float32Array,
        width: number,
        height: number,
        bounds: WindBounds,
    ): void {
        this.dataBounds = bounds;
        this.gridBounds = { ...bounds };
        this.windGridWidth = width;
        this.windGridHeight = height;

        // Detect global mode: lon span ≥ 359° means full-earth coverage
        this.globalMode = Math.abs(bounds.east - bounds.west) >= 359;

        const size = width * height;
        const u = new Float32Array(size);
        u.set(uData.subarray(0, size));
        const v = new Float32Array(size);
        v.set(vData.subarray(0, size));

        this.windTimeline = [{ u, v }];
        this.totalHours = 1;
        this.forecastHour = 0;
        this.hourIdxA = 0;
        this.hourIdxB = 0;
        this.blendFactor = 0;

        // Max speed
        let gridMax = 0;
        for (let i = 0; i < size; i++) {
            const spd = Math.sqrt(u[i] * u[i] + v[i] * v[i]) * MS_TO_KNOTS;
            if (spd > gridMax) gridMax = spd;
        }
        this.maxObservedSpeed = gridMax;

        if (this.windTexture0) this.uploadWindTexture(this.windTexture0, u, v);

        this.respawnAllParticles();
    }

    // ── Wind sampling with temporal interpolation ─────────────

    /**
     * Bilinear spatial sample from a single timestep.
     */
    private sampleTimestep(ts: WindTimestep, nx: number, ny: number): [number, number] {
        const w = this.windGridWidth;
        const h = this.windGridHeight;
        const cnx = Math.max(0, Math.min(1, nx));
        const cny = Math.max(0, Math.min(1, ny));
        const gx = cnx * (w - 1);
        const gy = cny * (h - 1);
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

        const uArr = ts.u;
        const vArr = ts.v;
        const u = uArr[i00] * (1 - fx) * (1 - fy) + uArr[i10] * fx * (1 - fy)
            + uArr[i01] * (1 - fx) * fy + uArr[i11] * fx * fy;
        const v = vArr[i00] * (1 - fx) * (1 - fy) + vArr[i10] * fx * (1 - fy)
            + vArr[i01] * (1 - fx) * fy + vArr[i11] * fx * fy;
        return [u, v];
    }

    /**
     * Sample wind with smooth temporal interpolation.
     * Blends between hourIdxA and hourIdxB using blendFactor.
     *   mix(windA, windB, blendFactor)
     */
    private sampleWind(nx: number, ny: number): [number, number] {
        const tsA = this.windTimeline[this.hourIdxA];
        if (!tsA) return [0, 0];

        const [uA, vA] = this.sampleTimestep(tsA, nx, ny);

        // If no blend needed (integer hour or single timestep), skip B
        if (this.blendFactor < 0.001 || this.hourIdxA === this.hourIdxB) {
            return [uA, vA];
        }

        const tsB = this.windTimeline[this.hourIdxB];
        if (!tsB) return [uA, vA];

        const [uB, vB] = this.sampleTimestep(tsB, nx, ny);

        // mix(A, B, blendFactor)
        const bf = this.blendFactor;
        return [
            uA * (1 - bf) + uB * bf,
            vA * (1 - bf) + vB * bf,
        ];
    }

    // ── Particle management ───────────────────────────────────

    private toGeo(nx: number, ny: number): [number, number] {
        return [
            this.gridBounds.west + nx * (this.gridBounds.east - this.gridBounds.west),
            this.gridBounds.south + ny * (this.gridBounds.north - this.gridBounds.south),
        ];
    }

    private randomWithinBounds(): [number, number] {
        const b = this.dataBounds;
        const gb = this.gridBounds;
        const lon = b.west + Math.random() * (b.east - b.west);
        const lat = b.south + Math.random() * (b.north - b.south);
        const gbLonRange = gb.east - gb.west;
        const gbLatRange = gb.north - gb.south;
        const nx = gbLonRange > 0 ? (lon - gb.west) / gbLonRange : Math.random();
        const ny = gbLatRange > 0 ? (lat - gb.south) / gbLatRange : Math.random();
        return [nx, ny];
    }

    private respawnAllParticles(): void {
        const data = this.trailData;
        const ages = this.particleAges;
        for (let i = 0; i < NUM_PARTICLES; i++) {
            const [px, py] = this.randomWithinBounds();
            const base = i * FLOATS_PER_PARTICLE;
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                data[offset] = px;
                data[offset + 1] = py;
                data[offset + 2] = 0;
                data[offset + 3] = 0;
            }
            data[base + 3] = 0.85;
            ages[i] = Math.floor(Math.random() * MAX_AGE);
        }
    }

    private advectParticles(): void {
        const data = this.trailData;
        const ages = this.particleAges;
        const hasWind = this.windTimeline.length > 0;
        const b = this.dataBounds;

        for (let i = 0; i < NUM_PARTICLES; i++) {
            const base = i * FLOATS_PER_PARTICLE;

            for (let t = TRAIL_LENGTH - 1; t > 0; t--) {
                const dst = base + t * FLOATS_PER_TRAIL_PT;
                const src = base + (t - 1) * FLOATS_PER_TRAIL_PT;
                data[dst] = data[src];
                data[dst + 1] = data[src + 1];
                data[dst + 2] = data[src + 2];
            }

            let x = data[base];
            let y = data[base + 1];
            let speedKnots = 0;

            if (hasWind) {
                const [u, v] = this.sampleWind(x, y);
                speedKnots = Math.sqrt(u * u + v * v) * MS_TO_KNOTS;
                x += u * SPEED_FACTOR;
                y += v * SPEED_FACTOR;
            }

            // ── Global wrapping vs bounded kill ──
            if (this.globalMode) {
                // Wrap X (longitude) seamlessly across antimeridian
                // If particle wrapped, reset trail to prevent cross-screen comet
                const prevX = x;
                if (x > 1.0) x -= 1.0;
                if (x < 0.0) x += 1.0;
                const wrapped = Math.abs(x - prevX) > 0.5;
                if (wrapped) {
                    // Kill trail — snap all trail points to new position
                    for (let t = 1; t < TRAIL_LENGTH; t++) {
                        const offset = base + t * FLOATS_PER_TRAIL_PT;
                        data[offset] = x;
                        data[offset + 1] = y;
                        data[offset + 2] = speedKnots;
                        data[offset + 3] = 0;
                    }
                }

                // Kill for: Y out of bounds, age, low velocity, or random drop
                const latOob = y < 0.0 || y > 1.0;
                const stalled = speedKnots < VELOCITY_KILL_THRESHOLD;
                const randomDrop = Math.random() < RANDOM_DROP_RATE;
                if (ages[i] >= MAX_AGE || latOob || stalled || randomDrop) {
                    const [rx, ry] = this.randomWithinBounds();
                    for (let t = 0; t < TRAIL_LENGTH; t++) {
                        const offset = base + t * FLOATS_PER_TRAIL_PT;
                        data[offset] = rx;
                        data[offset + 1] = ry;
                        data[offset + 2] = 0;
                        data[offset + 3] = 0;
                    }
                    data[base + 3] = 0.85;
                    ages[i] = 0;
                    continue;
                }
            } else {
                // Bounded mode: kill particles that leave the data region
                const [lon, lat] = this.toGeo(x, y);
                const oob = lon < b.west || lon > b.east || lat < b.south || lat > b.north;

                const stalled = speedKnots < VELOCITY_KILL_THRESHOLD;
                const randomDrop = Math.random() < RANDOM_DROP_RATE;
                if (ages[i] >= MAX_AGE || oob || stalled || randomDrop) {
                    const [rx, ry] = this.randomWithinBounds();
                    for (let t = 0; t < TRAIL_LENGTH; t++) {
                        const offset = base + t * FLOATS_PER_TRAIL_PT;
                        data[offset] = rx;
                        data[offset + 1] = ry;
                        data[offset + 2] = 0;
                        data[offset + 3] = 0;
                    }
                    data[base + 3] = 0.85;
                    ages[i] = 0;
                    continue;
                }
            }

            data[base] = x;
            data[base + 1] = y;
            data[base + 2] = speedKnots;

            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                const fadeRatio = 1.0 - t / TRAIL_LENGTH;
                // Kill trail segments with large jumps (prevents vertical comets)
                if (t > 0) {
                    const prevOffset = base + (t - 1) * FLOATS_PER_TRAIL_PT;
                    const dx = Math.abs(data[offset] - data[prevOffset]);
                    const dy = Math.abs(data[offset + 1] - data[prevOffset + 1]);
                    if (dx > 0.3 || dy > 0.3) {
                        data[offset + 3] = 0; // kill this segment
                        continue;
                    }
                }
                data[offset + 3] = 0.92 * fadeRatio;
            }
        }
    }

    // ── Render ─────────────────────────────────────────────────

    render(gl: WebGLRenderingContext, matrix: number[]): void {
        if (!this.program || !this.particleBuffer) return;

        const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);

        this.advectParticles();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.trailData);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        // ── Draw heatmap first (colored wind speed background) ──
        if (this.heatmapProgram && this.speedTexture && this.heatmapQuadBuffer && this.heatmapGridW > 0) {
            gl.useProgram(this.heatmapProgram);
            if (this.heatmapUMatrix) gl.uniformMatrix4fv(this.heatmapUMatrix, false, matrix);
            if (this.heatmapUGridBounds) {
                gl.uniform4f(this.heatmapUGridBounds,
                    this.gridBounds.south, this.gridBounds.north,
                    this.gridBounds.west, this.gridBounds.east);
            }
            if (this.heatmapUOpacity) gl.uniform1f(this.heatmapUOpacity, 0.6);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.speedTexture);
            if (this.heatmapUSpeedTex) gl.uniform1i(this.heatmapUSpeedTex, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmapQuadBuffer);
            gl.enableVertexAttribArray(this.heatmapAPos);
            gl.vertexAttribPointer(this.heatmapAPos, 2, gl.FLOAT, false, 0, 0);

            // Ensure no culling prevents rendering
            gl.disable(gl.CULL_FACE);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            gl.disableVertexAttribArray(this.heatmapAPos);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

        // ── Draw particles (white streams) ──
        gl.useProgram(this.program);
        if (this.uMatrixLoc) gl.uniformMatrix4fv(this.uMatrixLoc, false, matrix);
        if (this.uGridBoundsLoc) {
            gl.uniform4f(this.uGridBoundsLoc,
                this.gridBounds.south, this.gridBounds.north,
                this.gridBounds.west, this.gridBounds.east);
        }
        if (this.uBboxLoc) {
            gl.uniform4f(this.uBboxLoc,
                this.dataBounds.west, this.dataBounds.south,
                this.dataBounds.east, this.dataBounds.north);
        }
        if (this.uZoomLoc && this.map) {
            gl.uniform1f(this.uZoomLoc, this.map.getZoom());
        }

        // ── Bind dual wind textures and blend factor ──
        const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);

        if (this.windTexture0) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.windTexture0);
            if (this.uWindTex0Loc) gl.uniform1i(this.uWindTex0Loc, 0);
        }
        if (this.windTexture1) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.windTexture1);
            if (this.uWindTex1Loc) gl.uniform1i(this.uWindTex1Loc, 1);
        }
        if (this.uTimeBlendLoc) {
            gl.uniform1f(this.uTimeBlendLoc, this.blendFactor);
        }

        const STRIDE = FLOATS_PER_TRAIL_PT * 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);

        gl.enableVertexAttribArray(this.aParticlePosLoc);
        gl.vertexAttribPointer(this.aParticlePosLoc, 2, gl.FLOAT, false, STRIDE, 0);
        gl.enableVertexAttribArray(this.aParticleSpeedLoc);
        gl.vertexAttribPointer(this.aParticleSpeedLoc, 1, gl.FLOAT, false, STRIDE, 2 * 4);
        gl.enableVertexAttribArray(this.aParticleAlphaLoc);
        gl.vertexAttribPointer(this.aParticleAlphaLoc, 1, gl.FLOAT, false, STRIDE, 3 * 4);

        const drawCount = TOTAL_POINTS;
        gl.drawArrays(gl.POINTS, 0, drawCount);

        gl.disableVertexAttribArray(this.aParticlePosLoc);
        gl.disableVertexAttribArray(this.aParticleSpeedLoc);
        gl.disableVertexAttribArray(this.aParticleAlphaLoc);

        // Unbind wind textures
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(prevActiveTex);

        gl.useProgram(prevProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
        if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);

        this.map?.triggerRepaint();
    }

    // ── Cleanup ────────────────────────────────────────────────

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        if (this.program) gl.deleteProgram(this.program);
        if (this.heatmapProgram) gl.deleteProgram(this.heatmapProgram);
        if (this.particleBuffer) gl.deleteBuffer(this.particleBuffer);
        if (this.heatmapQuadBuffer) gl.deleteBuffer(this.heatmapQuadBuffer);
        if (this.heatmapIndexBuffer) gl.deleteBuffer(this.heatmapIndexBuffer);
        if (this.windTexture0) gl.deleteTexture(this.windTexture0);
        if (this.windTexture1) gl.deleteTexture(this.windTexture1);
        if (this.speedTexture) gl.deleteTexture(this.speedTexture);
        this.program = null;
        this.heatmapProgram = null;
        this.particleBuffer = null;
        this.heatmapQuadBuffer = null;
        this.heatmapIndexBuffer = null;
        this.windTexture0 = null;
        this.windTexture1 = null;
        this.speedTexture = null;
        this.windTimeline = [];
        this.map = null;
        this.gl = null;
    }
}
