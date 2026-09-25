import { describe, expect, it } from 'vitest';
import {
    assessPlaceConditions,
    type ConditionsForecast,
    type ConditionsPlace,
} from '../services/anchorages/placeConditions';
import { parseConditionsForecast } from '../services/anchorages/PlaceConditionsService';
import { mooringIcon } from '../components/map/cruisingReferencePresentation';
const now = Date.UTC(2026, 8, 23, 3, 25);
const place: ConditionsPlace = { id: 'cove', lat: -20, lon: 149, kind: 'anchorage', fetchLandNM: Array(36).fill(0.3) };
const forecast = (): ConditionsForecast => ({
    lat: -20,
    lon: 149,
    fetchedAt: now,
    hours: Array.from({ length: 14 }, (_, i) => ({
        t: Date.UTC(2026, 8, 23, 3 + i),
        wind: 12,
        gust: 17,
        direction: 135,
        weatherCode: 0,
        waveM: 0.3,
        waveDirection: 135,
        wavePeriod: 5,
    })),
});
describe('Weather traffic lights', () => {
    it('a cove with complete fresh favourable weather is green', () =>
        expect(assessPlaceConditions(place, forecast(), now).light).toBe('green'));
    it.each(['gust', 'waveM', 'waveDirection', 'wavePeriod', 'weatherCode'] as const)(
        'missing %s never means calm',
        (field) => {
            const f = forecast();
            delete f.hours[5][field];
            expect(assessPlaceConditions(place, f, now).light).toBe('unknown');
        },
    );
    it('missing shelter, approximate area centres and marinas cannot be green', () => {
        for (const p of [
            { ...place, fetchLandNM: undefined },
            { ...place, approximate: true },
            { ...place, kind: 'marina' },
        ])
            expect(assessPlaceConditions(p, forecast(), now).light).toBe('unknown');
    });
    it('stale and distant weather stay unknown', () => {
        expect(assessPlaceConditions(place, { ...forecast(), fetchedAt: now - 16 * 60_000 }, now).light).toBe(
            'unknown',
        );
        expect(assessPlaceConditions(place, { ...forecast(), lat: -21 }, now).light).toBe('unknown');
    });
    it('gaps, duplicated hours and truncated end coverage cannot produce green', () => {
        const f = forecast();
        f.hours.splice(4, 1);
        expect(assessPlaceConditions(place, f, now).light).toBe('unknown');
        f.hours.push(f.hours[3]);
        expect(assessPlaceConditions(place, f, now).light).toBe('unknown');
        const g = forecast();
        g.hours.pop();
        expect(assessPlaceConditions(place, g, now).light).toBe('unknown');
    });
    it('worst late shift wins, not the calm average', () => {
        const p = { ...place, fetchLandNM: Array.from({ length: 36 }, (_, i) => (i >= 24 && i <= 30 ? 15 : 0.3)) };
        const f = forecast();
        f.hours[10] = { ...f.hours[10], direction: 270, wind: 22, gust: 28 };
        expect(assessPlaceConditions(p, f, now).light).toBe('red');
    });
    it('shelter cannot hide strong wind, gusts, thunderstorms or prohibitions', () => {
        for (const h of [{ wind: 30, gust: 40 }, { gust: 36 }, { weatherCode: 95 }]) {
            const f = forecast();
            Object.assign(f.hours[5], h);
            expect(assessPlaceConditions(place, f, now).light).toBe('red');
        }
        expect(assessPlaceConditions({ ...place, noAnchoring: true }, undefined, now).light).toBe('red');
    });
    it('known adverse weather remains red with missing wave data', () => {
        const f = forecast();
        delete f.hours[0].waveM;
        f.hours[3].gust = 40;
        expect(assessPlaceConditions(place, f, now).light).toBe('red');
    });
    it('moderate concern is amber and long-period swell is not automatically blocked', () => {
        const f = forecast();
        f.hours[1].gust = 27;
        expect(assessPlaceConditions(place, f, now).light).toBe('amber');
        f.hours[1].gust = 17;
        f.hours[4].waveM = 0.6;
        f.hours[4].wavePeriod = 12;
        expect(assessPlaceConditions(place, f, now).light).toBe('amber');
    });
    it('mooring class and vessel size are independent of buoy body colour', () => {
        const p = {
            ...place,
            kind: 'mooring',
            source: 'QPWS',
            mooringClass: 'B',
            vessel: { lengthM: 16, hullType: 'monohull' },
        };
        expect(assessPlaceConditions(p, forecast(), now).light).toBe('green');
        expect(assessPlaceConditions({ ...p, mooringClass: 'T' }, forecast(), now).light).toBe('red');
        expect(assessPlaceConditions({ ...p, vessel: undefined }, forecast(), now).light).toBe('unknown');
        expect(assessPlaceConditions({ ...p, source: 'OpenStreetMap' }, forecast(), now).light).toBe('unknown');
        const f = forecast();
        f.hours[2].gust = 25;
        expect(assessPlaceConditions({ ...p, mooringClass: 'C' }, f, now).light).toBe('red');
    });
    it('weather ring preserves actual buoy and band pixel colours', () => {
        const a = mooringIcon(['blue'], 'green', 'red').data;
        const b = mooringIcon(['blue'], 'green', 'unknown').data;
        expect(a.slice((27 * 56 + 27) * 4, (27 * 56 + 27) * 4 + 4)).toEqual(
            b.slice((27 * 56 + 27) * 4, (27 * 56 + 27) * 4 + 4),
        );
        expect(a).not.toEqual(b);
    });
    it('rejects unrelated forecast responses and never interprets nulls or wrong units as zero', () => {
        const r = {
            latitude: -20,
            longitude: 149,
            hourly: { time: [now / 1000], wind_speed_10m: [null] },
            hourly_units: { wind_speed_10m: 'kn' },
        };
        expect(parseConditionsForecast(r, undefined, place, now).hours[0].wind).toBeUndefined();
        expect(parseConditionsForecast({ ...r, latitude: 0 }, undefined, place, now).hours).toEqual([]);
        expect(
            parseConditionsForecast(
                {
                    ...r,
                    hourly: { time: [now / 1000], wind_speed_10m: [20] },
                    hourly_units: { wind_speed_10m: 'km/h' },
                },
                undefined,
                place,
                now,
            ).hours[0].wind,
        ).toBeUndefined();
    });
});
