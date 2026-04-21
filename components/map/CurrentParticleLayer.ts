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
const NUM_PARTICLES = 80000;
const TRAIL_LENGTH = 28;
const FLOATS_PER_TRAIL_PT = 4; // x, y, speed (m/s), alpha
const FLOATS_PER_PARTICLE = TRAIL_LENGTH * FLOATS_PER_TRAIL_PT;
const TOTAL_POINTS = NUM_PARTICLES * TRAIL_LENGTH;

/** Per-frame displacement = u * SPEED_FACTOR * cosLat. Calibrated so a
 *  1 m/s real current advances ~0.005 normalized units/frame at the
 *  equator → particle crosses a 360° span in ~2 minutes at 15fps.
 *  This is 20× the WindParticleLayer factor (0.00025) which was tuned
 *  for 15 m/s wind. */
const SPEED_FACTOR = 0.0018;

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
    // Size scaled by alpha so head points (bright, alpha≈1) are big and
    // tail points (dim, alpha→0) shrink to 1px. Produces a clear
    // head-to-tail streak that reads as a direction arrow even in a
    // still screenshot — not a uniform blur.
    float baseSize = mix(4.0, 8.0, clamp((u_zoom - 3.0) / 7.0, 0.0, 1.0));
    gl_PointSize = baseSize * mix(0.35, 1.25, a_particle_alpha);
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

    // White particle on top of the heatmap reads cleanest — let the
    // heatmap underlay carry the colour-magnitude story; particles
    // carry the direction story. Match the alpha to speed so fast
    // particles are bright streamlines and slack ones fade out.
    vec3 color = vec3(0.97, 0.99, 1.00);
    float alpha = v_alpha * mix(0.5, 1.0, t);
    gl_FragColor = vec4(color, alpha);
}`;

// Heatmap shaders — render a coloured speed-magnitude raster underneath
// the particles. This is what makes the EAC visible as a coherent ribbon
// of orange/red rather than a few sparse white particles.
const HEATMAP_VERT = `
precision highp float;
attribute vec2 a_quad_pos;       // a unit quad: (0,0) to (1,1)
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds;      // [south, north, west, east]
uniform float u_lon_offset;
varying vec2 v_uv;

const float PI = 3.14159265359;

vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    float lon = u_grid_bounds.z + a_quad_pos.x * (u_grid_bounds.w - u_grid_bounds.z) + u_lon_offset;
    float lat = u_grid_bounds.x + a_quad_pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    vec2 merc = toMercator(lon, lat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
    // UV: x = nx, y = 1 - ny (texture is row-major north→south, but our
    // quad is bottom-up because nyBase=0 maps to south)
    v_uv = vec2(a_quad_pos.x, 1.0 - a_quad_pos.y);
}`;

const HEATMAP_FRAG = `
precision highp float;
uniform sampler2D u_speed_tex;   // R = speed encoded as u8 over [0, SPEED_STRONG*1.5], G = land flag
uniform float u_speed_strong;    // unused — kept for parity with particle shader
uniform float u_opacity;
varying vec2 v_uv;

