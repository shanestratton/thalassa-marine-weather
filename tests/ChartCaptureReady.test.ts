import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { waitForChartCaptureReady } from '../browser-tests/helpers/chartCaptureReady';

afterEach(() => vi.unstubAllGlobals());

const page = () => ({ evaluate: vi.fn(async (callback: () => Promise<void>) => callback()) }) as unknown as Page;

describe('paired chart capture readiness', () => {
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
});
