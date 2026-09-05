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

    it('pins the row height, so no future tile can stretch the deck again', () => {
        // Removing today's extra content is not the fix — the next addition
        // would do it again. A fixed row is.
        expect(hub).toMatch(/grid-cols-3'\} auto-rows-\[76px\] gap-2/);
    });
});
