/**
 * WindGLEngine — GPU-accelerated wind particle animation engine.
 *
 * Implements mapboxgl.CustomLayerInterface to render directly into
 * the map's WebGL context. Receives the camera MVP matrix every frame
 * via render(gl, matrix) so particles are pinned to geographic positions.
 *
 * Projection pipeline per particle:
 * Grid [0,1] → Lat/Lon (via grid bounds) → Web Mercator [0,1] → Clip space (via u_matrix)
 *
 * Trail system uses FBO ping-pong within the shared GL context.
 * Trails are in screen space; they fade naturally during map movement.
 */

import type mapboxgl from 'mapbox-gl';
import { WindGrid, MAX_SPEED, encodeWindTexture } from '../../services/weather/windField';

// ── Constants ─────────────────────────────────────────────────────
const PARTICLE_RES = 80;                    // 80×80 = 6400 particles
const NUM_PARTICLES = PARTICLE_RES * PARTICLE_RES;

// ── GLSL Shaders ──────────────────────────────────────────────────

/** Full-screen quad vertex shader (for update / fade / composite passes) */
const QUAD_VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Composite: copy trail texture to screen with opacity */
const SCREEN_FRAG = `
precision highp float;
uniform sampler2D u_screen;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
    vec4 c = texture2D(u_screen, v_uv);
    gl_FragColor = vec4(c.rgb, c.a * u_opacity);
}`;

/** Fade: decay trail alpha for persistence effect */
const FADE_FRAG = `
precision highp float;
uniform sampler2D u_screen;
uniform float u_fade;
varying vec2 v_uv;
void main() {
    vec4 c = texture2D(u_screen, v_uv);
    gl_FragColor = vec4(c.rgb, floor(c.a * u_fade * 255.0) / 255.0);
}`;

/** Update: advect particles by sampling wind U/V texture, with bearing rotation */
const UPDATE_FRAG = `
precision highp float;
uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform float u_rand_seed;
uniform float u_speed_factor;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform float u_bearing;     // Map bearing in radians
varying vec2 v_uv;

const vec3 K = vec3(12.9898, 78.233, 4375.85453);
float rand(vec2 co) {
    return fract(sin(dot(K.xy, co)) * (K.z + dot(K.xy, co)));
}

void main() {
    vec4 ps = texture2D(u_particles, v_uv);
    vec2 pos = ps.rg;  // [0,1] normalized grid position

    // Sample wind at particle position
    vec4 w = texture2D(u_wind, pos);
    float rawU = w.r * ${(2 * MAX_SPEED).toFixed(1)} - ${MAX_SPEED.toFixed(1)};
    float rawV = w.g * ${(2 * MAX_SPEED).toFixed(1)} - ${MAX_SPEED.toFixed(1)};

    // Rotate wind vector by map bearing
    float cosB = cos(u_bearing);
    float sinB = sin(u_bearing);
    float u = rawU * cosB - rawV * sinB;
    float v = rawU * sinB + rawV * cosB;

    float spd = length(vec2(u, v));

    // Move particle (speed_factor scales visual speed)
    vec2 newPos = pos + vec2(u, v) * u_speed_factor;

    // Random drop
    vec2 seed = (pos + v_uv) * u_rand_seed;
    float drop = step(1.0 - (u_drop_rate + spd * u_drop_rate_bump), rand(seed));

    // OOB respawn: recycle particles that drift outside the [0,1] grid
    float oob = step(1.0, max(newPos.x, newPos.y)) + (1.0 - step(0.0, min(newPos.x, newPos.y)));
    drop = max(drop, sign(oob));

    // THE NAN VIRUS CURE: If math exploded, force a respawn immediately.
    if (newPos.x != newPos.x || newPos.y != newPos.y || spd != spd) {
        drop = 1.0;
    }

    // Reset to random position if dropped (always inside [0,1])
    vec2 randPos = vec2(rand(seed + 1.3), rand(seed + 2.1));
    gl_FragColor = vec4(mix(newPos, randPos, drop), 0.0, 1.0);
}`;

