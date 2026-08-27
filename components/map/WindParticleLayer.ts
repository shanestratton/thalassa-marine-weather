/**
 * @filesize-justified WebGL2 shader class — vertex/fragment shaders + GPU buffer management are tightly coupled by design.
 *
 * ⚠️ NOT WIRED UP. NOTHING IN THE APP RENDERS THIS LAYER.
 *
 * Its only instantiation is components/map/ThalassaMap.tsx, and nothing
 * imports ThalassaMap — both are reachable from tests alone. The OBS page is
 * MapHub, and MapHub renders components/map/MapboxVelocityOverlay.tsx (a
 * leaflet-velocity bridge). That is the wind you see.
 *
 * This matters because it has already cost three rounds: the particle count,
 * speed and size ramps below were tuned on 2026-08-23, 08-27 and 08-28 in
 * response to Shane reporting the field was too dense, too fast and too
 * coarse at z9 — and every one of them shipped no visible change, because
 * this file does not run. The tests covering them are source-text assertions,
 * so they passed throughout and hid it.
 *
 * Tune MapboxVelocityOverlay.tsx instead; tests/WindParticleDensityRamp.test.ts
 * pins that one. Keep this file only if it is going to be wired up — otherwise
 * it is 1,100 lines of convincing-looking misdirection.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { particleScale } from '../../utils/deviceTier';
import { crumb } from '../../utils/flightRecorder';

const log = createLogger('WindParticleLayer');
import type { WindGrid } from '../../services/weather/windField';

const MAX_SPEED = 60.0;
/**
 * Particle budget (Shane 2026-08-22: "speed, speed and speed … not too many
 * and not too fast, but maintain the colouring").
 *
 * This layer keeps its particle state on the CPU and re-uploads the WHOLE
 * trail buffer to the GPU every frame (bufferSubData in render). The cost is
 * therefore particles × trail × 5 floats × 4 bytes, per frame, on top of a
 * CPU loop that shifts every trail point. At the old 30 000 × 30 that was an
 * 18 MB upload and ~900 k float moves per frame — ~1 GB/s of bus traffic at
 * 60 fps on a phone, which is what "slow to load" felt like: the first
 * seconds after the grid landed were spent choking on the animation, not
 * the data. Windy runs a few thousand particles with GPU-side state.
 *
 * 9 000 × 18 is 3.2 MB per frame — 5.6× less — and the colour ramp in
 * PARTICLE_FRAG is per-particle speed, so fewer particles do not change what
 * a given wind looks like, only how crowded it is. Tiers scale from here.
 */
// Device-tiered: 9k on high-end, 6.3k on mid, 3.6k on low (iPhone 8/SE).
const NUM_PARTICLES = Math.round(9000 * particleScale());
const MAX_AGE = 250;
/** Advection step per frame. 0.00025 read as "too fast" on the phone — the
 *  sperm sprinted. Slower also makes the speed COLOUR do more of the work of
 *  saying "it is blowing here", which is the honest signal anyway. */
const SPEED_FACTOR = 0.00016;
const MS_TO_KNOTS = 1.94384;
const VELOCITY_KILL_THRESHOLD = 0.3; // knots — kill particles in convergence zones
const RANDOM_DROP_RATE = 0.004; // 0.4% chance per frame of spontaneous respawn
const TRAIL_LENGTH = 18;

/**
 * THE ZOOM RAMP, round two. The 2026-08-23 version halved count and step
 * together at z9 — not enough (Shane 2026-08-27: "a lot less wind sperm when
 * we are zoomed at level 9, and put it on a sliding scale to level 3?? ther
 * is just way to many. also we need to slow them down at zoom level 9 and
 * sliding scale to zoom 3"). Count and step now ramp SEPARATELY, because
 * their physics differ:
 *
 * SPEED: the advection step is in DEGREES per frame, and screen pixels per
 * degree double with every zoom level — an unchanged step is 64x as fast on
 * screen at z9 as at z3. The particles were never accelerating; the map was.
 * The step therefore now HALVES per zoom level between z3 and z9, which
 * cancels the doubling exactly: every zoom in that range moves at z3's
 * on-screen pace — the pace he has never complained about. Clamped at z9 so
 * zooming past it doesn't grind the field to a stop (stillness reads as
 * broken).
 *
 * COUNT: density has the mirror problem (9 000 across the Coral Sea at z3 is
 * sparse; 9 000 in one bay at z9 is a swarm), but area-proportional thinning
 * would leave single digits at z9 — the field must still read as a field. A
 * linear ramp to a QUARTER at z9 is "a lot less" without going empty.
 *
 * Both anchored so the WIDE end is unchanged: at z3 this is exactly today's
 * count and today's step.
 */
const WIND_ZOOM_TIGHT = 9;
const WIND_ZOOM_WIDE = 3;
const WIND_ZOOM_MIN_FACTOR = 0.25;
/**
 * Particle SIZE, the third ramp (Shane 2026-08-28: "make the sperm smaller at
 * level 9, and go to a sliding scale to level 3… what i am trying to achieve
 * is that zoom level 9 looks more like zoom level 3. at the moment it
 * doesn't").
 *
 * It didn't because size ran the WRONG WAY: the shader grew the point from
 * 2.5px at z3 to 5.0px at z10, so the tight end — already the crowded, fast
 * end before the count and step ramps landed — also drew the fattest marks.
 * Zoomed in you saw big slow blobs; zoomed out, fine texture. Count and speed
 * were fixed on 2026-08-23/27; this is the half that was still inverted.
 *
 * Now it shrinks with zoom, over the same z3→z9 span the other two ramps use,
 * so all three agree: at z9 the field is a quarter as dense, moving at z3's
 * on-screen pace, drawn a touch finer than z3. Held at the wide end so z3 is
 * exactly what it is today.
 */
const WIND_POINT_SIZE_WIDE = 2.5;
const WIND_POINT_SIZE_TIGHT = 1.9;

/** 0.25 at z9+, 1.0 at z3-, linear between. Drives particle COUNT. */
export function windZoomFactor(zoom: number): number {
    if (!Number.isFinite(zoom)) return 1;
    const t = (WIND_ZOOM_TIGHT - zoom) / (WIND_ZOOM_TIGHT - WIND_ZOOM_WIDE);
    const clamped = Math.min(1, Math.max(0, t));
    return WIND_ZOOM_MIN_FACTOR + (1 - WIND_ZOOM_MIN_FACTOR) * clamped;
}

/** Advection-step factor: halves per zoom level from z3 (1.0) to z9 (1/64),
 *  cancelling the pixels-per-degree doubling so ON-SCREEN speed stays at
 *  z3's pace across the whole range. Clamped both ends. */