void main() {
    vec4 sample = texture2D(u_speed_tex, v_uv);
    // Tight land-discard threshold. With LINEAR filtering, coastal texels
    // bleed into neighbours — G gets averaged down to ~0.5 at boundaries
    // and even lower a few texels inland. Discard anything ≥0.2 to trim
    // that halo aggressively; risk of clipping some ocean at the coast
    // edge is worth the gain of never seeing heatmap over mid-continent.
    if (sample.g > 0.2) discard;
    float vRaw = sample.r;           // [0,1], represents real speed * (1 / (SPEED_STRONG * 1.5))
    if (vRaw < 0.01) discard;        // ~0.02 m/s — don't paint pure-slack ocean

    // Decode: speed-as-fraction-of-STRONG is vRaw * 1.5 (since the encode
    // range was SPEED_STRONG * 1.5). t > 1 = "rip" zones above STRONG.
    float t = clamp(vRaw * 1.5, 0.0, 1.0);
    vec3 c0 = vec3(0.10, 0.30, 0.55);   // deep blue (slack)
    vec3 c1 = vec3(0.20, 0.65, 0.85);   // cyan
    vec3 c2 = vec3(0.55, 0.80, 0.55);   // sea green
    vec3 c3 = vec3(0.95, 0.80, 0.40);   // amber
    vec3 c4 = vec3(0.95, 0.45, 0.30);   // coral
    vec3 c5 = vec3(0.85, 0.25, 0.30);   // deep coral (rip)

    vec3 color;
    if (t < 0.2)       color = mix(c0, c1, t / 0.2);
    else if (t < 0.4)  color = mix(c1, c2, (t - 0.2) / 0.2);
    else if (t < 0.6)  color = mix(c2, c3, (t - 0.4) / 0.2);
    else if (t < 0.8)  color = mix(c3, c4, (t - 0.6) / 0.2);
    else               color = mix(c4, c5, (t - 0.8) / 0.2);

    // Speed-graded alpha — slow flows are hinted, fast ones are bold.
    // Adds enough contrast that the EAC ribbon pops out without smothering
    // the satellite base in the open ocean.
    float alpha = u_opacity * mix(0.35, 0.85, t);
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

    // Trail-line rendering — replaces per-trail-point gl.POINTS so streaks
    // stay continuous at any zoom level. Uses gl.LINES primitive: each
    // pair of indices in this buffer connects two adjacent trail points.
    // Built once in onAdd (static — the indices never change; what
    // changes is the trail-point positions in the particle buffer).
    // 80k particles × 27 segments × 2 indices = 4.32M Uint32 indices
    // = 16.5 MB of GPU memory, uploaded once.
    private lineIndexBuffer: WebGLBuffer | null = null;
    private lineIndexCount = 0;
    private lineIndexType: number = 0; // UNSIGNED_INT or UNSIGNED_SHORT (fallback)

    // Heatmap underlay (the colour-coded speed magnitude raster)
    private heatmapProgram: WebGLProgram | null = null;
    private heatmapQuadBuffer: WebGLBuffer | null = null;
    private heatmapIndexBuffer: WebGLBuffer | null = null;
    private heatmapIndexCount = 0;
    private speedTexture: WebGLTexture | null = null;
    private hAQuadPosLoc = -1;
    private hUMatrixLoc: WebGLUniformLocation | null = null;
    private hUGridBoundsLoc: WebGLUniformLocation | null = null;
    private hULonOffsetLoc: WebGLUniformLocation | null = null;
    private hUSpeedTexLoc: WebGLUniformLocation | null = null;
    private hUSpeedStrongLoc: WebGLUniformLocation | null = null;
    private hUOpacityLoc: WebGLUniformLocation | null = null;

    // Attribute / uniform locations (particle program)
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
    // Advection runs on a separate timer from render() so camera
    // animations (which call render() at 60fps) don't 4× particle
    // motion speed and re-upload the 36 MB trail buffer 60 times/s.
    private _lastAdvectTime = 0;
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

        // ── Line index buffer for trail-segment rendering ──
        // Each particle has (TRAIL_LENGTH - 1) line segments. Each segment
        // needs 2 indices (start, end). Total: 80k × 27 × 2 = 4.32M idx.
        // Uint32 needed to address >65k vertices (TOTAL_POINTS = 2.24M).
        // WebGL2 supports gl.UNSIGNED_INT natively; WebGL1 needs the
        // OES_element_index_uint extension.
        const uint32Ext = 'drawElementsInstanced' in gl || gl.getExtension('OES_element_index_uint');
        if (uint32Ext) {
            this.lineIndexType = gl.UNSIGNED_INT;
            const segmentsPerParticle = TRAIL_LENGTH - 1;
            const indexCount = NUM_PARTICLES * segmentsPerParticle * 2;
            const idx = new Uint32Array(indexCount);
            let k = 0;
            for (let p = 0; p < NUM_PARTICLES; p++) {
                const base = p * TRAIL_LENGTH;
                for (let t = 0; t < segmentsPerParticle; t++) {
                    idx[k++] = base + t;
                    idx[k++] = base + t + 1;
                }
            }
            this.lineIndexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
            this.lineIndexCount = indexCount;
            log.info(
                `line index buffer: ${indexCount.toLocaleString()} indices (${(idx.byteLength / 1024 / 1024).toFixed(1)} MB)`,
            );
        } else {
            // Very old GPU — fall back to point rendering without lines.
            log.warn('OES_element_index_uint unavailable — falling back to POINTS rendering');
            this.lineIndexCount = 0;
        }

        // ── Heatmap underlay ─────────────────────────────────────────
        const hvs = compileShader(gl, gl.VERTEX_SHADER, HEATMAP_VERT, 'heatmap vert');
        const hfs = compileShader(gl, gl.FRAGMENT_SHADER, HEATMAP_FRAG, 'heatmap frag');
        this.heatmapProgram = linkProgram(gl, hvs, hfs);
        this.hAQuadPosLoc = gl.getAttribLocation(this.heatmapProgram, 'a_quad_pos');
        this.hUMatrixLoc = gl.getUniformLocation(this.heatmapProgram, 'u_matrix');
        this.hUGridBoundsLoc = gl.getUniformLocation(this.heatmapProgram, 'u_grid_bounds');
        this.hULonOffsetLoc = gl.getUniformLocation(this.heatmapProgram, 'u_lon_offset');
        this.hUSpeedTexLoc = gl.getUniformLocation(this.heatmapProgram, 'u_speed_tex');
        this.hUSpeedStrongLoc = gl.getUniformLocation(this.heatmapProgram, 'u_speed_strong');
        this.hUOpacityLoc = gl.getUniformLocation(this.heatmapProgram, 'u_opacity');

        // Subdivided quad covering [0,1]×[0,1] in grid space — a 32×32
        // mesh (33² = 1089 verts, 2048 tris). Subdivision is critical:
        // the GPU interpolates v_uv linearly in SCREEN space, but the
        // quad's geographic coords map to screen via Mercator (non-
        // linear in latitude). A 4-vertex world-spanning quad produced
        // catastrophic UV errors in the middle — sampling far-away
        // texels and bleeding heatmap colours deep over land. With 32
        // subdivisions each sub-triangle covers ~11° × ~5° at most,
        // where linear interpolation error is sub-texel.
        const SUBDIV = 32;
        const vCount = (SUBDIV + 1) * (SUBDIV + 1);
        const positions = new Float32Array(vCount * 2);
        {
            let p = 0;
            for (let y = 0; y <= SUBDIV; y++) {
                for (let x = 0; x <= SUBDIV; x++) {
                    positions[p++] = x / SUBDIV;
                    positions[p++] = y / SUBDIV;
                }
            }
        }
        const indexCount = SUBDIV * SUBDIV * 6;
        const indices = new Uint16Array(indexCount);
        {
            let ix = 0;
            for (let y = 0; y < SUBDIV; y++) {
                for (let x = 0; x < SUBDIV; x++) {
                    const v0 = y * (SUBDIV + 1) + x;
                    const v1 = v0 + 1;
                    const v2 = v0 + (SUBDIV + 1);
                    const v3 = v2 + 1;
                    // Two triangles per quad cell.
                    indices[ix++] = v0;
                    indices[ix++] = v1;
                    indices[ix++] = v2;
                    indices[ix++] = v1;
                    indices[ix++] = v3;
                    indices[ix++] = v2;
                }
            }
        }

        this.heatmapQuadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmapQuadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        this.heatmapIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.heatmapIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        this.heatmapIndexCount = indexCount;

        this.speedTexture = gl.createTexture();

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
        if (this.heatmapProgram) gl.deleteProgram(this.heatmapProgram);
        if (this.particleBuffer) gl.deleteBuffer(this.particleBuffer);
        if (this.heatmapQuadBuffer) gl.deleteBuffer(this.heatmapQuadBuffer);
        if (this.heatmapIndexBuffer) gl.deleteBuffer(this.heatmapIndexBuffer);
        if (this.lineIndexBuffer) gl.deleteBuffer(this.lineIndexBuffer);
        if (this.speedTexture) gl.deleteTexture(this.speedTexture);
        const gl2 = gl as WebGL2RenderingContext;
        if (this.particleVAO && gl2.deleteVertexArray) gl2.deleteVertexArray(this.particleVAO);
        this.heatmapProgram = null;
        this.heatmapQuadBuffer = null;
        this.heatmapIndexBuffer = null;
        this.lineIndexBuffer = null;
        this.speedTexture = null;
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
        this.uploadSpeedTexture();
        this.respawnAllParticles();
        this.map?.triggerRepaint();
    }

    /** Pack speed (R) + land flag (G) into a 2-channel RGBA8 texture for
     *  the heatmap shader. R = speed/SPEED_STRONG clamped to [0,1] then
     *  encoded as u8; G = 255 if land else 0. */
    private uploadSpeedTexture(): void {
        const gl = this.gl;
        const tex = this.speedTexture;
        const speed = this.gridSpeed;
        const mask = this.landMask;
        if (!gl || !tex || !speed || !mask) return;

        const w = this.gridW;
        const h = this.gridH;
        const size = w * h;
        const rgba = new Uint8Array(size * 4);
        // Encode speed as u8 across [0, SPEED_STRONG_M_S * 1.5] to give
        // some headroom for the few cells that exceed STRONG. Decoded in
        // the shader as: real_speed = R/255 * (SPEED_STRONG * 1.5).
        const ENCODE_RANGE = SPEED_STRONG_M_S * 1.5;
        const inv = 255.0 / ENCODE_RANGE;
        for (let i = 0; i < size; i++) {
            const off = i * 4;
            const s = Math.min(255, Math.round(speed[i] * inv));
            rgba[off] = s;
            rgba[off + 1] = mask[i] === 1 ? 255 : 0;
            rgba[off + 2] = 0;
            rgba[off + 3] = 255;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // LINEAR filtering smooths out the cell-grid step pattern at zoom.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.bindTexture(gl.TEXTURE_2D, null);
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
            data[base + 3] = 1.0; // head alpha — full brightness for "comet head"
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
                data[base + 3] = 1.0; // head alpha — full brightness for "comet head"
                ages[i] = 0;
                continue;
            }

            // Wrote new head position.
            data[base] = x;
            data[base + 1] = y;
            data[base + 2] = speedMS;

            // Trail alpha fade — slight quadratic bias so the head is
            // brighter than the tail, but not so aggressive that the
            // tail vanishes completely. Floor at 0.12 guarantees tail
            // pixels remain visible as thin streaks.
            for (let t = 0; t < TRAIL_LENGTH; t++) {
                const offset = base + t * FLOATS_PER_TRAIL_PT;
                const linFade = 1 - t / TRAIL_LENGTH;
                data[offset + 3] = 0.12 + 0.88 * linFade * linFade;
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
        const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);

        // Decouple advection from render cadence. During camera animation
        // Mapbox calls render() at 60fps, but we want particles to advect
        // at ~15fps regardless so motion speed stays constant and we
        // don't re-upload the 36 MB trail buffer 60×/s. Track whether
        // we advected this frame so the buffer upload below can be
        // skipped when data hasn't changed.
        let didAdvect = false;
        const ADVECT_INTERVAL_MS = 66;
        if (now - this._lastAdvectTime >= ADVECT_INTERVAL_MS) {
            this.advectParticles();
            this._lastAdvectTime = now;
            didAdvect = true;
        }

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);

        // ── Heatmap pass — colour magnitude underlay ─────────────────
        // Draws a quad covering the data bounds, sampling the speed texture
        // through a perceptual ramp so the EAC / ACC / Gulf Stream show as
        // coherent ribbons of colour even before particles tell direction.
        if (this.heatmapProgram && this.heatmapQuadBuffer && this.speedTexture) {
            gl.useProgram(this.heatmapProgram);
            if (this.hUMatrixLoc) gl.uniformMatrix4fv(this.hUMatrixLoc, false, mat);
            if (this.hUGridBoundsLoc) {
                gl.uniform4f(
                    this.hUGridBoundsLoc,
                    this.gridBounds.south,
                    this.gridBounds.north,
                    this.gridBounds.west,
                    this.gridBounds.east,
                );
            }
            if (this.hUSpeedStrongLoc) gl.uniform1f(this.hUSpeedStrongLoc, SPEED_STRONG_M_S);
            if (this.hUOpacityLoc) gl.uniform1f(this.hUOpacityLoc, 0.72);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.speedTexture);
            if (this.hUSpeedTexLoc) gl.uniform1i(this.hUSpeedTexLoc, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.heatmapQuadBuffer);
            if (this.hAQuadPosLoc >= 0) {
                gl.enableVertexAttribArray(this.hAQuadPosLoc);
                gl.vertexAttribPointer(this.hAQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
            }

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.heatmapIndexBuffer);
            const heatmapOffsets = this.globalMode ? [-360, 0, 360] : [0];
            for (const offset of heatmapOffsets) {
                if (this.hULonOffsetLoc) gl.uniform1f(this.hULonOffsetLoc, offset);
                gl.drawElements(gl.TRIANGLES, this.heatmapIndexCount, gl.UNSIGNED_SHORT, 0);
            }

            if (this.hAQuadPosLoc >= 0) gl.disableVertexAttribArray(this.hAQuadPosLoc);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

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

        // Re-upload particle buffer ONLY on frames where advection ran.
        // Saves ~35 MB/frame of CPU→GPU bandwidth on camera-animation
        // frames where positions haven't changed since the last advect.
        gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
        if (didAdvect) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.trailData);
        }

        // Draw 3 world copies in global mode for seamless antimeridian.
        // LINES draws continuous streaks between adjacent trail points —
        // every zoom shows unbroken lines instead of per-point dots. Fall
        // back to POINTS if the index buffer couldn't be built.
        const worldOffsets = this.globalMode ? [-360, 0, 360] : [0];
        const useLines = this.lineIndexBuffer !== null && this.lineIndexCount > 0;
        if (useLines) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuffer);
            // Most WebGL impls cap gl.lineWidth at 1; we call it anyway
            // for browsers that honour 2-3 px (e.g. Safari/iOS).
            gl.lineWidth(2.0);
        }
        for (const offset of worldOffsets) {
            if (this.uLonOffsetLoc) gl.uniform1f(this.uLonOffsetLoc, offset);
            if (useLines) {
                gl.drawElements(gl.LINES, this.lineIndexCount, this.lineIndexType, 0);
            } else {
                gl.drawArrays(gl.POINTS, 0, TOTAL_POINTS);
            }
        }

        if (gl2.bindVertexArray) gl2.bindVertexArray(prevVAO);

        gl.useProgram(prevProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
        if (prevBlend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        gl.activeTexture(prevActiveTex);

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
