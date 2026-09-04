/**
 * The Position page, and the invariant that makes the dot rail honest.
 *
 * Shane 2026-08-30: "we need a dedicated page to the gps coords ... just a nice
 * page with a heading that says Position, and then the LAT, LONG, in nice big
 * beautiful green lettering."
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

/** The rendered snap sections, in document order. */
function renderedSections(): string[] {
    // Allow a trailing parenthetical: the sail-plan marker carries one
    // ("SAIL PLAN (Serene Summer only ...)"), and a stricter pattern silently
    // matched nothing there rather than failing loudly.
    return [...source.matchAll(/── SECTION: ([^─]+?)──/g)].map((m) => m[1].split('(')[0].trim());
}

/** The dot rail's names, in the order it will jump to them. */
function railNames(): string[] {
    const line = source.match(/const base = \[([^\]]+)\]/);
    expect(line, 'dot rail name list not found').not.toBeNull();
    const base = [...(line as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Serene Summer alone gets the sail plan, appended last.
    return [...base, 'Sail Plan'];
}

describe('the dot rail matches the sections it jumps to', () => {
    it('lists every section, in the same order', () => {
        // The rail computes its index as scrollTop / clientHeight, so a name
        // missing or out of order here does not merely lose a dot — it points
        // every dot after it at the wrong instrument.
        const sections = renderedSections();
        const rail = railNames().map((n) => n.toUpperCase());
        expect(sections.map((s) => s.toUpperCase())).toEqual(rail);
    });

    it('opens on the Clock, then keeps Wind → Barometer → Position together near the top', () => {
        // Position was second from 2026-08-30. Shane moved the Barometer into
        // that slot on 2026-09-02 — "move the barometer from the bottom of the
        // instrument panel to the next one after the wind claude. it is that
        // banging" — and on 2026-09-04 asked for the ship's bell clock and its
        // bells to lead the panel: "all of this needs to be first in the
        // instrument panel".
        //
        // So the exact indices moved again, and pinning them was never the
        // point. The invariant that survives all three changes is the one the
        // earlier version of this test spelled out: the instruments a skipper
        // reaches for in a hurry stay within a few swipes of the top, and the
        // Barometer stays immediately behind Wind where he put it.
        const sections = renderedSections();
        expect(sections[0]).toBe('CLOCK');
        expect(sections[1]).toBe('BELLS');
        const wind = sections.indexOf('WIND');
        expect(sections[wind + 1]).toBe('BAROMETER');
        expect(sections.slice(0, 5)).toContain('POSITION');
    });
});

describe('the Position page', () => {
    const page = source.slice(source.indexOf('── SECTION: POSITION ──'), source.indexOf('── SECTION: SPEED ──'));

    it('shows latitude and longitude on their own lines', () => {
        expect(page).toContain('data-testid={`position-${label.toLowerCase()}`}');
        expect(page).toContain("['Latitude', formatLatitude(latitude.value)]");
        expect(page).toContain("['Longitude', formatLongitude(longitude.value)]");
    });

    it('renders them big and green', () => {
        expect(page).toContain('text-emerald-400');
        expect(page).toMatch(/fontSize: 'clamp\(/);
    });

    it('shows a dash rather than zeros when there is no fix', () => {
        // 0°0.000′N is a real place in the Gulf of Guinea. A confident green
        // reading of it is the worst thing this page could do.
        expect(page).toContain('— no fix —');
        expect(page).toContain('formatFix(latitude.value, longitude.value) ?');
    });

    it('admits when the fix is not live', () => {
        expect(page).toContain("latitude.freshness !== 'live'");
        expect(page).toContain('Last known — not live');
    });
});

describe('one position format, two readouts', () => {
    it('builds the combined fix from the same halves the Position page uses', () => {
        // Two formatters would eventually disagree by a decimal place, and a
        // position that reads differently on two screens of one app is a
        // position you cannot trust.
        expect(source).toContain('const a = formatLatitude(lat);');
        expect(source).toContain('const b = formatLongitude(lon);');
    });
});
