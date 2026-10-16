import { test, expect } from '@playwright/test';
import { message, concatenate, pair } from '../tests/fixtures/grib1Fixtures';
import { grib2Pair } from '../tests/fixtures/grib2ImportFixtures';
import { decodeGrib1File } from '../services/weather/decodeGrib1Wind';
import type { ImportedGribFile } from '../services/weather/gribImportTypes';
test.beforeEach(async ({ page }) => {
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto('/e2e/fixtures/grib-import.html');
    await page.waitForFunction(() => !!(window as unknown as { __gribImport: unknown }).__gribImport);
});
test('both editions decode in a disposable real Worker, transfer ownership, and allow cancellation', async ({
    page,
}) => {
    for (const [edition, buffer] of [
        [1, pair({ width: 300, rows: 300, dx: 0.1, dy: 0.1, south: -20, values: Array(90000).fill(3) })],
        [2, grib2Pair()],
    ] as const) {
        const result = await page.evaluate(
            async (bytes) =>
                await (
                    window as unknown as { __gribImport: { decode: (b: number[]) => Promise<unknown> } }
                ).__gribImport.decode(bytes),
            [...new Uint8Array(buffer)],
        );
        expect(result).toMatchObject({ edition, transferred: true });
        expect((result as { beats: number }).beats).toBeGreaterThan(0);
    }
    const cancelled = await page.evaluate(
        async (bytes) =>
            await (
                window as unknown as { __gribImport: { cancel: (b: number[]) => Promise<string> } }
            ).__gribImport.cancel(bytes),
        [...new Uint8Array(pair())],
    );
    expect(cancelled).toBe('CANCELLED');
});
test('regional imported wind and pressure preserve transparent holes and the selected forecast clock', async ({
    page,
}) => {
    const known = Array(16).fill(3),
        mask = Array.from({ length: 16 }, (_, i) => i % 4 < 2);
    const file = decodeGrib1File(
        concatenate(
            message({ width: 4, rows: 4, values: known, bitmap: mask }),
            message({ width: 4, rows: 4, parameter: 34, values: known, bitmap: mask }),
            message({ width: 4, rows: 4, p1: 6, values: Array(16).fill(20) }),
            message({ width: 4, rows: 4, parameter: 34, p1: 6, values: Array(16).fill(20) }),
            message({
                width: 4,
                rows: 4,
                parameter: 2,
                level: 102,
                height: 0,
                reference: 100000,
                bits: 0,
                bitmap: mask,
            }),
        ),
    );
    const result = (await page.evaluate(
        async (file) =>
            await (
                window as unknown as { __gribImport: { render: (input: ImportedGribFile) => Promise<unknown> } }
            ).__gribImport.render(file),
        file,
    )) as {
        first: { known: number[]; boundary: number[]; missing: number[]; outside: number[]; error: number };
        second: { known: number[]; missing: number[]; error: number };
        middle: { missing: number[] };
        pressurePixels: number[][];
    };
    expect(result.first.error).toBe(0);
    expect(result.second.error).toBe(0);
    expect(result.first.known[3]).toBeGreaterThan(0);
    expect(result.first.missing[3]).toBe(0);
    expect(result.first.boundary[3]).toBe(0);
    expect(result.first.outside[3]).toBe(0);
    expect(result.second.missing[3]).toBeGreaterThan(0);
    expect(result.middle.missing[3]).toBe(0);
    expect(result.second.known[0]).toBeGreaterThan(result.first.known[0]);
    expect(result.pressurePixels.some((pixel) => pixel[3] > 0)).toBe(true);
    expect(result.pressurePixels.some((pixel) => pixel[3] === 0)).toBe(true);
});
test('the actual React overlay displays imported wind on a real Mapbox map without painting its unknown region', async ({
    page,
}) => {
    const values = Array(16).fill(5),
        bitmap = Array.from({ length: 16 }, (_, i) => i % 4 < 2);
    const file = decodeGrib1File(
        concatenate(
            message({ width: 4, rows: 4, values, bitmap }),
            message({ width: 4, rows: 4, parameter: 34, values, bitmap }),
        ),
    );
    const result = await page.evaluate(
        async (file) =>
            await (
                window as unknown as {
                    __gribImport: {
                        mapOverlay: (
                            file: ImportedGribFile,
                        ) => Promise<{ known: number[]; unknown: number[]; error: number; errors: string[] }>;
                    };
                }
            ).__gribImport.mapOverlay(file),
        file,
    );
    expect(result.errors).toEqual([]);
    expect(result.error).toBe(0);
    expect(result.unknown).toEqual([40, 100, 50, 255]);
    expect(result.known).not.toEqual(result.unknown);
});
