/**
 * The trim prose leans on the vocabulary — leech telltale, luff breathing,
 * the clew rising, the roach the battens hold out. Those words only help if
 * you can point at them (Shane 2026-08-28: "can we have a parts of a sail
 * diagram in there as well").
 *
 * Static by design: it reads nothing from the boat, so it cannot be wrong
 * about the boat. These just hold the vocabulary complete.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SailPartsDiagram } from '../components/nmea/gauges/SailPartsDiagram';

describe('SailPartsDiagram', () => {
    it('names every part the trim advice refers to', () => {
        const { container } = render(<SailPartsDiagram />);
        for (const part of ['HEAD', 'TACK', 'CLEW', 'LUFF', 'FOOT', 'LEECH', 'ROACH', 'BATTENS', 'TELLTALES']) {
            expect(container.textContent).toContain(part);
        }
    });

    it('is described to a screen reader as a whole rather than as loose labels', () => {
        const { container } = render(<SailPartsDiagram />);
        const svg = container.querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('role')).toBe('img');
        expect(svg.getAttribute('aria-label')).toContain('Parts of a mainsail');
    });
});
