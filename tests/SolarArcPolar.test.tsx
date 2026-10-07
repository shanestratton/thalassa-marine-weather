/**
 * The solar arc in polar day and night (build 123, W1-06).
 *
 * celestial now hands the Sun & Moon widget and the tide card 'Sun stays up' /
 * 'Sun stays down' where the sun neither rises nor sets that day (USNO, Tromsø
 * 69.65 N 18.96 E: continuously above the horizon on 21 Jun 2026, below it on
 * 21 Dec 2026). The arc parsed those words to null and timed a made-up
 * 06:00–18:00 day: a yellow midday sun beside 'Sun stays down', a grey set sun
 * at 23:00 beside 'Sun stays up'.
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SolarArc } from '../components/dashboard/tide/CelestialComponents';
import { SUN_STAYS_DOWN, SUN_STAYS_UP } from '../utils/celestial';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const DAY = '#fbbf24';
const NIGHT = '#94a3b8';

function marker(container: HTMLElement) {
    const sun = container.querySelector('circle')!;
    return { fill: sun.getAttribute('fill'), cx: Number(sun.getAttribute('cx')), cy: Number(sun.getAttribute('cy')) };
}

describe('SolarArc in polar day and night', () => {
    it('midnight sun at 23:00 local: the sun is up, at the top of the arc, and one label says so', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-06-21T21:00:00Z')); // 23:00 in Tromsø
        const { container } = render(<SolarArc sunrise={SUN_STAYS_UP} sunset={SUN_STAYS_UP} timeZone="Europe/Oslo" />);
        expect(marker(container)).toEqual({ fill: DAY, cx: 50, cy: 10 });
        expect(container.querySelector('[data-sun-all-day="up"]')).not.toBeNull();
        expect(container).toHaveTextContent('Stays up all day');
        // No sunrise/sunset columns repeating the words.
        expect(container).not.toHaveTextContent('Sunrise');
        expect(container).not.toHaveTextContent('Sun stays up');
    });

    it('polar night at noon local: the sun is down, on the horizon, not a midday sun', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-12-21T11:00:00Z')); // 12:00 in Tromsø
        const { container } = render(
            <SolarArc sunrise={SUN_STAYS_DOWN} sunset={SUN_STAYS_DOWN} timeZone="Europe/Oslo" />,
        );
        expect(marker(container)).toEqual({ fill: NIGHT, cx: 50, cy: 50 });
        expect(container.querySelector('[data-sun-all-day="down"]')).not.toBeNull();
        expect(container).toHaveTextContent('Stays down all day');
        expect(container).not.toHaveTextContent('Sunset');
    });

    it('the large arc says it too, in place of the two times', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-12-21T11:00:00Z'));
        const { container } = render(
            <SolarArc sunrise={SUN_STAYS_DOWN} sunset={SUN_STAYS_DOWN} size="large" timeZone="Europe/Oslo" />,
        );
        expect(container).toHaveTextContent('Stays down all day');
        expect(container).not.toHaveTextContent('Sunrise');
        expect(marker(container).fill).toBe(NIGHT);
    });

    it('an ordinary day still runs from sunrise to sunset', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-07T10:00:00Z')); // 12:00 in Marseille
        const { container } = render(<SolarArc sunrise="07:43" sunset="19:09" timeZone="Europe/Paris" />);
        const m = marker(container);
        expect(m.fill).toBe(DAY);
        expect(m.cy).toBeLessThan(15);
        expect(container).toHaveTextContent('07:43');
        expect(container).toHaveTextContent('19:09');
        expect(container.querySelector('[data-sun-all-day]')).toBeNull();
    });
});
