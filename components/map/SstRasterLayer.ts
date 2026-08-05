/**
 * SstRasterLayer — Mapbox custom WebGL layer that renders a scalar
 * temperature field as a coloured heatmap raster. No particles —
 * temperature has no direction to animate; the heatmap carries the
 * whole story.
 *
 * Design is a streamlined fork of CurrentParticleLayer's heatmap
 * pass: same 32×32 subdivided quad mesh, same inverse-Mercator UV in
 * the fragment shader (per-pixel latitude via atan(exp(...))), same
 * land-flag discard. Tuning differences:
 *   – Colour ramp is THERMAL (deep indigo → blue → cyan → green →
 *     yellow → orange → red) instead of the currents RIP/SLACK ramp.
 *   – Signed display range is [-3, 40°C], so legitimate polar water is
 *     distinct from 0°C and tropical extremes do not saturate early.
 *   – Scalar-packed input: the pipeline writes temperature °C into
 *     the u-channel of the v2 THCU binary, v-channel is zero. The
 *     hook extracts u[] and passes it here as the sole data plane.
 *
 * Wire-protocol with the rest of the app is identical to the vector
 * layers — implements mapboxgl.CustomLayerInterface, one setData()
 * call per active forecast step.
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
import { encodeSstTemperatureByte, SST_DISPLAY_MAX_C, SST_DISPLAY_MIN_C } from './marineLayerRamps';

const log = createLogger('SstRasterLayer');

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
uniform sampler2D u_data_tex;   // R = normalized SST over [-3, 40]°C, G = land flag
uniform float u_opacity;
uniform vec4 u_grid_bounds;     // [south, north, west, east]
varying float v_lon;
varying float v_mercY;

const float PI = 3.14159265359;

// Inverse Web-Mercator Y → latitude. v_mercY is interpolated linearly
// in mercator space (correct — it IS mercator) so recovering lat per-
// pixel here eliminates the linear-in-screen-space vs linear-in-lat
// mismatch that would otherwise produce horizontal seams at mesh rows.
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
    if (sample.g > 0.2) discard;        // land — same 0.2 threshold as currents
    float vRaw = sample.r;

    // Texture bytes already carry the signed [-3, 40]°C domain as [0, 1].
    // Do not discard zero: it represents legitimate -3°C polar water.
    float t = clamp(vRaw, 0.0, 1.0);

    // 7-stop thermal ramp. Tuned so:
    //   -3°C  (t=0.000) deep indigo — ice-edge polar
    //    2°C  (t=0.116) blue
    //    8°C  (t=0.256) cyan — subpolar
    //   15°C  (t=0.419) green — temperate
    //   22°C  (t=0.581) yellow
    //   29°C  (t=0.744) orange
    //   40°C  (t=1.000) deep red — extreme upper bound
    vec3 c0 = vec3(0.12, 0.08, 0.40);   // deep indigo
    vec3 c1 = vec3(0.15, 0.35, 0.75);   // blue
    vec3 c2 = vec3(0.25, 0.70, 0.85);   // cyan
    vec3 c3 = vec3(0.40, 0.80, 0.45);   // green
    vec3 c4 = vec3(0.95, 0.92, 0.40);   // yellow
    vec3 c5 = vec3(0.95, 0.55, 0.30);   // orange
    vec3 c6 = vec3(0.85, 0.20, 0.20);   // red

    vec3 color;
    if      (t < 0.116) color = mix(c0, c1, t / 0.116);
    else if (t < 0.256) color = mix(c1, c2, (t - 0.116) / 0.140);
    else if (t < 0.419) color = mix(c2, c3, (t - 0.256) / 0.163);
    else if (t < 0.581) color = mix(c3, c4, (t - 0.419) / 0.162);
    else if (t < 0.744) color = mix(c4, c5, (t - 0.581) / 0.163);
    else                color = mix(c5, c6, (t - 0.744) / 0.256);

    // Slight alpha grading so extreme-temp regions pop more than
    // neutral mid-latitude ocean. Tuned to stay out of overwhelming.
    float alpha = u_opacity * mix(0.55, 0.85, abs(t - 0.5) * 2.0);
    gl_FragColor = vec4(color, alpha);
}`;

interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── Main Layer ─────────────────────────────────────────────────────────

export class SstRasterLayer implements mapboxgl.CustomLayerInterface {
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
            beginWebGlOperation(gl, 'SstRasterLayer', 'initialisation');
            this.program = createWebGlProgram(gl, 'SstRasterLayer', HEATMAP_VERT, HEATMAP_FRAG, 'heatmap');

            this.aQuadPosLoc = requireWebGlAttribute(
                gl.getAttribLocation(this.program, 'a_quad_pos'),
                'SstRasterLayer',
                'a_quad_pos',
            );
            this.uMatrixLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_matrix'),
                'SstRasterLayer',
                'u_matrix',
            );
            this.uGridBoundsLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_grid_bounds'),
                'SstRasterLayer',
                'u_grid_bounds',
            );
            this.uLonOffsetLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_lon_offset'),
                'SstRasterLayer',
                'u_lon_offset',
            );
            this.uDataTexLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_data_tex'),
                'SstRasterLayer',
                'u_data_tex',
            );
            this.uOpacityLoc = requireWebGlUniform(
                gl.getUniformLocation(this.program, 'u_opacity'),
                'SstRasterLayer',
                'u_opacity',
            );

            // Subdivided quad — see CurrentParticleLayer for the full
            // reasoning (Mercator interpolation seams without subdivision).
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

            this.quadBuffer = requireWebGlResource(gl.createBuffer(), 'SstRasterLayer', 'heatmap vertex buffer');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
            proveWebGlOperation(gl, 'SstRasterLayer', 'heatmap vertex upload');

            this.indexBuffer = requireWebGlResource(gl.createBuffer(), 'SstRasterLayer', 'heatmap index buffer');
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
            proveWebGlOperation(gl, 'SstRasterLayer', 'heatmap index upload');
            this.indexCount = indexCount;

            this.dataTexture = requireWebGlResource(gl.createTexture(), 'SstRasterLayer', 'temperature texture');
            proveWebGlOperation(gl, 'SstRasterLayer', 'temperature texture allocation');

            this._onVisibilityChange = () => {
                if (!document.hidden && this.dataValid) this.map?.triggerRepaint();
            };
            document.addEventListener('visibilitychange', this._onVisibilityChange);

            log.info(`onAdd — ${SUBDIV}×${SUBDIV} heatmap mesh`);
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

    /** Set the active day's temperature grid + bounds + land mask.
     *  `tempCelsius` is a row-major w*h array of sea-surface temperature
     *  in degrees Celsius; land cells can be anything since the mask
     *  discards them. */
    setData(tempCelsius: Float32Array, width: number, height: number, bounds: Bounds, landMask: Uint8Array): void {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
            throw new Error('[SstRasterLayer] grid dimensions must be positive safe integers');
        }
        if (tempCelsius.length !== width * height) {
            throw new Error(`[SstRasterLayer] temp length mismatch: ${tempCelsius.length} expected=${width * height}`);
        }
        if (landMask.length !== width * height) {
            throw new Error(`[SstRasterLayer] mask length mismatch: ${landMask.length} expected=${width * height}`);
        }
        if (!this.map || !this.gl || !this.program || !this.quadBuffer || !this.indexBuffer || !this.dataTexture) {
            throw new Error('[SstRasterLayer] renderer is not fully initialised');
        }
        const globalMode = Math.abs(bounds.east - bounds.west) >= 359;
        this.dataValid = false;
        this.uploadDataTexture(tempCelsius, landMask, width, height, globalMode);
        this.gridW = width;
        this.gridH = height;
        this.gridBounds = { ...bounds };
        this.globalMode = globalMode;
        this.dataValid = true;
        this.map?.triggerRepaint();
    }

    private uploadDataTexture(
        temp: Float32Array,
        mask: Uint8Array,
        width: number,
        height: number,
        globalMode: boolean,
    ): void {
        const gl = this.gl;
        const tex = this.dataTexture;
        if (!gl || !tex) throw new Error('[SstRasterLayer] temperature texture upload is not initialised');
        const w = width;
        const h = height;
        const size = w * h;
        const rgba = new Uint8Array(size * 4);
        for (let i = 0; i < size; i++) {
            const off = i * 4;
            rgba[off] = encodeSstTemperatureByte(temp[i]);
            rgba[off + 1] = mask[i] === 1 ? 255 : 0;
            rgba[off + 2] = 0;
            rgba[off + 3] = 255;
        }
        beginWebGlOperation(gl, 'SstRasterLayer', 'temperature texture upload');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, globalMode ? gl.REPEAT : gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            proveWebGlOperation(gl, 'SstRasterLayer', 'temperature texture upload');
        } finally {
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        log.debug(`uploaded signed SST texture (${SST_DISPLAY_MIN_C}..${SST_DISPLAY_MAX_C}°C)`);
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

        // Save state we'll mutate.
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
        if (this.uOpacityLoc) gl.uniform1f(this.uOpacityLoc, 0.72);

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

        // No particle animation = no keepalive needed. The only reason
        // we'd need to re-render is if the camera moves, which Mapbox
        // itself triggers. A scalar heatmap is visually static.
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
