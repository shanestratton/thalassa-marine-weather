import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from 'fast-png';
import type { Page, TestInfo } from '@playwright/test';
import { contrast } from '../../tests/helpers/colourScience';
import { waitForChartCaptureReady } from './chartCaptureReady';

const MAX_FRAME_PIXELS = 30_000_000;
const MAX_CROP_PIXELS = 2_000_000;

type PixelFrame = {
    width: number;
    height: number;
    channels: 3 | 4;
    depth: 8;
    data: Uint8Array | Uint8ClampedArray;
};
type Size = { width: number; height: number };
type Clip = Size & { x: number; y: number };
type PixelPair = {
    on: PixelFrame;
    off: PixelFrame;
    viewport: Readonly<Size>;
    scale: number;
};

function integer(value: number, label: string, allowZero = false): number {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new Error(`${label} must be a bounded integer`);
    }
    return value;
}

function validateFrame(value: unknown): PixelFrame {
    if (!value || typeof value !== 'object') throw new Error('A decoded frame is required');
    const frame = value as PixelFrame;
    const pixels = integer(frame.width, 'width') * integer(frame.height, 'height');
    if (!Number.isSafeInteger(pixels) || pixels > MAX_FRAME_PIXELS) {
        throw new Error('Decoded source exceeds the 30M pixel bound');
    }
    if (frame.depth !== 8 || (frame.channels !== 3 && frame.channels !== 4)) {
        throw new Error('Only original 8-bit RGB/RGBA frames are supported');
    }
    if (!(frame.data instanceof Uint8Array) && !(frame.data instanceof Uint8ClampedArray)) {
        throw new Error('Original byte data is required');
    }
    if (frame.data.length !== pixels * frame.channels || frame.data.byteLength !== pixels * frame.channels) {
        throw new Error('Decoded dimensions, channels and byte data do not agree');
    }
    return frame;
}

export function createPixelPair(onValue: unknown, offValue: unknown, viewport: Size): Readonly<PixelPair> {
    const on = validateFrame(onValue);
    const off = validateFrame(offValue);
    for (const key of ['width', 'height', 'channels', 'depth'] as const) {
        if (on[key] !== off[key]) throw new Error('On/off frame shapes differ');
    }
    const width = integer(viewport.width, 'viewport width');
    const height = integer(viewport.height, 'viewport height');
    const scale = on.width / width;
    if (!Number.isSafeInteger(scale) || scale < 1 || on.height / height !== scale) {
        throw new Error('Actual integer DPR must match both viewport axes');
    }
    return Object.freeze({ on, off, viewport: Object.freeze({ width, height }), scale });
}

/** Copy exact original bytes, never scale, interpolate, composite or exclude pixels. */
export function cropPixelPair(pair: Readonly<PixelPair>, clip: Clip): Readonly<PixelPair> {
    const checked = createPixelPair(pair.on, pair.off, pair.viewport);
    if (pair.scale !== checked.scale) throw new Error('Pair DPR was changed');
    const x = integer(clip.x, 'clip x', true);
    const y = integer(clip.y, 'clip y', true);
    const width = integer(clip.width, 'clip width');
    const height = integer(clip.height, 'clip height');
    if (x + width > checked.viewport.width || y + height > checked.viewport.height) {
        throw new Error('Clip lies outside the original viewport');
    }
    const sx = x * checked.scale;
    const sy = y * checked.scale;
    const sw = width * checked.scale;
    const sh = height * checked.scale;
    if (![sx, sy, sw, sh].every(Number.isSafeInteger) || sw * sh > MAX_CROP_PIXELS) {
        throw new Error('Measure an explicitly bounded crop, not the full viewport');
    }
    const crop = (frame: PixelFrame): PixelFrame => {
        const data = new Uint8Array(sw * sh * frame.channels);
        for (let row = 0; row < sh; row++) {
            const start = ((sy + row) * frame.width + sx) * frame.channels;
            data.set(frame.data.subarray(start, start + sw * frame.channels), row * sw * frame.channels);
        }
        return { width: sw, height: sh, channels: frame.channels, depth: 8, data };
    };
    return createPixelPair(crop(checked.on), crop(checked.off), { width, height });
}

