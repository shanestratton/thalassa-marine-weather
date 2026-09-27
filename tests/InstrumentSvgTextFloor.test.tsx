/**
 * UX scorecard run 8, glass-svg-text: the app's 12 px text floor (index.css)
 * is a CSS rule on class names, so it never reached the SVG fontSize
 * attributes on the Instrument Panel's dials. They drew at 8, 10 and 11 px:
 * the barometer's weather legend and unit, the rudder's numerals, the wind
 * dial's tick labels. This is the floor audit for SVG text.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttitudeGauge } from '../components/nmea/gauges/AttitudeGauge';
import { BarometerGauge } from '../components/nmea/gauges/BarometerGauge';
import { HeadingGauge } from '../components/nmea/gauges/HeadingGauge';
import { RudderGauge } from '../components/nmea/gauges/RudderGauge';
import { SereneWindRose } from '../components/nmea/gauges/SereneWindRose';

const FLOOR = 12;

afterEach(cleanup);

function fontSizes(container: HTMLElement): number[] {
    return [...container.querySelectorAll('svg text')].map((text) => Number(text.getAttribute('font-size')));
}

describe('Instrument Panel dials keep SVG text at the 12 px floor', () => {
    const dials: Array<[string, React.ReactElement]> = [
        ['barometer', <BarometerGauge key="b" hpa={1013.2} setHandHpa={1015} readout="1013.2" readoutUnit="hPa" />],
        ['barometer, no data', <BarometerGauge key="bd" hpa={null} readout="--" />],
        ['rudder', <RudderGauge key="r" angle={-12.5} />],
        ['rudder, no data', <RudderGauge key="rd" angle={null} />],
        ['heading', <HeadingGauge key="h" value={87} isLive />],
        ['heading, no data', <HeadingGauge key="hd" value={null} isLive={false} />],
        ['heel', <AttitudeGauge key="a" angle={6.2} axis="heel" />],
        ['wind rose with heading', <SereneWindRose key="w" gaugeKey="floor" angle={40} speed={12} heading={90} />],
    ];

    for (const [name, element] of dials) {
        it(`the ${name} dial`, () => {
            const { container } = render(element);
            const sizes = fontSizes(container);
            expect(sizes.length).toBeGreaterThan(0);
            for (const size of sizes) expect(size).toBeGreaterThanOrEqual(FLOOR);
        });
    }

    it('the panel page draws no SVG text under the floor either', () => {
        const panel = readFileSync(resolve(process.cwd(), 'components/nmea/TheGlassPage.tsx'), 'utf8');
        const literal = [...panel.matchAll(/fontSize=(?:"|\{)(\d+(?:\.\d+)?)(?:"|\})/g)].map((m) => Number(m[1]));
        expect(literal.length).toBeGreaterThan(0);
        for (const size of literal) expect(size).toBeGreaterThanOrEqual(FLOOR);
    });

    it('prints a missing flank reading as a readable dash, not gray-600', () => {
        const panel = readFileSync(resolve(process.cwd(), 'components/nmea/TheGlassPage.tsx'), 'utf8');
        expect(panel).not.toContain("'text-gray-600'");
        expect(panel).toContain("${has ? tone : 'text-gray-400'}");
    });
});
