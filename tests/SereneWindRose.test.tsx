/**
 * The rose is a transcription of the Serene Summer dashboard gauge handed
 * over in ~/Desktop/wind-rose-for-thalassa, whose README is explicit that
 * the screenshot is the specification. These pin the three things that
 * README says will bite, because each of them fails SILENTLY — the rose
 * still renders, it just renders a lie.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SereneWindRose } from '../components/nmea/gauges/SereneWindRose';

const svgOf = (c: HTMLElement) => c.querySelector('svg') as SVGSVGElement;

describe('needle side is decided by angle alone', () => {
    it('paints starboard green for wind over the starboard bow', () => {
        const { container } = render(<SereneWindRose gaugeKey="a" angle={45} speed={12.4} />);
        const grad = container.querySelector('#a-ndl stop') as SVGStopElement;
        expect(grad.getAttribute('stop-color')).toBe('var(--stbd)');
        expect(container.textContent).toContain('45° STBD');
    });

    it('paints port red past 180, and says so in words not a letter', () => {
        // "S" already means South on the ring beside it; one letter meaning
        // two things on an instrument is how you end up on the wrong tack.
        const { container } = render(<SereneWindRose gaugeKey="b" angle={315} speed={18.2} />);
        const grad = container.querySelector('#b-ndl stop') as SVGStopElement;
        expect(grad.getAttribute('stop-color')).toBe('var(--port)');
        expect(container.textContent).toContain('45° PORT');
    });

    it('reports the angle off the bow, not the raw 0-360 bearing', () => {
        const { container } = render(<SereneWindRose gaugeKey="c" angle={300} speed={5} />);
        expect(container.textContent).toContain('60° PORT');
    });
});

describe('the no-data state', () => {
    it('draws no needle at all when the masthead is silent', () => {
        // A needle at the bow with no data is a lie, and these instruments
        // are dark often enough for this to be the common case.
        const { container } = render(<SereneWindRose gaugeKey="n" angle={null} speed={null} />);
        expect(container.querySelector('#n-ndl')).toBeNull();
        expect(container.textContent).toContain('no data');
    });

    it('still draws the bezel and the side arcs', () => {
        const { container } = render(<SereneWindRose gaugeKey="n2" angle={null} speed={null} />);
        expect(container.querySelector('#n2-stbd')).not.toBeNull();
        expect(container.querySelector('#n2-port')).not.toBeNull();
        expect(container.querySelectorAll('circle').length).toBeGreaterThan(2);
    });

    it('shows a dash for speed rather than a zero', () => {
        const { container } = render(<SereneWindRose gaugeKey="n3" angle={null} speed={null} />);
        expect(container.textContent).toContain('—');
        expect(container.textContent).not.toContain('0.0');
    });
});

describe('gradient ids are namespaced per rose', () => {
    it('gives two roses on one page entirely separate gradients', () => {
        // url(#id) resolves document-wide. A collision means the second rose
        // paints with the first one's needle — the WRONG SIDE on opposite
        // tacks, which is the whole reason `gaugeKey` is required.
        const { container } = render(
            <>
                <SereneWindRose gaugeKey="awa" angle={45} speed={10} />
                <SereneWindRose gaugeKey="twa" angle={315} speed={10} heading={40} />
            </>,
        );
        expect(container.querySelector('#awa-ndl')).not.toBeNull();
        expect(container.querySelector('#twa-ndl')).not.toBeNull();
        const stbdStop = container.querySelector('#awa-ndl stop') as SVGStopElement;
        const portStop = container.querySelector('#twa-ndl stop') as SVGStopElement;
        expect(stbdStop.getAttribute('stop-color')).toBe('var(--stbd)');
        expect(portStop.getAttribute('stop-color')).toBe('var(--port)');
    });
});

describe('the compass ring appears only with a heading', () => {
    it('labels the ring off the bow when there is no heading to point at', () => {
        // Compass letters here would put N at the masthead and quietly claim
        // she is heading north.
        const { container } = render(<SereneWindRose gaugeKey="h0" angle={45} speed={9} />);
        expect(container.textContent).toContain('BOW');
        expect(container.textContent).toContain('no heading');
        expect(container.textContent).not.toContain('NNE');
    });

    it('draws compass points, degree numerals and a real bearing with heading', () => {
        const { container } = render(<SereneWindRose gaugeKey="h1" angle={120} speed={9.6} heading={40} />);
        expect(container.textContent).toContain('NNE');
        expect(container.textContent).toContain('030'); // zero-padded graduation
        expect(container.textContent).toContain('160° SSE'); // 120 + 40
        expect(container.textContent).not.toContain('BOW');
    });

    it('rotates the ring by minus the heading so north sits where north is', () => {
        const { container } = render(<SereneWindRose gaugeKey="h2" angle={10} speed={4} heading={40} />);
        const ring = svgOf(container).querySelector('g[transform]') as SVGGElement;
        expect(ring.getAttribute('transform')).toContain('rotate(-40.0');
    });
});

describe('geometry is carried across verbatim', () => {
    it('keeps the 380 viewBox the radii were spaced for', () => {
        // The box grew from 340 specifically so the degree numerals get a
        // lane of their own; rescaling one number without the rest closes it.
        const { container } = render(<SereneWindRose gaugeKey="g" angle={45} speed={1} />);
        expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 380 380');
    });
});