/**
 * The original RGB-delta and strongest-twentieth oracle, unchanged. `include`,
 * when given, is an explicit sample mask in the measured pair's CSS pixels
 * (asked once each, applied at its DPR): a pixel it refuses is never measured,
 * so land can be kept out of a claim about the sea. No mask, every pixel.
 */
export function measurePixelPair(pair: Readonly<PixelPair>, include?: (x: number, y: number) => boolean) {
    const checked = createPixelPair(pair.on, pair.off, pair.viewport);
    if (pair.scale !== checked.scale) throw new Error('Pair DPR was changed');
    const { on, off, scale, viewport } = checked;
    if (on.width * on.height > MAX_CROP_PIXELS) {
        throw new Error('Measure an explicitly bounded crop, not the full viewport');
    }
    if (include !== undefined && typeof include !== 'function') throw new Error('A sample mask must be a function');
    let kept: Uint8Array | null = null;
    if (include) {
        kept = new Uint8Array(viewport.width * viewport.height);
        for (let y = 0; y < viewport.height; y++) {
            for (let x = 0; x < viewport.width; x++) kept[y * viewport.width + x] = include(x, y) ? 1 : 0;
        }
    }
    const out: Array<{ ink: string; ground: string; change: number; contrast: number }> = [];
    const hex = (d: Uint8Array | Uint8ClampedArray, i: number) =>
        `#${[d[i], d[i + 1], d[i + 2]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
    for (let i = 0; i < on.data.length; i += on.channels) {
        if (kept) {
            const p = i / on.channels;
            const x = Math.floor((p % on.width) / scale);
            const y = Math.floor(Math.floor(p / on.width) / scale);
            if (!kept[y * viewport.width + x]) continue;
        }
        const change =
            Math.abs(on.data[i] - off.data[i]) +
            Math.abs(on.data[i + 1] - off.data[i + 1]) +
            Math.abs(on.data[i + 2] - off.data[i + 2]);
        if (change > 60) {
            const ink = hex(on.data, i);
            const ground = hex(off.data, i);
            out.push({ ink, ground, change, contrast: contrast(ink, ground) });
        }
    }
    const cores = [...out].sort((a, b) => b.contrast - a.contrast).slice(0, Math.max(1, Math.floor(out.length / 20)));
    return { all: out, cores, edge: cores[cores.length - 1]?.contrast ?? 0 };
}

function decodeScreenshot(wire: Buffer): PixelFrame {
    if (
        wire.length < 33 ||
        !wire.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        wire.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) {
        throw new Error('An original PNG screenshot is required');
    }
    const pixels = integer(wire.readUInt32BE(16), 'PNG width') * integer(wire.readUInt32BE(20), 'PNG height');
    if (pixels > MAX_FRAME_PIXELS || wire[24] !== 8) throw new Error('Screenshot dimensions/depth exceed the bound');
    return validateFrame(decode(wire));
}

/**
 * Capture real full-viewport ON/OFF frames once per base, then measure the
 * original CSS clips in their native pixels. Clipped GPU captures showed flat
 * land while full frames showed imagery; repeated GPU captures also consumed
 * Chromium's entire unchanged 150s budget. No basemap is substituted or frozen,
 * and wind keeps animating. Both Light bands now share this same frame pair.
 * These observations do not establish a compositor cause: fresh focused and
 * whole-release runs must validate this capture path independently.
 *
 * Each capture has no timeout of its own (timeout: 0): it is bounded by the
 * test's budget, never by a caller's actionTimeout, which Playwright also
 * applies to an un-timed screenshot. CI's software GL took 17-43 s for one
 * (run 38190842354), well past a 15 s cap meant for clicks.
 */
export async function captureWindPair(page: Page) {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('A real prescribed viewport is required');
    await waitForChartCaptureReady(page);
    const wireOn = await page.screenshot({ animations: 'allow', fullPage: false, timeout: 0 });
    const native = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLCanvasElement>('[data-wind-field="true"] canvas')].map((canvas) => {
            const ctx = canvas.getContext('2d')!;
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const counts = { drawn: 0, slate: 0, red: 0, white: 0, black: 0 };
            for (let i = 0; i < pixels.length; i += 4) {
                const r = pixels[i],
                    g = pixels[i + 1],
                    b = pixels[i + 2],
                    a = pixels[i + 3];
                if (a < 64) continue;
                counts.drawn++;
                if (b >= r + 5 && r < 60 && g < 70 && b < 80) counts.slate++;
                if (r > g + 40 && r > b + 40) counts.red++;
                if (Math.min(r, g, b) >= 240) counts.white++;
                if (Math.max(r, g, b) < 10) counts.black++;
            }
            return { width: canvas.width, height: canvas.height, counts, png: canvas.toDataURL() };
        }),
    );
    console.info('APP_WIND_RGBA ' + JSON.stringify(native.map(({ png: _png, ...result }) => result)));
    const held = await page.evaluateHandle(() => {
        const records = [...document.querySelectorAll<HTMLElement>('[data-wind-field="true"]')].map((el) => ({
            el,
            visibility: el.style.visibility,
            priority: el.style.getPropertyPriority('visibility'),
        }));
        if (!records.length) throw new Error('A real wind overlay is required');
        records.forEach(({ el }) => el.style.setProperty('visibility', 'hidden', 'important'));
        return records;
    });
    let wireOff: Buffer | undefined;
    const failures: unknown[] = [];
    try {
        await waitForChartCaptureReady(page);
        wireOff = await page.screenshot({ animations: 'allow', fullPage: false, timeout: 0 });
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            await held.evaluate((records) =>
                records.forEach(({ el, visibility, priority }) =>
                    el.style.setProperty('visibility', visibility, priority),
                ),
            );
        } catch (error) {
            failures.push(error);
        } finally {
            try {
                await held.dispose();
            } catch (error) {
                failures.push(error);
            }
        }
    }
    // A timed-out page can also reject cleanup. Keep the original capture
    // failure rather than replacing it with a closed-page restoration error.
    // Cleanup still always runs, and any cleanup failure still fails the test.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
        // Playwright's error JSON retains `cause`, but not AggregateError.errors.
        throw new AggregateError(failures, 'Wind capture and cleanup failed', { cause: failures[0] });
    }
    return {
        pair: createPixelPair(decodeScreenshot(wireOn), decodeScreenshot(wireOff!), viewport),
        wireOn,
        wireOff: wireOff!,
        native,
    };
}

/** Save the actual measured ON frame, without another GPU capture. */
export function saveCapturedOn(
    capture: Awaited<ReturnType<typeof captureWindPair>>,
    info: TestInfo,
    name: string,
    extraDirectory = '',
): void {
    const file = `${name}-${info.project.name}.png`;
    writeFileSync(info.outputPath(file), capture.wireOn, { flag: 'wx', mode: 0o600 });
    if (extraDirectory) writeFileSync(join(extraDirectory, file), capture.wireOn, { mode: 0o600 });
}

/** Preserve both measured frames before assertions, including failed colour checks. */
export function saveCapturedPair(
    capture: Awaited<ReturnType<typeof captureWindPair>>,
    info: TestInfo,
    name: string,
    extraDirectory = '',
): void {
    saveCapturedOn(capture, info, name, extraDirectory);
    for (const [index, native] of capture.native.entries()) {
        writeFileSync(
            info.outputPath(`${name}-raw-canvas-${index}.png`),
            Buffer.from(native.png.split(',')[1], 'base64'),
        );
    }
    const file = `${name}-without-wind-${info.project.name}.png`;
    writeFileSync(info.outputPath(file), capture.wireOff, { flag: 'wx', mode: 0o600 });
    if (extraDirectory) writeFileSync(join(extraDirectory, file), capture.wireOff, { mode: 0o600 });
}