export function windStepZoomFactor(zoom: number): number {
    if (!Number.isFinite(zoom)) return 1;
    const clamped = Math.min(WIND_ZOOM_TIGHT, Math.max(WIND_ZOOM_WIDE, zoom));
    return Math.pow(2, -(clamped - WIND_ZOOM_WIDE));
}

/** Particles actually simulated and drawn at this zoom. The buffer is always
 *  allocated for the maximum, so this never reallocates — it just draws less. */
export function windParticlesForZoom(zoom: number, max: number): number {
    return Math.max(1, Math.round(max * windZoomFactor(zoom)));
}
const FLOATS_PER_TRAIL_PT = 5; // x, y, speed, alpha, opposition
const FLOATS_PER_PARTICLE = TRAIL_LENGTH * FLOATS_PER_TRAIL_PT;

/** The budget, exported so a contract test can hold the per-frame upload to
 *  a ceiling instead of someone quietly nudging the count back up. */
export const WIND_PARTICLE_BUDGET = {
    baseParticles: 9000,
    trailLength: TRAIL_LENGTH,
    speedFactor: SPEED_FACTOR,
    /** Bytes re-uploaded to the GPU per frame at the high-end tier, at the
     *  WIDEST zoom — the worst case, and unchanged by the zoom ramp. */
    bytesPerFrameHighTier: 9000 * TRAIL_LENGTH * FLOATS_PER_TRAIL_PT * 4,
    /** …and at the tightest zoom, where the ramp quarters it. */
    bytesPerFrameTightZoom: Math.round(9000 * WIND_ZOOM_MIN_FACTOR) * TRAIL_LENGTH * FLOATS_PER_TRAIL_PT * 4,
    zoomFactorRange: [WIND_ZOOM_MIN_FACTOR, 1] as const,
    /** Step ramp bounds: z3 pace preserved on-screen across z3–z9. */
    stepFactorRange: [Math.pow(2, -(WIND_ZOOM_TIGHT - WIND_ZOOM_WIDE)), 1] as const,
    /** Point size in px: z3 unchanged, finer at z9 — the ramp that was inverted. */
    pointSizeRange: [WIND_POINT_SIZE_TIGHT, WIND_POINT_SIZE_WIDE] as const,
} as const;

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

// ── East Australian Current (EAC) — Static Lookup ─────────────
// The EAC flows consistently southward along the Australian east coast.
// These regional boxes define where current flows, with direction vectors.
// Phase 2: replace with live HYCOM API data.

interface CurrentRegion {
    south: number;
    north: number;
    west: number;
    east: number;
    /** Current direction U (m/s, positive = eastward) */
    cu: number;
    /** Current direction V (m/s, positive = northward) */
    cv: number;
}

const EAC_REGIONS: CurrentRegion[] = [
    // Main EAC flow — strong southward (−1.5 m/s), slight onshore
    { south: -33, north: -25, west: 152, east: 155, cu: 0.2, cv: -1.5 },
    // EAC extension — weaker southward past Sydney
    { south: -37, north: -33, west: 150, east: 153, cu: 0.1, cv: -0.8 },
    // Northern feeder — moderate southward into the EAC
    { south: -25, north: -20, west: 153, east: 156, cu: 0.1, cv: -1.0 },
];

