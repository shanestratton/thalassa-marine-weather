/**
 * encNavaidIconId — unknown-attribute fallbacks (2026-07-17 audit #8):
 * a mark with no CATLAM/CATCAM must assert PRESENCE (neutral glyph),
 * never a specific passing rule. The old fallbacks painted a north
 * cardinal / port-hand can the data never carried.
 */
import { describe, expect, it } from 'vitest';

import { encNavaidIconId, readS57 } from '../../services/enc/types';

describe('encNavaidIconId unknown-attribute fallbacks', () => {
    it('known CATCAM quadrants map to their cardinals', () => {
        expect(encNavaidIconId('BOYCAR', { CATCAM: 1 }, 'A')).toBe('sm-cardinal-north');
        expect(encNavaidIconId('BOYCAR', { CATCAM: '3' }, 'A')).toBe('sm-cardinal-south');
    });

    it('missing/garbage CATCAM renders the neutral unknown mark, NEVER a north cardinal', () => {
        expect(encNavaidIconId('BOYCAR', {}, 'A')).toBe('sm-mark-unknown');
        expect(encNavaidIconId('BCNCAR', { CATCAM: 'x' }, 'A')).toBe('sm-mark-unknown');
        expect(encNavaidIconId('BOYCAR', null, 'B')).toBe('sm-mark-unknown');
    });

    it('missing CATLAM renders the neutral unknown mark, never a port-hand can', () => {
        expect(encNavaidIconId('BOYLAT', {}, 'A')).toBe('sm-mark-unknown');
        expect(encNavaidIconId('BCNLAT', { CATLAM: '9' }, 'A')).toBe('sm-mark-unknown');
    });

    it('known CATLAM hands still map by region', () => {
        expect(encNavaidIconId('BOYLAT', { CATLAM: 1 }, 'A')).toBe('sm-buoy-port');
        expect(encNavaidIconId('BOYLAT', { CATLAM: 1 }, 'B')).toBe('sm-buoy-port-b');
        expect(encNavaidIconId('BOYLAT', { CATLAM: 2 }, 'A')).toBe('sm-buoy-starboard');
    });

    // Preferred-channel marks (cycle-5 re-audit #6/#7): CATLAM value 3 =
    // preferred channel to STARBOARD (a modified port mark), 4 = to PORT. This
    // locks the mapping so a comment-driven "fix" can't silently ship the
    // wrong-side glyph (the docstring used to invert 3/4).
    it('CATLAM 3 = preferred-channel-to-starboard glyph, 4 = to-port, buoys + beacons', () => {
        expect(encNavaidIconId('BOYLAT', { CATLAM: 3 }, 'A')).toBe('sm-buoy-prefchan-stbd');
        expect(encNavaidIconId('BCNLAT', { CATLAM: 3 }, 'A')).toBe('sm-beacon-prefchan-stbd');
        expect(encNavaidIconId('BOYLAT', { CATLAM: 4 }, 'A')).toBe('sm-buoy-prefchan-port');
        expect(encNavaidIconId('BCNLAT', { CATLAM: 4 }, 'A')).toBe('sm-beacon-prefchan-port');
    });

    it('preferred-channel glyphs invert for IALA region B', () => {
        expect(encNavaidIconId('BOYLAT', { CATLAM: 3 }, 'B')).toBe('sm-buoy-prefchan-stbd-b');
        expect(encNavaidIconId('BCNLAT', { CATLAM: 3 }, 'B')).toBe('sm-beacon-prefchan-stbd-b');
        expect(encNavaidIconId('BOYLAT', { CATLAM: 4 }, 'B')).toBe('sm-buoy-prefchan-port-b');
        expect(encNavaidIconId('BCNLAT', { CATLAM: 4 }, 'B')).toBe('sm-beacon-prefchan-port-b');
    });
});

describe('readS57 — case-defensive property read (audit: ~50 hand-repeated pairs)', () => {
    it('prefers the uppercase key, falls back to lowercase (ogr2ogr cells)', () => {
        expect(readS57({ DRVAL1: 5 }, 'DRVAL1')).toBe(5);
        expect(readS57({ drval1: '3.2' }, 'DRVAL1')).toBe('3.2');
        expect(readS57({ DRVAL1: 5, drval1: 9 }, 'DRVAL1')).toBe(5);
    });
    it('null/absent props read undefined, never throw', () => {
        expect(readS57(null, 'OBJNAM')).toBeUndefined();
        expect(readS57(undefined, 'OBJNAM')).toBeUndefined();
        expect(readS57({}, 'OBJNAM')).toBeUndefined();
    });
});
