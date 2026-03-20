/**
 * PrecipHeatmapRenderer v6 — CONTOUR-BASED BLOB RENDERING
 *
 * Instead of rendering each pixel independently, this approach:
 * 1. Computes the disaggregated precipitation field
 * 2. Creates three intensity threshold masks (blue, yellow, red)
 * 3. Applies morphological closing (box blur + re-threshold) to merge
 *    nearby dots into solid blobs and discard isolated speckle
 * 4. Softens edges with a final blur pass
 * 5. Composites layers bottom-to-top: cloud → blue → yellow → red
 *
 * The result: solid coloured contour-fills exactly like weather radar.
 */

import type { PrecipFrame } from './decodeGrib2Precip';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('PrecipHeatmapRenderer');

export interface PrecipHeatmapResult {
    dataUrl: string;
    coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

// ══════════════════════════════════════════════════════════════
//  PERLIN NOISE ENGINE
// ══════════════════════════════════════════════════════════════

const PERM = new Uint8Array(512);
const GRAD: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
];
{
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let seed = 42;
    for (let i = 255; i > 0; i--) {
        seed = (seed * 16807) % 2147483647;
        const j = seed % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function dotGrad(hash: number, x: number, y: number): number {
    const g = GRAD[hash & 7];
    return g[0] * x + g[1] * y;
}

function perlin2(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = PERM[PERM[xi] + yi];
    const ab = PERM[PERM[xi] + yi + 1];
    const ba = PERM[PERM[xi + 1] + yi];
    const bb = PERM[PERM[xi + 1] + yi + 1];
    const x1 = xf - 1,
        y1 = yf - 1;
    return (
        (dotGrad(aa, xf, yf) * (1 - u) + dotGrad(ba, x1, yf) * u) * (1 - v) +
        (dotGrad(ab, xf, y1) * (1 - u) + dotGrad(bb, x1, y1) * u) * v
    );
}

function fbm(x: number, y: number): number {
    let value = 0,
        amplitude = 1,
        frequency = 1,
        maxAmp = 0;
    for (let i = 0; i < 5; i++) {
        value += perlin2(x * frequency, y * frequency) * amplitude;
        maxAmp += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    return value / maxAmp;
}

// ══════════════════════════════════════════════════════════════
//  BILINEAR INTERPOLATION
// ══════════════════════════════════════════════════════════════

function sampleBilinear(data: Float32Array, width: number, height: number, x: number, y: number): number {
    const x0 = Math.floor(x),
        y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1),
        y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0,
        fy = y - y0;
    return (
        data[y0 * width + x0] * (1 - fx) * (1 - fy) +
        data[y0 * width + x1] * fx * (1 - fy) +
        data[y1 * width + x0] * (1 - fx) * fy +
        data[y1 * width + x1] * fx * fy
    );
}

// ══════════════════════════════════════════════════════════════
//  FAST BOX BLUR (separable — horizontal then vertical)
// ══════════════════════════════════════════════════════════════

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
    const dst = new Float32Array(w * h);
    const tmp = new Float32Array(w * h);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
        let sum = 0;
        const row = y * w;
        // Seed the running sum
        for (let x = 0; x < Math.min(radius, w); x++) sum += src[row + x];
        for (let x = 0; x < w; x++) {
            if (x + radius < w) sum += src[row + x + radius];
            if (x - radius - 1 >= 0) sum -= src[row + x - radius - 1];
            const count = Math.min(x + radius, w - 1) - Math.max(x - radius, 0) + 1;
            tmp[row + x] = sum / count;
        }
    }

    // Vertical pass
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = 0; y < Math.min(radius, h); y++) sum += tmp[y * w + x];
        for (let y = 0; y < h; y++) {
            if (y + radius < h) sum += tmp[(y + radius) * w + x];
            if (y - radius - 1 >= 0) sum -= tmp[(y - radius - 1) * w + x];
            const count = Math.min(y + radius, h - 1) - Math.max(y - radius, 0) + 1;
            dst[y * w + x] = sum / count;
        }
    }

    return dst;
}

// ══════════════════════════════════════════════════════════════
//  LAYER DEFINITIONS
// ══════════════════════════════════════════════════════════════

interface ContourLayer {
    threshold: number;
    fillR: number;
    fillG: number;
    fillB: number;
    fillA: number;
    mergeRadius: number;
    smoothRadius: number;
    minDensity: number;
    outlineOf?: number;
    blueShading?: boolean; // Use precip-intensity-based shading instead of flat fill
}