/** Sample ocean current at a geographic position. Returns [cu, cv] or null if outside known current zones. */
function sampleCurrentDirection(lat: number, lon: number): [number, number] | null {
    for (const r of EAC_REGIONS) {
        if (lat >= r.south && lat <= r.north && lon >= r.west && lon <= r.east) {
            return [r.cu, r.cv];
        }
    }
    return null;
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
    // Monochrome slate ramp — professional, near-invisible at low wind.
    // Only gale+ gets a subtle warm accent.
    vec3 dark    = vec3(0.06, 0.07, 0.09);   // near-black calm
    vec3 slate1  = vec3(0.12, 0.13, 0.16);   // light breeze
    vec3 slate2  = vec3(0.20, 0.21, 0.24);   // gentle breeze
    vec3 slate3  = vec3(0.30, 0.31, 0.33);   // moderate breeze
    vec3 slate4  = vec3(0.42, 0.42, 0.43);   // fresh breeze
    vec3 warm    = vec3(0.55, 0.40, 0.30);   // gale — subtle amber
    vec3 danger  = vec3(0.65, 0.30, 0.28);   // storm — muted coral

    float t;
    if (speed < 3.0) {
        t = speed / 3.0;
        return mix(dark, slate1, t);
    } else if (speed < 8.0) {
        t = (speed - 3.0) / 5.0;
        return mix(slate1, slate2, t);
    } else if (speed < 15.0) {
        t = (speed - 8.0) / 7.0;
        return mix(slate2, slate3, t);
    } else if (speed < 25.0) {
        t = (speed - 15.0) / 10.0;
        return mix(slate3, slate4, t);
    } else if (speed < 35.0) {
        t = (speed - 25.0) / 10.0;
        return mix(slate4, warm, t);
    } else if (speed < 50.0) {
        t = (speed - 35.0) / 15.0;
        return mix(warm, danger, t);
    } else {
        t = smoothstep(50.0, 70.0, speed);
        return mix(danger, vec3(0.70, 0.25, 0.30), t);
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
attribute float a_particle_opposition;
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds;
uniform vec4 u_bbox;
uniform float u_zoom;
uniform float u_lon_offset;
varying float v_speed;
varying float v_alpha;
varying float v_opposition;

const float PI = 3.14159265359;

vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    float lat = u_grid_bounds.x + a_particle_pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    float lon = u_grid_bounds.z + a_particle_pos.x * (u_grid_bounds.w - u_grid_bounds.z) + u_lon_offset;

    if (lat < -85.0 || lat > 85.0 || a_particle_alpha <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }

    v_speed = a_particle_speed;
    v_alpha = a_particle_alpha;
    v_opposition = a_particle_opposition;
    vec2 merc = toMercator(lon, lat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
    gl_PointSize = mix(${WIND_POINT_SIZE_WIDE.toFixed(1)}, ${WIND_POINT_SIZE_TIGHT.toFixed(1)}, clamp((u_zoom - ${WIND_ZOOM_WIDE}.0) / ${WIND_ZOOM_TIGHT - WIND_ZOOM_WIDE}.0, 0.0, 1.0));
}`;

const PARTICLE_FRAG = `
precision highp float;
varying float v_speed;
varying float v_alpha;
varying float v_opposition;

void main() {
    // Speed-based color ramp: steel blue → warm amber → coral
    float t = smoothstep(2.0, 40.0, v_speed);
    vec3 calm   = vec3(0.55, 0.65, 0.78);   // steel blue — light winds
    vec3 fresh  = vec3(0.85, 0.75, 0.50);   // warm amber — moderate
    vec3 gale   = vec3(0.90, 0.45, 0.40);   // coral red  — strong
    vec3 color = t < 0.5
        ? mix(calm, fresh, t * 2.0)
        : mix(fresh, gale, (t - 0.5) * 2.0);

    // Wind-Against-Current: blend toward warning orange when opposing
    vec3 warning = vec3(0.95, 0.55, 0.15);   // bright warning orange
    color = mix(color, warning, v_opposition * 0.85);

    // Boost alpha slightly when opposing — make danger more visible
    float alpha = v_alpha * mix(0.35, 0.65, t);
    alpha = mix(alpha, max(alpha, 0.7), v_opposition * 0.5);
    gl_FragColor = vec4(color, alpha);
}`;

// ── Helpers ───────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, source: string, label: string): WebGLShader {
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

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader, label: string): WebGLProgram {
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
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    private map: mapboxgl.Map | null = null;
    private gl: WebGLRenderingContext | null = null;

    // Particle shader locations
    private program: WebGLProgram | null = null;
    private particleBuffer: WebGLBuffer | null = null;
    private aParticlePosLoc: number = -1;
    private aParticleSpeedLoc: number = -1;
    private aParticleAlphaLoc: number = -1;
    private aParticleOppositionLoc: number = -1;
    private particleVAO: WebGLVertexArrayObject | null = null;
    private uMatrixLoc: WebGLUniformLocation | null = null;
    private uGridBoundsLoc: WebGLUniformLocation | null = null;
    private uBboxLoc: WebGLUniformLocation | null = null;
    private uZoomLoc: WebGLUniformLocation | null = null;
    private uLonOffsetLoc: WebGLUniformLocation | null = null;
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
    private landMask: Uint8Array | null = null;

    // Wind textures: pair for current interpolation (GPU path, future use)
    private windTexture0: WebGLTexture | null = null;
    private windTexture1: WebGLTexture | null = null;
    private windTexWidth: number = 0;
    private windTexHeight: number = 0;

    // Trail buffer
    private trailData: Float32Array;
    private _debugFrame = 0;
    private _lastRenderTime = 0;
    /** The single pending repaint keepalive. Kill #28 audit: both render
     *  paths used to fire handle-less setTimeouts, so a camera animation
     *  could seed up to ~4 parallel 66 ms chains that each re-armed forever,
     *  floating the idle repaint duty cycle above the intended 15 fps.
     *  Current/Wave/Sst layers already cancel-and-reschedule; now this one
     *  does too. */
    private _repaintTimer: ReturnType<typeof setTimeout> | null = null;
    private particleAges: Int32Array;
    /** Particles simulated and drawn right now — never above NUM_PARTICLES,
     *  which is what the buffer is sized for. Zoom moves this, not the
     *  allocation, so tightening the view frees GPU upload without ever
     *  reallocating. */
    private activeParticles = NUM_PARTICLES;
    /** Advection step for the current zoom (degrees/frame). */
    private speedFactor = SPEED_FACTOR;
    /** Rounded zoom the two above were computed for. */
    private zoomBudgetFor = Number.NaN;
    /** Cached view over the active slice, so the per-frame upload does not
     *  allocate a new subarray every frame. */
    private uploadView: Float32Array | null = null;

    // ── Timeline: all timesteps stored as CPU arrays ──
    private windTimeline: WindTimestep[] = [];
    private windGridWidth: number = 0;
    private windGridHeight: number = 0;
    private totalHours: number = 0;

    // Current interpolation state (fractional hour → smooth blend)
    private forecastHour: number = 0; // float, e.g. 4.5
    private blendFactor: number = 0; // 0.0–1.0 between hourA and hourB
    // Sentinel -1 means "nothing uploaded yet" so the very first
    // setForecastHour() call always hits the upload path.
    private hourIdxA: number = -1; // floor index into windTimeline
    private hourIdxB: number = -1; // ceil index into windTimeline

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
    private _onVisibilityChange: (() => void) | null = null;

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
                this.trailData[offset] = px; // x
                this.trailData[offset + 1] = py; // y
                this.trailData[offset + 2] = 0; // speed
                this.trailData[offset + 3] = 0; // alpha
                this.trailData[offset + 4] = 0; // opposition
            }
            this.trailData[base + 3] = 0.85;
            this.particleAges[i] = Math.floor(Math.random() * MAX_AGE);
        }
    }

    // ── WebGL init ────────────────────────────────────────────

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        log.info(`[WindGL] onAdd called — gl context:`, gl ? 'valid' : 'null');
        this.map = map;
        this.gl = gl;

        const vs = compileShader(gl, gl.VERTEX_SHADER, PARTICLE_VERT, 'particle-vert');
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, PARTICLE_FRAG, 'particle-frag');
        this.program = linkProgram(gl, vs, fs, 'particle');

        this.aParticlePosLoc = gl.getAttribLocation(this.program, 'a_particle_pos');
        this.aParticleSpeedLoc = gl.getAttribLocation(this.program, 'a_particle_speed');
        this.aParticleAlphaLoc = gl.getAttribLocation(this.program, 'a_particle_alpha');
        this.aParticleOppositionLoc = gl.getAttribLocation(this.program, 'a_particle_opposition');

        this.uMatrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
        this.uGridBoundsLoc = gl.getUniformLocation(this.program, 'u_grid_bounds');
        this.uBboxLoc = gl.getUniformLocation(this.program, 'u_bbox');
        this.uZoomLoc = gl.getUniformLocation(this.program, 'u_zoom');
        this.uLonOffsetLoc = gl.getUniformLocation(this.program, 'u_lon_offset');
        this.uWindTex0Loc = gl.getUniformLocation(this.program, 'u_wind_texture_0');
        this.uWindTex1Loc = gl.getUniformLocation(this.program, 'u_wind_texture_1');
        this.uTimeBlendLoc = gl.getUniformLocation(this.program, 'u_time_blend');

        const buf = gl.createBuffer();
        if (!buf) throw new Error('[WindParticleLayer] Failed to create particle buffer');
        this.particleBuffer = buf;

        // WebGL2: create our own VAO so attribute state isn't recorded into MapLibre's VAO
        const gl2 = gl as WebGL2RenderingContext;
        if (gl2.createVertexArray) {
            this.particleVAO = gl2.createVertexArray();
            gl2.bindVertexArray(this.particleVAO);
            log.info('[WindGL] Using WebGL2 VAO for particle attributes');
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.trailData, gl.DYNAMIC_DRAW);

        // Record attribute layout into our VAO now (once at init time)
        const STRIDE = FLOATS_PER_TRAIL_PT * 4;
        if (this.aParticlePosLoc >= 0) {
            gl.enableVertexAttribArray(this.aParticlePosLoc);
            gl.vertexAttribPointer(this.aParticlePosLoc, 2, gl.FLOAT, false, STRIDE, 0);
        }
        if (this.aParticleSpeedLoc >= 0) {
            gl.enableVertexAttribArray(this.aParticleSpeedLoc);
            gl.vertexAttribPointer(this.aParticleSpeedLoc, 1, gl.FLOAT, false, STRIDE, 2 * 4);
        }
        if (this.aParticleAlphaLoc >= 0) {
            gl.enableVertexAttribArray(this.aParticleAlphaLoc);
            gl.vertexAttribPointer(this.aParticleAlphaLoc, 1, gl.FLOAT, false, STRIDE, 3 * 4);
        }
        if (this.aParticleOppositionLoc >= 0) {
            gl.enableVertexAttribArray(this.aParticleOppositionLoc);
            gl.vertexAttribPointer(this.aParticleOppositionLoc, 1, gl.FLOAT, false, STRIDE, 4 * 4);
        }

        // Unbind our VAO so MapLibre's state isn't affected
        if (gl2.bindVertexArray) gl2.bindVertexArray(null);

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

        if (this.pendingGrid) {
            const { grid, hour } = this.pendingGrid;
            this.pendingGrid = null;
            this.setGrid(grid, hour);
        }

        // Resume rendering when the page becomes visible again.
        // The render() method gates triggerRepaint() behind !document.hidden,
        // so when the user backgrounds the app, the loop stops. This listener
        // kicks it back off when they return.
        this._onVisibilityChange = () => {
            if (!document.hidden && this.windTimeline.length > 0) {
                this.map?.triggerRepaint();
            }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    // ── Data loading ──────────────────────────────────────────

    /**
     * Load a full WindGrid and build the timeline of all hourly timesteps.
     * Accepts a fractional starting hour for smooth initial positioning.
     */
    /** performance.now() at the last setGrid; the first render after it
     *  reports the grid→first-frame latency, which is the number the
     *  skipper actually feels. */
    private _gridSetAt = 0;
    private _firstFrameReported = true;

    setGrid(grid: WindGrid, hour: number = 0): void {
        this.currentGrid = grid;
        const perfT0 = performance.now();

        if (!this.gl) {
            this.pendingGrid = { grid, hour };
            log.info(`[WindGL] setGrid: GL not ready, queuing grid ${grid.width}×${grid.height}`);
            return;
        }

        // Keep the OUTGOING bounds so particles can be carried across the
        // change geographically instead of being teleported — see
        // remapParticlesAcrossBounds.
        const prevBounds = this.windTimeline.length > 0 ? { ...this.gridBounds } : null;
        this.dataBounds = this.sanitizeBounds({
            north: grid.north,
            south: grid.south,
            east: grid.east,
            west: grid.west,
        });
        this.gridBounds = { ...this.dataBounds };
        this.windGridWidth = grid.width;
        this.windGridHeight = grid.height;
        this.totalHours = grid.totalHours;

        // Detect global mode: full 360° longitude coverage
        this.globalMode = Math.abs(grid.east - grid.west) >= 359;

        // Build timeline: store all hourly U/V arrays
        this.windTimeline = [];
        // Reset bracketing indices so setForecastHour() below force-uploads
        // the new grid's textures — otherwise a fresh grid that happens to
        // keep the same scrub hour would short-circuit the upload path and
        // the GPU would render stale data from the previous grid.
        this.hourIdxA = -1;
        this.hourIdxB = -1;
        const size = grid.width * grid.height;

        log.info(
            `[WindGL] setGrid: ${grid.width}×${grid.height}, totalHours=${grid.totalHours}, u.length=${grid.u.length}, bounds=[${grid.south},${grid.north}]×[${grid.west},${grid.east}]`,
        );

        for (let h = 0; h < grid.totalHours; h++) {
            const uSrc = grid.u[h];
            const vSrc = grid.v[h];
            if (!uSrc || !vSrc) {
                log.warn(`[WindGL] setGrid: hour ${h} missing data — u:${!!uSrc} v:${!!vSrc}`);
                continue;
            }

            const u = new Float32Array(size);
            u.set(uSrc.subarray(0, size));
            const v = new Float32Array(size);
            v.set(vSrc.subarray(0, size));
            this.windTimeline.push({ u, v });
        }

        this.totalHours = this.windTimeline.length;
        log.info(`[WindGL] setGrid: built ${this.windTimeline.length} timesteps, maxSpeed calc...`);

        // Compute max speed across ALL timesteps for legend
        let gridMax = 0;
        for (const ts of this.windTimeline) {
            for (let i = 0; i < size; i++) {
                const spd = Math.sqrt(ts.u[i] * ts.u[i] + ts.v[i] * ts.v[i]) * MS_TO_KNOTS;
                if (spd > gridMax) gridMax = spd;
            }
        }
        this.maxObservedSpeed = gridMax;
        log.info(`[WindGL] setGrid: maxSpeed=${gridMax.toFixed(1)} kts, uploading textures...`);

        // ── Upload speed texture for heatmap ──
        this._uploadSpeedTexture(grid);

        // Set initial hour and upload first pair of textures
        this.setForecastHour(hour);
        this.remapParticlesAcrossBounds(prevBounds);

        // Reset render log counter so we see the first render with actual data
        this._renderLogCount = 0;
        // warn, not info (info is silent in prod): this is the boot-speed
        // ground truth for wind, split so fetch vs GPU vs first paint are
        // separately visible in a device log (Shane 2026-08-22).
        log.warn(
            `[perf] wind grid→GPU ${Math.round(performance.now() - perfT0)}ms ` +
                `(${grid.width}×${grid.height}×${this.windTimeline.length}h, ${NUM_PARTICLES} particles)`,
        );
        crumb('wind:gpu', `${Math.round(performance.now() - perfT0)}ms`);
        this._gridSetAt = performance.now();
        this._firstFrameReported = false;
        this.map?.triggerRepaint();
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
            -1.0,
            0.0, // bottom-left  (1 world west)
            2.0,
            0.0, // bottom-right (2 worlds east)
            -1.0,
            1.0, // top-left
            2.0,
            1.0, // top-right
        ]);

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
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
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
        gl: WebGLRenderingContext,
        tex: WebGLTexture,
        u: Float32Array,
        v: Float32Array,
        w: number,
        h: number,
        size: number,
    ): void {
        const rgba = new Uint8Array(size * 4);
        const inv = 255.0 / (2.0 * MAX_SPEED);
        for (let i = 0; i < size; i++) {
            const o = i * 4;
            rgba[o] = Math.round(Math.max(0, Math.min(255, (u[i] + MAX_SPEED) * inv)));
            rgba[o + 1] = Math.round(Math.max(0, Math.min(255, (v[i] + MAX_SPEED) * inv)));
            rgba[o + 2] = 0;
            rgba[o + 3] = 255;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }

    /**
     * Set the forecast hour as a FLOAT for smooth interpolation.
     * e.g., setForecastHour(4.5) blends 50/50 between hour 4 and hour 5.
     * Does NOT respawn particles — they smoothly transition.
     *
     * Texture re-uploads are cheap per-call but add up during scrubbing —
     * we only re-upload when the INTEGER bracketing hour changes. The
     * blendFactor handles sub-hour interpolation via a shader uniform, so
     * a drag that wiggles between hour 4.1 and 4.9 only uploads once
     * (for hour 4 and hour 5), not 60 times per second.
     */
    setForecastHour(hour: number): void {
        if (this.windTimeline.length === 0) return;

        const maxIdx = this.totalHours - 1;
        const clamped = Math.max(0, Math.min(hour, maxIdx));
        this.forecastHour = clamped;

        const newIdxA = Math.floor(clamped);
        const newIdxB = Math.min(newIdxA + 1, maxIdx);
        const needsUpload = newIdxA !== this.hourIdxA || newIdxB !== this.hourIdxB;

        this.hourIdxA = newIdxA;
        this.hourIdxB = newIdxB;
        this.blendFactor = clamped - this.hourIdxA;

        // Only touch the GPU when the bracketing hour pair has actually
        // changed. Sub-hour scrub updates happen every RAF tick during a
        // drag — keeping them off the tex pipe saves 0.5–1 ms per tick.
        if (needsUpload) {
            const tsA = this.windTimeline[this.hourIdxA];
            const tsB = this.windTimeline[this.hourIdxB];
            if (tsA && this.windTexture0) this.uploadWindTexture(this.windTexture0, tsA.u, tsA.v);
            if (tsB && this.windTexture1) this.uploadWindTexture(this.windTexture1, tsB.u, tsB.v);
        }
    }

    /** Convenience: set integer hour (backward-compatible with setHour). */
    setHour(hour: number): void {
        this.setForecastHour(hour);
    }

    /** Set wind data for a single timestep (backward compat).
     *
     *  Optional landMask is a u8[width*height] plane (1=land, 0=ocean).
     *  When supplied, randomWithinBounds rejects land cells so particles
     *  don't spawn over land and sit there as static dots — a real
     *  problem for ocean-currents data where land cells are filled with
     *  zero velocity and cause stalled-particle artifacts. */
    setWindData(
        uData: Float32Array,
        vData: Float32Array,
        width: number,
        height: number,
        bounds: WindBounds,
        landMask?: Uint8Array,
    ): void {
        this.dataBounds = this.sanitizeBounds(bounds);
        this.gridBounds = { ...this.dataBounds };
        this.windGridWidth = width;
        this.windGridHeight = height;
        this.landMask = landMask && landMask.length === width * height ? landMask : null;

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
        // Reset to sentinels so the next setForecastHour re-uploads the
        // bracketing textures with the new grid data.
        this.hourIdxA = -1;
        this.hourIdxB = -1;
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
        const u =
            uArr[i00] * (1 - fx) * (1 - fy) +
            uArr[i10] * fx * (1 - fy) +
            uArr[i01] * (1 - fx) * fy +
            uArr[i11] * fx * fy;
        const v =
            vArr[i00] * (1 - fx) * (1 - fy) +
            vArr[i10] * fx * (1 - fy) +
            vArr[i01] * (1 - fx) * fy +
            vArr[i11] * fx * fy;
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
        return [uA * (1 - bf) + uB * bf, vA * (1 - bf) + vB * bf];
    }

    // ── Particle management ───────────────────────────────────

    /** Clamp bounds to valid geographic ranges — safety net for bogus GRIB data. */
    private sanitizeBounds(b: WindBounds): WindBounds {
        const clamped = {
            north: Math.max(-90, Math.min(90, b.north)),
            south: Math.max(-90, Math.min(90, b.south)),
            east: b.east,
            west: b.west,
        };
        if (clamped.north !== b.north || clamped.south !== b.south) {
            /* best effort */
        }
        return clamped;
    }

    private toGeo(nx: number, ny: number): [number, number] {
        return [
            this.gridBounds.west + nx * (this.gridBounds.east - this.gridBounds.west),
            this.gridBounds.south + ny * (this.gridBounds.north - this.gridBounds.south),
        ];
    }

    private randomWithinBounds(): [number, number] {
        const b = this.dataBounds;
        const gb = this.gridBounds;
        // Constrain to ±70° latitude to avoid polar degenerate zones
        const safeNorth = Math.min(b.north, 70);
        const safeSouth = Math.max(b.south, -70);
        const gbLonRange = gb.east - gb.west;
        const gbLatRange = gb.north - gb.south;

        const mask = this.landMask;
        const w = this.windGridWidth;
        const h = this.windGridHeight;
        // Up to 8 rejection-sample tries to land on an ocean cell. Tries
        // capped to keep this O(1) — for grids that are mostly land near
        // the bounds (e.g. tropical Pacific plus PNG), 8 is enough to find
        // ocean ~99.9% of the time without degrading first-paint cost.
        const maxTries = mask && w > 0 && h > 0 ? 8 : 1;
        for (let attempt = 0; attempt < maxTries; attempt++) {
            const lon = b.west + Math.random() * (b.east - b.west);
            const lat = safeSouth + Math.random() * (safeNorth - safeSouth);
            const nx = gbLonRange > 0 ? (lon - gb.west) / gbLonRange : Math.random();
            const ny = gbLatRange > 0 ? (lat - gb.south) / gbLatRange : Math.random();
            if (mask && w > 0 && h > 0) {
                // Mask is row-major north→south; ny=0 is south, ny=1 is north
                // (matches gridBounds south/north normalization).
                const col = Math.min(w - 1, Math.max(0, Math.floor(nx * w)));
                const row = Math.min(h - 1, Math.max(0, Math.floor((1 - ny) * h)));
                if (mask[row * w + col] === 1) continue; // land — try again
            }
            return [nx, ny];
        }
        // Exhausted — fall back to wherever we landed last (rare, <0.1%).
        const lon = b.west + Math.random() * (b.east - b.west);
        const lat = safeSouth + Math.random() * (safeNorth - safeSouth);
        const nx = gbLonRange > 0 ? (lon - gb.west) / gbLonRange : Math.random();
        const ny = gbLatRange > 0 ? (lat - gb.south) / gbLatRange : Math.random();
        return [nx, ny];
    }

    private respawnAllParticles(): void {
        // The WHOLE buffer, not just the active slice: a slot that is inactive
        // now becomes active the moment the user zooms out, and it must not
        // wake up holding a position from the previous grid.
        for (let i = 0; i < NUM_PARTICLES; i++) this.respawnParticle(i);
    }

    /**
     * Carry particles across a grid change instead of teleporting them.
     *
     * Every setGrid used to call respawnAllParticles(), so each publish
     * relocated all NUM_PARTICLES at once — and a zoom-out publishes two or
     * three times in a row (cached synoptic, then the refined fetch). That
     * visible reset is the "jerky" (Shane 2026-08-22: "make it so that it
     * flows nicely").
     *
     * Particle x/y are NORMALISED to the grid bounds, so the same 0..1 pair
     * means a different place on a different grid — which is exactly why a
     * naive keep would smear the field sideways. Converting through lon/lat
     * and back keeps every particle where it physically is; only the frame of
     * reference changes.
     *
     * Particles that fall outside the new grid ARE respawned, and that is
     * free visually: the grid always covers the viewport, so anything outside
     * it was off-screen anyway. Which means the particles a skipper can
     * actually see never move.
     */
    private remapParticlesAcrossBounds(prev: WindBounds | null): void {
        const gb = this.gridBounds;
        const prevLon = prev ? prev.east - prev.west : 0;
        const prevLat = prev ? prev.north - prev.south : 0;
        const newLon = gb.east - gb.west;
        const newLat = gb.north - gb.south;
        if (!prev || prevLon <= 0 || prevLat <= 0 || newLon <= 0 || newLat <= 0) {
            this.respawnAllParticles();
            return;
        }

        const data = this.trailData;
        const ages = this.particleAges;
        let carried = 0;
        for (let i = 0; i < NUM_PARTICLES; i++) {
            const base = i * FLOATS_PER_PARTICLE;
            // The HEAD decides whether this particle survives the change.
            const headLon = prev.west + data[base] * prevLon;
            const headLat = prev.south + data[base + 1] * prevLat;
            const hx = (headLon - gb.west) / newLon;
            const hy = (headLat - gb.south) / newLat;
            if (hx < 0 || hx > 1 || hy < 0 || hy > 1) {
                const [px, py] = this.randomWithinBounds();
                for (let t = 0; t < TRAIL_LENGTH; t++) {
                    const off = base + t * FLOATS_PER_TRAIL_PT;
                    data[off] = px;
                    data[off + 1] = py;
                    data[off + 2] = 0;
                    data[off + 3] = 0;
                    data[off + 4] = 0;
                }
                data[base + 3] = 0.85;
                ages[i] = Math.floor(Math.random() * MAX_AGE);
                continue;
            }
            // Whole trail, not just the head: remapping only the head would
            // stretch each trail between two coordinate systems and read as a
            // one-frame streak across the screen.
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const off = base + t * FLOATS_PER_TRAIL_PT;
                const lon = prev.west + data[off] * prevLon;
                const lat = prev.south + data[off + 1] * prevLat;
                data[off] = (lon - gb.west) / newLon;
                data[off + 1] = (lat - gb.south) / newLat;
            }
            carried++;
        }
        log.info(`[WindGL] bounds change: ${carried}/${NUM_PARTICLES} particles carried across`);
    }

    /**
     * Re-point the count and the step at the current zoom.
     *
     * Bucketed on the ROUNDED zoom so a pinch does not respawn particles on
     * every frame of the gesture; the step itself reads the exact zoom, so it
     * stays smooth through the pinch while the population only steps.
     *
     * Growing the population activates slots whose trail data is stale — the
     * last thing simulated there, possibly a whole ocean away — so newly
     * active particles are respawned rather than teleported in mid-trail.
     */
    private syncZoomBudget(): void {
        const zoom = this.map?.getZoom?.();
        if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return;
        this.speedFactor = SPEED_FACTOR * windStepZoomFactor(zoom);

        const bucket = Math.round(zoom);
        if (bucket === this.zoomBudgetFor) return;
        this.zoomBudgetFor = bucket;

        const next = Math.min(NUM_PARTICLES, windParticlesForZoom(bucket, NUM_PARTICLES));
        if (next === this.activeParticles) return;

        if (next > this.activeParticles) {
            for (let i = this.activeParticles; i < next; i++) this.respawnParticle(i);
        }
        this.activeParticles = next;
        this.uploadView = null; // slice changed
    }

    /** Seed one particle at a random point in bounds, whole trail collapsed
     *  onto it so it does not draw a streak from wherever it used to be. */
    private respawnParticle(i: number): void {
        const data = this.trailData;
        const [px, py] = this.randomWithinBounds();
        const base = i * FLOATS_PER_PARTICLE;
        for (let t = 0; t < TRAIL_LENGTH; t++) {
            const offset = base + t * FLOATS_PER_TRAIL_PT;
            data[offset] = px;
            data[offset + 1] = py;
            data[offset + 2] = 0;
            data[offset + 3] = 0;
            data[offset + 4] = 0;
        }
        data[base + 3] = 0.85;
        this.particleAges[i] = Math.floor(Math.random() * MAX_AGE);
    }

    private advectParticles(): void {
        this.syncZoomBudget();
        const data = this.trailData;
        const ages = this.particleAges;
        const hasWind = this.windTimeline.length > 0;
        const b = this.dataBounds;

        // Active slice only. Inactive slots keep their last state and are
        // respawned on the way back in, so zooming out does not stream a
        // sudden wall of particles from wherever they were left.
        for (let i = 0; i < this.activeParticles; i++) {
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

            let opposition = 0;

            if (hasWind) {
                const [u, v] = this.sampleWind(x, y);
                speedKnots = Math.sqrt(u * u + v * v) * MS_TO_KNOTS;

                // Scale displacement by cos(latitude) to prevent Mercator polar acceleration.
                const latDeg = this.gridBounds.south + y * (this.gridBounds.north - this.gridBounds.south);
                const lonDeg = this.gridBounds.west + x * (this.gridBounds.east - this.gridBounds.west);
                const cosLat = Math.max(0.1, Math.cos((latDeg * Math.PI) / 180));
                x += u * this.speedFactor * cosLat;
                y += v * this.speedFactor * cosLat;

                // Wind-Against-Current: compute opposition factor via dot product
                const current = sampleCurrentDirection(latDeg, lonDeg);
                if (current && speedKnots > 2) {
                    const [cu, cv] = current;
                    // Normalize wind direction
                    const windMag = Math.sqrt(u * u + v * v);
                    const curMag = Math.sqrt(cu * cu + cv * cv);
                    if (windMag > 0.01 && curMag > 0.01) {
                        // dot product of normalized directions: -1 = directly opposing, +1 = aligned
                        const dot = (u * cu + v * cv) / (windMag * curMag);
                        // opposition = 0 when aligned/perpendicular, 0→1 when opposing
                        opposition = Math.max(0, -dot);
                    }
                }
            }

            // ── Global wrapping vs bounded kill ──
            if (this.globalMode) {
                // Wrap X (longitude) seamlessly across antimeridian
                const prevX = data[base]; // position BEFORE advection stored at head
                if (x > 1.0) x -= 1.0;
                if (x < 0.0) x += 1.0;

                // If particle wrapped across antimeridian, kill entire trail
                if (Math.abs(x - prevX) > 0.5) {
                    for (let t = 0; t < TRAIL_LENGTH; t++) {
                        const offset = base + t * FLOATS_PER_TRAIL_PT;
                        data[offset] = x;
                        data[offset + 1] = y;
                        data[offset + 2] = 0;
                        data[offset + 3] = 0;
                        data[offset + 4] = 0;
                    }
                    data[base + 3] = 0.85;
                    ages[i] = 0;
                    continue;
                }

                // Kill for: polar zones, Y out of bounds, age, low velocity, or random drop
                const polarKill = y < 0.11 || y > 0.89; // ~±70° latitude
                const latOob = y < 0.0 || y > 1.0;
                const stalled = speedKnots < VELOCITY_KILL_THRESHOLD;
                const randomDrop = Math.random() < RANDOM_DROP_RATE;
                if (ages[i] >= MAX_AGE || latOob || polarKill || stalled || randomDrop) {
                    const [rx, ry] = this.randomWithinBounds();
                    for (let t = 0; t < TRAIL_LENGTH; t++) {
                        const offset = base + t * FLOATS_PER_TRAIL_PT;
                        data[offset] = rx;
                        data[offset + 1] = ry;
                        data[offset + 2] = 0;
                        data[offset + 3] = 0;
                        data[offset + 4] = 0;
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
                        data[offset + 4] = 0;
                    }
                    data[base + 3] = 0.85;
                    ages[i] = 0;
                    continue;
                }
            }

            data[base] = x;
            data[base + 1] = y;
            data[base + 2] = speedKnots;
            data[base + 4] = opposition; // Wind-Against-Current factor

            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                const fadeRatio = 1.0 - t / TRAIL_LENGTH;
                data[offset + 3] = 0.92 * fadeRatio;
            }
        }

        // DEBUG: expose state to window for browser inspection
        this._debugFrame++;
        if (this._debugFrame % 60 === 0) {
            const p0base = 0;
            const trail0 = [];
            for (let t = 0; t < 6; t++) {
                const off = p0base + t * FLOATS_PER_TRAIL_PT;
                trail0.push({ x: data[off], y: data[off + 1], spd: data[off + 2], a: data[off + 3] });
            }
            // Sample 10 particles
            const sample: Array<{ x: number; y: number; age: number }> = [];
            for (let i = 0; i < Math.min(10, NUM_PARTICLES); i++) {
                const b2 = i * FLOATS_PER_PARTICLE;
                sample.push({ x: data[b2], y: data[b2 + 1], age: ages[i] });
            }
            const wind0 = hasWind ? this.sampleWind(data[0], data[1]) : [0, 0];

            // Snapshot camera state so we can tell if Mapbox is animating
            // the view continuously (which forces the layer to re-render
            // each frame and can present as flashing).
            const m = this.map;
            const cam = m
                ? {
                      zoom: m.getZoom(),
                      center: m.getCenter().toArray(),
                      bearing: m.getBearing(),
                      pitch: m.getPitch(),
                      isMoving: m.isMoving(),
                      isZooming: m.isZooming(),
                      isEasing: m.isEasing(),
                  }
                : null;

            window.__windDebug = {
                frame: this._debugFrame,
                hasWind,
                timelineLen: this.windTimeline.length,
                dataBounds: { ...this.dataBounds },
                gridBounds: { ...this.gridBounds },
                globalMode: this.globalMode,
                trail0,
                sample,
                wind0: { u: wind0[0], v: wind0[1] },
                cam,
            };
        }
    }

    // ── Render ─────────────────────────────────────────────────

    private _renderLogCount = 0;

    render(gl: WebGLRenderingContext, matrixOrOptions: unknown): void {
        // PERF: Throttle to ~15fps when the map is idle. Wind particles
        // don't need 60fps; this cuts GPU load by ~75%.
        //
        // EXCEPTION: while Mapbox is animating its own camera (panning,
        // easeTo on zoom, fitBounds, etc.) it's already calling render()
        // every RAF tick whether we want it to or not. If we throttle in
        // that state, every Mapbox frame paints the base layer but skips
        // our particles → severe flashing while the camera moves.
        // Detection: map.isMoving()/isZooming()/isEasing() — draw every
        // frame while any is true.
        //
        // CRITICAL: when we bail on a throttled frame we must NOT request
        // an immediate repaint. Mapbox would call render() back on the
        // next RAF (~16ms), we'd bail again, → 4 bail cycles per draw.
        // Each bail still triggers a full Mapbox frame: framebuffer clear
        // + base-tile redraw + (no particles). Schedule next repaint at
        // the throttle deadline so Mapbox pauses until we're ready.
        const map = this.map;
        const mapAnimating = map ? map.isMoving() || map.isZooming() || map.isEasing() : false;
        const now = performance.now();
        const elapsed = now - this._lastRenderTime;
        if (!mapAnimating && elapsed < 66) {
            if (!document.hidden) {
                const remaining = 66 - elapsed;
                this._scheduleRepaint(remaining);
            }
            return;
        }
        this._lastRenderTime = now;

        if (!this._firstFrameReported && this.windTimeline.length > 0) {
            this._firstFrameReported = true;
            const sinceGrid = Math.round(now - this._gridSetAt);
            log.warn(`[perf] wind first frame +${sinceGrid}ms after grid`);
            crumb('wind:first-frame', `+${sinceGrid}ms`);
        }

        if (!this.program || !this.particleBuffer || !matrixOrOptions) {
            if (this._renderLogCount < 3) {
                log.warn(
                    `[WindGL] render bail: program=${!!this.program} buf=${!!this.particleBuffer} arg=${!!matrixOrOptions} timeline=${this.windTimeline.length}`,
                );
                this._renderLogCount++;
            }
            return;
        }

        // MapLibre v3+ passes { modelViewProjectionMatrix, projectionMatrix, ... }
        // MapLibre v2 / Mapbox passes a flat matrix (number[] | Float64Array)
        let rawMatrix = matrixOrOptions;
        if (
            matrixOrOptions &&
            typeof matrixOrOptions === 'object' &&
            !ArrayBuffer.isView(matrixOrOptions) &&
            !Array.isArray(matrixOrOptions)
        ) {
            // In MapLibre GL JS v3, defaultProjectionData.mainMatrix is the correct matrix for
            // 2D custom layers. modelViewProjectionMatrix does NOT work for [0,1] Mercator coords.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const opts = matrixOrOptions as any;
            rawMatrix =
                opts.defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix ?? opts.projectionMatrix;
            if (this._renderLogCount < 2) {
                log.info(
                    `[WindGL] MapLibre v3 — mainMatrix[0]=${opts.defaultProjectionData?.mainMatrix?.[0]?.toFixed(0)}`,
                );
            }
        }

        if (!rawMatrix) {
            if (this._renderLogCount < 3) {
                log.warn(
                    `[WindGL] No valid matrix in render arg. Type: ${typeof matrixOrOptions}, constructor: ${matrixOrOptions?.constructor?.name}`,
                );
                this._renderLogCount++;
            }
            return;
        }

        // Convert to Float32Array safely (MapLibre Float64Array, Mapbox number[])
        let mat: Float32Array;
        if (rawMatrix instanceof Float32Array) {
            mat = rawMatrix;
        } else {
            // Use Array.from for correct element-by-element copy from Float64Array
            mat = new Float32Array(Array.from(rawMatrix as ArrayLike<number>));
        }

        if (mat.length !== 16) {
            if (this._renderLogCount < 3) {
                log.warn(
                    `[WindGL] Invalid matrix length: ${mat.length} (expected 16). Raw type: ${rawMatrix?.constructor?.name}`,
                );
                this._renderLogCount++;
            }
            return;
        }

        if (this._renderLogCount < 3) {
            log.info(
                `[WindGL] Rendering: timeline=${this.windTimeline.length} particles=${NUM_PARTICLES} mat[0]=${mat[0].toFixed(4)} gridBounds=[${this.gridBounds.south},${this.gridBounds.north}]×[${this.gridBounds.west},${this.gridBounds.east}]`,
            );
            this._renderLogCount++;
        }

        const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);

        this.advectParticles();

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        // ── Draw heatmap first (colored wind speed background) ──
        if (this.heatmapProgram && this.speedTexture && this.heatmapQuadBuffer && this.heatmapGridW > 0) {
            gl.useProgram(this.heatmapProgram);
            if (this.heatmapUMatrix) gl.uniformMatrix4fv(this.heatmapUMatrix, false, mat);
            if (this.heatmapUGridBounds) {
                gl.uniform4f(
                    this.heatmapUGridBounds,
                    this.gridBounds.south,
                    this.gridBounds.north,
                    this.gridBounds.west,
                    this.gridBounds.east,
                );
            }
            if (this.heatmapUOpacity) gl.uniform1f(this.heatmapUOpacity, 0.12);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.speedTexture);
            if (this.heatmapUSpeedTex) gl.uniform1i(this.heatmapUSpeedTex, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmapQuadBuffer);
            if (this.heatmapAPos >= 0) {
                gl.enableVertexAttribArray(this.heatmapAPos);
                gl.vertexAttribPointer(this.heatmapAPos, 2, gl.FLOAT, false, 0, 0);
            }

            // Ensure no culling prevents rendering
            gl.disable(gl.CULL_FACE);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            if (this.heatmapAPos >= 0) gl.disableVertexAttribArray(this.heatmapAPos);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

        // ── Draw particles (white streams) ──
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
        if (this.uBboxLoc) {
            gl.uniform4f(
                this.uBboxLoc,
                this.dataBounds.west,
                this.dataBounds.south,
                this.dataBounds.east,
                this.dataBounds.north,
            );
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

        // Save MapLibre's VAO, bind ours for the draw
        const gl2 = gl as WebGL2RenderingContext;
        const prevVAO = gl2.getParameter ? gl2.getParameter(gl2.VERTEX_ARRAY_BINDING) : null;
        if (gl2.bindVertexArray && this.particleVAO) {
            gl2.bindVertexArray(this.particleVAO);
        } else {
            // WebGL1 fallback: manually set up attributes
            gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
            if (this.aParticlePosLoc >= 0) {
                gl.enableVertexAttribArray(this.aParticlePosLoc);
                gl.vertexAttribPointer(this.aParticlePosLoc, 2, gl.FLOAT, false, STRIDE, 0);
            }
            if (this.aParticleSpeedLoc >= 0) {
                gl.enableVertexAttribArray(this.aParticleSpeedLoc);
                gl.vertexAttribPointer(this.aParticleSpeedLoc, 1, gl.FLOAT, false, STRIDE, 2 * 4);
            }
            if (this.aParticleAlphaLoc >= 0) {
                gl.enableVertexAttribArray(this.aParticleAlphaLoc);
                gl.vertexAttribPointer(this.aParticleAlphaLoc, 1, gl.FLOAT, false, STRIDE, 3 * 4);
            }
            if (this.aParticleOppositionLoc >= 0) {
                gl.enableVertexAttribArray(this.aParticleOppositionLoc);
                gl.vertexAttribPointer(this.aParticleOppositionLoc, 1, gl.FLOAT, false, STRIDE, 4 * 4);
            }
        }

        // Update buffer data (our VAO keeps the buffer binding)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        // Upload ONLY what is simulated. At z9 that halves the per-frame
        // transfer — this buffer is re-uploaded every single frame, so the
        // saving is continuous, not one-off. The view is cached because
        // subarray() allocates, and allocating 60x a second to avoid
        // uploading is a poor trade.
        const active = Math.min(this.activeParticles, NUM_PARTICLES);
        if (!this.uploadView || this.uploadView.length !== active * FLOATS_PER_PARTICLE) {
            this.uploadView =
                active >= NUM_PARTICLES ? this.trailData : this.trailData.subarray(0, active * FLOATS_PER_PARTICLE);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uploadView);

        const drawCount = active * TRAIL_LENGTH;
        // Draw particles for 3 world copies: offset by -360°, 0°, +360°
        const worldOffsets = this.globalMode ? [-360, 0, 360] : [0];
        for (const offset of worldOffsets) {
            if (this.uLonOffsetLoc) gl.uniform1f(this.uLonOffsetLoc, offset);
            gl.drawArrays(gl.POINTS, 0, drawCount);
        }

        // Restore MapLibre's VAO
        if (gl2.bindVertexArray) gl2.bindVertexArray(prevVAO);

        // Unbind wind textures
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(prevActiveTex);

        gl.useProgram(prevProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
        if (prevBlend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);

        // Continue animation. If Mapbox is already driving its own RAF
        // loop (camera animating), do NOTHING — it'll call us next frame
        // anyway, and adding our timer would just queue redundant
        // repaints. When idle, schedule the next paint at the throttle
        // deadline so Mapbox pauses its loop until we're ready.
        if (document.hidden) return;
        if (mapAnimating) return; // Mapbox will RAF us anyway during animation
        this._scheduleRepaint(66);
    }

    /** One keepalive at a time — a new schedule replaces the pending one. */
    private _scheduleRepaint(ms: number): void {
        if (this._repaintTimer !== null) clearTimeout(this._repaintTimer);
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null;
            this.map?.triggerRepaint();
        }, ms);
    }

    // ── Cleanup ────────────────────────────────────────────────

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        if (this._repaintTimer !== null) {
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        }
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }
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
