/**
 * encNavaidIconId — unknown-attribute fallbacks (2026-07-17 audit #8):
 * a mark with no CATLAM/CATCAM must assert PRESENCE (neutral glyph),
 * never a specific passing rule. The old fallbacks painted a north
 * cardinal / port-hand can the data never carried.
 */
import { describe, expect, it } from 'vitest';

import { encNavaidIconId } from '../../services/enc/types';

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
});
