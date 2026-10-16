import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { aisDisplayPasses, aisDisplayMmsiFilter, normaliseAisDisplayFilters } from '../services/ais/aisFilter';
import { AisStore } from '../services/AisStore';
import { publishAisTargetPicture, readAisTargetPicture, searchAisTargetPicture } from '../services/ais/aisTargetCache';
import { gradeCollisionTargets } from '../services/AisGuardWatch';

const props = { mmsi: 503123456, shipType: 36, sog: 4, navStatus: 0, source: 'local' };
const restrictive = { vesselType: 'cargo', minSpeedKn: 10, hideMoored: true, source: 'internet' } as const;
const feature = (p = props): GeoJSON.Feature<GeoJSON.Point> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [153, -27] },
    properties: p,
});

afterEach(() => {
    AisStore.stop();
    publishAisTargetPicture([]);
});

describe('AIS display choices', () => {
    it('defaults to every vessel and bounds corrupt account preferences', () => {
        expect(aisDisplayPasses(props)).toBe(true);
        expect(normaliseAisDisplayFilters({ minSpeedKn: -1 })).toEqual({
            vesselType: 'all',
            minSpeedKn: 0,
            hideMoored: false,
            source: 'all',
        });
        expect(normaliseAisDisplayFilters({ minSpeedKn: NaN }).minSpeedKn).toBe(0);
    });
    it('combines type, moored state, minimum speed and source for ordinary targets', () => {
        expect(aisDisplayPasses(props, { vesselType: 'cargo' })).toBe(false);
        expect(aisDisplayPasses(props, { vesselType: 'sailing', minSpeedKn: 4, source: 'local' })).toBe(true);
        expect(aisDisplayPasses({ ...props, navStatus: 5 }, { hideMoored: true })).toBe(false);
        expect(aisDisplayPasses({ ...props, navStatus: 1 }, { hideMoored: true })).toBe(false);
        expect(aisDisplayPasses({ ...props, sog: 102.3 }, { minSpeedKn: 1 })).toBe(false);
        expect(aisDisplayPasses(props, { source: 'internet' })).toBe(false);
    });
    it.each(['CAUTION', 'DANGER'])('%s bypasses every restrictive display preference', (risk) => {
        expect(aisDisplayPasses({ ...props, navStatus: 5, sog: 0 }, restrictive, risk)).toBe(true);
    });
    it.each([970123456, 972123456, 974123456, 979123456])('every 97x beacon stays visible (%s)', (mmsi) => {
        expect(aisDisplayPasses({ ...props, mmsi, sog: 0, navStatus: 5 }, restrictive)).toBe(true);
    });
    it('builds a map mask without dropping or mutating source features', () => {
        const features = [feature(), feature({ ...props, mmsi: 503123457 })];
        expect(aisDisplayMmsiFilter(features, restrictive, new Map([[503123457, 'DANGER']]))).toEqual([
            'in',
            ['to-number', ['get', 'mmsi']],
            ['literal', [503123457]],
        ]);
        expect(features).toHaveLength(2);
        expect(features[0].properties).toEqual(props);
    });
    it('the fixed collision grading is independent of all display preferences', () => {
        const target: GeoJSON.Feature<GeoJSON.Point> = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [153, -26.99] },
            properties: { ...props, cog: 180, sog: 6, lastUpdated: Date.now() },
        };
        const candidates = gradeCollisionTargets(
            { lat: -27, lon: 153 },
            { sogKn: 6, cogDeg: 0, pair: 'offshore', source: 'nmea' },
            [target],
            { inshore: { cpaNm: 0.2, tcpaMin: 6 }, offshore: { cpaNm: 0.5, tcpaMin: 15 } },
            undefined,
            Date.now(),
            false,
        );
        expect(candidates[0].assessment.risk).toBe('DANGER');
        expect(aisDisplayPasses(target.properties, restrictive)).toBe(false);
        expect(aisDisplayPasses(target.properties, restrictive, candidates[0].assessment.risk)).toBe(true);
        for (const file of [
            'services/AisGuardWatch.ts',
            'services/CollisionAlarmService.ts',
            'utils/collisionRule.ts',
        ]) {
            expect(readFileSync(file, 'utf8')).not.toMatch(/aisDisplayFilters|from ['"].*aisFilter/);
        }
    });
});

describe('received targets without internet', () => {
    it('searches names, call signs and MMSIs locally, preferring the receiver to a cached duplicate', () => {
        AisStore.update({ ...props, name: 'MY RECEIVER BOAT', callSign: 'VK1234', lat: -27, lon: 153, aisClass: 'B' });
        publishAisTargetPicture([feature({ ...props, source: 'cloud', name: 'Older network name' } as typeof props)]);
        expect(searchAisTargetPicture('receiver')[0].properties?.source).toBe('local');
        expect(searchAisTargetPicture('vk1234')[0].properties?.aisClass).toBe('B');
        expect(searchAisTargetPicture('503123456')).toHaveLength(1);
        expect(readAisTargetPicture()).toHaveLength(1);
    });
    it('retains a cached internet target and labels local static-only reports as no position', () => {
        publishAisTargetPicture([feature({ ...props, source: 'cloud' })]);
        AisStore.update({ mmsi: 503999999, name: 'WAITING FOR FIX', aisClass: 'A' });
        expect(searchAisTargetPicture('503123456')[0].properties?.source).toBe('cloud');
        expect(searchAisTargetPicture('waiting')[0].properties?.hasPosition).toBe(false);
        expect(readAisTargetPicture()).toHaveLength(1);
    });
});
