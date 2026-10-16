import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'fast-png';
import type { Page, TestInfo } from '@playwright/test';
import {
    captureWindPair,
    createPixelPair,
    cropPixelPair,
    measurePixelPair,
    saveCapturedOn,
    saveCapturedPair,
} from '../browser-tests/helpers/windPixelCapture';
import { contrast } from './helpers/colourScience';

const ownedOutputs: string[] = [];
// Windows has no POSIX owner or permission bits (process.getuid is undefined); only those checks are skipped there.
const POSIX_OWNERSHIP = process.platform !== 'win32';
function outputDirectories() {
    const root = mkdtempSync(join(tmpdir(), 'thalassa-wind-pixel-unit-'));
    const output = join(root, 'output');
    const extra = join(root, 'extra');
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(extra, { mode: 0o700 });
    ownedOutputs.push(root);
    return { output, extra };
}

type Frame = {
    width: number;
    height: number;
    channels: 3 | 4;
    depth: 8;
    data: Uint8Array;
};

function frame(width = 2, height = 2, channels: 3 | 4 = 4, seed = 0): Frame {
    const data = new Uint8Array(width * height * channels);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < channels; c++) {
                data[(y * width + x) * channels + c] = (x * 29 + y * 47 + c * 13 + seed) % 256;
            }
        }
    }
    return { width, height, channels, depth: 8, data };
}

const blank = (width = 2, height = 2, channels: 3 | 4 = 4): Frame => ({
    width,
    height,
    channels,
    depth: 8,
    data: new Uint8Array(width * height * channels),
});
const smallPair = () => createPixelPair(blank(), blank(), { width: 2, height: 2 });

