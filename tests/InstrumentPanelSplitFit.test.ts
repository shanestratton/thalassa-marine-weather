/**
 * The Instrument Panel in the tablet split (Shane 2026-10-02, on his iPad at
 * 1080x810: "the instrument panel items, are not fitting in the screen when
 * in split mode. they are about 1.5 lines too big").
 *
 * Measured in the browser at 1080x810, 1180x820 and 1366x1024: no instrument
 * overflowed its own page. Every page but the last stopped 17 px short of the
 * pane's foot, so the NEXT plate's heading ("Barometer · 3 of 9") sat in those
 * 17 px and the frame edge cut it through its letters. On the phone the same
 * page stops 24 px above the tab bar and the heading shows whole: that is the
 * deliberate peek (UX scorecard run 7). A pane has no tab bar to tuck the rest
 * under. App stretches the page 4.5rem + the bottom inset past the frame, and
 * the frame clips it. So in a pane each page fills exactly what the pane shows.
 *
 * Layout cannot be measured in jsdom; these pin the wiring, the way the other
 * Instrument Panel suites do. The measurements live in the report for this fix.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const app = read('App.tsx');
const panel = read('components/nmea/TheGlassPage.tsx');

describe('Instrument Panel in a split pane', () => {
    it('App says how far the right pane page hangs below its frame, and stretches it by exactly that', () => {
        expect(app).toMatch(/'--split-page-overhang':\s*'calc\(4\.5rem \+ env\(safe-area-inset-bottom\)\)'/);
        expect(app).toContain("height: 'calc(100% + var(--split-page-overhang))'");
        // The old literal is gone, so the stretch and the figure pages subtract
        // cannot drift apart.
        expect(app).not.toContain("height: 'calc(100% + 4.5rem + env(safe-area-inset-bottom))'");
    });

    it('in a pane, every page but the last fills what the pane shows, with no clipped peek', () => {
        expect(panel).toContain("import { usePaneScope } from '../../context/PanePortalContext';");
        expect(panel).toContain(
            "const paneSnapFit = inPane ? '[&>section:not(:last-child)]:h-[calc(100%_-_var(--split-page-overhang,0px))]' : '';",
        );
        expect(panel).toContain('const inPane = usePaneScope() !== null;');
        // On the snap scroller itself, so it reaches every page but Helm,
        // which stays full height with its own bottom clearance.
        expect(panel).toContain(
            '<div className={`h-full overflow-y-auto snap-y snap-mandatory no-scrollbar ${paneSnapFit}`}>',
        );
    });

    it('the barometer dial gives up height before the words do', () => {
        // The fullest Barometer page (this device's barometer, so the amber
        // warning shows, and a "falling very rapidly" pill and sentence) fitted
        // Shane's 1080x810 pane by 5 px with a fixed 300 px dial, and was cut
        // 43 px at 1133x744 and 15 px at 1024x768. The dial now sits in a box
        // that is the only thing on the page allowed to shrink, and the dial
        // is never wider than that box is tall, so the text always fits.
        const barometer = panel.slice(
            panel.indexOf('── SECTION: BAROMETER ──'),
            panel.indexOf('── SECTION: POSITION ──'),
        );
        expect(barometer).toContain('<div className="min-h-0 flex flex-col text-center">');
        expect(barometer).toContain('<div className="min-h-0 flex-[0_1_300px] [container-type:size]">');
        expect(barometer).toContain('<div className="mx-auto w-[min(100%,100cqh)]">');
        // The words under the dial keep their own block, so the pill still sits
        // on a line the way it did and the phone page lays out as before.
        expect(barometer.indexOf('flex-[0_1_300px]')).toBeLessThan(barometer.indexOf('<BarometerGauge'));
        expect(barometer.indexOf('<BarometerGauge')).toBeLessThan(barometer.indexOf("'Boat sensor'"));
    });

    it('the phone keeps its peek: the pages still stop 24 px above the tab bar', () => {
        expect(panel).toContain("const sectionHeight = 'h-[calc(100%_-_var(--thalassa-tabbar-height)_-_24px)]';");
        const sections = [...panel.matchAll(/<section\b[\s\S]*?<\/section>/g)].map(([section]) => section);
        for (const section of sections.slice(0, -1)) expect(section).toContain('w-full ${sectionHeight} snap-start');
        expect(sections.at(-1)).toContain('w-full h-full snap-start snap-always');
    });
});
