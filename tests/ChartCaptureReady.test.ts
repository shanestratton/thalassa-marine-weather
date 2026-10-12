import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { waitForChartCaptureReady } from '../browser-tests/helpers/chartCaptureReady';

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0));
        return 0;
    });
});
afterEach(() => vi.unstubAllGlobals());

const page = () => ({ evaluate: vi.fn(async (callback: () => Promise<void>) => callback()) }) as unknown as Page;

describe('paired chart capture readiness', () => {
    it('does not capture inside native idle: waits for an intervening browser rendering opportunity', async () => {
        let idle!: () => void;
        const frames: FrameRequestCallback[] = [];
        const raf = vi.fn((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('window', {
            __thalassaMap: {
                once: (_event: string, callback: () => void) => {
                    idle = callback;
                },
                triggerRepaint: vi.fn(),
            },
        });
        let completed = false;
        const ready = waitForChartCaptureReady(page()).then(() => {
            completed = true;
        });
        idle();
        await Promise.resolve();
        await Promise.resolve();
        expect(completed, 'idle is inside the map render callback, before presentation').toBe(false);
        expect(frames).toHaveLength(1);
        frames[0](10);
        await Promise.resolve();
        expect(completed, 'the first RAF still runs before that rendering opportunity').toBe(false);
        expect(frames).toHaveLength(2);
        frames[1](20);
        await ready;
        expect(completed).toBe(true);
        expect(raf).toHaveBeenCalledTimes(2);
    });

    it('registers for genuine idle before requesting a repaint and remains pending until that callback', async () => {
        const order: string[] = [];
        let idle!: () => void;
        const map = {
            once: vi.fn((event: string, callback: () => void) => {
                order.push(event);
                idle = callback;
            }),
            triggerRepaint: vi.fn(() => order.push('repaint')),
        };
        vi.stubGlobal('window', { __thalassaMap: map });
        let completed = false;
        const ready = waitForChartCaptureReady(page()).then(() => {
            completed = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(['idle', 'repaint']);
        expect(completed).toBe(false);
        expect(map.triggerRepaint).toHaveBeenCalledOnce();
        idle();
        await ready;
        expect(completed).toBe(true);
    });

    it('handles an immediately delivered real idle callback without a timer or repeat capture', async () => {
        let idle!: () => void;
        const map = {
            once: vi.fn((_: string, callback: () => void) => {
                idle = callback;
            }),
            triggerRepaint: vi.fn(() => idle()),
        };
        vi.stubGlobal('window', { __thalassaMap: map });
        await waitForChartCaptureReady(page());
        expect(map.once).toHaveBeenCalledOnce();
        expect(map.triggerRepaint).toHaveBeenCalledOnce();
    });

    for (const map of [undefined, {}, { once: () => {} }, { triggerRepaint: () => {} }]) {
        it('refuses a missing or incomplete chart instead of manufacturing readiness', async () => {
            vi.stubGlobal('window', { __thalassaMap: map });
            await expect(waitForChartCaptureReady(page())).rejects.toThrow('A real chart is required');
        });
    }

    it('propagates native repaint failure without resolving or retrying', async () => {
        const repaint = vi.fn(() => {
            throw new Error('Native repaint refused');
        });
        vi.stubGlobal('window', { __thalassaMap: { once: vi.fn(), triggerRepaint: repaint } });
        await expect(waitForChartCaptureReady(page())).rejects.toThrow('Native repaint refused');
        expect(repaint).toHaveBeenCalledOnce();
    });

    for (const failedFrame of [1, 2]) {
        it(`propagates frame ${failedFrame} scheduling failure without declaring readiness`, async () => {
            const failure = new Error('Browser frame scheduling refused');
            let idle!: () => void;
            let calls = 0;
            vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
                if (++calls === failedFrame) throw failure;
                queueMicrotask(() => callback(0));
                return calls;
            });
            vi.stubGlobal('window', {
                __thalassaMap: {
                    once: (_event: string, callback: () => void) => {
                        idle = callback;
                    },
                    triggerRepaint: vi.fn(),
                },
            });
            const ready = waitForChartCaptureReady(page());
            idle();
            await expect(ready).rejects.toBe(failure);
            expect(calls).toBe(failedFrame);
        });
    }
});
