/**
 * The Vessel tab's running order, as Shane specified it (2026-08-30):
 *
 *   the 4 pinned buttons, then Diary + Scuttlebutt, then the Skipper Device
 *   card, then Passage Planning, then Boat Binder, then the menu headers.
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

/**
 * First occurrence of a marker that legitimately repeats — the menu headers
 * are several, and demanding uniqueness of them would be wrong rather than
 * strict. Still asserted present.
 */
function firstAt(marker: string): number {
    const i = source.indexOf(marker);
    expect(i, `layout anchor not found: ${marker}`).toBeGreaterThan(-1);
    return i;
}

/** The hub's scroll port, distinct from the Boat Binder screen's. */
const HUB_SCROLL = 'overflow-y-auto vessel-hub-no-scrollbar px-4 pt-4 stagger-in';

describe('Vessel tab running order', () => {
    it('puts the read-most screens first and the config cards after', () => {
        const scrollArea = at(HUB_SCROLL);
        const diary = at('aria-label="Open Diary"');
        const scuttlebutt = at('aria-label="Open Scuttlebutt"');
        // Not bare '<SkipperDeviceControl' — that also matches
        // React.FC<SkipperDeviceControlProps> where the component is defined.
        const skipper = at('<SkipperDeviceControl\n');
        const passage = at('label="Passage Planning"');
        const binder = at('BOAT BINDER — imports / inventory / reference');
        const firstHeader = firstAt('<SectionHeader');

        // Diary and Scuttlebutt lead the scrolling area...
        expect(scrollArea).toBeLessThan(diary);
        expect(diary).toBeLessThan(scuttlebutt);
        // ...ahead of the three cards that describe how the boat is set up...
        expect(scuttlebutt).toBeLessThan(skipper);
        expect(skipper).toBeLessThan(passage);
        expect(passage).toBeLessThan(binder);
        // ...and the collapsible menu headers come last.
        expect(binder).toBeLessThan(firstHeader);
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
