/**
 * Shore Watch in the viewer's own units (126-03a): feet for a feet skipper,
 * metres otherwise, from this phone's Settings, never the boat's. The real
 * radar replaces the decorative ring, and the boat's live depth and wind
 * (126-05's `live` block) appear only when the broadcast carries them.
 *
 * Fictional anchorages: off Horta, the Azores, and off Lyttelton, New Zealand.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShoreWatchReadings } from '../components/anchor-watch/ShoreWatchReadings';
import { anchorLengthParts, formatAnchorLength } from '../components/anchor-watch/anchorUtils';
import type { PositionBroadcast } from '../services/AnchorWatchSyncService';
import type { DistanceUnit, LengthUnit, SpeedUnit } from '../types/units';

const NOW = Date.UTC(2026, 9, 10, 2, 0, 0);
const HORTA = { latitude: 38.53, longitude: -28.62 };

function data(over: Partial<PositionBroadcast> = {}): PositionBroadcast {
    return {
        type: 'position',
        vessel: { latitude: 38.5301, longitude: -28.6201, accuracy: 3, heading: 0, speed: 0, timestamp: NOW },
        anchor: { ...HORTA, timestamp: NOW },
        distance: 11,
        swingRadius: 50,
        isAlarm: false,
        config: { rodeLength: 45, waterDepth: 4.3 },
        timestamp: NOW,
        ...over,
    };
}

interface Options {
    lengthUnit?: LengthUnit;
    speedUnit?: SpeedUnit;
    distanceUnit?: DistanceUnit;
    fresh?: boolean;
    trail?: { latitude: number; longitude: number; timestamp: number }[];
    radarAction?: React.ReactNode;
}

function render(broadcast: PositionBroadcast, options: Options = {}) {
    const markup = renderToStaticMarkup(
        <ShoreWatchReadings
            data={broadcast}
            fresh={options.fresh ?? true}
            isAlarm={broadcast.isAlarm}
            statusLabel={options.fresh === false ? 'Last-known data' : 'Holding'}
            showMute={false}
            muted={false}
            onMute={() => undefined}
            lengthUnit={options.lengthUnit ?? 'm'}
            speedUnit={options.speedUnit ?? 'kts'}
            distanceUnit={options.distanceUnit}
            trail={options.trail ?? []}
            radarAction={options.radarAction}
            now={NOW}
        />,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const metrics = Object.fromEntries(
        [...container.querySelectorAll('dt')].map((label) => [
            label.textContent,
            label.nextElementSibling?.textContent,
        ]),
    );
    const radar = container.querySelector('canvas[role="img"]');
    const overlay = container.querySelector('[data-testid="shore-radar-distance"]');
    return { container, metrics, radar, overlay };
}

describe('formatAnchorLength', () => {
    it.each([
        [11, 'm', '11 m'],
        [50, 'm', '50 m'],
        [11, 'ft', '36 ft'],
        [50, 'ft', '164 ft'],
        [45, 'ft', '148 ft'],
        [63, 'ft', '207 ft'],
        [1900, 'm', '1.0 NM'],
        [1900, 'ft', '1.0 NM'],
    ] as const)('%s m in %s reads %s', (metres, unit, words) => {
        expect(formatAnchorLength(metres, unit)).toBe(words);
    });

    it('gives depth one decimal', () => {
        expect(formatAnchorLength(4.3, 'm', { decimals: 1 })).toBe('4.3 m');
        expect(formatAnchorLength(4.3, 'ft', { decimals: 1 })).toBe('14.1 ft');
        expect(formatAnchorLength(5, 'm', { decimals: 1 })).toBe('5.0 m');
    });

    it("past 1000 m it uses the viewer's distance unit, NM unless they chose km or miles", () => {
        expect(formatAnchorLength(1900, 'm', { long: 'nm' })).toBe('1.0 NM');
        expect(formatAnchorLength(1900, 'm', { long: 'km' })).toBe('1.9 km');
        expect(formatAnchorLength(1900, 'ft', { long: 'mi' })).toBe('1.2 mi');
    });

    it('says -- for a length that is not a number, never NaN', () => {
        expect(formatAnchorLength(Number.NaN, 'm')).toBe('--');
        expect(anchorLengthParts(Number.POSITIVE_INFINITY, 'ft')).toEqual({ value: '--', unit: '' });
    });

    it('splits the number from its unit for the big readout', () => {
        expect(anchorLengthParts(11, 'ft')).toEqual({ value: '36', unit: 'ft' });
        expect(anchorLengthParts(1900, 'm')).toEqual({ value: '1.0', unit: 'NM' });
    });
});

describe('ShoreWatchReadings, in the viewer’s units', () => {
    it('in feet: 11 m, 50 m, 45 m and 4.3 m read 36 ft, 164 ft, 148 ft and 14.1 ft', () => {
        const { metrics, overlay } = render(data(), { lengthUnit: 'ft' });
        expect(overlay?.textContent).toContain('36');
        expect(overlay?.textContent).toContain('ft');
        expect(overlay?.textContent).not.toMatch(/\bm\b/);
        expect(metrics['Swing Radius']).toBe('164 ft');
        expect(metrics.Rode).toBe('148 ft');
        expect(metrics.Depth).toBe('14.1 ft');
    });

    it('in metres the readings are unchanged', () => {
        const { metrics, overlay } = render(data(), { lengthUnit: 'm' });
        expect(overlay?.textContent?.replace(/\s+/g, '')).toBe('fromanchor11m');
        expect(metrics['Swing Radius']).toBe('50 m');
        expect(metrics.Rode).toBe('45 m');
        expect(metrics.Depth).toBe('4.3 m');
        expect(metrics['Last Update']).toBeTruthy();
    });

    it('a distance of 1,900 m reads 1.0 NM on the radar', () => {
        const { overlay } = render(data({ distance: 1900, isAlarm: true }), { lengthUnit: 'ft' });
        expect(overlay?.textContent).toContain('1.0');
        expect(overlay?.textContent).toContain('NM');
    });

    it("the real radar replaces the ring, labelled in the viewer's units", () => {
        const { radar } = render(data(), { lengthUnit: 'ft' });
        expect(radar).not.toBeNull();
        const label = radar!.getAttribute('aria-label')!;
        expect(label).toContain('36 ft from the anchor');
        expect(label).toContain('164 ft');
        expect(label).not.toContain('last-known');
    });

    it('a stale radar is dimmed and says last-known, in its label and its overlay', () => {
        const { radar, overlay } = render(data(), { fresh: false, lengthUnit: 'm' });
        expect(radar!.getAttribute('aria-label')).toContain('last-known');
        expect(radar!.getAttribute('class')).toContain('opacity-60');
        expect(overlay?.textContent).toContain('last-known from anchor');
    });

    it("says when the trail drawn starts: its first half-minute, in the viewer's clock", () => {
        const trail = [
            { ...HORTA, timestamp: NOW - 60_000 },
            { latitude: 38.5302, longitude: -28.6202, timestamp: NOW - 30_000 },
            { latitude: 38.5301, longitude: -28.6201, timestamp: NOW },
        ];
        const since = new Date(NOW - 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        expect(render(data()).container.textContent).not.toContain('Trail since');
        const { container, radar } = render(data(), { trail });
        expect(container.textContent).toContain(`Trail since ${since}`);
        expect(radar!.getAttribute('aria-label')).toContain(`Her trail since ${since} is drawn.`);
    });

    it('a phone that slept: the old run is not drawn and no trail is claimed for the gap', () => {
        // Heard 5 h ago, then nothing until this one half-minute.
        const trail = [
            { ...HORTA, timestamp: NOW - 5 * 3_600_000 - 30_000 },
            { ...HORTA, timestamp: NOW - 5 * 3_600_000 },
            { latitude: 38.5301, longitude: -28.6201, timestamp: NOW },
        ];
        const { container, radar } = render(data(), { trail });
        expect(container.textContent).not.toContain('Trail since');
        expect(radar!.getAttribute('aria-label')).not.toContain('trail');
    });

    // Review 126-03a: the distance sat over the circle's north-west arc on a
    // small radar, over the boat when she lay there. It is now beside the
    // canvas, in its own column, so nothing is drawn under it.
    it('puts the distance beside the radar canvas, never over it', () => {
        const { overlay, radar } = render(data());
        expect(overlay!.getAttribute('class')).not.toContain('absolute');
        expect(overlay!.contains(radar)).toBe(false);
        expect(radar!.parentElement!.contains(overlay)).toBe(false);
    });

    it('keeps the bottom-left corner of the radar for an action', () => {
        const { container } = render(data(), { radarAction: <button type="button">Move anchor</button> });
        const slot = container.querySelector('[data-testid="shore-radar-action"]');
        expect(slot?.textContent).toBe('Move anchor');
        expect(slot?.getAttribute('class')).toContain('bottom-');
        expect(slot?.getAttribute('class')).toContain('left-');
    });
});

describe('ShoreWatchReadings, live depth and wind (126-05)', () => {
    const live = (over: Record<string, unknown> = {}) =>
        ({
            depthM: 3.2,
            depthReference: 'below-keel',
            depthAt: NOW - 10_000,
            twsKn: 18,
            twsAt: NOW - 10_000,
            twdDeg: 135,
            twdAt: NOW - 10_000,
            ...over,
        }) as PositionBroadcast['live'];

    it('shows no Depth below keel or Wind row when the broadcast has no live block', () => {
        const { metrics } = render(data());
        expect(Object.keys(metrics)).toEqual(['Swing Radius', 'Rode', 'Depth', 'Last Update']);
        expect(render(data({ live: {} })).metrics).not.toHaveProperty('Wind');
    });

    it('shows depth below the keel and the wind, in knots and degrees true', () => {
        const { metrics } = render(data({ live: live() }));
        expect(Object.keys(metrics)).toEqual([
            'Swing Radius',
            'Rode',
            'Depth',
            'Last Update',
            'Depth below keel',
            'Wind',
        ]);
        expect(metrics['Depth below keel']).toBe('3.2 m');
        expect(metrics.Wind).toBe('18 kn · 135°T');
    });

    it.each([
        ['kmh', '33.3 km/h · 135°T'],
        ['mps', '9.3 m/s · 135°T'],
        ['mph', '20.7 mph · 135°T'],
    ] as const)('wind in %s reads %s', (speedUnit, words) => {
        expect(render(data({ live: live() }), { speedUnit }).metrics.Wind).toBe(words);
    });

    it('depth below the keel in feet', () => {
        expect(render(data({ live: live() }), { lengthUnit: 'ft' }).metrics['Depth below keel']).toBe('10.5 ft');
    });

    it('a north-easterly reads 045°T', () => {
        expect(render(data({ live: live({ twdDeg: 45 }) })).metrics.Wind).toBe('18 kn · 045°T');
    });

    it('names the depth the Pi had when it was not below the keel', () => {
        expect(render(data({ live: live({ depthReference: 'below-transducer' }) })).metrics).toHaveProperty(
            'Depth below transducer',
        );
        expect(render(data({ live: live({ depthReference: 'below-waterline' }) })).metrics).toHaveProperty(
            'Depth below surface',
        );
    });

    it('says how old a reading is past two minutes, and drops it past fifteen', () => {
        const fiveMin = render(data({ live: live({ depthAt: NOW - 5 * 60_000, twsAt: NOW - 5 * 60_000 }) })).metrics;
        expect(fiveMin['Depth below keel']).toBe('3.2 m (5 min ago)');
        expect(fiveMin.Wind).toBe('18 kn · 135°T (5 min ago)');
        const old = render(
            data({ live: live({ depthAt: NOW - 20 * 60_000, twsAt: NOW - 20 * 60_000, twdAt: NOW - 20 * 60_000 }) }),
        ).metrics;
        expect(old).not.toHaveProperty('Depth below keel');
        expect(old).not.toHaveProperty('Wind');
    });

    it('a value that is not a number is not shown', () => {
        const { metrics } = render(data({ live: live({ depthM: Number.NaN, twsKn: Number.NaN }) }));
        expect(metrics).not.toHaveProperty('Depth below keel');
        // The direction alone is still a reading.
        expect(metrics.Wind).toBe('135°T');
    });
});
