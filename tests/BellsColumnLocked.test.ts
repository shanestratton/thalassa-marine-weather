/**
 * The Bells column must not move. It already said `sticky left-0` and moved
 * anyway — because the table was `border-collapse: collapse`.
 *
 * WebKit does not honour `position: sticky` on a table cell inside a
 * border-collapsed table. The cell scrolls away with the rest of the row, so
 * the class was there, looked right, and did nothing on the only platform this
 * ships to (Shane 2026-09-05: "make sure that the Bells Column in the bells
 * section of the instrument panel is locked and does not move at all").
 *
 * The knock-on is the reason this is worth a test rather than a one-line
 * change: under `border-separate`, a border on a <tr> is not rendered AT ALL.
 * Switching the table without moving the row rules onto the cells silently
 * deletes every horizontal line in the table.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('components/nmea/gauges/ShipsBellReference.tsx', 'utf8');

describe('the bells table Bells column', () => {
    it('is sticky in a table where sticky actually works', () => {
        const table = src.slice(src.indexOf('<table'), src.indexOf('</table>'));
        expect(table).toContain('border-separate');
        expect(table).toContain('border-spacing-0');
        // The bug, by name: sticky cells silently stop sticking under this.
        expect(table).not.toMatch(/\bborder-collapse\b/);
    });

    it('keeps both header and body cells of that column pinned', () => {
        const table = src.slice(src.indexOf('<table'), src.indexOf('</table>'));
        const sticky = table.match(/sticky left-0/g) ?? [];
        // One in <thead> ("Bells"), one per body row (the bell-pattern <th>).
        expect(sticky.length).toBe(2);
        // Opaque, or the scrolling columns show through the pinned one.
        expect(table).toMatch(/sticky left-0 z-\d+ [^"]*bg-slate-900/);
    });

    it('draws its row rules on cells, not on <tr>, or they vanish', () => {
        const table = src.slice(src.indexOf('<table'), src.indexOf('</table>'));
        const tbody = table.slice(table.indexOf('<tbody'));
        expect(tbody).not.toMatch(/<tr[^>]*className="[^"]*border-t/);
        // Every scrolling cell and the pinned one both carry the rule, so the
        // line runs unbroken across the pinned boundary.
        expect(tbody).toMatch(/<th className="sticky left-0[^"]*border-t/);
        expect(tbody).toMatch(/className=\{`border-t border-white\/\[0\.05\] px-2/);
    });

    it('marks the pinned edge so content scrolling under it reads as underneath', () => {
        const table = src.slice(src.indexOf('<table'), src.indexOf('</table>'));
        expect(table).toMatch(/sticky left-0[^"]*border-r/);
    });
});
