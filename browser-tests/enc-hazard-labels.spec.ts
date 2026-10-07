import { expect, test } from '@playwright/test';

/**
 * A hazard's NAME can never take a hazard MARK off the chart (build 123,
 * package HM, the follow-up to W1-FX). Fictional marks on a real Mapbox map
 * (e2e/fixtures/enc-hazard-labels.tsx): the plotting chart with the declutter
 * slider at 0, at z13 (where the names first show), z14 and z16.
 *
 * Wrecks, rocks and obstructions share one source (enc-vec-points) with their
 * name labels, and every chart map (the main chart and the auto-route trial
 * map) runs with crossSourceCollisions off, so they share one collision graph;
 * Mapbox places the higher layer first. The names used
 * to sit topmost, so a named wreck's name was placed before the marks and
 * culled an unnamed rock beside it: the skipper saw a name and no rock.
 * Measured before the fix (2026-10-08, both engines, every zoom): it culled
 * the wreck's own symbol too, so of the six marks that should draw here only
 * R2, the one rock with no name near it, was left.
 *
 * When the deeper of two touching rocks was named too, its name took the
 * shallow rock with it and neither drew.
 *
 * What stays (Shane 2026-08-07): danger symbols still declutter among
 * themselves, the shallower of two touching rocks surviving, and names still
 * give way to each other. A name prints when it has room and drops when it
 * doesn't. Known, not covered here: the shallowest-wins sort works within one
 * class only (Mapbox places all rocks, then wrecks, then obstructions), and a
 * named mark that loses the declutter can still print its name beside the
 * survivor when there is room.
 */
type Placement = { marks: string[]; names: string[]; painted: boolean };
type Fixture = {
    __encHazards: {
        ready: boolean;
        read(): Promise<Placement>;
        probe(tag: string): number[];
    };
};

// IHO hazard magenta over the fixture's pale water: red and blue strong, green low.
const isMagenta = ([r, g, b]: number[]) => r > 150 && b > 110 && g < r - 60;

for (const zoom of [13, 14, 16]) {
    test(`z${zoom}: a hazard’s name never takes a wreck, rock or obstruction off the chart`, async ({
        page,
    }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`/e2e/fixtures/enc-hazard-labels.html?z=${zoom}`);
        await page.waitForFunction(() => (window as unknown as Partial<Fixture>).__encHazards?.ready === true, null, {
            timeout: 30_000,
        });
        const seen = await page.evaluate(() => (window as unknown as Fixture).__encHazards.read());
        testInfo.annotations.push({ type: 'placed', description: JSON.stringify(seen) });
        if (process.env.ENC_HAZARD_SHOT) {
            console.info('placed:', JSON.stringify(seen));
            await page.screenshot({ path: process.env.ENC_HAZARD_SHOT.replace(/\.png$/, `-z${zoom}.png`) });
        }

        // The rock under the wreck's name draws, and so does the obstruction under
        // the named rock's: no name ever costs a mark.
        expect(seen.marks, 'R1, the rock where the wreck’s name would print').toContain('R1');
        expect(seen.marks, 'O1, the obstruction where the rock’s name would print').toContain('O1');
        // The named marks draw too.
        expect(seen.marks).toEqual(expect.arrayContaining(['W1', 'W2', 'R4']));
        // Danger symbols still declutter among themselves, shallowest surviving:
        // of the two rocks on top of each other only the 2 m one draws.
        expect(seen.marks, 'R2, the 2 m rock').toContain('R2');
        expect(seen.marks, 'R3, the 9 m rock under it').not.toContain('R3');
        // And when the deeper rock is named, its name does not take the 2 m
        // rock with it.
        expect(seen.marks, 'R6, the 2 m rock on the named 9 m one').toContain('R6');
        expect(seen.marks, 'R5, the named 9 m rock under it').not.toContain('R5');
        expect(seen.marks).toEqual(['O1', 'R1', 'R2', 'R4', 'R6', 'W1', 'W2']);

        // A name prints where it has room and gives way where a mark is.
        expect(seen.names, 'the lone wreck keeps its name').toEqual(['W2']);

        // And the pixels, when this map is allowed to paint.
        testInfo.annotations.push({
            type: 'pixels',
            description: seen.painted ? 'rendered' : 'canvas not painted (no token)',
        });
        if (seen.painted) {
            for (const tag of ['R1', 'O1', 'R2', 'W1', 'W2', 'R4', 'R6']) {
                const px = await page.evaluate((t) => (window as unknown as Fixture).__encHazards.probe(t), tag);
                expect(isMagenta(px), `${tag} is drawn (pixel ${px})`).toBe(true);
            }
        }
        expect(errors).toEqual([]);
    });
}
