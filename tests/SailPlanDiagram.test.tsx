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

describe('the rig mirrors with the tack', () => {
    it('sets the sails to starboard when the wind is over the port side', () => {
        // Wind at 315 is on the port bow, so the boom is out to starboard.
        // Drawing it the other way would be a boat that cannot be sailing.
        const { container } = render(<SailPlanDiagram {...base} windAngle={315} />);
        const boom = container.querySelectorAll('line')[2] as SVGLineElement;
        expect(Number(boom.getAttribute('x2'))).toBeGreaterThan(150);
    });

    it('sets them to port when the wind is over the starboard side', () => {
        const { container } = render(<SailPlanDiagram {...base} windAngle={45} />);
        const boom = container.querySelectorAll('line')[2] as SVGLineElement;
        expect(Number(boom.getAttribute('x2'))).toBeLessThan(150);
    });
});

describe('the boom angle follows the point of sail', () => {
    it('is close to the centreline beating and well out running', () => {
        const beat = render(<SailPlanDiagram {...base} band="Beating" windAngle={45} />);
        const beatX = Number((beat.container.querySelectorAll('line')[2] as SVGLineElement).getAttribute('x2'));
        const run = render(<SailPlanDiagram {...base} band="Running" windAngle={45} />);
        const runX = Number((run.container.querySelectorAll('line')[2] as SVGLineElement).getAttribute('x2'));
        // Both to port, but running is much further out.
        expect(runX).toBeLessThan(beatX);
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
        const boom = container.querySelectorAll('line')[2] as SVGLineElement;
        expect(boom.getAttribute('opacity')).toBe('0.5');
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
        const pole = Array.from(container.querySelectorAll('line')).find(
            (l) => l.getAttribute('stroke-width') === '3',
        ) as SVGLineElement;
        expect(Number(pole.getAttribute('x2'))).toBeGreaterThan(150);
    });

    it('draws no yankee gear at all when the sail is furled', () => {
        const { container } = render(<SailPlanDiagram {...base} band="Beam reach" windAngle={45} yankee="Furled" />);
        expect(container.textContent).not.toContain('YANKEE CAR');
        expect(container.textContent).not.toContain('RAIL BLOCK');
    });
});
