import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    colourNames,
    matchesMooringColour,
    mergeMooringReferences,
    parseOsmReferences,
    parseQpwsReferences,
    referenceQuery,
    referenceTiles,
} from '../services/anchorages/cruisingReference';
import { mooringIcon, mooringPopup } from '../components/map/cruisingReferencePresentation';

const retrieved = '2026-09-23T00:00:00Z';
const buoy = (tags: Record<string, string>, extra = {}) => ({
    type: 'node',
    id: 1,
    lat: -20.07,
    lon: 148.92,
    tags,
    ...extra,
});
const parse = (tags: Record<string, string>, extra = {}) =>
    parseOsmReferences({ elements: [buoy(tags, extra)] }, retrieved);
describe('Mooring data, not an access/suitability classifier', () => {
    it.each<Record<string, string>>([
        { anchoring: 'no' },
        { anchorage: 'prohibited' },
        { 'seamark:anchorage:restriction': 'anchoring_prohibited' },
        { 'seamark:restriction': 'restricted_entry' },
        { 'seamark:restricted_area:restriction': 'anchoring_prohibited' },
        { 'seamark:anchorage:access': 'private' },
        { boat: 'no' },
        { 'access:conditional': 'no @ (Oct-Apr)' },
        { 'motorboat:conditional': 'no @ (Oct-Apr)' },
        { 'sailboat:conditional': 'no @ (Oct-Apr)' },
        { boat: 'destination', access: 'yes' },
        { 'seamark:anchorage:access': 'destination', access: 'yes' },
    ])('preserves explicit OSM restriction tags for strict planner exclusion: %j', (tags) => {
        const [p] = parse({ 'seamark:type': 'anchorage', ...tags });
        expect(p.restrictionNotes?.length).toBeGreaterThan(0);
        expect(p.restrictionNotes?.join(' ')).toContain(Object.values(tags)[0]);
    });
    it('marks current restriction parsing without inventing public access', () => {
        const [p] = parse({ 'seamark:type': 'anchorage' });
        expect(p.restrictionNotes).toEqual([]);
        expect(p.access).toContain('Unknown');
        expect(parse({ 'seamark:type': 'anchorage', 'seamark:anchorage:access': 'private' })[0].access).toBe('private');
    });
    it('records blue and white body colours without inferring public access', () => {
        const [p] = parse({
            'seamark:type': 'mooring',
            'seamark:mooring:category': 'buoy',
            'seamark:mooring:colour': 'blue;white',
        });
        expect(p.colours).toEqual(['blue', 'white']);
        expect(p.access).toContain('Unknown');
        expect(p.mooringClass).toBeNull();
        expect(matchesMooringColour(p, 'blue-white')).toBe(true);
    });
    it('keeps private blue buoys private and unknown-colour buoys grey', () => {
        const [p] = parse({ mooring: 'buoy', access: 'private', colour: 'blue' });
        expect(p.access).toBe('private');
        const [unknown] = parse({ mooring: 'buoy' });
        expect(unknown.colours).toEqual([]);
        expect(matchesMooringColour(unknown, 'all')).toBe(true);
        expect(matchesMooringColour(unknown, 'blue-white')).toBe(false);
    });
    it.each(['dolphin', 'bollard', 'pile'])('excludes a %s rather than drawing a pick-up buoy', (category) => {
        expect(parse({ 'seamark:type': 'mooring', 'seamark:mooring:category': category })).toEqual([]);
    });
    it('excludes reef-protection and other special-purpose buoys', () => {
        expect(
            parse({
                'seamark:type': 'buoy_special_purpose',
                'seamark:buoy_special_purpose:category': 'marine_farm',
                colour: 'white;blue',
            }),
        ).toEqual([]);
    });
    it('supports explicitly tagged special-purpose mooring buoys', () => {
        expect(
            parse({ 'seamark:type': 'buoy_special_purpose', 'seamark:buoy_special_purpose:category': 'mooring' })[0]
                .kind,
        ).toBe('mooring');
    });
    it('marks area centres as approximate and separates anchorages from moorings', () => {
        const [p] = parse(
            { 'seamark:type': 'anchorage' },
            { type: 'way', lat: undefined, lon: undefined, center: { lat: -20, lon: 149 } },
        );
        expect(p.kind).toBe('anchorage');
        expect(p.approximate).toBe(true);
    });
    it('rejects malformed positions, errors, truncated and partial responses', () => {
        expect(parse({ mooring: 'buoy' }, { lat: 100 })).toEqual([]);
        expect(() => parseOsmReferences({ elements: [], remark: 'timeout' }, retrieved)).toThrow();
        expect(() => parseOsmReferences({ elements: Array(3001).fill({}) }, retrieved)).toThrow();
        expect(() =>
            parseQpwsReferences({ features: [], properties: { exceededTransferLimit: true } }, retrieved),
        ).toThrow();
    });
    it('only accepts known colour names, not HTML/css from external tags', () => {
        expect(colourNames('white;blue;white;<script>;#ffffff;gray')).toEqual(['white', 'blue', 'grey']);
    });
    it('keeps body colour distinct from the official class band', () => {
        const snapshot = JSON.parse(readFileSync('public/anchorages/moorings/qpws.json', 'utf8'));
        const points = parseQpwsReferences(snapshot.data, snapshot.retrievedAt);
        expect(points.length).toBeGreaterThan(300);
        const butterfly = points.find((p) => p.name.includes('Butterfly') && p.mooringClass === 'B')!;
        expect(butterfly.colours).toEqual(['blue']);
        expect(butterfly.band).toBe('green');
        expect(butterfly.access).toContain('Public');
        expect(points.some((p) => p.mooringClass === 'D' && p.band === 'red')).toBe(true);
    });
    it('does not merge distinct neighbouring buoys or infer colour from an official neighbour', () => {
        const [p] = parse({ mooring: 'buoy', name: 'Private buoy', colour: 'white' });
        const o = { ...p, id: 'qpws-1', name: 'Public buoy', source: 'QPWS' as const, colours: ['blue'] };
        expect(mergeMooringReferences([o], [p])).toHaveLength(2);
        expect(mergeMooringReferences([o], [{ ...p, name: 'Public buoy' }])).toHaveLength(1);
    });
});
describe('Bounded global viewport loading', () => {
    it.each([
        [148.92, -20.07],
        [166.45, -22.27],
        [-64.6, 18.4],
        [15, 43],
        [179.9, -16.6],
    ])('supports cruising grounds at %s, %s', (lon, lat) => {
        const tiles = referenceTiles({ west: lon, east: lon + 0.1, south: lat, north: lat + 0.1 }, 12);
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThanOrEqual(8);
        expect(referenceQuery(tiles[0])).toContain('nwr');
        if (!Number.isInteger(lat)) expect(referenceQuery(tiles[0])).not.toContain(String(lat));
    });
    it('splits the dateline and caps zoomed-out requests', () => {
        const tiles = referenceTiles({ west: 179.8, east: -179.8, south: -17.2, north: -17.1 }, 12);
        expect(tiles.map((t) => t.west)).toEqual([179, -180]);
        expect(referenceTiles({ west: -180, east: 180, south: -80, north: 80 }, 3)).toEqual([]);
        expect(referenceTiles({ west: 0, east: 4, south: 0, north: 3 }, 9)).toEqual([]);
    });
});
describe('Mooring presentation', () => {
    it('escapes all external text and refuses unsafe cached links', () => {
        const p = parse({ mooring: 'buoy', name: '<img onerror=alert(1)>', description: '<script>x</script>' })[0];
        const html = mooringPopup({ ...p, sourceUrl: 'javascript:alert(1)' });
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('Not recorded');
        expect(html).toContain('No live occupancy');
    });
    it('draws separate white and blue/green-band symbols with unknown neutral', () => {
        const blue = mooringIcon(['blue'], 'green'),
            white = mooringIcon(['white'], null),
            unknown = mooringIcon([], null);
        expect(blue.data.length).toBe(56 * 56 * 4);
        expect(blue.data).not.toEqual(white.data);
        expect(unknown.data).not.toEqual(blue.data);
    });
});
