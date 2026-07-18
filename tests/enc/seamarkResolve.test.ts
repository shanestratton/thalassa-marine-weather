/**
 * Seamark icon resolution — cycle-5 audit #6 (port-hand beacon glyph) and #7
 * (UWTROC WATLEV→rock-glyph mapping). Locks the corrected OSM-overlay beacon
 * branch and the INT1 rock mapping so a future edit can't reintroduce the
 * "every port beacon is a starboard cone" bug or transpose the K11/K12 rocks.
 */
import { describe, it, expect } from 'vitest';
import {
    resolveSeamarkIcon,
    getSeamarkIconDefs,
    UWTROC_ROCK_GLYPH,
    UWTROC_ROCK_GLYPH_DEFAULT,
} from '../../components/map/seamarkIcons';

const registeredIds = new Set(getSeamarkIconDefs().map((d) => d.id));

describe('resolveSeamarkIcon — lateral beacons resolve by HAND, not colour (#6)', () => {
    it('port-hand beacon → a CAN glyph, never the starboard cone', () => {
        // IALA-A: port is red. The old colour-only branch returned sm-beacon-red
        // (a cone) — the shape contradicted the hand.
        expect(
            resolveSeamarkIcon('beacon_lateral', { 'beacon_lateral:category': 'port', 'beacon_lateral:colour': 'red' }),
        ).toBe('sm-beacon-can-red');
        // IALA-B: port is green.
        expect(
            resolveSeamarkIcon('beacon_lateral', {
                'beacon_lateral:category': 'port',
                'beacon_lateral:colour': 'green',
            }),
        ).toBe('sm-beacon-can-green');
    });

    it('starboard-hand beacon → a CONE glyph', () => {
        expect(
            resolveSeamarkIcon('beacon_lateral', {
                'beacon_lateral:category': 'starboard',
                'beacon_lateral:colour': 'green',
            }),
        ).toBe('sm-beacon-green');
        expect(
            resolveSeamarkIcon('beacon_lateral', {
                'beacon_lateral:category': 'starboard',
                'beacon_lateral:colour': 'red',
            }),
        ).toBe('sm-beacon-red');
    });

    it('preferred-channel beacons keep their banded glyphs', () => {
        expect(resolveSeamarkIcon('beacon_lateral', { 'beacon_lateral:category': 'preferred_channel_port' })).toBe(
            'sm-beacon-prefchan-port',
        );
        expect(resolveSeamarkIcon('beacon_lateral', { 'beacon_lateral:category': 'preferred_channel_starboard' })).toBe(
            'sm-beacon-prefchan-stbd',
        );
    });

    it('no category falls back to colour → can for red, cone for green; unknown never asserts a hand', () => {
        expect(resolveSeamarkIcon('beacon_lateral', { 'beacon_lateral:colour': 'red' })).toBe('sm-beacon-can-red');
        expect(resolveSeamarkIcon('beacon_lateral', { 'beacon_lateral:colour': 'green' })).toBe('sm-beacon-green');
        expect(resolveSeamarkIcon('beacon_lateral', {})).toBe('sm-mark-unknown');
    });

    it('non-lateral beacons (cardinal/other) still route by colour — the cone is not a hand there', () => {
        expect(resolveSeamarkIcon('beacon_cardinal', { 'beacon_cardinal:colour': 'yellow' })).toBe('sm-beacon-yellow');
    });

    it('buoy_lateral resolution is unchanged', () => {
        expect(resolveSeamarkIcon('buoy_lateral', { 'buoy_lateral:category': 'port' })).toBe('sm-buoy-port');
        expect(resolveSeamarkIcon('buoy_lateral', { 'buoy_lateral:category': 'starboard' })).toBe('sm-buoy-starboard');
    });

    it('every beacon_lateral resolution returns a REGISTERED icon id', () => {
        const cases: Array<Record<string, string>> = [
            { 'beacon_lateral:category': 'port', 'beacon_lateral:colour': 'red' },
            { 'beacon_lateral:category': 'port', 'beacon_lateral:colour': 'green' },
            { 'beacon_lateral:category': 'starboard', 'beacon_lateral:colour': 'green' },
            { 'beacon_lateral:category': 'starboard', 'beacon_lateral:colour': 'red' },
            { 'beacon_lateral:category': 'preferred_channel_port' },
            { 'beacon_lateral:category': 'preferred_channel_starboard' },
            { 'beacon_lateral:colour': 'red' },
            { 'beacon_lateral:colour': 'green' },
            {},
        ];
        for (const tags of cases) {
            const id = resolveSeamarkIcon('beacon_lateral', tags);
            expect(registeredIds.has(id), `${id} not registered`).toBe(true);
        }
    });
});

describe('UWTROC rock glyph — INT1 K-section mapping is correct, not transposed (#7)', () => {
    it('WATLEV 4 (covers & uncovers, K11) → the drying asterisk', () => {
        const four = UWTROC_ROCK_GLYPH.find(([w]) => w === '4');
        expect(four?.[1]).toBe('sm-hazard-rock-drying');
    });

    it('WATLEV 5 (awash at chart datum, K12) → the dotted cross — NOT the drying asterisk', () => {
        const five = UWTROC_ROCK_GLYPH.find(([w]) => w === '5');
        expect(five?.[1]).toBe('sm-hazard-rock-awash-cd');
        // Guard the transpose the audit imagined: 4 and 5 must be distinct glyphs.
        const four = UWTROC_ROCK_GLYPH.find(([w]) => w === '4');
        expect(five?.[1]).not.toBe(four?.[1]);
    });

    it('submerged / unknown WATLEV (K13) → the plain cross default', () => {
        expect(UWTROC_ROCK_GLYPH_DEFAULT).toBe('sm-hazard-rock');
    });

    it('all three rock glyphs are registered', () => {
        for (const [, id] of UWTROC_ROCK_GLYPH) expect(registeredIds.has(id), `${id} not registered`).toBe(true);
        expect(registeredIds.has(UWTROC_ROCK_GLYPH_DEFAULT)).toBe(true);
    });
});
