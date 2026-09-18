import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadingGauge } from '../components/nmea/gauges/HeadingGauge';
import { RudderGauge } from '../components/nmea/gauges/RudderGauge';
import { AttitudeGauge } from '../components/nmea/gauges/AttitudeGauge';
import { BarometerGauge } from '../components/nmea/gauges/BarometerGauge';
import { SereneWindRose } from '../components/nmea/gauges/SereneWindRose';
import { ShipsBellClock } from '../components/nmea/gauges/ShipsBellClock';
import { CLOCK_MAX_WIDTH } from '../components/nmea/instrumentLayout';

let stylesheet: HTMLStyleElement;
beforeEach(() => {
    stylesheet = document.createElement('style');
    stylesheet.textContent = readFileSync('components/nmea/instrumentDaylight.css', 'utf8');
    document.head.append(stylesheet);
});
afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('display-light');
    stylesheet.remove();
});

const paint = (el: Element, property: string) => getComputedStyle(el).getPropertyValue(property);

describe('instrument paint follows the live display class', () => {
    it('changes mounted compass paint without new readings, then restores all authored dark paint', () => {
        const { container } = render(<HeadingGauge value={359.6} isLive />);
        const face = container.querySelector('stop')!;
        const reading = [...container.querySelectorAll('text')].find((el) => el.textContent === '000')!;
        const north = [...container.querySelectorAll('text')].find((el) => el.textContent === 'N')!;
        const originalMarkup = container.innerHTML;
        const dark = [paint(face, 'stop-color'), paint(reading, 'fill'), paint(north, 'fill')];

        document.documentElement.classList.add('display-light');
        expect(paint(face, 'stop-color')).toBe('rgb(255, 255, 255)');
        expect(paint(reading, 'fill')).toBe('#0f172a');
        expect(paint(north, 'fill')).toBe('#b91c1c');
        expect(container.innerHTML).toBe(originalMarkup);

        document.documentElement.classList.remove('display-light');
        expect([paint(face, 'stop-color'), paint(reading, 'fill'), paint(north, 'fill')]).toEqual(dark);
        expect(face.getAttribute('stop-color')).toBe('#1e293b');
        expect(reading.getAttribute('fill')).toBe('#f8fafc');
    });

    it('keeps rudder sides and off-scale measured angles when day paint is applied', () => {
        document.documentElement.classList.add('display-light');
        const { container, rerender } = render(<RudderGauge angle={-55} />);
        const label = () => [...container.querySelectorAll('text')].at(-1)!;
        expect(container.textContent).toContain('55.0°');
        expect(label().textContent).toBe('PORT');
        expect(paint(label(), 'fill')).toBe('#b91c1c');
        rerender(<RudderGauge angle={55} />);
        expect(container.textContent).toContain('55.0°');
        expect(label().textContent).toBe('STARBOARD');
        expect(paint(label(), 'fill')).toBe('#047857');
        rerender(<RudderGauge angle={null} />);
        expect(container.textContent).toContain('NO DATA');
        expect(container.textContent).not.toContain('0.0°');
    });

    it('keeps caution and warning needles distinct, and does not recolour unrelated SVGs', () => {
        document.documentElement.classList.add('display-light');
        const { container, rerender } = render(<BarometerGauge hpa={995} severity="watch" readout="995" />);
        const needle = () => container.querySelector('g[filter] line')!;
        expect(paint(needle(), 'stroke')).toBe('#854d0e');
        rerender(<BarometerGauge hpa={995} severity="warn" readout="995" />);
        expect(paint(needle(), 'stroke')).toBe('#b91c1c');
        expect(container.textContent).toContain('995');
        rerender(
            <svg>
                <text fill="#f8fafc">Unrelated</text>
            </svg>,
        );
        expect(paint(container.querySelector('text')!, 'fill')).not.toBe('#0f172a');
    });

    it('preserves signed attitude, live/stale wind and the absent wind needle', () => {
        document.documentElement.classList.add('display-light');
        const { container, rerender } = render(<AttitudeGauge axis="heel" angle={-8.2} />);
        expect(container.textContent).toContain('8.2°PORT');
        expect(paint(container.querySelector('g[transform] path')!, 'stroke')).toBe('#b91c1c');
        rerender(<AttitudeGauge axis="pitch" angle={-8.2} />);
        expect(container.textContent).toContain('BOW DOWN');
        rerender(<SereneWindRose gaugeKey="day" angle={315} speed={12.4} isLive={false} />);
        expect(container.textContent).toContain('45° PORT');
        expect(container.querySelector('svg')!.style.opacity).toBe('0.45');
        expect(container.querySelector('#day-ndl stop')!.getAttribute('stop-color')).toBe('var(--port)');
        rerender(<SereneWindRose gaugeKey="day" angle={null} speed={null} />);
        expect(container.querySelector('#day-ndl')).toBeNull();
        expect(container.textContent).toContain('no data');
        expect(container.textContent).not.toContain('0.0');
    });

    it('keeps the ivory clock and its responsive limits, improving only fine daylight marks', () => {
        const { container } = render(<ShipsBellClock hour={14} minute={30} second={15} zoneLabel="AEST" />);
        const original = container.innerHTML;
        document.documentElement.classList.add('display-light');
        expect(container.textContent).toContain('AEST');
        expect(container.querySelector('.nmea-clock')!.getAttribute('style')).toContain(CLOCK_MAX_WIDTH);
        expect(paint(container.querySelector('line[stroke-opacity="0.5"]')!, 'stroke-opacity')).toBe('0.75');
        expect(container.innerHTML).toBe(original);
        expect(container.querySelector('#bell-dial stop')!.getAttribute('stop-color')).toBe('#fffaf0');
    });
});
