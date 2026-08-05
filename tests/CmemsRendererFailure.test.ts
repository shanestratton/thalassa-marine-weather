import { describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';

vi.mock('../utils/deviceTier', () => ({ particleScale: () => 0.001 }));

import { ChlRasterLayer } from '../components/map/ChlRasterLayer';
import { CurrentParticleLayer } from '../components/map/CurrentParticleLayer';
import { MldRasterLayer } from '../components/map/MldRasterLayer';
import { SeaIceRasterLayer } from '../components/map/SeaIceRasterLayer';
import { SstRasterLayer } from '../components/map/SstRasterLayer';
import { WaveParticleLayer } from '../components/map/WaveParticleLayer';

const BOUNDS = { north: 1, south: -1, east: 1, west: -1 };

interface RendererLayer {
    onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void;
    onRemove(map: mapboxgl.Map, gl: WebGLRenderingContext): void;
    render(gl: WebGLRenderingContext, matrixOrOptions: unknown): void;
}

interface RendererCase {
    name: string;
    create: () => RendererLayer;
    loadValid: (layer: RendererLayer) => void;
    loadInvalid: (layer: RendererLayer) => void;
    particle: boolean;
}

const RENDERERS: RendererCase[] = [
    {
        name: 'currents',
        create: () => new CurrentParticleLayer('currents-test'),
        loadValid: (layer) =>
            (layer as CurrentParticleLayer).setCurrents(
                new Float32Array([1]),
                new Float32Array([0]),
                1,
                1,
                BOUNDS,
                new Uint8Array([0]),
            ),
        loadInvalid: (layer) =>
            (layer as CurrentParticleLayer).setCurrents(
                new Float32Array(0),
                new Float32Array([0]),
                1,
                1,
                BOUNDS,
                new Uint8Array([0]),
            ),
        particle: true,
    },
    {
        name: 'waves',
        create: () => new WaveParticleLayer('waves-test'),
        loadValid: (layer) =>
            (layer as WaveParticleLayer).setWaves(
                new Float32Array([1]),
                new Float32Array([0]),
                1,
                1,
                BOUNDS,
                new Uint8Array([0]),
            ),
        loadInvalid: (layer) =>
            (layer as WaveParticleLayer).setWaves(
                new Float32Array(0),
                new Float32Array([0]),
                1,
                1,
                BOUNDS,
                new Uint8Array([0]),
            ),
        particle: true,
    },
    {
        name: 'sst',
        create: () => new SstRasterLayer('sst-test'),
        loadValid: (layer) =>
            (layer as SstRasterLayer).setData(new Float32Array([25]), 1, 1, BOUNDS, new Uint8Array([0])),
        loadInvalid: (layer) =>
            (layer as SstRasterLayer).setData(new Float32Array(0), 1, 1, BOUNDS, new Uint8Array([0])),
        particle: false,
    },
    {
        name: 'chlorophyll',
        create: () => new ChlRasterLayer('chl-test'),
        loadValid: (layer) =>
            (layer as ChlRasterLayer).setData(new Float32Array([0.5]), 1, 1, BOUNDS, new Uint8Array([0])),
        loadInvalid: (layer) =>
            (layer as ChlRasterLayer).setData(new Float32Array(0), 1, 1, BOUNDS, new Uint8Array([0])),
        particle: false,
    },
    {
        name: 'sea ice',
        create: () => new SeaIceRasterLayer('seaice-test'),
        loadValid: (layer) =>
            (layer as SeaIceRasterLayer).setData(new Float32Array([0.5]), 1, 1, BOUNDS, new Uint8Array([0])),
        loadInvalid: (layer) =>
            (layer as SeaIceRasterLayer).setData(new Float32Array(0), 1, 1, BOUNDS, new Uint8Array([0])),
        particle: false,
    },
    {
        name: 'mixed layer depth',
        create: () => new MldRasterLayer('mld-test'),
        loadValid: (layer) =>
            (layer as MldRasterLayer).setData(new Float32Array([0.5]), 1, 1, BOUNDS, new Uint8Array([0])),
        loadInvalid: (layer) =>
            (layer as MldRasterLayer).setData(new Float32Array(0), 1, 1, BOUNDS, new Uint8Array([0])),
        particle: false,
    },
];

interface GlFaults {
    nullBufferAt?: number;
    nullTexture?: boolean;
    nullVao?: boolean;
    shaderCompileFailureAt?: number;
    outOfMemoryOnBufferUploadAt?: number;
    outOfMemoryOnTextureUpload?: boolean;
    outOfMemoryOnTextureUploadAt?: number;
}

function webGlHarness(faults: GlFaults = {}) {
    let nextError = 0;
    let bufferAllocations = 0;
    let bufferUploads = 0;
    let shaderCompileChecks = 0;
    let textureUploads = 0;
    const buffer = {} as WebGLBuffer;
    const texture = {} as WebGLTexture;
    const shader = {} as WebGLShader;
    const program = {} as WebGLProgram;
    const vao = {} as WebGLVertexArrayObject;
    const uniform = {} as WebGLUniformLocation;
    const raw = {
        NO_ERROR: 0,
        INVALID_ENUM: 0x0500,
        INVALID_VALUE: 0x0501,
        INVALID_OPERATION: 0x0502,
        OUT_OF_MEMORY: 0x0505,
        INVALID_FRAMEBUFFER_OPERATION: 0x0506,
        CONTEXT_LOST_WEBGL: 0x9242,
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893,
        DYNAMIC_DRAW: 0x88e8,
        STATIC_DRAW: 0x88e4,
        FLOAT: 0x1406,
        UNSIGNED_INT: 0x1405,
        TEXTURE_2D: 0x0de1,
        TEXTURE_MIN_FILTER: 0x2801,
        TEXTURE_MAG_FILTER: 0x2800,
        TEXTURE_WRAP_S: 0x2802,
        TEXTURE_WRAP_T: 0x2803,
        LINEAR: 0x2601,
        REPEAT: 0x2901,
        CLAMP_TO_EDGE: 0x812f,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401,
        isContextLost: vi.fn(() => false),
        getError: vi.fn(() => {
            const error = nextError;
            nextError = 0;
            return error;
        }),
        createShader: vi.fn(() => shader),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => {
            shaderCompileChecks += 1;
            return faults.shaderCompileFailureAt !== shaderCompileChecks;
        }),
        getShaderInfoLog: vi.fn(() => ''),
        deleteShader: vi.fn(),
        createProgram: vi.fn(() => program),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(() => ''),
        deleteProgram: vi.fn(),
        getAttribLocation: vi.fn(() => 0),
        getUniformLocation: vi.fn(() => uniform),
        createBuffer: vi.fn(() => {
            bufferAllocations += 1;
            return faults.nullBufferAt === bufferAllocations ? null : buffer;
        }),
        bindBuffer: vi.fn(),
        bufferData: vi.fn(() => {
            bufferUploads += 1;
            if (faults.outOfMemoryOnBufferUploadAt === bufferUploads) nextError = 0x0505;
        }),
        deleteBuffer: vi.fn(),
        createTexture: vi.fn(() => (faults.nullTexture ? null : texture)),
        bindTexture: vi.fn(),
        texParameteri: vi.fn(),
        texImage2D: vi.fn(() => {
            textureUploads += 1;
            if (faults.outOfMemoryOnTextureUpload || faults.outOfMemoryOnTextureUploadAt === textureUploads) {
                nextError = 0x0505;
            }
        }),
        deleteTexture: vi.fn(),
        createVertexArray: vi.fn(() => (faults.nullVao ? null : vao)),
        bindVertexArray: vi.fn(),
        deleteVertexArray: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        drawArrays: vi.fn(),
        drawElements: vi.fn(),
        getExtension: vi.fn(() => null),
    };
    return { gl: raw as unknown as WebGLRenderingContext, raw };
}

