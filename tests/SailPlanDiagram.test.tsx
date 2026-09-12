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

describe('the hardware is off the boat, the pole stays', () => {
    // Sept 10: separate guides beside/below the hull, never gear across sails.
    it('keeps the traveller below the rig and Yankee guide beside the hull', () => {
        for (const band of ['Beating', 'Close reach', 'Beam reach', 'Broad reach', 'Running']) {
            for (const windAngle of [45, 315]) {
                const { container } = render(
                    <SailPlanDiagram {...base} band={band} windAngle={windAngle} yankee="Full" />,
                );
                for (const name of ['yankee-car', 'rail-block', 'mainsheet', 'yankee-sheet']) {
                    expect(mark(container, name), `${name} ${band} @${windAngle}`).toBeNull();
                }
                const rig = mark(container, 'rig-diagram');
                expect(rig.querySelector('[data-mark="traveller-car"]')).toBeNull();
                expect(rig.querySelector('[data-mark="yankee-car-guide"]')).not.toBeNull();
                expect(container.textContent).toContain('TRAVELLER');
                expect(container.textContent).toContain('YANKEE CAR');
                expect(container.textContent).not.toContain('RAIL BLOCK');
            }
        }
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

    it('draws no pole in the bands that are not poled, nor when the sail is furled', () => {
        for (const band of ['Beating', 'Close reach', 'Beam reach', 'Broad reach']) {
            const { container } = render(<SailPlanDiagram {...base} band={band} windAngle={45} yankee="Full" />);
            expect(mark(container, 'pole'), band).toBeNull();
        }
        const { container } = render(<SailPlanDiagram {...base} band="Running" windAngle={45} yankee="Furled" />);
        expect(mark(container, 'pole')).toBeNull();
        expect(container.textContent).not.toContain('POLED');
    });
});

describe('qualitative guides agree with the advice, without claiming live positions', () => {
    const guide = (props = {}) => render(<SailPlanDiagram {...base} windAngle={45} {...props} />).container;
    const setting = (c: HTMLElement) => c.querySelector('.sail-traveller-setting')!.textContent;
    const carCentre = (c: HTMLElement) => Number(mark(c, 'traveller-car').getAttribute('x')) + 10;

    it('mirrors windward and leeward advice without moving the Yankee fore/aft setting', () => {
        for (const windAngle of [45, 315]) {
            const lee = windAngle > 180 ? 1 : -1;
            const beating = guide({ band: 'Beating', windAngle });
            expect(setting(beating)).toBe('To windward');
            expect(Math.sign(carCentre(beating) - 170)).toBe(-lee);
            for (const band of ['Beam reach', 'Broad reach']) {
                expect(Math.sign(carCentre(guide({ band, windAngle })) - 170)).toBe(lee);
            }
            expect(carCentre(guide({ band: 'Close reach', windAngle }))).toBe(170);
        }
        for (const band of ['Beating', 'Close reach', 'Beam reach']) {
            expect(mark(guide({ band }), 'yankee-car-guide').textContent).toContain('Leave set');
        }
    });

    it('shows no recommended traveller position with a down main, unknown wind/band or running', () => {
        for (const props of [
            { main: 'Down' },
            { windAngle: null },
            { windAngle: NaN },
            { band: 'unknown' },
            { band: 'Running' },
        ]) {
            const c = guide(props);
            expect(mark(c, 'traveller-car')).toBeNull();
            expect(c.textContent).toContain('Trim guide · not live positions');
            expect(c.textContent).toContain('fore/aft setting not measured');
        }
        expect(setting(guide({ band: 'Running' }))).toBe('Not controlling trim');
        expect(mark(guide({ yankee: 'Furled' }), 'yankee-car-guide').textContent).toContain('Sail stowed');
        expect(mark(guide({ yankee: 'Down' }), 'yankee-car-guide').textContent).toContain('Sail stowed');
    });

    it('retains Running advice when Gybe down draws a broad-reaching rig', () => {
        const c = guide({ band: 'Broad reach', adviceBand: 'Running' });
        expect(setting(c)).toBe('Not controlling trim');
        expect(mark(c, 'traveller-car')).toBeNull();
        expect(mark(c, 'pole')).toBeNull();
        expect(mark(c, 'yankee-car-guide').textContent).toContain('Pole / gybe');
    });

    it('keeps both complete warnings in document flow after the traveller, not in the clipped SVG', () => {
        const c = guide({ prevent: true, runners: true, windAngle: null });
        const warnings = c.querySelectorAll('[data-mark="sail-warning"]');
        expect(warnings).toHaveLength(2);
        for (const warning of warnings) {
            expect(warning.closest('svg')).toBeNull();
            expect(
                mark(c, 'traveller-guide').compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }
        expect(c.textContent).toContain('no wind angle');
    });
});
