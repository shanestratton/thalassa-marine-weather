/**
 * "Where everything goes" was four paragraphs of prose. Where the traveller
 * sits and how far the boom is out are POSITIONS, and a picture states a
 * position in one glance where a sentence makes you build it in your head —
 * on a moving deck, in the wet (Shane 2026-08-28: "can we actually have
 * images. they are so much easier. with a wind direction showing as well?").
 *
 * The risk with a drawing is that it stops agreeing with the plan it claims
 * to illustrate. These pin the parts that would be actively misleading if
 * they drifted: which side the sails set on, and whether the two warnings
 * that hurt people are shown.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SailPlanDiagram } from '../components/nmea/gauges/SailPlanDiagram';

const base = { band: 'Beam reach', main: 'Full', yankee: 'Full', stay: false as const };

/**
 * The centreline, read from the drawing rather than hardcoded.
 *
 * These assertions used to compare against a literal 150 (half of the old
 * 300-wide viewBox) and select the boom as querySelectorAll('line')[2] — a
 * positional index into the artwork. Both broke on the 2026-09-05 rescale,
 * neither because the BEHAVIOUR changed. Marks carry data-mark now, and the
 * centreline comes off the viewBox, so this file survives the next redraw.
 */
function centreline(container: HTMLElement): number {
    // The FRAME's centre. Since 2026-09-05 the hull leans away from whichever
    // side the labels are on, so for "is this mark to port or starboard" use
    // the mast instead — that is the middle of the ship.
    const box = container.querySelector('svg')!.getAttribute('viewBox')!.split(' ');
    return Number(box[2]) / 2;
}
const mark = (container: HTMLElement, name: string) => container.querySelector(`[data-mark="${name}"]`) as SVGElement;
/** The middle of the SHIP, which is not the middle of the frame — see above. */
const mastX = (container: HTMLElement) => Number(mark(container, 'mast').getAttribute('cx'));

describe('the rig mirrors with the tack', () => {
    it('sets the sails to starboard when the wind is over the port side', () => {
        // Wind at 315 is on the port bow, so the boom is out to starboard.
        // Drawing it the other way would be a boat that cannot be sailing.
        const { container } = render(<SailPlanDiagram {...base} windAngle={315} />);
        expect(Number(mark(container, 'boom').getAttribute('x2'))).toBeGreaterThan(mastX(container));
    });

    it('sets them to port when the wind is over the starboard side', () => {
        const { container } = render(<SailPlanDiagram {...base} windAngle={45} />);
        expect(Number(mark(container, 'boom').getAttribute('x2'))).toBeLessThan(mastX(container));
    });
});

describe('the boom angle follows the point of sail', () => {
    it('is close to the centreline beating and well out running', () => {
        const beat = render(<SailPlanDiagram {...base} band="Beating" windAngle={45} />);
        // Distance OFF THE MAST, not an absolute x. The hull's frame position
        // changes with the tack, so comparing raw x2 across two renders
        // measures the lean as well as the boom.
        const beatX = Math.abs(Number(mark(beat.container, 'boom').getAttribute('x2')) - mastX(beat.container));
        const run = render(<SailPlanDiagram {...base} band="Running" windAngle={45} />);
        const runX = Math.abs(Number(mark(run.container, 'boom').getAttribute('x2')) - mastX(run.container));
        // Running is much further out. This read `runX < beatX` while both
        // were absolute x on the same tack — true, but only because "further
        // out to port" meant a SMALLER number. As a distance off the mast it
        // says what it means.
        expect(runX).toBeGreaterThan(beatX);
    });
});

describe('sails that are not set are not drawn', () => {
    it('omits the yankee when it is furled', () => {
        const withSail = render(<SailPlanDiagram {...base} yankee="Full" windAngle={45} />);
        const furled = render(<SailPlanDiagram {...base} yankee="Furled" windAngle={45} />);
        expect(furled.container.querySelectorAll('path').length).toBeLessThan(
            withSail.container.querySelectorAll('path').length,
        );
    });

    it('dims the boom and drops the sail when the main is down', () => {
        const { container } = render(<SailPlanDiagram {...base} main="Down" windAngle={45} />);
        expect(mark(container, 'boom').getAttribute('opacity')).toBe('0.5');
        // And no mainsheet, because there is no sail for it to be trimming.
        expect(mark(container, 'mainsheet')).toBeNull();
    });
});

describe('the warnings that hurt people are never silent', () => {
    it('shows the preventer when the plan calls for one', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Running" windAngle={180} prevent />);
        expect(container.textContent).toContain('PREVENTER ON');
    });

    it('shows the runners when the plan calls for them', () => {
        const { container } = render(<SailPlanDiagram {...base} stay="storm" windAngle={45} runners />);
        expect(container.textContent).toContain('RUNNERS ON');
    });

    it('says so plainly when there is no wind angle to draw', () => {
        // Better an honest gap than a boat drawn on a tack it is not on.
        const { container } = render(<SailPlanDiagram {...base} windAngle={null} />);
        expect(container.textContent).toContain('no wind angle');
    });
});

describe('the yankee lead, which is not the same as the car', () => {
    it('shows the car live on its track while the advice is "leave the car alone"', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Beating" windAngle={45} yankee="Full" />);
        expect(container.textContent).toContain('YANKEE CAR');
        expect(container.textContent).not.toContain('RAIL BLOCK');
    });

    it('moves the lead to a rail block reaching, because the track cannot do outboard', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Beam reach" windAngle={45} yankee="Full" />);
        expect(container.textContent).toContain('RAIL BLOCK');
    });

    it('poles it out running, and to WINDWARD — the opposite side to everything else', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Running" windAngle={45} yankee="Full" />);
        expect(container.textContent).toContain('POLED');
        // Wind on the starboard bow, so the rig is to port and the pole to
        // starboard. Drawing the pole to leeward would be a gybe waiting.
        // The BOAT's centreline, off the mast — the hull no longer sits at
        // the frame's centre, it leans away from the labels.
        const cx = Number(mark(container, 'mast').getAttribute('cx'));
        expect(Number(mark(container, 'pole').getAttribute('x2'))).toBeGreaterThan(cx);
        // And the SAIL it carries goes with it. The yankee was drawn to
        // leeward in every state, including this one — the pole was right and
        // the sail it holds out was on the other side of the boat.
        const yankee = container.querySelector(`path[d^="M ${cx} 62"]`) as SVGPathElement;
        expect(yankee.getAttribute('d')).toContain(`${cx + 66}`);
    });

    it('draws no yankee gear at all when the sail is furled', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Beam reach" windAngle={45} yankee="Furled" />);
        expect(container.textContent).not.toContain('YANKEE CAR');
        expect(container.textContent).not.toContain('RAIL BLOCK');
    });
});