// Bottom to top: cloud → white outline ring → blue → deep blue → yellow → orange → red
const CONTOUR_LAYERS: ContourLayer[] = [
    // 0: Cloud halo — warm amber-brown
    {
        threshold: 0.3,
        fillR: 220,
        fillG: 190,
        fillB: 130,
        fillA: 55,
        mergeRadius: 12,
        smoothRadius: 6,
        minDensity: 0.15,
    },
    // 1: White outline ring — matches blue exactly, just 2px wider
    {
        threshold: 1.0,
        fillR: 245,
        fillG: 245,
        fillB: 240,
        fillA: 140,
        mergeRadius: 10,
        smoothRadius: 0,
        minDensity: 0.2,
        outlineOf: 2,
    },
    // 2: Blue — light/moderate rain (intensity-shaded: light cyan edges, dark blue centres)
    {
        threshold: 1.0,
        fillR: 0,
        fillG: 150,
        fillB: 255,
        fillA: 195,
        mergeRadius: 8,
        smoothRadius: 4,
        minDensity: 0.2,
        blueShading: true,
    },
    // 3: Dark green outline — near-black border defining yellow cores
    {
        threshold: 4.5,
        fillR: 20,
        fillG: 70,
        fillB: 20,
        fillA: 210,
        mergeRadius: 7,
        smoothRadius: 0,
        minDensity: 0.18,
        outlineOf: 4, // yellow is now index 4
    },
    // 5: Yellow — heavy rain cores
    {
        threshold: 5.0,
        fillR: 255,
        fillG: 225,
        fillB: 0,
        fillA: 230,
        mergeRadius: 5,
        smoothRadius: 3,
        minDensity: 0.2,
    },
    // 6: Orange — very heavy
    {
        threshold: 10.0,
        fillR: 255,
        fillG: 160,
        fillB: 0,
        fillA: 235,
        mergeRadius: 4,
        smoothRadius: 2,
        minDensity: 0.2,
    },
    // 7: Red — extreme
    {
        threshold: 20.0,
        fillR: 255,
        fillG: 30,
        fillB: 0,
        fillA: 240,
        mergeRadius: 3,
        smoothRadius: 2,
        minDensity: 0.25,
    },
];

// ══════════════════════════════════════════════════════════════
//  DISAGGREGATION PARAMS
// ══════════════════════════════════════════════════════════════

interface DisaggParams {
    bias: number;
    gain: number;
    maxMult: number;
    noiseScale: number;
}

function getDisaggParams(mmh: number): DisaggParams {
    if (mmh < 0.5) return { bias: -0.35, gain: 2.5, maxMult: 2.5, noiseScale: 6.0 };
    if (mmh < 1.5) return { bias: -0.2, gain: 2.2, maxMult: 2.2, noiseScale: 5.5 };
    if (mmh < 4.0) return { bias: -0.1, gain: 1.8, maxMult: 2.0, noiseScale: 5.0 };
    if (mmh < 10.0) return { bias: 0.0, gain: 1.5, maxMult: 1.8, noiseScale: 4.5 };
    if (mmh < 25.0) return { bias: 0.1, gain: 1.3, maxMult: 1.5, noiseScale: 4.0 };
    return { bias: 0.15, gain: 1.2, maxMult: 1.3, noiseScale: 3.0 };
}

// ══════════════════════════════════════════════════════════════
//  RENDERER v6 — CONTOUR-BASED BLOB RENDERING
// ══════════════════════════════════════════════════════════════

const UPSAMPLE_FACTOR = 20;
const MAX_CANVAS_DIM = 1600; // Slightly smaller to keep perf reasonable with all the blur passes