/**
 * Draw vertex shader — THE CORE FIX.
 *
 * Converts particle grid position [0,1] → geographic lat/lon → Web Mercator → clip space
 * using the map's camera MVP matrix. This pins particles to the Earth.
 */
const DRAW_VERT = `
precision highp float;

attribute float a_index;

uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform float u_particles_res;
uniform mat4 u_matrix;          // Mapbox camera MVP matrix
uniform vec4 u_grid_bounds;     // (south, north, west, east)
uniform float u_zoom;

varying float v_speed;

#define PI 3.14159265359

// Convert Lon/Lat to Web Mercator [0, 1] — Mapbox normalized space
vec2 toMercator(float lon, float lat) {
    float x = (lon + 180.0) / 360.0;
    float y = 0.5 - log(tan(PI / 4.0 + lat * PI / 360.0)) / (2.0 * PI);
    return vec2(x, y);
}

void main() {
    // 1. Look up particle position from state texture
    float col = mod(a_index, u_particles_res);
    float row = floor(a_index / u_particles_res);
    vec2 tc = vec2((col + 0.5) / u_particles_res, (row + 0.5) / u_particles_res);

    vec4 ps = texture2D(u_particles, tc);
    vec2 pos = ps.rg;  // [0,1] in grid space

    // OOB & NaN kill: If position is outside [0,1] or is NaN, discard it.
    // The flipped logic !(pos >= 0 && pos <= 1) implicitly catches NaN values
    // because any comparison with NaN resolves to false.
    if (!(pos.x >= 0.0 && pos.x <= 1.0 && pos.y >= 0.0 && pos.y <= 1.0)) {
        v_speed = -1.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // Move off-screen
        gl_PointSize = 0.0;
        return;
    }

    // Get wind speed for coloring
    vec4 w = texture2D(u_wind, pos);
    v_speed = w.b;

    // 2. Convert grid [0,1] → geographic lat/lon
    float lat = u_grid_bounds.x + pos.y * (u_grid_bounds.y - u_grid_bounds.x);
    float lon = u_grid_bounds.z + pos.x * (u_grid_bounds.w - u_grid_bounds.z);

    // 3. Convert lat/lon → Web Mercator [0,1]
    vec2 merc = toMercator(lon, lat);

    // 4. Multiply by camera MVP matrix → clip space (pinned to Earth!)
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);

    // 5. Zoom-adaptive point size (larger for debug visibility)
    gl_PointSize = mix(2.0, 6.0, clamp((u_zoom - 3.0) / 8.0, 0.0, 1.0));
}`;

/** Draw fragment shader: color by wind speed */
const DRAW_FRAG = `
precision highp float;
varying float v_speed;

vec3 col(float t) {
    vec3 a = vec3(0.15, 0.40, 0.70);
    vec3 b = vec3(0.85, 0.55, 0.30);
    vec3 c = vec3(1.0, 1.0, 1.0);
    vec3 d = vec3(0.00, 0.33, 0.67);
    return a + b * cos(6.28318 * (c * t + d));
}

void main() {
    // Discard off-screen/OOB particles OR particles infected by the NaN virus
    if (v_speed < 0.0 || v_speed != v_speed) {
        discard;
    }

    float t = clamp(v_speed * 4.0, 0.0, 1.0);
    vec3 rgb = col(t);
    gl_FragColor = vec4(rgb, 0.85);
}`;

// ── Engine Class (Mapbox Custom Layer) ────────────────────────────

export class WindGLEngine implements mapboxgl.CustomLayerInterface {
    // CustomLayerInterface required fields
    readonly id: string;
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    // Internal state
    private map!: mapboxgl.Map;
    private gl!: WebGLRenderingContext;
    private grid: WindGrid | null = null;
    private gridBounds = { south: 0, north: 0, west: 0, east: 0 };
    private hasFloat = false;
    private pendingGrid: { grid: WindGrid; hour: number } | null = null;

