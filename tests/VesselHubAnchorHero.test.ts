/**
 * At anchor the hero card stands down — but never during a drag alarm.
 *
 * Shane 2026-09-04: "when we are at anchor, can we remove the card the says at
 * anchor on the vessel home page". It was repeating the Anchor tile below it,
 * so the tile took over — and took the swing arc with it.
 *
 * THE ARC HAS SINCE COME OFF THE TILE TOO (2026-09-05), and that is a real
 * loss worth writing down rather than glossing: with the hero card hidden at
 * anchor, the swing arc is no longer anywhere on the Vessel page during a
 * normal watch. It is one tap away on the Anchor screen, which the tile links
 * to, and it returns on the hero card during a drag alarm.
 *
 * The reason is that it cost more than it gave HERE. Four tiles share one grid
 * row, so all of them are as tall as the tallest: the arc plus a fourth "0m of
 * 35m" line made the deck grow the moment the anchor went down and shrink when
 * it came up (Shane: "when the anchor is down, can we not allow the anchor card
 * to grow. as it is buggering up the page"). A quarter-width tile is the wrong
 * place for a picture.
 *
 * The exception is the whole point of the card: a DRAG ALARM is the moment it
 * exists for. Hiding it then would remove the loudest thing on the page at the
 * one time it matters, so that path is pinned here rather than left to
 * whoever next tidies this component.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const hub = readFileSync('components/VesselHub.tsx', 'utf8');

/**
 * The four safety tiles, comments removed.
 *
 * Bounded STRUCTURALLY — from the group's testid to the end of the last tile
 * (Anchor) — not by a nearby comment. The first version of this sliced to the
 * string "Weather Window", which lives in a comment; strip the comments and
 * the anchor vanished, the slice ran to the end of the file, and the test
 * failed on a `truncate` belonging to a vessel-name label two hundred lines
 * away.
 */
function safetyDeck(hub: string): string {
    const bare = hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const start = bare.indexOf('data-testid="vessel-safety-controls"');
    expect(start, 'the safety deck must be findable').toBeGreaterThan(-1);
    const lastTile = bare.indexOf('aria-label="Anchor Watch"', start);
    expect(lastTile, 'the Anchor tile closes the deck').toBeGreaterThan(start);
    const end = bare.indexOf('</button>', lastTile);
    return bare.slice(start, end);
}