export function renderPrecipFrame(frame: PrecipFrame): PrecipHeatmapResult {
    const outW = Math.min(frame.width * UPSAMPLE_FACTOR, MAX_CANVAS_DIM);
    const outH = Math.min(frame.height * UPSAMPLE_FACTOR, MAX_CANVAS_DIM);

    const geoOffX = (frame.lon1 ?? frame.west) * 5.7;
    const geoOffY = (frame.lat1 ?? frame.north) * 5.7;

    // ── STEP 1: Compute precipitation fields ──
    const precipField = new Float32Array(outW * outH); // disaggregated (for thresholds)
    const smoothField = new Float32Array(outW * outH); // smooth original (for blue shading)

    for (let py = 0; py < outH; py++) {
        const gy = (py / (outH - 1)) * (frame.height - 1);
        const nfy = (py / outH) * frame.height;

        for (let px = 0; px < outW; px++) {
            const gx = (px / (outW - 1)) * (frame.width - 1);
            const nfx = (px / outW) * frame.width;

            const smoothMmh = sampleBilinear(frame.rate, frame.width, frame.height, gx, gy);
            smoothField[py * outW + px] = smoothMmh;

            let mmh = smoothMmh;
            if (mmh > 0.01) {
                const p = getDisaggParams(mmh);
                const nx = geoOffX + nfx * p.noiseScale;
                const ny = geoOffY + nfy * p.noiseScale;
                const noise = fbm(nx, ny);
                const mask = Math.min(Math.max(0, (noise + p.bias) * p.gain), p.maxMult);
                mmh = mmh * mask;
            }

            precipField[py * outW + px] = mmh;
        }
    }

    // ── STEP 2: For each layer, create threshold mask → close → smooth ──
    // Store final alpha masks for each layer
    const layerMasks: Float32Array[] = [];

    for (const layer of CONTOUR_LAYERS) {
        // Create binary mask: 1 where precip >= threshold, 0 otherwise
        const binary = new Float32Array(outW * outH);
        for (let i = 0; i < precipField.length; i++) {
            binary[i] = precipField[i] >= layer.threshold ? 1.0 : 0.0;
        }

        // Morphological closing: blur the binary mask then re-threshold
        // This merges nearby dots into solid blobs and discards isolated speckle
        const closed = boxBlur(binary, outW, outH, layer.mergeRadius);

        // Re-threshold: only keep areas where enough nearby pixels were above threshold
        // minDensity of 0.2 means at least 20% of the merge neighborhood was active
        for (let i = 0; i < closed.length; i++) {
            closed[i] = closed[i] >= layer.minDensity ? 1.0 : 0.0;
        }

        // Final smooth blur for soft edges
        const smooth = boxBlur(closed, outW, outH, layer.smoothRadius);

        layerMasks.push(smooth);
    }

    // ── STEP 3: Composite layers bottom-to-top ──
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(outW, outH);
    const pixels = imageData.data;

    for (let i = 0; i < outW * outH; i++) {
        let r = 0,
            g = 0,
            b = 0,
            a = 0;

        for (let li = 0; li < CONTOUR_LAYERS.length; li++) {
            const layer = CONTOUR_LAYERS[li];
            let maskVal = Math.min(layerMasks[li][i], 1.0);

            // If this is an outline ring, subtract the inner layer's mask
            if (layer.outlineOf !== undefined) {
                const innerMask = Math.min(layerMasks[layer.outlineOf][i], 1.0);
                maskVal = Math.max(0, maskVal - innerMask);
            }

            if (maskVal > 0.01) {
                let lr = layer.fillR,
                    lg = layer.fillG,
                    lb = layer.fillB,
                    la = layer.fillA;

                // Blue shading: vary colour based on precipitation intensity + noise
                if (layer.blueShading) {
                    // Use SMOOTH field for shading — no disaggregation speckle
                    const precip = smoothField[i];
                    const px = i % outW;
                    const py = Math.floor(i / outW);
                    const nfx = (px / outW) * frame.width;
                    const nfy = (py / outH) * frame.height;

                    // Normalise: 0 at threshold edge, 1 deep inside
                    const depth = Math.min(1, Math.max(0, (precip - 1.0) / 3.5));

                    // Gentle noise for subtle organic variation
                    const splotch = fbm(geoOffX + nfx * 2.0 + 100, geoOffY + nfy * 2.0 + 100);

                    // Base: medium cyan-blue with gradual edge→centre gradient + noise
                    // edgeFade: 0 at threshold, 1 at depth=0.67 (gradual transition)
                    const edgeFade = Math.min(1, depth * 1.5);
                    const noiseVar = splotch * 0.25; // ±25% organic noise for visible variation

                    // Light cyan edges → medium blue centres, with noise-driven patches
                    lr = Math.round(25 + 50 * (1 - edgeFade)); // 75→25
                    lg = Math.round(120 + 60 * (1 - edgeFade) + noiseVar * -40); // 180→120 ± noise
                    lb = Math.round(225 + 25 * (1 - edgeFade) + noiseVar * -25); // 250→225 ± noise
                    la = Math.round(165 + 55 * edgeFade); // 165→220
                }

                const layerA = (la / 255) * maskVal;
                const outA = layerA + (a / 255) * (1 - layerA);
                if (outA > 0.001) {
                    r = Math.round((lr * layerA + r * (a / 255) * (1 - layerA)) / outA);
                    g = Math.round((lg * layerA + g * (a / 255) * (1 - layerA)) / outA);
                    b = Math.round((lb * layerA + b * (a / 255) * (1 - layerA)) / outA);
                    a = Math.round(outA * 255);
                }
            }
        }

        const pIdx = i * 4;
        pixels[pIdx] = r;
        pixels[pIdx + 1] = g;
        pixels[pIdx + 2] = b;
        pixels[pIdx + 3] = a;
    }

    ctx.putImageData(imageData, 0, 0);

    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
        [frame.lon1, frame.lat1],
        [frame.lon2, frame.lat1],
        [frame.lon2, frame.lat2],
        [frame.lon1, frame.lat2],
    ];

    log.info(`[PrecipRenderer] ${frame.width}×${frame.height} → ${outW}×${outH} v6 (contour blobs)`);

    return { dataUrl: canvas.toDataURL(), coordinates };
}

export function renderAllPrecipFrames(frames: PrecipFrame[]): PrecipHeatmapResult[] {
    return frames.map(renderPrecipFrame);
}
