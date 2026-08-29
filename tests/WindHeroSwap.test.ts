import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    isWindHeroId,
    TWS_ZONES,
    WIND_CAPTIONS,
    windBottomFor,
    zoneColorFor,
    type WindHeroId,
} from '../components/nmea/windHeroSlots';

const HEROES: WindHeroId[] = ['tws', 'awa', 'twa'];
const GREEN = '#22c55e';
const YELLOW = '#eab308';
const ORANGE = '#f97316';
const RED = '#ef4444';

describe('wind hero slot assignment', () => {
    it('shows all three instruments exactly once, whichever is promoted', () => {
        // The bottom pair is derived rather than stored precisely so this
        // cannot drift. Two "Apparent" roses side by side would be read as
        // apparent and true, which is worse than showing nothing.
        for (const hero of HEROES) {
            const onScreen = [hero, ...windBottomFor(hero)].sort();
            expect(onScreen).toEqual(['awa', 'twa', 'tws']);
        }
    });

    it('sends the dial to the slot the promoted rose vacated', () => {
        // "Switch places" — literally. Promoting the left rose puts the dial
        // on the left; promoting the right rose puts it on the right.
        expect(windBottomFor('awa')).toEqual(['tws', 'twa']);
        expect(windBottomFor('twa')).toEqual(['awa', 'tws']);
    });

    it('rests with the dial up top and the roses beneath', () => {
        expect(windBottomFor('tws')).toEqual(['awa', 'twa']);
    });

    it('refuses a corrupted stored value instead of rendering an empty slot', () => {
        expect(isWindHeroId('awa')).toBe(true);
        expect(isWindHeroId(null)).toBe(false);
        expect(isWindHeroId('')).toBe(false);
        expect(isWindHeroId('AWA')).toBe(false);
        expect(isWindHeroId('depth')).toBe(false);
    });

    it('names every instrument, so no promoted rose renders an empty caption', () => {
        for (const hero of HEROES) expect(WIND_CAPTIONS[hero]).toBeTruthy();
    });
});

describe('TWS band colour', () => {
    it('colours the needle by the band the reading is in', () => {
        expect(zoneColorFor(0, TWS_ZONES, GREEN)).toBe(GREEN);
        expect(zoneColorFor(12, TWS_ZONES, GREEN)).toBe(GREEN);
        expect(zoneColorFor(20, TWS_ZONES, GREEN)).toBe(YELLOW);
        expect(zoneColorFor(30, TWS_ZONES, GREEN)).toBe(ORANGE);
        expect(zoneColorFor(50, TWS_ZONES, GREEN)).toBe(RED);
    });

    it('puts a boundary reading in the band above', () => {
        // 15.0 kt is the start of yellow, not the top of green.
        expect(zoneColorFor(15, TWS_ZONES, GREEN)).toBe(YELLOW);
        expect(zoneColorFor(25, TWS_ZONES, GREEN)).toBe(ORANGE);
        expect(zoneColorFor(40, TWS_ZONES, GREEN)).toBe(RED);
        expect(zoneColorFor(14.99, TWS_ZONES, GREEN)).toBe(GREEN);
    });

    it('KEEPS a gust past the dial maximum red', () => {
        // The one that matters. A naive band lookup falls off the end of the
        // list and returns the first colour, painting a 70 kt gust GREEN —
        // the single reading that must never look calm.
        expect(zoneColorFor(60, TWS_ZONES, GREEN)).toBe(RED);
        expect(zoneColorFor(70, TWS_ZONES, GREEN)).toBe(RED);
        expect(zoneColorFor(140, TWS_ZONES, GREEN)).toBe(RED);
    });

    it('falls back rather than inventing a colour when there is no reading', () => {
        expect(zoneColorFor(null, TWS_ZONES, '#ffffff')).toBe('#ffffff');
        expect(zoneColorFor(undefined, TWS_ZONES, '#ffffff')).toBe('#ffffff');
        expect(zoneColorFor(NaN, TWS_ZONES, '#ffffff')).toBe('#ffffff');
        expect(zoneColorFor(Infinity, TWS_ZONES, '#ffffff')).toBe('#ffffff');
        expect(zoneColorFor(10, [], '#ffffff')).toBe('#ffffff');
    });
});

describe('the swap cannot break the roses', () => {
    const source = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

    it('binds gaugeKey to the instrument, never to the slot', () => {
        // Every gradient id inside the rose is namespaced with gaugeKey and
        // url(#id) resolves document-wide. A key that travelled with the slot
        // would let the two roses collide on a swap and paint one with the
        // other's needle gradient — the WRONG SIDE on opposite tacks.
        expect(source).toContain('gaugeKey="glass-awa"');
        expect(source).toContain('gaugeKey="glass-twa"');
        expect(source).not.toMatch(/gaugeKey=\{[^}]*slot/);
    });

    it('cancels the long press on movement, so a flick still scrolls', () => {
        // The panel is a vertical snap-scroller. A press that becomes a drag
        // must scroll the page, not rearrange it.
        expect(source).toContain('onTouchMove={cancel}');
        expect(source).toContain('onTouchCancel={cancel}');
    });
});
