import { expect, test } from '@playwright/test';

/**
 * Scale-ordered chart drawing, on a real Mapbox map (item f, Shane
 * 2026-10-02: "we should overlay the charts the other way so the water is
 * drawn over the land"). Synthetic cells (e2e/fixtures/enc-scale-order.tsx):
 * a 1:3,500,000 overview whose coarse land blob covers a harbour the
 * 1:90,000 chart charts 10–15 m deep, and a 1:90,000 island in the overview's
 * water.
 *
 * The topmost area fill at each spot comes from Mapbox's own rendered-feature
 * query, in the order it draws — that needs no pixels, so it holds anywhere.
 * The pixels are read too when the canvas renders (Mapbox paints only for an
 * authenticated map: the dev server's own token), and ENC_SCALE_SHOT keeps
 * the render — the before/after evidence.
 */
type Fixture = {
    __encScale: {
        ready: boolean;
        stack: string[];
        top(lon: number, lat: number): { layer: string; cell: string } | null;
        probe(lon: number, lat: number): number[];
    };
};

const SPOTS = {
    harbour: [10.99, 11.015], // overview land + the detailed chart's 10–15 m
    overviewOnlyLand: [10.92, 11.06], // overview land, no detailed chart there
    island: [11.11, 11.01], // the detailed island, in the overview's water
    detailedSea: [11.08, 10.99],
    overviewSea: [11.0, 10.92],
} as const;

// The chart's water ramp runs pale blue to white (blue the strongest
// channel); its land is the tan #d6c590 (blue well under red).
const isWater = ([r, g, b]: number[]) => b > 200 && b >= r && b >= g;
const isLand = ([r, , b]: number[]) => r > 150 && b < r - 30;

test('a detailed chart’s water draws over an overview’s land, and its island over the overview’s water', async ({
    page,
}, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/fixtures/enc-scale-order.html');
    await page.waitForFunction(() => (window as unknown as Fixture).__encScale?.ready === true, null, {
        timeout: 30_000,
    });
    await page.screenshot({ path: process.env.ENC_SCALE_SHOT || testInfo.outputPath('enc-scale-order.png') });

    const at = (name: keyof typeof SPOTS) =>
        page.evaluate(([lon, lat]) => {
            const f = (window as unknown as Fixture).__encScale;
            return { top: f.top(lon, lat), px: f.probe(lon, lat) };
        }, SPOTS[name]);
    const seen = {
        harbour: await at('harbour'),
        overviewOnlyLand: await at('overviewOnlyLand'),
        island: await at('island'),
        detailedSea: await at('detailedSea'),
        overviewSea: await at('overviewSea'),
    };
    const stack = await page.evaluate(() => (window as unknown as Fixture).__encScale.stack);
    testInfo.annotations.push({ type: 'enc stack', description: stack.join(' < ') });
    testInfo.annotations.push({ type: 'seen', description: JSON.stringify(seen) });
    if (process.env.ENC_SCALE_SHOT) console.info('seen:', JSON.stringify(seen));

    // What Mapbox draws on top at each spot.
    expect(seen.harbour.top, 'Cid Harbour: the detailed chart’s water is on top').toEqual({
        layer: 'enc-vec-depare-t5-fill',
        cell: 'DETAILED',
    });
    expect(seen.island.top, 'the detailed island is on top of the overview’s water').toEqual({
        layer: 'enc-vec-lndare-t5-fill',
        cell: 'DETAILED',
    });
    expect(seen.overviewOnlyLand.top, 'outside the detailed chart the overview’s land still draws').toEqual({
        layer: 'enc-vec-lndare-fill',
        cell: 'OVERVIEW',
    });
    expect(seen.detailedSea.top?.cell).toBe('DETAILED');
    expect(seen.overviewSea.top).toEqual({ layer: 'enc-vec-depare-fill', cell: 'OVERVIEW' });

    // And the pixels, when this map is allowed to paint.
    const painted = seen.overviewSea.px[3] > 0;
    testInfo.annotations.push({ type: 'pixels', description: painted ? 'rendered' : 'canvas not painted (no token)' });
    if (painted) {
        expect(isWater(seen.harbour.px), `harbour pixel ${seen.harbour.px}`).toBe(true);
        expect(isLand(seen.island.px), `island pixel ${seen.island.px}`).toBe(true);
        expect(isLand(seen.overviewOnlyLand.px), `overview land pixel ${seen.overviewOnlyLand.px}`).toBe(true);
        expect(isWater(seen.detailedSea.px)).toBe(true);
        expect(isWater(seen.overviewSea.px)).toBe(true);
    }
    expect(errors).toEqual([]);
});
