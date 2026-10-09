import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { packagedFetch } from './helpers/packagedFetch';
vi.mock('@capacitor/core', () => ({
    CapacitorHttp: {
        get: vi.fn().mockResolvedValue({
            status: 200,
            data: {
                lat: '-20.347503',
                lon: '148.949890',
                name: 'Marina Walk',
                type: 'footway',
                address: { city_district: 'Whitsundays', village: 'Hamilton Island', state: 'Queensland' },
            },
        }),
    },
}));
import { CapacitorHttp } from '@capacitor/core';
import {
    detailedEndpointName,
    marineEndpointName,
    selectMarineEndpointName,
    type MarineLocality,
} from '../services/marineEndpointName';

const place = (name: string, lat: number, lon: number, kind: MarineLocality['kind'] = 'island'): MarineLocality => ({
    id: name,
    name,
    lat,
    lon,
    kind,
});

// The regional reference is a packaged data file (public/data, build 126),
// read with a same-origin fetch; the stub serves it from public/.
beforeAll(() => vi.stubGlobal('fetch', packagedFetch()));
afterAll(() => vi.unstubAllGlobals());

describe('marine endpoint labels', () => {
    it('resolves Daydream offline and disambiguates Hamilton with its local village, not its district or street', async () => {
        expect(await marineEndpointName(-20.2543216666667, 148.815016666667)).toBe('Daydream Island');
        expect(CapacitorHttp.get).not.toHaveBeenCalled();
        expect(await marineEndpointName(-20.3475033333333, 148.949890666667)).toBe('Hamilton Island');
        await marineEndpointName(-20.3475033333333, 148.949890666667);
        expect(CapacitorHttp.get).toHaveBeenCalledOnce();
    });

    it('rejects distant reverse matches, businesses, streets and broad regions', () => {
        expect(detailedEndpointName({ lat: -17.59, lon: 146.6, address: { city: 'Far Away' } }, -20, 149)).toBeNull();
        expect(
            detailedEndpointName(
                { lat: -20, lon: 149, name: 'Cafe', address: { road: 'Marina Walk', city_district: 'Whitsundays' } },
                -20,
                149,
            ),
        ).toBeNull();
        expect(detailedEndpointName({ address: { island: 'Some Island' } }, -20, 149)).toBeNull();
    });

    it('prefers a close named cove to its island', () => {
        expect(
            selectMarineEndpointName(-20, 149, [
                place('An Island', -20.01, 149),
                place('Quiet Cove', -20.001, 149, 'cove'),
            ]),
        ).toBe('Quiet Cove');
    });

    it('does not claim a distant island or bay for an offshore endpoint', () => {
        expect(
            selectMarineEndpointName(-20, 149, [
                place('Distant Island', -20.02, 149),
                place('Distant Bay', -20.01, 149, 'bay'),
            ]),
        ).toBeNull();
    });

    it('refuses ambiguous neighbouring islands and ignores duplicate records of the same name', () => {
        expect(
            selectMarineEndpointName(-20, 149, [
                place('East Island', -20, 149.001),
                place('West Island', -20, 148.999),
            ]),
        ).toBeNull();
        expect(
            selectMarineEndpointName(-20, 149, [place('Same Island', -20, 149), place('Same Island', -20, 149)]),
        ).toBe('Same Island');
    });

    it('falls back outside current regional coverage and rejects invalid coordinates', async () => {
        expect(await marineEndpointName(48, -4)).toBeNull();
        expect(selectMarineEndpointName(NaN, 149, [place('Island', -20, 149)])).toBeNull();
    });
});
