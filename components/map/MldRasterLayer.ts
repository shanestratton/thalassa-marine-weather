/**
 * MldRasterLayer — Mapbox custom WebGL layer that renders the CMEMS
 * mixed-layer depth field as a perceptually-uniform plasma heatmap.
 *
 * Streamlined fork of ChlRasterLayer / SeaIceRasterLayer: same 32×32
 * subdivided quad, same inverse-Mercator UV, same land-flag discard.
 * Differences:
 *   – Input is PRE-NORMALISED to [0,1] in the pipeline (log10(MLD)
 *     mapped over [1m, 1000m] → t ∈ [0,1]). ENCODE_RANGE = 1.0 →
 *     full u8 resolution across 3 orders of magnitude of MLD.
 *   – Plasma colour ramp: yellow (shallow stratified ~1-3m) → orange
 *     → red → magenta → deep purple → near-black blue (deep
 *     convective ~1000m+). Reads as "warm sunlit thin layer → cold
 *     deeply-mixed water" at a glance.
 *   – Discard threshold t<0.10 (~2m MLD) — anything shallower is
 *     either coastal noise or a numerical artefact.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MldRasterLayer');

// Pipeline pre-normalises log10(MLD) over [1m, 1000m] to [0, 1] →
// ENCODE_RANGE = 1.0 packs onto the full u8 0-255 range.
const ENCODE_RANGE_MLD = 1.0;

// ── Shaders ────────────────────────────────────────────────────────────

const HEATMAP_VERT = `
precision highp float;
attribute vec2 a_quad_pos;            // unit quad [0,1]² in grid space
uniform mat4 u_matrix;
uniform vec4 u_grid_bounds;           // [south, north, west, east]
uniform float u_lon_offset;           // for global-mode world copies
varying float v_lon;
varying float v_mercY;

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
    v_lon = lon - u_lon_offset;
    v_mercY = merc.y;
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
}`;

const HEATMAP_FRAG = `
precision highp float;
uniform sampler2D u_data_tex;   // R = pre-normalised log10(MLD) ∈ [0,1] as u8, G = land flag
uniform float u_opacity;
uniform vec4 u_grid_bounds;     // [south, north, west, east]
varying float v_lon;
varying float v_mercY;

const float PI = 3.14159265359;

float mercToLat(float mercY) {
    float y = (0.5 - mercY) * 2.0 * PI;
    return (2.0 * atan(exp(y)) - PI * 0.5) * 180.0 / PI;
}

void main() {
    float lat = mercToLat(v_mercY);
    float south = u_grid_bounds.x;
    float north = u_grid_bounds.y;
    float west = u_grid_bounds.z;
    float east = u_grid_bounds.w;

    float u = (v_lon - west) / (east - west);
    float v = 1.0 - (lat - south) / (north - south);
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) discard;

    vec4 sample = texture2D(u_data_tex, vec2(u, v));
    if (sample.g > 0.2) discard;

    // Discard ultra-shallow MLD — coastal noise or numerical underflow.
    // t<0.10 corresponds to log10(MLD) < 0.3 ≈ MLD < 2m, which doesn't
    // happen in real open ocean.
    float t = clamp(sample.r, 0.0, 1.0);
    if (t < 0.10) discard;

    // Plasma-style colour ramp. Hand-tuned to the matplotlib plasma
    // map's perceptually-uniform stops, with t=0 → yellow (sunlit
    // shallow stratified) and t=1 → near-black blue (deep convective).
    //   t≈0.10 (~2m)     pale yellow         — sunlit, summer pool
    //   t≈0.30 (~10m)    orange              — typical tropical MLD
    //   t≈0.50 (~30m)    red-orange          — temperate summer
    //   t≈0.65 (~75m)    magenta-red         — temperate winter / Med
    //   t≈0.80 (~200m)   purple              — sub-polar, edges of NA
    //   t≈1.00 (~1000m+) deep navy           — Labrador / Greenland
    //                                          / Weddell convection
    vec3 c0 = vec3(0.96, 0.92, 0.40);   // pale yellow
    vec3 c1 = vec3(0.98, 0.62, 0.20);   // orange
    vec3 c2 = vec3(0.92, 0.30, 0.30);   // red-orange
    vec3 c3 = vec3(0.78, 0.18, 0.50);   // magenta-red
    vec3 c4 = vec3(0.45, 0.10, 0.55);   // purple
    vec3 c5 = vec3(0.10, 0.05, 0.30);   // deep navy

    vec3 color;
    if      (t < 0.30) color = mix(c0, c1, (t - 0.10) / 0.20);
    else if (t < 0.50) color = mix(c1, c2, (t - 0.30) / 0.20);
    else if (t < 0.65) color = mix(c2, c3, (t - 0.50) / 0.15);
    else if (t < 0.80) color = mix(c3, c4, (t - 0.65) / 0.15);
    else               color = mix(c4, c5, (t - 0.80) / 0.20);

    // Higher MLD → more opaque. Shallow MLD pixels (alpha≈0.65) let
    // the surface chart show through more, deep convective sites
    // (alpha≈0.92) read as solid blue patches.
    float alpha = u_opacity * mix(0.65, 0.92, (t - 0.10) / 0.90);
    gl_FragColor = vec4(color, alpha);
}`;

// ── Helpers ────────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, label: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`[MldRasterLayer] failed to create ${label}`);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`[MldRasterLayer] ${label}: ${info}`);
    }
    return shader;
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error('[MldRasterLayer] failed to create program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`[MldRasterLayer] link: ${info}`);
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

// ── Main Layer ─────────────────────────────────────────────────────────

export class MldRasterLayer implements mapboxgl.CustomLayerInterface {
    readonly id: string;
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    private map: mapboxgl.Map | null = null;
    private gl: WebGLRenderingContext | null = null;

    private program: WebGLProgram | null = null;
    private quadBuffer: WebGLBuffer | null = null;
    private indexBuffer: WebGLBuffer | null = null;
    private indexCount = 0;
    private dataTexture: WebGLTexture | null = null;

    private aQuadPosLoc = -1;
    private uMatrixLoc: WebGLUniformLocation | null = null;
    private uGridBoundsLoc: WebGLUniformLocation | null = null;
    private uLonOffsetLoc: WebGLUniformLocation | null = null;
    private uDataTexLoc: WebGLUniformLocation | null = null;
    private uOpacityLoc: WebGLUniformLocation | null = null;

    private gridBounds: Bounds = { north: 0, south: 0, east: 0, west: 0 };
    private gridW = 0;
    private gridH = 0;
    private globalMode = false;

    private _keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
    private _onVisibilityChange: (() => void) | null = null;

    constructor(id: string) {
        this.id = id;
    }

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        this.map = map;
        this.gl = gl;

        const vs = compileShader(gl, gl.VERTEX_SHADER, HEATMAP_VERT, 'mld vert');
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, HEATMAP_FRAG, 'mld frag');
        this.program = linkProgram(gl, vs, fs);

        this.aQuadPosLoc = gl.getAttribLocation(this.program, 'a_quad_pos');
        this.uMatrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
        this.uGridBoundsLoc = gl.getUniformLocation(this.program, 'u_grid_bounds');
        this.uLonOffsetLoc = gl.getUniformLocation(this.program, 'u_lon_offset');
        this.uDataTexLoc = gl.getUniformLocation(this.program, 'u_data_tex');
        this.uOpacityLoc = gl.getUniformLocation(this.program, 'u_opacity');

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
                    indices[ix++] = v0;
                    indices[ix++] = v1;
                    indices[ix++] = v2;
                    indices[ix++] = v1;
                    indices[ix++] = v3;
                    indices[ix++] = v2;
                }
            }
        }

        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        this.indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        this.indexCount = indexCount;

        this.dataTexture = gl.createTexture();

        this._onVisibilityChange = () => {
            if (!document.hidden && this.gridW > 0) this.map?.triggerRepaint();
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        log.info(`onAdd — ${SUBDIV}×${SUBDIV} mld mesh`);
    }

    onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }
        if (this._keepaliveTimer !== null) {
            clearTimeout(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
        if (this.program) gl.deleteProgram(this.program);
        if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
        if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
        if (this.dataTexture) gl.deleteTexture(this.dataTexture);
        this.program = null;
        this.quadBuffer = null;
        this.indexBuffer = null;
        this.dataTexture = null;
        this.gl = null;
        this.map = null;
    }

    /** Set the active day's MLD grid + bounds + land mask.
     *  `mldNormalised` is row-major w*h of pre-normalised log10(MLD)
     *  values in [0, 1] (pipeline does the mapping). Land cells are
     *  masked separately and can hold any value. */
    setData(mldNormalised: Float32Array, width: number, height: number, bounds: Bounds, landMask: Uint8Array): void {
        if (mldNormalised.length !== width * height) {
            log.warn(`mld length mismatch: ${mldNormalised.length} expected=${width * height}`);
            return;
        }
        if (landMask.length !== width * height) {
            log.warn(`mask length mismatch: ${landMask.length} expected=${width * height}`);
            return;
        }
        this.gridW = width;
        this.gridH = height;
        this.gridBounds = { ...bounds };
        this.globalMode = Math.abs(bounds.east - bounds.west) >= 359;
        this.uploadDataTexture(mldNormalised, landMask);
        this.map?.triggerRepaint();
    }

    private uploadDataTexture(values: Float32Array, mask: Uint8Array): void {
        const gl = this.gl;
        const tex = this.dataTexture;
        if (!gl || !tex) return;
        const w = this.gridW;
        const h = this.gridH;
        const size = w * h;
        const rgba = new Uint8Array(size * 4);
        const inv = 255.0 / ENCODE_RANGE_MLD;
        for (let i = 0; i < size; i++) {
            const off = i * 4;
            const s = Math.min(255, Math.max(0, Math.round(values[i] * inv)));
            rgba[off] = s;
            rgba[off + 1] = mask[i] === 1 ? 255 : 0;
            rgba[off + 2] = 0;
            rgba[off + 3] = 255;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    render(gl: WebGLRenderingContext, matrixOrOptions: unknown): void {
        if (!this.program || !this.quadBuffer || !this.indexBuffer || !this.dataTexture || !matrixOrOptions) {
            this._scheduleKeepalive();
            return;
        }

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

        const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        const prevBlend = gl.isEnabled(gl.BLEND);
        const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
        const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);

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
        if (this.uOpacityLoc) gl.uniform1f(this.uOpacityLoc, 0.78);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
        if (this.uDataTexLoc) gl.uniform1i(this.uDataTexLoc, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        if (this.aQuadPosLoc >= 0) {
            gl.enableVertexAttribArray(this.aQuadPosLoc);
            gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        const offsets = this.globalMode ? [-360, 0, 360] : [0];
        for (const offset of offsets) {
            if (this.uLonOffsetLoc) gl.uniform1f(this.uLonOffsetLoc, offset);
            gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        }

        if (this.aQuadPosLoc >= 0) gl.disableVertexAttribArray(this.aQuadPosLoc);
        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.useProgram(prevProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
        if (prevBlend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
        gl.activeTexture(prevActiveTex);
    }

    private _scheduleKeepalive(): void {
        if (document.hidden) return;
        if (this._keepaliveTimer !== null) clearTimeout(this._keepaliveTimer);
        this._keepaliveTimer = setTimeout(() => {
            this._keepaliveTimer = null;
            this.map?.triggerRepaint();
        }, 500);
    }
}
