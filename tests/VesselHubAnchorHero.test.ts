/**
 * At anchor the hero card stands down — but never during a drag alarm.
 *
 * Shane 2026-09-04: "when we are at anchor, can we remove the card the says at
 * anchor on the vessel home page". It was repeating the Anchor tile below it,
 * so the tile took over — and took the swing arc with it, since where the boat
 * sits in its circle is the one part worth a picture.
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

    it('the swing arc moved to the Anchor tile, so nothing is lost by hiding the card', () => {
        expect(hub).toMatch(
            /const anchorShowSwing = \(anchorEffectivelyArmed \|\| anchorStatus === 'alarm'\) && anchorRadius > 0;/,
        );
        // Rendered on the tile, with the reading it is a picture of.
        expect(hub).toMatch(/\{anchorShowSwing \? \([\s\S]{0,400}<SwingArc/);
        expect(hub).toMatch(/\{Math\.round\(anchorOffset\)\}m of \{Math\.round\(anchorRadius\)\}m/);
    });
});
