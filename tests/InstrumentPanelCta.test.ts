/**
 * The Instrument Panel CTA sits above the menu, not at the end of a scroll.
 *
 * Shane 2026-09-04: "put the Instrument CTA Button at the bottom of the
 * screen, exactly 8px above the top of the menu section". It used to be the
 * last child of the page's scroller, so the way into the Instrument Panel only
 * appeared after scrolling past every gateway setting — the one control on
 * that page a skipper wants mid-passage was the hardest to reach.
 *
 * The 8px is DERIVED from the nav rather than measured by eye: the tab bar is
 * `h-16` plus the safe-area inset (App.tsx), so the offset must name both. A
 * hard-coded "72px" would be right on one phone and wrong on every notched
 * one, and would silently drift if the nav ever changed height.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nmea = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');
const app = readFileSync('App.tsx', 'utf8');

describe('the Instrument Panel CTA', () => {
    it('is pinned, not the tail of the scroller', () => {
        expect(nmea).toMatch(/className="fixed left-0 right-0 z-800 px-4"/);
        // Under the nav, over the page.
        expect(app).toMatch(/className="fixed bottom-0 left-0 right-0 z-900/);
    });

    it('sits 8px above the top of the menu, derived from the nav itself', () => {
        expect(nmea).toMatch(/bottom: 'calc\(4rem \+ env\(safe-area-inset-bottom\) \+ 8px\)'/);
        // The nav really is 4rem tall plus the inset — if either changes, this
        // test fails rather than the button quietly drifting off the gap.
        expect(app).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
        expect(app).toMatch(/className="flex justify-around items-center h-16/);
    });

    it('the scroller clears the pinned button, so no card hides behind it', () => {
        expect(nmea).toMatch(/paddingBottom: 'calc\(4rem \+ env\(safe-area-inset-bottom\) \+ 68px\)'/);
    });
});
