/**
 * SeaIceRasterLayer — Mapbox custom WebGL layer that renders the
 * CMEMS sea-ice concentration field as a white/cyan ice-pack heatmap.
 *
 * Streamlined fork of ChlRasterLayer / SstRasterLayer: same 32×32
 * subdivided quad, same inverse-Mercator UV, same land-flag discard.
 * Differences:
 *   – Input is the raw CMEMS `siconc` value [0, 1] packed directly
 *     into the u-channel by the pipeline — no log / linear remap, no
 *     range constants needed (ENCODE_RANGE = 1.0).
 *   – Colour ramp is ICE-WHITE (pale cyan → soft white → pure white)
 *     so the layer reads unmistakably as "frozen ocean" against the
 *     dark satellite base.
 *   – Discard threshold t<0.15 = the conventional meteorological
 *     "ice edge" — anything sparser than 15% is open water with
 *     isolated floes and isn't routing-relevant.
 */
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import {
    beginWebGlOperation,
    createWebGlProgram,
    proveWebGlOperation,
    requireWebGlAttribute,
    requireWebGlResource,
    requireWebGlUniform,
} from './cmemsWebglSafety';

const log = createLogger('SeaIceRasterLayer');

// siconc is dimensionless [0, 1] in the source dataset. The pipeline
// clips and packs it directly into the u-channel — no remap step. So
// `t` in the shader IS the concentration fraction, and 1.0 = 100%
// pack ice.
const ENCODE_RANGE_SI = 1.0;

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
uniform sampler2D u_data_tex;   // R = siconc fraction [0,1] as u8, G = land flag
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

    // Conventional "ice edge" is 15% concentration. Below that we
    // discard so polar transit corridors through marginal ice show
    // clean ocean, and the open Southern Ocean / Bering Sea shoulder
    // months don't get a wash of pale cyan over half the polar map.
    float t = clamp(sample.r, 0.0, 1.0);
    if (t < 0.15) discard;

    // Ice-white colour ramp. Lighter = MORE ice (matches NOAA / NSIDC
    // conventions). Slight blue cast at low concentration so the
    // marginal ice zone reads as "cold water with floes" rather than
    // pure white-out cloud.
    //   t≈0.15 (ice edge)        — pale cyan, semi-transparent
    //   t≈0.40 (loose pack)      — cool white-blue
    //   t≈0.65 (mid pack)        — near white
    //   t≈0.85 (heavy pack)      — bright white, near-opaque
    //   t≈1.00 (consolidated)    — pure white, fully opaque
    vec3 c0 = vec3(0.55, 0.75, 0.85);   // pale cyan blue
    vec3 c1 = vec3(0.78, 0.88, 0.92);   // cool white-blue
    vec3 c2 = vec3(0.92, 0.95, 0.97);   // near white
    vec3 c3 = vec3(1.00, 1.00, 1.00);   // pure white

    vec3 color;
    if      (t < 0.40) color = mix(c0, c1, (t - 0.15) / 0.25);
    else if (t < 0.65) color = mix(c1, c2, (t - 0.40) / 0.25);
    else               color = mix(c2, c3, (t - 0.65) / 0.35);

    // Higher concentration → more opaque. Marginal ice (t≈0.15) at
    // alpha≈0.55 lets the user sense "ice present here" without
    // hiding the underlying ocean colour. Consolidated pack at
    // alpha≈0.95 looks genuinely solid.
    float alpha = u_opacity * mix(0.55, 0.95, (t - 0.15) / 0.85);
    gl_FragColor = vec4(color, alpha);
}`;

interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── Main Layer ─────────────────────────────────────────────────────────

export class SeaIceRasterLayer implements mapboxgl.CustomLayerInterface {
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
    private dataValid = false;

    private _keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
    private _onVisibilityChange: (() => void) | null = null;

    constructor(id: string) {
        this.id = id;
    }

    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
        this.map = map;
        this.gl = gl;
        this.dataValid = false;
        try {
            beginWebGlOperation(gl, 'SeaIceRasterLayer', 'initialisation');
            this.program = createWebGlProgram(gl, 'SeaIceRasterLayer', HEATMAP_VERT, HEATMAP_FRAG, 'heatmap');

            this.aQuadPosLoc = requireWebGlAttribute(
                gl.getAttribLocation(this.program, 'a_quad_pos'),
                'SeaIceRasterLayer',
                'a_quad_pos',
            );
            this.uMatrixLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_matrix'),
                'SeaIceRasterLayer',
                'u_matrix',
            );
            this.uGridBoundsLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_grid_bounds'),
                'SeaIceRasterLayer',
                'u_grid_bounds',
            );
            this.uLonOffsetLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_lon_offset'),
                'SeaIceRasterLayer',
                'u_lon_offset',
            );
            this.uDataTexLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_data_tex'),
                'SeaIceRasterLayer',
                'u_data_tex',
            );
            this.uOpacityLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_opacity'),
                'SeaIceRasterLayer',
                'u_opacity',
            );

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

            this.quadBuffer = requireWebGlResource(gl.createBuffer(), 'SeaIceRasterLayer', 'heatmap vertex buffer');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
            proveWebGlOperation(gl, 'SeaIceRasterLayer', 'heatmap vertex upload');

            this.indexBuffer = requireWebGlResource(gl.createBuffer(), 'SeaIceRasterLayer', 'heatmap index buffer');
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
            proveWebGlOperation(gl, 'SeaIceRasterLayer', 'heatmap index upload');
            this.indexCount = indexCount;

            this.dataTexture = requireWebGlResource(gl.createTexture(), 'SeaIceRasterLayer', 'sea-ice texture');
            proveWebGlOperation(gl, 'SeaIceRasterLayer', 'sea-ice texture allocation');

            this._onVisibilityChange = () => {
                if (!document.hidden && this.dataValid) this.map?.triggerRepaint();
            };
            document.addEventListener('visibilitychange', this._onVisibilityChange);

            log.info(`onAdd — ${SUBDIV}×${SUBDIV} ice mesh`);
        } catch (error) {
            try {
                this.onRemove(map, gl);
            } catch {
                // Preserve the allocation failure; cleanup is idempotent.
            }
            throw error;
        }
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
        this.dataValid = false;
        this.gl = null;
        this.map = null;
    }

    /** Set the active day's sea-ice grid + bounds + land mask.
     *  `siconcFraction` is a row-major w*h array of concentration
     *  fractions in [0, 1] (0 = open water, 1 = consolidated pack).
     *  Land cells are masked separately and can hold any value. */
    setData(siconcFraction: Float32Array, width: number, height: number, bounds: Bounds, landMask: Uint8Array): void {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
            throw new Error('[SeaIceRasterLayer] grid dimensions must be positive safe integers');
        }
        if (siconcFraction.length !== width * height) {
            throw new Error(
                `[SeaIceRasterLayer] siconc length mismatch: ${siconcFraction.length} expected=${width * height}`,
            );
        }
        if (landMask.length !== width * height) {
            throw new Error(`[SeaIceRasterLayer] mask length mismatch: ${landMask.length} expected=${width * height}`);
        }
        if (!this.map || !this.gl || !this.program || !this.quadBuffer || !this.indexBuffer || !this.dataTexture) {
            throw new Error('[SeaIceRasterLayer] renderer is not fully initialised');
        }
        const globalMode = Math.abs(bounds.east - bounds.west) >= 359;
        this.dataValid = false;
        this.uploadDataTexture(siconcFraction, landMask, width, height, globalMode);
        this.gridW = width;
        this.gridH = height;
        this.gridBounds = { ...bounds };
        this.globalMode = globalMode;
        this.dataValid = true;
        this.map?.triggerRepaint();
    }

    private uploadDataTexture(
        values: Float32Array,
        mask: Uint8Array,
        width: number,
        height: number,
        globalMode: boolean,
    ): void {
        const gl = this.gl;
        const tex = this.dataTexture;
        if (!gl || !tex) throw new Error('[SeaIceRasterLayer] sea-ice texture upload is not initialised');
        const w = width;
        const h = height;
        const size = w * h;
        const rgba = new Uint8Array(size * 4);
        const inv = 255.0 / ENCODE_RANGE_SI;
        for (let i = 0; i < size; i++) {
            const off = i * 4;
            const s = Math.min(255, Math.max(0, Math.round(values[i] * inv)));
            rgba[off] = s;
            rgba[off + 1] = mask[i] === 1 ? 255 : 0;
            rgba[off + 2] = 0;
            rgba[off + 3] = 255;
        }
        beginWebGlOperation(gl, 'SeaIceRasterLayer', 'sea-ice texture upload');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            proveWebGlOperation(gl, 'SeaIceRasterLayer', 'sea-ice texture upload');
        } finally {
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
    }

    render(gl: WebGLRenderingContext, matrixOrOptions: unknown): void {
        if (
            !this.dataValid ||
            !this.program ||
            !this.quadBuffer ||
            !this.indexBuffer ||
            !this.dataTexture ||
            !matrixOrOptions
        ) {
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
        if (this.uOpacityLoc) gl.uniform1f(this.uOpacityLoc, 0.85);

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
