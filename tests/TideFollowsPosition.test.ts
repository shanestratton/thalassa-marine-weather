/**
 * The tide station follows the boat.
 *
 * Shane, 2026-09-06: "the tide location name in the bottom left hand corner
 * of the tide graph does not update dynamically … as well as the tide graph
 * itself". The follower renamed the location at 0.5 NM but tides only came
 * with the 30 NM forecast refetch; stations sit a few miles apart.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIDE_REFRESH_NM, tideNeedsRefresh } from '../utils/gpsFollow';
import { interpolateTideHourly } from '../services/weather/api/tides';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the tide station follows the boat', () => {
    it('asks for tides again after a few miles, not thirty', () => {
        expect(TIDE_REFRESH_NM).toBe(3);
        const fetchedFor = { lat: -27.2, lon: 153.11 };
        expect(tideNeedsRefresh(fetchedFor, { lat: -27.21, lon: 153.11 })).toBe(false); // ~0.6 NM
        expect(tideNeedsRefresh(fetchedFor, { lat: -27.26, lon: 153.11 })).toBe(true); // ~3.6 NM
        expect(tideNeedsRefresh(null, { lat: -27.26, lon: 153.11 })).toBe(false); // nothing fetched yet
    });

    it('draws the same half-hourly cosine curve the full fetch does', () => {
        const points = interpolateTideHourly([
            { time: '2026-09-06T06:00:00.000Z', type: 'Low', height: 0.4 },
            { time: '2026-09-06T00:00:00.000Z', type: 'High', height: 2.4 },
        ]);
        expect(points).toHaveLength(12);
        expect(points[0]).toEqual({ time: '2026-09-06T00:00:00.000Z', height: 2.4 });
        expect(points[6].height).toBeCloseTo(1.4, 6); // halfway in time is halfway in height on a cosine
        expect(points[11].height).toBeGreaterThan(0.4);
        expect(interpolateTideHourly([])).toEqual([]);
    });

    it('the follower refreshes tides on a rename hop and the full fetch shares the curve helper', () => {
        const context = read('context/WeatherContext.tsx');
        const rename = context.slice(
            context.indexOf('// Inside the 30 NM bubble'),
            context.indexOf('// Immediate first tick'),
        );
        expect(rename).toContain('tideNeedsRefresh(tidePointRef.current, { lat: latitude, lon: longitude })');
        expect(rename).toContain('fetchTidesForPosition(latitude, longitude)');
        expect(rename).toContain('tideGUIDetails: tides.tideGUIDetails ?? current.tideGUIDetails');
        expect(context).toContain('tidePointRef.current = { lat: d.coordinates.lat, lon: d.coordinates.lon };');
        expect(read('services/weather/index.ts')).toContain(
            'const interpolated = interpolateTideHourly(tideData.tides);',
        );
    });
});