    // GL resources
    private updateProg!: WebGLProgram;
    private drawProg!: WebGLProgram;
    private screenProg!: WebGLProgram;
    private fadeProg!: WebGLProgram;

    private quadPosLocs = new Map<WebGLProgram, number>();
    private drawIdxLoc = 0;

    private quadBuf!: WebGLBuffer;
    private idxBuf!: WebGLBuffer;
    private fbo!: WebGLFramebuffer;

    private windTex!: WebGLTexture;
    private pState0!: WebGLTexture;
    private pState1!: WebGLTexture;
    private trail0!: WebGLTexture;
    private trail1!: WebGLTexture;

    private trailW = 0;
    private trailH = 0;

    // Tuning
    private fadeOpacity = 0.985;
    private speedFactor = 0.0002;
    private dropRate = 0.0015;
    private dropRateBump = 0.005;

    constructor(layerId = 'wind-particles') {
        this.id = layerId;
    }

    // ── CustomLayerInterface callbacks ────────────────────────

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext) {
        this.map = map;
        this.gl = gl;

        // Check for float texture support
        const floatExt = gl.getExtension('OES_texture_float');
        this.hasFloat = !!floatExt;
        if (!this.hasFloat) {
            console.warn('[WindGL] OES_texture_float not available — low-precision particles');
        }

        this.initGL();

        // If grid was set before onAdd, upload it now
        if (this.pendingGrid) {
            this.grid = this.pendingGrid.grid;
            this.gridBounds = {
                south: this.pendingGrid.grid.south,
                north: this.pendingGrid.grid.north,
                west: this.pendingGrid.grid.west,
                east: this.pendingGrid.grid.east,
            };
            this.uploadWind(this.pendingGrid.hour);
            this.pendingGrid = null;
        }

        console.log(`[WindGL] Custom layer added. ${NUM_PARTICLES} particles, float=${this.hasFloat}`);
    }

    render(gl: WebGLRenderingContext, matrix: number[]) {
        if (!this.grid) return;

        // Resize trail textures if canvas size changed
        const canvas = gl.canvas as HTMLCanvasElement;
        if (canvas.width !== this.trailW || canvas.height !== this.trailH) {
            this.recreateTrails();
        }

        // ── Zoom-adaptive rendering parameters ──
        // At global zoom (≤4), trails must decay much faster to prevent
        // color wash from 6400+ overlapping particles in small screen areas.
        const zoom = this.map.getZoom();
        const globalT = Math.max(0, Math.min(1, (5 - zoom) / 3)); // 1.0 at zoom ≤ 2, 0.0 at zoom ≥ 5

        // Trail fade:  0.985 (zoomed in, long trails) → 0.80 (global, nearly instant decay)
        const adaptiveFade = this.fadeOpacity * (1 - globalT) + 0.80 * globalT;
        // Composite opacity: 1.0 (zoomed) → 0.4 (global, semi-transparent overlay)
        const adaptiveOpacity = 1.0 * (1 - globalT) + 0.4 * globalT;
        // Speed factor: 0.0002 (zoomed) → 0.00006 (global, slower drift)
        const adaptiveSpeed = this.speedFactor * (1 - globalT) + 0.00006 * globalT;

        try {
            // Save Mapbox GL state we'll modify
            const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            const prevActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
            const prevBlend = gl.isEnabled(gl.BLEND);
            const prevBlendSrc = gl.getParameter(gl.BLEND_SRC_RGB);
            const prevBlendDst = gl.getParameter(gl.BLEND_DST_RGB);
            const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
            const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.disable(gl.DEPTH_TEST);  // Mapbox leaves depth on — kills 2D particles
            gl.depthMask(false);

            // 1. Update particle positions (pass map bearing for wind rotation)
            const bearingRad = this.map.getBearing() * Math.PI / 180;
            this.stepUpdate(bearingRad, adaptiveSpeed);

            // 2. Fade trail + draw new particles (using MVP matrix)
            this.stepTrail(matrix, adaptiveFade);

            // 3. Composite trail to map's framebuffer
            this.stepComposite(prevFbo, adaptiveOpacity);

            // Restore Mapbox GL state
            gl.useProgram(prevProgram);
            gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
            gl.activeTexture(prevActiveTexture);
            if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
            gl.blendFunc(prevBlendSrc, prevBlendDst);
            if (prevDepthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            gl.depthMask(prevDepthMask);
        } catch (e) {
            console.error('[WindGL] Render error:', e);
        }

        // Keep animating
        this.map.triggerRepaint();
    }

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext) {
        [this.updateProg, this.drawProg, this.screenProg, this.fadeProg].forEach(p => gl.deleteProgram(p));
        [this.windTex, this.pState0, this.pState1, this.trail0, this.trail1].forEach(t => gl.deleteTexture(t));
        [this.quadBuf, this.idxBuf].forEach(b => gl.deleteBuffer(b));
        gl.deleteFramebuffer(this.fbo);
        console.log('[WindGL] Custom layer removed');
    }

    // ── Public API ────────────────────────────────────────────

    setGrid(grid: WindGrid, hour = 0) {
        if (!this.gl) {
            // GL not ready yet (onAdd hasn't been called), defer
            this.pendingGrid = { grid, hour };
            return;
        }
        this.grid = grid;
        this.gridBounds = {
            south: grid.south,
            north: grid.north,
            west: grid.west,
            east: grid.east,
        };
        this.uploadWind(hour);
    }

    setHour(hour: number) {
        if (!this.grid || !this.gl) return;
        this.uploadWind(hour);
        this.clearTrails();
    }

    // ── GL Initialization ─────────────────────────────────────

    private initGL() {
        const gl = this.gl;

        this.updateProg = this.compile(QUAD_VERT, UPDATE_FRAG);
        this.drawProg = this.compile(DRAW_VERT, DRAW_FRAG);
        this.screenProg = this.compile(QUAD_VERT, SCREEN_FRAG);
        this.fadeProg = this.compile(QUAD_VERT, FADE_FRAG);

        for (const p of [this.updateProg, this.screenProg, this.fadeProg]) {
            this.quadPosLocs.set(p, gl.getAttribLocation(p, 'a_pos'));
        }
        this.drawIdxLoc = gl.getAttribLocation(this.drawProg, 'a_index');

        // Quad buffer (full-screen triangle strip)
        this.quadBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        // Particle index buffer
        const idx = new Float32Array(NUM_PARTICLES);
        for (let i = 0; i < NUM_PARTICLES; i++) idx[i] = i;
        this.idxBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.idxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, idx, gl.STATIC_DRAW);

        this.fbo = gl.createFramebuffer()!;
        this.windTex = this.makeTex(gl.LINEAR, gl.UNSIGNED_BYTE, new Uint8Array(16), 2, 2);

        // Float particle state textures
        const initData = new Float32Array(NUM_PARTICLES * 4);
        for (let i = 0; i < NUM_PARTICLES; i++) {
            initData[i * 4] = Math.random();     // x [0,1]
            initData[i * 4 + 1] = Math.random(); // y [0,1]
            initData[i * 4 + 2] = 0;
            initData[i * 4 + 3] = 1;
        }

        if (this.hasFloat) {
            this.pState0 = this.makeTex(gl.NEAREST, gl.FLOAT, initData, PARTICLE_RES, PARTICLE_RES);
            this.pState1 = this.makeTex(gl.NEAREST, gl.FLOAT, initData, PARTICLE_RES, PARTICLE_RES);
        } else {
            const fallback = new Uint8Array(NUM_PARTICLES * 4);
            for (let i = 0; i < NUM_PARTICLES; i++) {
                fallback[i * 4] = Math.floor(Math.random() * 256);
                fallback[i * 4 + 1] = Math.floor(Math.random() * 256);
                fallback[i * 4 + 2] = 0;
                fallback[i * 4 + 3] = 255;
            }
            this.pState0 = this.makeTex(gl.NEAREST, gl.UNSIGNED_BYTE, fallback, PARTICLE_RES, PARTICLE_RES);
            this.pState1 = this.makeTex(gl.NEAREST, gl.UNSIGNED_BYTE, fallback, PARTICLE_RES, PARTICLE_RES);
            this.speedFactor = 0.002;
        }

        // Trail textures (sized to canvas)
        const canvas = this.gl.canvas as HTMLCanvasElement;
        this.trailW = canvas.width;
        this.trailH = canvas.height;
        const empty = new Uint8Array(this.trailW * this.trailH * 4);
        this.trail0 = this.makeTex(gl.LINEAR, gl.UNSIGNED_BYTE, empty, this.trailW, this.trailH);
        this.trail1 = this.makeTex(gl.LINEAR, gl.UNSIGNED_BYTE, empty, this.trailW, this.trailH);
    }

    // ── Render Pipeline ───────────────────────────────────────

    /** Step 1: Advect particle positions using wind field, with bearing rotation */
    private stepUpdate(bearingRad: number, adaptiveSpeed?: number) {
        const gl = this.gl;
        const p = this.updateProg;
        gl.useProgram(p);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pState0);
        gl.uniform1i(gl.getUniformLocation(p, 'u_particles'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.windTex);
        gl.uniform1i(gl.getUniformLocation(p, 'u_wind'), 1);

        gl.uniform1f(gl.getUniformLocation(p, 'u_rand_seed'), Math.random());
        gl.uniform1f(gl.getUniformLocation(p, 'u_speed_factor'), adaptiveSpeed ?? this.speedFactor);
        gl.uniform1f(gl.getUniformLocation(p, 'u_drop_rate'), this.dropRate);
        gl.uniform1f(gl.getUniformLocation(p, 'u_drop_rate_bump'), this.dropRateBump);
        gl.uniform1f(gl.getUniformLocation(p, 'u_bearing'), bearingRad);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pState1, 0);
        gl.viewport(0, 0, PARTICLE_RES, PARTICLE_RES);
        this.drawQuad(p);

        [this.pState0, this.pState1] = [this.pState1, this.pState0];
    }

    /** Step 2: Fade previous trail + draw new particles using MVP matrix */
    private stepTrail(matrix: number[], adaptiveFade?: number) {
        const gl = this.gl;
        const w = this.trailW;
        const h = this.trailH;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trail1, 0);
        gl.viewport(0, 0, w, h);

        // Fade previous trail (zoom-adaptive: fast decay at global zoom)
        gl.useProgram(this.fadeProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.trail0);
        gl.uniform1i(gl.getUniformLocation(this.fadeProg, 'u_screen'), 0);
        gl.uniform1f(gl.getUniformLocation(this.fadeProg, 'u_fade'), adaptiveFade ?? this.fadeOpacity);
        this.drawQuad(this.fadeProg);

        // Draw new particles with geographic projection
        const dp = this.drawProg;
        gl.useProgram(dp);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.pState0);
        gl.uniform1i(gl.getUniformLocation(dp, 'u_particles'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.windTex);
        gl.uniform1i(gl.getUniformLocation(dp, 'u_wind'), 1);
        gl.uniform1f(gl.getUniformLocation(dp, 'u_particles_res'), PARTICLE_RES);

        // Pass camera MVP matrix and grid bounds
        gl.uniformMatrix4fv(gl.getUniformLocation(dp, 'u_matrix'), false, matrix);
        const gb = this.gridBounds;
        gl.uniform4f(gl.getUniformLocation(dp, 'u_grid_bounds'), gb.south, gb.north, gb.west, gb.east);
        gl.uniform1f(gl.getUniformLocation(dp, 'u_zoom'), this.map.getZoom());

        gl.bindBuffer(gl.ARRAY_BUFFER, this.idxBuf);
        gl.enableVertexAttribArray(this.drawIdxLoc);
        gl.vertexAttribPointer(this.drawIdxLoc, 1, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, NUM_PARTICLES);
        gl.disableVertexAttribArray(this.drawIdxLoc);

        [this.trail0, this.trail1] = [this.trail1, this.trail0];
    }

    /** Step 3: Composite trail texture to the map's framebuffer */
    private stepComposite(targetFbo: WebGLFramebuffer | null, adaptiveOpacity?: number) {
        const gl = this.gl;
        const canvas = gl.canvas as HTMLCanvasElement;

        // Render to whatever FBO Mapbox was using (NOT always null!)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
        gl.viewport(0, 0, canvas.width, canvas.height);
        // Don't clear — we're compositing on top of the map

        gl.useProgram(this.screenProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.trail0);
        gl.uniform1i(gl.getUniformLocation(this.screenProg, 'u_screen'), 0);
        gl.uniform1f(gl.getUniformLocation(this.screenProg, 'u_opacity'), adaptiveOpacity ?? 1.0);
        this.drawQuad(this.screenProg);
    }

    // ── GPU Helpers ───────────────────────────────────────────

    private uploadWind(hour: number) {
        if (!this.grid) return;
        const gl = this.gl;
        const data = encodeWindTexture(this.grid, hour);
        gl.bindTexture(gl.TEXTURE_2D, this.windTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.grid.width, this.grid.height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    private clearTrails() {
        const gl = this.gl;
        const e = new Uint8Array(this.trailW * this.trailH * 4);
        gl.bindTexture(gl.TEXTURE_2D, this.trail0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.trailW, this.trailH, 0, gl.RGBA, gl.UNSIGNED_BYTE, e);
        gl.bindTexture(gl.TEXTURE_2D, this.trail1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.trailW, this.trailH, 0, gl.RGBA, gl.UNSIGNED_BYTE, e);
    }

    private recreateTrails() {
        const gl = this.gl;
        const canvas = gl.canvas as HTMLCanvasElement;
        this.trailW = canvas.width;
        this.trailH = canvas.height;
        gl.deleteTexture(this.trail0);
        gl.deleteTexture(this.trail1);
        const e = new Uint8Array(this.trailW * this.trailH * 4);
        this.trail0 = this.makeTex(gl.LINEAR, gl.UNSIGNED_BYTE, e, this.trailW, this.trailH);
        this.trail1 = this.makeTex(gl.LINEAR, gl.UNSIGNED_BYTE, e, this.trailW, this.trailH);
    }

    private makeTex(filter: number, type: number, data: ArrayBufferView, w: number, h: number): WebGLTexture {
        const gl = this.gl;
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, type, data);
        return t;
    }

    private compile(vs: string, fs: string): WebGLProgram {
        const gl = this.gl;
        const v = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(v, vs);
        gl.compileShader(v);
        if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
            const e = gl.getShaderInfoLog(v);
            console.error('[WindGL] VS error:', e);
            throw new Error('VS: ' + e);
        }
        const f = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(f, fs);
        gl.compileShader(f);
        if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
            const e = gl.getShaderInfoLog(f);
            console.error('[WindGL] FS error:', e);
            throw new Error('FS: ' + e);
        }
        const p = gl.createProgram()!;
        gl.attachShader(p, v);
        gl.attachShader(p, f);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            const e = gl.getProgramInfoLog(p);
            console.error('[WindGL] Link error:', e);
            throw new Error('Link: ' + e);
        }
        return p;
    }

    private drawQuad(prog: WebGLProgram) {
        const gl = this.gl;
        const loc = this.quadPosLocs.get(prog)!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disableVertexAttribArray(loc);
    }
}