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
 * doesn't. Known, not covered here: a named mark that loses the declutter can
 * still print its name beside the survivor when there is room.
 *
 * Since build 125 (125-04) the shallowest danger wins ACROSS classes too: the
 * second half of this file (?layout=cross).
 */
type Placement = {
    marks: string[];
    names: string[];
    glyphs: Record<string, string>;
    markLayers: string[];
    painted: boolean;
};
type Palette = 'day' | 'night' | 'imagery' | 'bare';
type Fixture = {
    __encHazards: {
        ready: boolean;
        read(): Promise<Placement>;
        probe(tag: string): number[];
        setPalette(name: Palette): void;
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

/**
 * The shallowest danger wins ACROSS classes (build 125, 125-04, chart safety).
 *
 * A sort key orders one layer, and wrecks, rocks and obstructions used to be
 * three layers that Mapbox placed whole: every rock, then every wreck, then
 * every obstruction. So a 15 m rock took a 0.5 m dangerous wreck off the
 * chart, and a 9 m wreck took a 2 m obstruction. Now one layer with one depth
 * sort key draws all three, each class keeping its own INT1 glyph. The key is
 * stamped per mark in the merge: the charted depth read case-defensively;
 * without one, a mark that dries below 0, a danger of unknown depth at 0
 * (fail-safe), and foul ground or a non-dangerous wreck at 20.1 m, behind
 * every sounded danger; equal depths keep the rock, wreck, obstruction order
 * (125-04 review).
 *
 * Fictional marks on a fictional approach to Brittany (e2e/fixtures/
 * enc-hazard-labels.tsx, ?layout=cross), at every zoom band the chart draws
 * hazards (from z7, the mount's floor, up), and in every display state the
 * chart has (paper day chart, S-52 night dim, satellite imagery base, the
 * declutter slider at its last notch): placement must not move between them.
 */
const PALETTES: Palette[] = ['day', 'night', 'imagery', 'bare'];
const CROSS_WINNERS: Record<string, string> = {
    A2: 'sm-hazard-wreck-dangerous', // the 0.5 m wreck on the 15 m rock A1
    B2: 'sm-hazard-obstruction', // the 2 m obstruction on the 9 m wreck B1
    C2: 'sm-hazard-obstruction', // the unknown-depth obstruction on the 1 m rock C1
    D2: 'sm-hazard-wreck-dangerous', // the 0.5 m wreck under depthless foul ground D1
    E2: 'sm-hazard-rock', // the 1 m rock under a depthless non-dangerous wreck E1
    F2: 'sm-hazard-wreck-dangerous', // the 0.5 m wreck under a 20 m obstruction F1, lower-case names
    G2: 'sm-hazard-rock-drying', // the rock that covers and uncovers under an unknown obstruction G1
    H2: 'sm-hazard-rock-awash-cd', // the rock awash (VALSOU 0) under an unknown obstruction H1: a tie, rock first
    I2: 'sm-hazard-rock-awash-cd', // the rock awash, no depth, under depthless foul ground I1
    L1: 'sm-hazard-foul', // lone foul ground (CATOBS 7)
    L2: 'sm-hazard-wreck-mast', // lone wreck showing her mast (CATWRK 4)
    L3: 'sm-hazard-rock-awash-cd', // lone rock awash at chart datum (WATLEV 5)
};
/** Each pair's loser, by its winner: the mark that must NOT be placed. */
const CROSS_LOSERS: Record<string, string> = {
    A2: 'A1',
    B2: 'B1',
    C2: 'C1',
    D2: 'D1',
    E2: 'E1',
    F2: 'F1',
    G2: 'G1',
    H2: 'H1',
    I2: 'I1',
};

for (const zoom of [7, 10, 13, 16, 19]) {
    test(`z${zoom}: the shallowest danger wins across wrecks, rocks and obstructions, in every chart state`, async ({
        page,
    }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`/e2e/fixtures/enc-hazard-labels.html?layout=cross&z=${zoom}`);
        await page.waitForFunction(() => (window as unknown as Partial<Fixture>).__encHazards?.ready === true, null, {
            timeout: 30_000,
        });
        let day: Placement | null = null;
        for (const palette of PALETTES) {
            const seen = await page.evaluate(async (name) => {
                const fx = (window as unknown as Fixture).__encHazards;
                fx.setPalette(name);
                return fx.read();
            }, palette);
            testInfo.annotations.push({ type: `placed ${palette}`, description: JSON.stringify(seen) });
            if (process.env.ENC_HAZARD_SHOT) {
                console.info(`cross z${zoom} ${palette}:`, JSON.stringify(seen));
                await page.screenshot({
                    path: process.env.ENC_HAZARD_SHOT.replace(/\.png$/, `-cross-z${zoom}-${palette}.png`),
                });
            }

            // One layer draws every hazard mark.
            expect(seen.markLayers, 'symbol layers drawing hazard marks').toHaveLength(1);
            // The 0.5 m wreck beats the 15 m rock; the 2 m obstruction beats the 9 m wreck.
            expect(seen.marks, `${palette}: A2, the 0.5 m wreck`).toContain('A2');
            expect(seen.marks, `${palette}: A1, the 15 m rock under it`).not.toContain('A1');
            expect(seen.marks, `${palette}: B2, the 2 m obstruction`).toContain('B2');
            expect(seen.marks, `${palette}: B1, the 9 m wreck under it`).not.toContain('B1');
            // Unknown depth sorts as 0, the most dangerous (fail-safe).
            expect(seen.marks, `${palette}: C2, the obstruction of unknown depth`).toContain('C2');
            expect(seen.marks, `${palette}: C1, the 1 m rock under it`).not.toContain('C1');
            // But a mark the chart calls non-dangerous, with no depth, never
            // takes the space from a danger (D, E, I); a lower-case cell sorts
            // by its depths too (F); and a rock that dries, or ties at 0, keeps
            // the rock's old priority over an unknown obstruction (G, H).
            for (const [winner, loser] of Object.entries(CROSS_LOSERS)) {
                expect(seen.marks, `${palette}: ${winner} must draw`).toContain(winner);
                expect(seen.marks, `${palette}: ${loser} must give way to ${winner}`).not.toContain(loser);
            }
            expect(seen.marks).toEqual(Object.keys(CROSS_WINNERS).sort());
            // Each class keeps its own glyph in the one layer.
            expect(seen.glyphs).toEqual(CROSS_WINNERS);
            // And nothing moves between the chart's display states.
            if (day) expect(seen.marks, `${palette} places what day places`).toEqual(day.marks);
            else day = seen;

            if (seen.painted) {
                for (const tag of Object.keys(CROSS_LOSERS)) {
                    const px = await page.evaluate((t) => (window as unknown as Fixture).__encHazards.probe(t), tag);
                    expect(isMagenta(px), `${palette}: ${tag} is drawn (pixel ${px})`).toBe(true);
                }
            }
        }
        testInfo.annotations.push({
            type: 'pixels',
            description: day?.painted ? 'rendered' : 'canvas not painted (no token)',
        });
        expect(errors).toEqual([]);
    });
}
