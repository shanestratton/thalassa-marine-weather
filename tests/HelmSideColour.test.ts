/**
 * The helm reads red to port and green to starboard.
 *
 * Shane, 2026-08-30, watching HELM sit at -30.2 in amber while the yard
 * antifouled around a rudder hard over to port: the number said port, the
 * colour said nothing. Red/green is the pair a sailor reads without thinking,
 * and it is already what the wind rose beside it uses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PORT_RED, STBD_GREEN, sideColour } from '../components/nmea/sideColour';

describe('port / starboard colour', () => {
    it('paints a negative helm PORT red', () => {
        expect(sideColour(-30.2)).toBe(PORT_RED);
        expect(sideColour(-0.1)).toBe(PORT_RED);
        expect(sideColour(-90)).toBe(PORT_RED);
    });

    it('paints a positive helm STARBOARD green', () => {
        expect(sideColour(30.2)).toBe(STBD_GREEN);
        expect(sideColour(0.1)).toBe(STBD_GREEN);
    });

    it('leaves amidships neutral rather than calling it a side', () => {
        // A rudder dead centre is not "slightly to port". Colouring 0 red would
        // put a red helm on a boat steering straight.
        expect(sideColour(0)).toBeNull();
        expect(sideColour(-0)).toBeNull();
    });

    it('has no opinion when there is no reading', () => {
        expect(sideColour(null)).toBeNull();
        expect(sideColour(undefined)).toBeNull();
        expect(sideColour(NaN)).toBeNull();
        expect(sideColour(Infinity)).toBeNull();
    });

    it('uses the rose’s own two colours, not a second pair', () => {
        // SereneWindRose pins these in its palette; the helm must match exactly
        // or the panel ends up with two reds meaning the same thing.
        const rose = readFileSync('components/nmea/gauges/SereneWindRose.tsx', 'utf8');
        expect(rose).toContain(PORT_RED);
        expect(rose).toContain(STBD_GREEN);
    });
});

describe('the helm tile is wired to it', () => {
    const source = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

    it('colours Helm by side and no longer hardcodes amber', () => {
        const helm = source.slice(source.indexOf('label="Helm"'), source.indexOf('label="Helm"') + 260);
        expect(helm).toContain('sideColoured');
        expect(helm).not.toContain('text-amber-300');
    });

    it('decides from the DISPLAYED value, so colour cannot contradict the number', () => {
        // -0.04 prints as 0.0 at one decimal; painting that red would show a
        // red helm beside a number reading dead centre.
        expect(source).toContain('const shown = has ? Number(text) : null;');
        expect(source).toContain('sideColoured ? sideColour(shown) : null');
    });
});
