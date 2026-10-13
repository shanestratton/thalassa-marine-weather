/**
 * The Vessel tab's running order, as Shane specified it (2026-08-30):
 *
 *   the 4 pinned buttons, then Diary + Scuttlebutt, then the Skipper Device
 *   card, then the menu.
 *
 * and the menu as one box, most used first (Shane 2026-10-04: "one box around
 * crew and float plan, boat binder, settings, nmea gateway, boat network, and
 * music ... order them in a better order from most used to least"): Crew &
 * Float Plan, Boat Binder, NMEA Gateway, Music, Settings, Boat Network. Crew &
 * Float Plan is a card of its own above the box since 2026-10-13 (Shane: "the
 * crew and float plan, really needs its own card"); the order is unchanged.
 *
 * Pinned as a test because the order is a judgement about what a skipper
 * reaches for most, and nothing else in the file records it — a later edit
 * that moves a block would otherwise silently undo the decision.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/VesselHub.tsx', 'utf8');

/**
 * Where a marker appears in the file.
 *
 * Asserted present AND unique: `overflow-y-auto vessel-hub-no-scrollbar` also
 * matches the Boat Binder's own screen higher up the file, so the first draft
 * of this test compared the hub's card order against the wrong element and
 * passed for the wrong reason. An ambiguous anchor is worse than a missing one.
 */
function at(marker: string): number {
    const first = source.indexOf(marker);
    expect(first, `layout anchor not found: ${marker}`).toBeGreaterThan(-1);
    expect(source.indexOf(marker, first + 1), `layout anchor is ambiguous: ${marker}`).toBe(-1);
    return first;
}

/** The hub's scroll port, distinct from the Boat Binder screen's. */
const HUB_SCROLL = 'overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 stagger-in';

describe('Vessel tab running order', () => {
    it('puts the read-most screens first and the config cards after', () => {
        const scrollArea = at(HUB_SCROLL);
        const diary = at('aria-label="Open Diary"');
        const scuttlebutt = at('aria-label="Open Scuttlebutt"');
        // Not bare '<SkipperDeviceControl' — that also matches
        // React.FC<SkipperDeviceControlProps> where the component is defined.
        const skipper = at('<SkipperDeviceControl\n');
        const menus = at('data-testid="vessel-hub-menus"');
        const crew = at('data-testid="vessel-hub-crew"');
        const menu = at('data-testid="vessel-hub-menu"');
        // Most used first. "Crew & Float Plan" was "Passage Planning" (glossary,
        // UX scorecard run 6).
        const rows = ['Crew & Float Plan', 'Boat Binder', 'NMEA Gateway', 'Music', 'Settings', 'Boat Network'].map(
            (label) => at(`label="${label}"`),
        );

        // Diary and Scuttlebutt lead the scrolling area...
        expect(scrollArea).toBeLessThan(diary);
        expect(diary).toBeLessThan(scuttlebutt);
        // ...ahead of the card that says who speaks for the boat...
        expect(scuttlebutt).toBeLessThan(skipper);
        // ...and the menu comes last: Crew & Float Plan's own card, then the
        // box, its rows in the decided order.
        expect(skipper).toBeLessThan(menus);
        expect(menus).toBeLessThan(crew);
        expect(crew).toBeLessThan(rows[0]);
        expect(rows[0]).toBeLessThan(menu);
        expect(menu).toBeLessThan(rows[1]);
        for (let i = 1; i < rows.length; i++) expect(rows[i - 1]).toBeLessThan(rows[i]);
        // Nothing is folded behind a header any more.
        expect(source.indexOf('<SectionHeader')).toBe(-1);
    });

    it('leaves the 4 watch tiles pinned above the scrolling area', () => {
        // Anchor, Guardian, MOB and Radio are safety controls and were
        // deliberately locked to the screen (Shane 2026-07-19: "can we have it
        // so the Watch Status items are always on the screen ... as they are
        // quite important"). Reordering the cards below must never drag them
        // into the scroll port.
        expect(at('PINNED TO THE SCREEN')).toBeLessThan(at(HUB_SCROLL));
    });
});