function mapHarness() {
    const raw = { triggerRepaint: vi.fn() };
    return { map: raw as unknown as mapboxgl.Map, raw };
}

describe.each(RENDERERS)('$name CMEMS renderer failure contract', ({ create, loadValid, loadInvalid, particle }) => {
    it('throws on malformed frame dimensions instead of silently accepting them', () => {
        expect(() => loadInvalid(create())).toThrow(/mismatch/);
    });

    it('refuses valid data before every required renderer resource exists', () => {
        expect(() => loadValid(create())).toThrow(/renderer is not fully initialised/);
    });

    it('rejects a null buffer and makes partial onAdd cleanup idempotent', () => {
        const layer = create();
        const { gl, raw } = webGlHarness({ nullBufferAt: 1 });
        const { map } = mapHarness();

        expect(() => layer.onAdd(map, gl)).toThrow(/failed to allocate .*buffer/);
        expect(raw.deleteProgram).toHaveBeenCalled();
        const deletePrograms = raw.deleteProgram.mock.calls.length;
        const deleteBuffers = raw.deleteBuffer.mock.calls.length;
        layer.onRemove(map, gl);
        expect(raw.deleteProgram).toHaveBeenCalledTimes(deletePrograms);
        expect(raw.deleteBuffer).toHaveBeenCalledTimes(deleteBuffers);
    });

    it('rejects a null texture and releases all resources allocated earlier in onAdd', () => {
        const layer = create();
        const { gl, raw } = webGlHarness({ nullTexture: true });
        const { map } = mapHarness();

        expect(() => layer.onAdd(map, gl)).toThrow(/failed to allocate .*texture/);
        expect(raw.deleteProgram).toHaveBeenCalled();
        expect(raw.deleteBuffer).toHaveBeenCalled();
        const deletePrograms = raw.deleteProgram.mock.calls.length;
        const deleteBuffers = raw.deleteBuffer.mock.calls.length;
        layer.onRemove(map, gl);
        expect(raw.deleteProgram).toHaveBeenCalledTimes(deletePrograms);
        expect(raw.deleteBuffer).toHaveBeenCalledTimes(deleteBuffers);
    });

    it('turns WebGL OUT_OF_MEMORY during a texture upload into a data-load failure', () => {
        const layer = create();
        const { gl, raw } = webGlHarness({ outOfMemoryOnTextureUpload: true });
        const { map, raw: mapRaw } = mapHarness();
        layer.onAdd(map, gl);

        expect(() => loadValid(layer)).toThrow(/OUT_OF_MEMORY/);
        expect((layer as unknown as { dataValid: boolean }).dataValid).toBe(false);
        if (particle) {
            const state = layer as unknown as {
                gridU: Float32Array | null;
                gridV: Float32Array | null;
                gridSpeed: Float32Array | null;
                landMask: Uint8Array | null;
                spawnCDF: Float32Array | null;
                spawnIndexMap: Int32Array | null;
                trailData: Float32Array;
                particleAges: Int32Array;
            };
            expect(state.gridU).toBeNull();
            expect(state.gridV).toBeNull();
            expect(state.gridSpeed).toBeNull();
            expect(state.landMask).toBeNull();
            expect(state.spawnCDF).toBeNull();
            expect(state.spawnIndexMap).toBeNull();
            expect(state.trailData).toHaveLength(0);
            expect(state.particleAges).toHaveLength(0);
        }
        layer.render(gl, new Float32Array(16));
        expect(raw.drawArrays).not.toHaveBeenCalled();
        expect(raw.drawElements).not.toHaveBeenCalled();
        expect(mapRaw.triggerRepaint).not.toHaveBeenCalled();
        layer.onRemove(map, gl);
    });

    it('acknowledges a successful upload before requesting a repaint', () => {
        const layer = create();
        const { gl } = webGlHarness();
        const { map, raw: mapRaw } = mapHarness();
        layer.onAdd(map, gl);

        expect(() => loadValid(layer)).not.toThrow();
        expect((layer as unknown as { dataValid: boolean }).dataValid).toBe(true);
        expect(mapRaw.triggerRepaint).toHaveBeenCalled();
        layer.onRemove(map, gl);
    });

    if (particle) {
        it('rejects a null WebGL2 vertex array instead of claiming a complete particle renderer', () => {
            const layer = create();
            const { gl } = webGlHarness({ nullVao: true });
            const { map } = mapHarness();

            expect(() => layer.onAdd(map, gl)).toThrow(/failed to allocate particle vertex array/);
        });

        it('recreates released particle CPU buffers when a later texture upload succeeds', () => {
            const layer = create();
            const { gl } = webGlHarness({ outOfMemoryOnTextureUploadAt: 1 });
            const { map } = mapHarness();
            layer.onAdd(map, gl);

            expect(() => loadValid(layer)).toThrow(/OUT_OF_MEMORY/);
            const state = layer as unknown as {
                dataValid: boolean;
                trailData: Float32Array;
                particleAges: Int32Array;
            };
            expect(state.trailData).toHaveLength(0);
            expect(state.particleAges).toHaveLength(0);

            expect(() => loadValid(layer)).not.toThrow();
            expect(state.dataValid).toBe(true);
            expect(state.trailData.length).toBeGreaterThan(0);
            expect(state.particleAges.length).toBeGreaterThan(0);
            layer.onRemove(map, gl);
        });
    }
});

it.each(RENDERERS)('$name detects OUT_OF_MEMORY during initial buffer upload', ({ create }) => {
    const layer = create();
    const { gl } = webGlHarness({ outOfMemoryOnBufferUploadAt: 1 });
    const { map } = mapHarness();
    expect(() => layer.onAdd(map, gl)).toThrow(/OUT_OF_MEMORY/);
});

it('releases the first compiled shader when the second shader fails compilation', () => {
    const layer = new SstRasterLayer('sst-shader-cleanup-test');
    const { gl, raw } = webGlHarness({ shaderCompileFailureAt: 2 });
    const { map } = mapHarness();

    expect(() => layer.onAdd(map, gl)).toThrow(/fragment shader compile failed/);
    expect(raw.deleteShader).toHaveBeenCalledTimes(2);
    expect(raw.createProgram).not.toHaveBeenCalled();
});