// Independent transcription of the old screenshot measurement, using its
// actual colour-science helper. No resampling, masks or acceptance changes.
function originalMeasurement(on: Frame, off: Frame) {
    const all: Array<{ ink: string; ground: string; change: number; contrast: number }> = [];
    const hex = (data: Uint8Array, i: number) =>
        `#${[data[i], data[i + 1], data[i + 2]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
    for (let i = 0; i < on.data.length; i += on.channels) {
        const change =
            Math.abs(on.data[i] - off.data[i]) +
            Math.abs(on.data[i + 1] - off.data[i + 1]) +
            Math.abs(on.data[i + 2] - off.data[i + 2]);
        if (change > 60) {
            const ink = hex(on.data, i);
            const ground = hex(off.data, i);
            all.push({ ink, ground, change, contrast: contrast(ink, ground) });
        }
    }
    const cores = [...all].sort((a, b) => b.contrast - a.contrast).slice(0, Math.max(1, Math.floor(all.length / 20)));
    return { all, cores, edge: cores[cores.length - 1]?.contrast ?? 0 };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.querySelectorAll('[data-wind-pixel-test]').forEach((element) => element.remove());
    for (const root of ownedOutputs.splice(0)) {
        const ownerUid = process.getuid?.();
        if (POSIX_OWNERSHIP && ownerUid === undefined) {
            throw new Error('POSIX ownership is required for private unit artifacts');
        }
        const owned = (stat: { uid: number }) => !POSIX_OWNERSHIP || stat.uid === ownerUid;
        for (const leaf of ['output', 'extra']) {
            const directory = join(root, leaf);
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
                throw new Error('Owned unit-output directory changed');
            }
            for (const file of readdirSync(directory)) {
                if (!/^measured-wind(?:-without-wind)?-webkit\.png$/.test(file)) {
                    throw new Error('Unexpected unit-output file; preserve it');
                }
                const path = join(directory, file);
                const fileStat = lstatSync(path);
                if (!fileStat.isFile() || fileStat.isSymbolicLink() || !owned(fileStat)) {
                    throw new Error('Owned unit-output file changed');
                }
                unlinkSync(path);
            }
            rmdirSync(directory);
        }
        rmdirSync(root);
    }
});

describe('wind pixel pair geometry — generated fixtures, not browser evidence', () => {
    for (const channels of [3, 4] as const) {
        for (const scale of [1, 3]) {
            for (const clip of [
                { x: 0, y: 0, width: 1, height: 1 },
                { x: 1, y: 1, width: 2, height: 1 },
                { x: 3, y: 2, width: 1, height: 1 },
            ]) {
                it(`copies exact RGB bytes and alpha at ${channels} channels/${scale}x, clip ${JSON.stringify(clip)}`, () => {
                    const on = frame(4 * scale, 3 * scale, channels, 0);
                    const off = frame(4 * scale, 3 * scale, channels, 67);
                    const onBefore = on.data.slice();
                    const offBefore = off.data.slice();
                    const pair = createPixelPair(on, off, { width: 4, height: 3 });
                    const cropped = cropPixelPair(pair, clip);
                    const expected = (source: Frame) => {
                        const bytes: number[] = [];
                        for (let y = clip.y * scale; y < (clip.y + clip.height) * scale; y++) {
                            for (let x = clip.x * scale; x < (clip.x + clip.width) * scale; x++) {
                                for (let c = 0; c < channels; c++)
                                    bytes.push(source.data[(y * source.width + x) * channels + c]);
                            }
                        }
                        return new Uint8Array(bytes);
                    };
                    expect(cropped.on.data).toEqual(expected(on));
                    expect(cropped.off.data).toEqual(expected(off));
                    expect(cropped.on).toMatchObject({
                        width: clip.width * scale,
                        height: clip.height * scale,
                        channels,
                        depth: 8,
                    });
                    expect(cropped.viewport).toEqual({ width: clip.width, height: clip.height });
                    expect(cropped.scale).toBe(scale);
                    expect(Object.isFrozen(pair)).toBe(true);
                    expect(Object.isFrozen(pair.viewport)).toBe(true);
                    expect(cropped.on.data).not.toBe(on.data);
                    expect(cropped.off.data).not.toBe(off.data);
                    expect(on.data).toEqual(onBefore);
                    expect(off.data).toEqual(offBefore);
                });
            }
        }
    }

    it('uses the original byte-array view offset, not the start of its underlying buffer', () => {
        const storage = new Uint8Array(40).fill(222);
        const data = storage.subarray(7, 23);
        data.set(frame().data);
        const on = { ...frame(), data };
        const cropped = cropPixelPair(createPixelPair(on, frame(), { width: 2, height: 2 }), {
            x: 1,
            y: 1,
            width: 1,
            height: 1,
        });
        expect(cropped.on.data).toEqual(data.slice(12, 16));
    });

    it('accepts original Uint8ClampedArray bytes without colour or alpha normalization', () => {
        const on = { ...frame(), data: new Uint8ClampedArray(frame().data) };
        const pair = createPixelPair(on, frame(), { width: 2, height: 2 });
        expect(pair.on.data).toBe(on.data);
        expect(cropPixelPair(pair, { x: 0, y: 0, width: 2, height: 2 }).on.data).toEqual(new Uint8Array(on.data));
    });

    it.each([
        ['dimensions', frame(4, 1)],
        ['channels', frame(2, 2, 3)],
        ['depth', { ...frame(), depth: 16 }],
    ])('refuses mismatched on/off %s', (_, off) => {
        expect(() => createPixelPair(frame(), off, { width: 2, height: 2 })).toThrow();
    });

    it.each([
        ['missing frame', null],
        ['non-object frame', 'pixels'],
        ['zero width', { ...frame(), width: 0 }],
        ['negative height', { ...frame(), height: -1 }],
        ['fractional width', { ...frame(), width: 2.5 }],
        ['nonfinite height', { ...frame(), height: Infinity }],
        ['unsupported channels', { ...frame(), channels: 2 }],
        ['unsupported depth', { ...frame(), depth: 16 }],
        ['short data', { ...frame(), data: new Uint8Array(15) }],
        ['long data', { ...frame(), data: new Uint8Array(17) }],
        ['float data', { ...frame(), data: new Float32Array(16) }],
        ['16-bit data', { ...frame(), data: new Uint16Array(16) }],
        ['array-like data', { ...frame(), data: Array(16).fill(0) }],
        ['DataView data', { ...frame(), data: new DataView(new ArrayBuffer(16)) }],
    ])('refuses malformed decoded input: %s', (_, value) => {
        expect(() => createPixelPair(value, frame(), { width: 2, height: 2 })).toThrow();
    });

    it('checks byteLength as well as element length', () => {
        const data = new Uint8Array(16);
        Object.defineProperty(data, 'byteLength', { value: 15 });
        expect(() => createPixelPair({ ...frame(), data }, frame(), { width: 2, height: 2 })).toThrow();
    });

    it('refuses a source beyond 30M pixels without requiring a huge test allocation', () => {
        expect(() =>
            createPixelPair({ ...frame(), width: 30_001, height: 1000 }, frame(), { width: 2, height: 2 }),
        ).toThrow(/30M/);
    });

    it.each([
        { width: 0, height: 2 },
        { width: 2, height: -1 },
        { width: 2.5, height: 2 },
        { width: 2, height: NaN },
    ])('refuses malformed logical viewport %j', (viewport) => {
        expect(() => createPixelPair(frame(), frame(), viewport)).toThrow();
    });

    it.each([
        [3, 3, 2, 2],
        [4, 2, 2, 2],
        [2, 2, 4, 4],
    ])('refuses fractional, unequal-axis or below-one DPR (%i,%i/%i,%i)', (width, height, vw, vh) => {
        expect(() => createPixelPair(frame(width, height), frame(width, height), { width: vw, height: vh })).toThrow(
            /DPR/,
        );
    });

    it.each([
        { x: -1, y: 0, width: 1, height: 1 },
        { x: 0, y: -1, width: 1, height: 1 },
        { x: 0.5, y: 0, width: 1, height: 1 },
        { x: 0, y: 0.5, width: 1, height: 1 },
        { x: 0, y: 0, width: 1.5, height: 1 },
        { x: 0, y: 0, width: 1, height: 1.5 },
        { x: 0, y: 0, width: 0, height: 1 },
        { x: 0, y: 0, width: 1, height: 0 },
        { x: 1, y: 1, width: 2, height: 1 },
        { x: 0, y: 1, width: 1, height: 2 },
        { x: Infinity, y: 0, width: 1, height: 1 },
    ])('refuses noninteger/out-of-bounds original clip %j', (clip) => {
        expect(() => cropPixelPair(smallPair(), clip)).toThrow();
    });

    it('refuses forged DPR in both crop and measurement, never resamples', () => {
        const forged = { ...smallPair(), scale: 3 };
        expect(() => cropPixelPair(forged, { x: 0, y: 0, width: 1, height: 1 })).toThrow(/DPR/);
        expect(() => measurePixelPair(forged)).toThrow(/DPR/);
    });

    it('revalidates a mutated source before crop or measurement', () => {
        const off = frame();
        const pair = createPixelPair(frame(), off, { width: 2, height: 2 });
        off.data = new Uint8Array(12);
        expect(() => cropPixelPair(pair, { x: 0, y: 0, width: 1, height: 1 })).toThrow();
        expect(() => measurePixelPair(pair)).toThrow();
    });

    it('refuses a crop over 2M pixels before allocating either crop byte array', () => {
        const pair = createPixelPair(blank(1500, 1500, 3), blank(1500, 1500, 3), { width: 1500, height: 1500 });
        const NativeUint8Array = Uint8Array;
        let allocations = 0;
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(NativeUint8Array, {
                construct(target, args, newTarget) {
                    allocations++;
                    return Reflect.construct(target, args, newTarget);
                },
            }),
        );
        try {
            expect(() => cropPixelPair(pair, { x: 0, y: 0, width: 1500, height: 1500 })).toThrow(/bounded crop/);
            expect(allocations).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('refuses accidental whole-frame measurement beyond the 2M crop bound', () => {
        const pair = createPixelPair(blank(1500, 1500, 3), blank(1500, 1500, 3), { width: 1500, height: 1500 });
        expect(() => measurePixelPair(pair)).toThrow(/bounded crop/);
    });
});

describe('unchanged wind pixel measurement', () => {
    for (const channels of [3, 4] as const) {
        it(`matches the independent old loop over generated ${channels}-channel pixels`, () => {
            const on = frame(41, 5, channels, 11);
            const off = frame(41, 5, channels, 83);
            expect(measurePixelPair(createPixelPair(on, off, { width: 41, height: 5 }))).toEqual(
                originalMeasurement(on, off),
            );
        });
    }

    it('excludes RGB delta 60, includes 61 and ignores alpha-only changes', () => {
        const on = blank(3, 1);
        const off = blank(3, 1);
        on.data.set([60, 0, 0, 255, 61, 0, 0, 255, 0, 0, 0, 255]);
        const measured = measurePixelPair(createPixelPair(on, off, { width: 3, height: 1 }));
        expect(measured.all).toEqual([
            { ink: '#3d0000', ground: '#000000', change: 61, contrast: contrast('#3d0000', '#000000') },
        ]);
        expect(measured.cores).toEqual(measured.all);
    });

    it.each([1, 19, 20, 39, 40, 59, 60])('keeps the exact strongest-twentieth floor at %i changed pixels', (width) => {
        const on = blank(width, 1, 3);
        const off = blank(width, 1, 3);
        off.data.fill(255);
        const measured = measurePixelPair(createPixelPair(on, off, { width, height: 1 }));
        expect(measured.all).toHaveLength(width);
        expect(measured.cores).toHaveLength(Math.max(1, Math.floor(width / 20)));
        expect(measured.edge).toBe(contrast('#000000', '#ffffff'));
    });

    it('preserves stable ordering of equal-contrast cores', () => {
        const on = blank(40, 1, 3);
        const off = blank(40, 1, 3);
        on.data.fill(100);
        off.data.fill(238);
        on.data.set([0, 0, 0, 255, 255, 255]);
        off.data.set([255, 255, 255, 0, 0, 0]);
        const measured = measurePixelPair(createPixelPair(on, off, { width: 40, height: 1 }));
        expect(measured.cores.map(({ ink, ground }) => ({ ink, ground }))).toEqual([
            { ink: '#000000', ground: '#ffffff' },
            { ink: '#ffffff', ground: '#000000' },
        ]);
        expect(measured).toEqual(originalMeasurement(on, off));
    });

    it('returns empty cores and zero edge when original RGB bytes are unchanged', () => {
        expect(measurePixelPair(smallPair())).toEqual({ all: [], cores: [], edge: 0 });
    });
});

// Relief + Sat (A4, 2026-10-12): "white streaks on the dark base" is a claim
// about the sea. An explicit mask, from the fixture's own isLand, keeps land
// out of the sample; the oracle itself (delta over 60, strongest twentieth,
// their weakest) is untouched, and no mask means exactly the old measurement.
describe('wind pixel measurement over the sea alone', () => {
    // 4 x 1 CSS px at 2x: CSS columns 0-1 are land, a dark rim on pale fields
    // (21:1, the strongest change here); columns 2-3 are deep sea under a
    // white streak core.
    const shore = () => {
        const on = blank(8, 2, 3);
        const off = blank(8, 2, 3);
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 8; x++) {
                const i = (y * 8 + x) * 3;
                if (x < 4) {
                    off.data.set([255, 255, 255], i);
                    on.data.set([0, 0, 0], i);
                } else {
                    off.data.set([16, 55, 94], i);
                    on.data.set([255, 255, 255], i);
                }
            }
        }
        return { on, off, pair: createPixelPair(on, off, { width: 4, height: 1 }) };
    };

    it('leaves masked land out before the change filter and the strongest twentieth', () => {
        const { pair } = shore();
        const sea = measurePixelPair(pair, (x) => x >= 2);
        expect(sea.all).toHaveLength(8);
        expect(sea.all.every(({ ink, ground }) => ink === '#ffffff' && ground === '#10375e')).toBe(true);
        expect(sea.cores).toHaveLength(1);
        expect(sea.edge).toBe(contrast('#ffffff', '#10375e'));
    });

    it('without a mask it is exactly the old measurement, land and all', () => {
        const { on, off, pair } = shore();
        const everything = measurePixelPair(pair);
        expect(everything).toEqual(originalMeasurement(on, off));
        expect(everything.all).toHaveLength(16);
        expect(everything.cores[0]).toMatchObject({ ink: '#000000', ground: '#ffffff' });
    });

    it('asks the mask once per CSS pixel of the measured pair, and applies it at the pair’s DPR', () => {
        const { pair } = shore();
        const asked: Array<[number, number]> = [];
        const kept = measurePixelPair(pair, (x, y) => {
            asked.push([x, y]);
            return x === 1;
        });
        expect(asked).toEqual([
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
        ]);
        // CSS column 1 is device columns 2 and 3, both rows.
        expect(kept.all).toHaveLength(4);
        expect(kept.all.every(({ ink }) => ink === '#000000')).toBe(true);
    });

    it('refuses a mask that is not a function', () => {
        expect(() => measurePixelPair(shore().pair, 'sea' as never)).toThrow(/mask/);
    });
});

type HeldRecord = { el: HTMLElement; visibility: string; priority: string };

function mockCapture(
    wireOn: Buffer,
    wireOff: Buffer,
    options: {
        offError?: Error;
        offRepaintError?: Error;
        restoreError?: Error;
        disposeError?: Error;
        viewport?: { width: number; height: number } | null;
    } = {},
) {
    const order: string[] = [];
    let idle: (() => void) | undefined;
    let records: HeldRecord[] = [];
    let repaintCount = 0;
    const map = {
        once: vi.fn((event: string, callback: () => void) => {
            order.push(event);
            idle = callback;
        }),
        triggerRepaint: vi.fn(() => {
            order.push('repaint');
            repaintCount++;
            if (repaintCount === 2 && options.offRepaintError) throw options.offRepaintError;
            idle?.();
        }),
    };
    vi.stubGlobal('window', { __thalassaMap: map });
    const held = {
        evaluate: vi.fn(async (callback: (value: HeldRecord[]) => void) => {
            order.push('restore');
            if (options.restoreError) throw options.restoreError;
            callback(records);
        }),
        dispose: vi.fn(async () => {
            order.push('dispose');
            if (options.disposeError) throw options.disposeError;
        }),
    };
    let screenshotCount = 0;
    const page = {
        viewportSize: vi.fn(() => (options.viewport === undefined ? { width: 2, height: 2 } : options.viewport)),
        evaluate: vi.fn(async (callback: () => Promise<void>) => callback()),
        evaluateHandle: vi.fn(async (callback: () => HeldRecord[]) => {
            order.push('hold-hide');
            records = callback();
            return held;
        }),
        screenshot: vi.fn(async () => {
            screenshotCount++;
            order.push(`screenshot-${screenshotCount}`);
            if (screenshotCount === 1) return wireOn;
            document.querySelectorAll<HTMLElement>('[data-wind-pixel-test]').forEach((element) => {
                expect(element.style.visibility).toBe('hidden');
                expect(element.style.getPropertyPriority('visibility')).toBe('important');
            });
            if (options.offError) throw options.offError;
            return wireOff;
        }),
    };
    return { page: page as unknown as Page, methods: page, map, held, order };
}

function overlay(visibility = '', priority = '') {
    const element = document.createElement('div');
    element.dataset.windField = 'true';
    element.dataset.windPixelTest = 'true';
    element.style.setProperty('visibility', visibility, priority);
    element.style.opacity = '0.75';
    element.style.transform = 'translate(2px, 3px)';
    document.body.appendChild(element);
    return element;
}
const png = (source: Frame) => Buffer.from(encode(source));

describe('capture orchestration — mock page/DOM callbacks, not native browser evidence', () => {
    it('takes exactly two original full-viewport PNGs and restores empty/value/priority visibility', async () => {
        const empty = overlay();
        const visible = overlay('visible', 'important');
        const collapsed = overlay('collapse');
        const before = [empty, visible, collapsed].map((element) => element.style.cssText);
        const on = frame();
        const off = frame(2, 2, 4, 87);
        const wireOn = png(on);
        const mocked = mockCapture(wireOn, png(off));
        const captured = await captureWindPair(mocked.page);
        expect(captured.pair.on.data).toEqual(on.data);
        expect(captured.pair.off.data).toEqual(off.data);
        expect(captured.wireOn).toBe(wireOn);
        // timeout: 0, a capture's own: never a caller's 15 s actionTimeout (CI's software GL took 17-43 s).
        expect(mocked.methods.screenshot.mock.calls).toEqual([
            [{ animations: 'allow', fullPage: false, timeout: 0 }],
            [{ animations: 'allow', fullPage: false, timeout: 0 }],
        ]);
        expect(mocked.map.once.mock.calls.map(([event]) => event)).toEqual(['idle', 'idle']);
        expect(mocked.map.triggerRepaint).toHaveBeenCalledTimes(2);
        expect(mocked.order).toEqual([
            'idle',
            'repaint',
            'screenshot-1',
            'hold-hide',
            'idle',
            'repaint',
            'screenshot-2',
            'restore',
            'dispose',
        ]);
        expect([empty, visible, collapsed].map((element) => element.style.cssText)).toEqual(before);
        expect(empty.style.visibility).toBe('');
        expect(visible.style.visibility).toBe('visible');
        expect(visible.style.getPropertyPriority('visibility')).toBe('important');
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
    });

    it('restores exact original visibility and disposes the held handle when OFF capture fails', async () => {
        const element = overlay('collapse', 'important');
        const before = element.style.cssText;
        const failure = new Error('Synthetic OFF screenshot failure');
        const mocked = mockCapture(png(frame()), png(frame()), { offError: failure });
        await expect(captureWindPair(mocked.page)).rejects.toBe(failure);
        expect(element.style.cssText).toBe(before);
        expect(mocked.held.evaluate).toHaveBeenCalledOnce();
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });

    it('still disposes the held handle if restoration itself refuses', async () => {
        overlay();
        const failure = new Error('Synthetic restoration refusal');
        const mocked = mockCapture(png(frame()), png(frame()), { restoreError: failure });
        await expect(captureWindPair(mocked.page)).rejects.toBe(failure);
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });

    it('restores visibility and disposes the handle when OFF readiness refuses before screenshot', async () => {
        const element = overlay('visible', 'important');
        const before = element.style.cssText;
        const failure = new Error('Synthetic OFF repaint refusal');
        const mocked = mockCapture(png(frame()), png(frame()), { offRepaintError: failure });
        await expect(captureWindPair(mocked.page)).rejects.toBe(failure);
        expect(element.style.cssText).toBe(before);
        expect(mocked.held.evaluate).toHaveBeenCalledOnce();
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
        expect(mocked.methods.screenshot).toHaveBeenCalledOnce();
        expect(mocked.map.triggerRepaint).toHaveBeenCalledTimes(2);
    });

    it.each(['OFF screenshot', 'OFF repaint'] as const)(
        'preserves original %s failure followed by both cleanup errors',
        async (stage) => {
            overlay();
            const primary = new Error(`Synthetic ${stage} failure`);
            const restoration = new Error('Synthetic restoration after page close');
            const disposal = new Error('Synthetic disposal failure');
            const mocked = mockCapture(png(frame()), png(frame()), {
                ...(stage === 'OFF screenshot' ? { offError: primary } : { offRepaintError: primary }),
                restoreError: restoration,
                disposeError: disposal,
            });
            const outcome = await captureWindPair(mocked.page).then(
                () => {
                    throw new Error('A failed capture must never return a pixel pair');
                },
                (error: unknown) => error,
            );
            expect(outcome).toBeInstanceOf(AggregateError);
            const errors = (outcome as AggregateError).errors;
            expect(errors).toHaveLength(3);
            expect(errors[0]).toBe(primary);
            expect((outcome as AggregateError).cause).toBe(primary);
            expect(errors[1]).toBe(restoration);
            expect(errors[2]).toBe(disposal);
            expect(mocked.held.evaluate).toHaveBeenCalledOnce();
            expect(mocked.held.dispose).toHaveBeenCalledOnce();
            expect(mocked.order.slice(-2)).toEqual(['restore', 'dispose']);
            expect(mocked.methods.screenshot).toHaveBeenCalledTimes(stage === 'OFF screenshot' ? 2 : 1);
        },
    );

    it('fails a successful capture on a disposal-only error without hiding that error', async () => {
        const element = overlay('visible', 'important');
        const before = element.style.cssText;
        const failure = new Error('Synthetic disposal-only failure');
        const mocked = mockCapture(png(frame()), png(frame()), { disposeError: failure });
        await expect(captureWindPair(mocked.page)).rejects.toBe(failure);
        expect(element.style.cssText).toBe(before);
        expect(mocked.held.evaluate).toHaveBeenCalledOnce();
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, 0] as const)('does not swallow a falsy OFF failure (%s)', async (primary) => {
        const element = overlay('collapse', 'important');
        const before = element.style.cssText;
        const wire = png(frame());
        const mocked = mockCapture(wire, wire);
        mocked.methods.screenshot.mockResolvedValueOnce(wire).mockRejectedValueOnce(primary);
        await expect(captureWindPair(mocked.page)).rejects.toBe(primary);
        expect(element.style.cssText).toBe(before);
        expect(mocked.held.evaluate).toHaveBeenCalledOnce();
        expect(mocked.held.dispose).toHaveBeenCalledOnce();
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });

    it('refuses a missing real viewport before any capture or idle request', async () => {
        const mocked = mockCapture(png(frame()), png(frame()), { viewport: null });
        await expect(captureWindPair(mocked.page)).rejects.toThrow(/viewport/);
        expect(mocked.methods.screenshot).not.toHaveBeenCalled();
        expect(mocked.map.once).not.toHaveBeenCalled();
    });

    it('refuses a missing wind overlay without an OFF capture or invented handle', async () => {
        const mocked = mockCapture(png(frame()), png(frame()));
        await expect(captureWindPair(mocked.page)).rejects.toThrow(/wind overlay/);
        expect(mocked.methods.screenshot).toHaveBeenCalledOnce();
        expect(mocked.held.dispose).not.toHaveBeenCalled();
    });

    it.each(['invalid signature', 'over-budget header', 'unsupported depth'] as const)(
        'refuses %s PNG input after restoring presentation',
        async (kind) => {
            const element = overlay('visible');
            const before = element.style.cssText;
            const wire = png(frame());
            if (kind === 'invalid signature') wire[0] = 0;
            else if (kind === 'over-budget header') {
                wire.writeUInt32BE(30_001, 16);
                wire.writeUInt32BE(1000, 20);
            } else wire[24] = 16;
            const mocked = mockCapture(wire, png(frame()));
            await expect(captureWindPair(mocked.page)).rejects.toThrow(kind === 'invalid signature' ? /PNG/ : /bound/);
            expect(element.style.cssText).toBe(before);
            expect(mocked.held.dispose).toHaveBeenCalledOnce();
            expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
        },
    );

    it('saves the measured ON bytes without issuing another screenshot', async () => {
        overlay();
        const wireOn = png(frame());
        const mocked = mockCapture(wireOn, png(frame()));
        const captured = await captureWindPair(mocked.page);
        const directories = outputDirectories();
        const info = {
            project: { name: 'webkit' },
            outputPath: vi.fn((name: string) => join(directories.output, name)),
        };
        saveCapturedOn(captured, info as unknown as TestInfo, 'measured-wind', directories.extra);
        for (const directory of [directories.output, directories.extra]) {
            const path = join(directory, 'measured-wind-webkit.png');
            expect(readFileSync(path)).toEqual(wireOn);
            if (POSIX_OWNERSHIP) expect(lstatSync(path).mode & 0o777).toBe(0o600);
        }
        expect(() => saveCapturedOn(captured, info as unknown as TestInfo, 'measured-wind')).toThrow(/EEXIST/);
        expect(readFileSync(join(directories.output, 'measured-wind-webkit.png'))).toEqual(wireOn);
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });

    it('retains both actual measured frames before failed assertions, without an extra GPU capture', async () => {
        overlay();
        const wireOn = png(frame());
        const wireOff = png(frame(2, 2, 4, 87));
        const mocked = mockCapture(wireOn, wireOff);
        const captured = await captureWindPair(mocked.page);
        const directories = outputDirectories();
        const info = {
            project: { name: 'webkit' },
            outputPath: vi.fn((name: string) => join(directories.output, name)),
        };
        saveCapturedPair(captured, info as unknown as TestInfo, 'measured-wind');
        expect(readdirSync(directories.output).sort()).toEqual([
            'measured-wind-webkit.png',
            'measured-wind-without-wind-webkit.png',
        ]);
        expect(readFileSync(join(directories.output, 'measured-wind-webkit.png'))).toEqual(wireOn);
        expect(readFileSync(join(directories.output, 'measured-wind-without-wind-webkit.png'))).toEqual(wireOff);
        expect(mocked.methods.screenshot).toHaveBeenCalledTimes(2);
    });
});
