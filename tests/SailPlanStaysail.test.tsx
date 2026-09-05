/**
 * Serene Summer is a CUTTER. The inner sail is half of what that means, and
 * "Where everything goes" is a reference for where things live on the boat —
 * so a staysail that simply vanishes when it is furled teaches the wrong rig
 * (Shane 2026-08-28: "we need to show the staysail when we are drawing
 * pictures").
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SailPlanDiagram } from '../components/nmea/gauges/SailPlanDiagram';

const draw = (props: Partial<React.ComponentProps<typeof SailPlanDiagram>> = {}) =>
    render(<SailPlanDiagram band="Beam reach" windAngle={90} main="Full" yankee="Full" stay={true} {...props} />)
        .container;

describe('the staysail', () => {
    it('is named on the drawing when it is set', () => {
        expect(draw().textContent).toContain('STAYSAIL');
    });

    it('is still drawn when stowed, and says so', () => {
        const c = draw({ stay: false });
        expect(c.textContent).toContain('STAYSAIL (STOWED)');
        // Ghosted, not deleted — the stowed outline is dashed. Selected by
        // data-mark rather than by its dash pattern: the dash is styling and
        // changed with the 2026-09-05 rescale (3 4 → 4 5), while what this
        // test cares about is that the mark is still THERE.
        const ghost = c.querySelector('[data-mark="staysail"]')!;
        expect(ghost).not.toBeNull();
        expect(ghost.getAttribute('stroke-dasharray')).toBeTruthy();
    });

    it('is filled when set and unfilled when stowed', () => {
        expect(draw({ stay: true }).innerHTML).toContain('rgba(255,255,255,0.16)');
        const stowed = draw({ stay: false });
        expect(stowed.querySelector('[data-mark="staysail"]')?.getAttribute('fill')).toBe('none');
    });

    it('calls it a storm jib when that is what is up', () => {
        const c = draw({ stay: 'storm' });
        expect(c.textContent).toContain('STORM JIB');
        expect(c.textContent).not.toContain('STAYSAIL');
    });

    it('names the yankee too, so the two headsails can be told apart', () => {
        expect(draw().textContent).toContain('YANKEE');
    });

    it('keeps both stay fittings on the foredeck whatever the sails do', () => {
        // Standing rigging. It is the SECOND fitting, aft of the headstay,
        // that makes her a cutter rather than a sloop.
        for (const stay of [true, false, 'storm'] as const) {
            const c = draw({ stay });
            // By data-mark, not by hardcoded cy. Their y positions moved with
            // the rescale; that they BOTH exist in every staysail state is the
            // contract, and it is what makes her read as a cutter.
            expect(c.querySelectorAll('[data-mark="stay-fitting"]')).toHaveLength(2);
        }
    });

    it('tells a screen reader exactly what it tells the eye', () => {
        expect(draw({ stay: false }).querySelector('svg')?.getAttribute('aria-label')).toContain('staysail stowed');
        expect(draw({ stay: true }).querySelector('svg')?.getAttribute('aria-label')).toContain('staysail set');
        expect(draw({ stay: 'storm' }).querySelector('svg')?.getAttribute('aria-label')).toContain('storm jib set');
    });

    it('puts the sails on the correct side for the tack', () => {
        // Wind from port (>180) puts the sails to starboard, and vice versa.
        const port = draw({ windAngle: 270 }).innerHTML;
        const stbd = draw({ windAngle: 90 }).innerHTML;
        expect(port).not.toBe(stbd);
    });
});