describe('the Vessel hero card at anchor', () => {
    it('stands down when armed, and ONLY when armed', () => {
        expect(hub).toMatch(/if \(anchorStatus === 'armed'\) return null;/);
        // Never on the alarm branch: 'alarm' must not short-circuit the card.
        expect(hub).not.toMatch(/if \(anchorStatus === 'alarm'\) return null;/);
        expect(hub).not.toMatch(/if \(anchorStatus !== 'disarmed'\) return null;/);
    });

    it('the drag alarm still reaches the hero card', () => {
        // deriveVoyageState answers 'Drag Alarm' before anything else, and the
        // card keeps its alarm styling — so the early return above must sit
        // AFTER the alarm has had its chance to render.
        expect(hub).toMatch(/if \(anchorStatus === 'alarm'\) return \{ label: 'Drag Alarm'/);
        expect(hub).toMatch(/anchorStatus === 'alarm' \? 'nav-hero-alarm' : ''/);
        const guard = hub.indexOf("if (anchorStatus === 'armed') return null;");
        const alarmStyling = hub.indexOf("anchorStatus === 'alarm' ? 'nav-hero-alarm' : ''");
        expect(guard).toBeGreaterThan(-1);
        expect(alarmStyling).toBeGreaterThan(guard); // the card still renders below it
    });

    it('the arc is gone from the tile, and the tile is the route to it', () => {
        // No conditional swap in the tile: the same 8x8 dot in every state.
        const tile = hub.slice(hub.indexOf('aria-label="Anchor Watch"'));
        const body = tile.slice(0, tile.indexOf('</button>'));
        expect(body).not.toContain('<SwingArc');
        expect(body).not.toContain('anchorShowSwing');
        expect(body).not.toMatch(/\{Math\.round\(anchorOffset\)\}m of \{Math\.round\(anchorRadius\)\}m/);
        // ...but it still opens the screen that has the picture.
        expect(body).toContain("onNavigate('compass')");
    });

    it('the arc still exists for the alarm, which is when it is looked at', () => {
        // The hero card returns null while ARMED but not while alarming, so
        // the arc it carries is exactly the drag-alarm case.
        expect(hub).toContain('<SwingArc');
        const showSwing = hub.indexOf("const showSwing = anchorStatus !== 'disarmed' && anchorRadius > 0;");
        expect(showSwing).toBeGreaterThan(-1);
    });

    it('pins the row height — tall enough for the content, and no taller', () => {
        // BOTH directions are bugs. Too loose and the Anchor tile stretches
        // the whole deck when the anchor goes down; too tight and every tile
        // loses its second line, which is what 76px did — "OVERBOA",
        // "POSITION", "OFF" (Shane 2026-09-05, an hour after asking for the
        // first fix). So this asserts the ARITHMETIC, not a number someone
        // liked the look of.
        const row = hub.match(/auto-rows-\[(\d+)px\]/);
        expect(row, 'the safety deck must pin its row height').not.toBeNull();
        const pinned = Number(row![1]);

        const py = 10 * 2; // py-2.5, both edges
        const gaps = 6 * 2; // gap-1.5 between icon, heading and status
        const icon = 32; // h-8
        const heading = 11; // text-[11px] leading-none
        const status = 11 * 2; // text-[9.5px] leading-[1.1] ≈ 10.45/line, TWO lines — 11 keeps the ceiling
        const content = py + gaps + icon + heading + status;

        expect(pinned, `must fit ${content}px of content`).toBeGreaterThanOrEqual(content);
        // Slack for font metrics, not room for a third status line to creep in.
        expect(pinned).toBeLessThanOrEqual(content + 12);
    });

    it('lets the last row scroll clear of the tab bar', () => {
        // The scrolling area had px-4 pt-4 and no bottom padding, so Settings &
        // Connect sat flush against the bottom of the port — underneath the tab
        // bar, with nothing below it to scroll into (Shane 2026-09-05: "the
        // settings and connect button is not half hidden").
        //
        // The padding must be on the SCROLL CONTAINER. On a wrapper around it,
        // it only shrinks the port and moves the problem down a level.
        const at = hub.indexOf('overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 stagger-in');
        expect(at, 'the vessel scroll area must be findable').toBeGreaterThan(-1);
        const el = hub.slice(at, at + 400);
        expect(el).toContain("paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)'");
    });

    it('never truncates a safety status — least of all OVERBOARD', () => {
        // "OVERBOARD" is the longest word in the narrowest tile and it was
        // being cut to "OVERBOA", on the button a skipper reaches for when
        // someone is in the water. Shane, 2026-09-05: "we really need to be
        // able to see the entire word claude, so i dont get sued, because a
        // punter went over the side and they didnt know which button to press."
        //
        // A word that does not fit must WRAP, not lose its ending. That is the
        // only acceptable failure mode here, and it is why the row above is
        // sized for two lines.
        const deck = safetyDeck(hub);
        expect(deck, 'no status line on the safety deck may truncate').not.toContain('truncate');
        expect((deck.match(/text-\[9\.5px\] font-bold uppercase leading-\[1\.1\]/g) ?? []).length).toBe(4);
        // And the word itself is still there to be seen. Written "Overboard"
        // in the source and uppercased by CSS, which is why this matches the
        // source spelling rather than what the screen shows.
        expect(deck).toContain('Overboard');
        expect(deck).toContain('uppercase');
    });

    it('sizes the status line to the longest word it has to hold', () => {
        // "OVERBOARD" is the longest, in the narrowest tile. At 9px it
        // truncated; at 10px, on the phone, the mid-word fallback split it
        // "OVERBOAR / D" (Shane, 2026-09-06). 9.5px keeps the word whole at
        // the widths that clipped it, and all four tiles move together so the
        // deck reads as one. Neither old size may come back.
        const deck = safetyDeck(hub);
        expect(deck).not.toContain('text-[9px]');
        expect(deck).not.toContain('max-w-full text-[10px]');
        expect((deck.match(/max-w-full text-\[9\.5px\]/g) ?? []).length).toBe(4);
    });
});
