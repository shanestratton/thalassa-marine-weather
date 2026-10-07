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
        expect(nmea).toMatch(/className="fixed left-0 right-0 z-800 px-4 \[@media\(max-height:700px\)\]:hidden"/);
        // Under the nav, over the page.
        expect(app).toMatch(/className="fixed bottom-0 left-0 right-0 z-900/);
    });

    it('flows after Connect on short screens instead of covering it (UX scorecard run 7)', () => {
        // At 375×667 the pinned bar hid Connect and the foot of Host IP / Port.
        // Below 700 px tall the pinned copy hides and an in-flow copy shows,
        // after the connection card.
        expect(nmea).toContain('<div className="mb-3 hidden [@media(max-height:700px)]:block">');
        expect(nmea.indexOf('hidden [@media(max-height:700px)]:block')).toBeGreaterThan(
            nmea.indexOf('aria-label="Connect NMEA"'),
        );
        expect(nmea.match(/<InstrumentPanelButton quiet=\{connectShowing\}/g)).toHaveLength(2);
    });

    it('is the quiet button while Connect is the next step, so one primary shows', () => {
        expect(nmea).toContain('const connectShowing = !showConnected && !showConnecting && !rolledUp;');
        expect(nmea).toMatch(/variant="primary"\s+onClick=\{handleConnect\}\s+aria-label="Connect NMEA"/);
    });

    it('sits 8px above the top of the menu, derived from the nav itself', () => {
        expect(nmea).toMatch(/bottom: 'calc\(4rem \+ env\(safe-area-inset-bottom\) \+ 8px\)'/);
        // The nav really is 4rem tall plus the inset — if either changes, this
        // test fails rather than the button quietly drifting off the gap.
        expect(app).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
        expect(app).toMatch(/className="flex justify-around items-center h-16/);
    });

    it('the scroller clears the pinned button, so no card hides behind it', () => {
        // Nav + inset + the 8px gap + the button's own height + 12px (UX
        // scorecard run 6), with the button's height named once and shared.
        // The gap + button is a reserve that drops to zero on short screens,
        // where the button is in the flow (UX scorecard run 7).
        expect(nmea).toContain('const CTA_HEIGHT_PX = 52;');
        expect(nmea).toContain(
            "const CTA_RESERVE_CLASS = '[--nmea-cta-reserve:60px] [@media(max-height:700px)]:[--nmea-cta-reserve:0px]'; // 60 = 8 + CTA_HEIGHT_PX",
        );
        expect(nmea).toMatch(
            /paddingBottom:\s+'calc\(4rem \+ env\(safe-area-inset-bottom\) \+ var\(--nmea-cta-reserve, 0px\) \+ 12px\)'/,
        );
        expect(nmea).toContain('style={{ minHeight: CTA_HEIGHT_PX }}');
    });
});
