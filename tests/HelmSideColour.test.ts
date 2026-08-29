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
import { PORT_RED, SIDE_DEAD_BAND, STBD_GREEN, sideColour } from '../components/nmea/sideColour';

describe('port / starboard colour', () => {
    it('matches the dead-band the Heading panel already used', () => {
        expect(SIDE_DEAD_BAND).toBe(0.3);
    });

    it('paints a negative helm PORT red', () => {
        expect(sideColour(-30.2)).toBe(PORT_RED);
        expect(sideColour(-90)).toBe(PORT_RED);
        // -0.1 used to be red here. It is inside the dead-band added
        // 2026-08-30, and a tenth of a degree of rudder is not a side.
        expect(sideColour(-0.1)).toBeNull();
    });

    it('paints a positive helm STARBOARD green', () => {
        expect(sideColour(30.2)).toBe(STBD_GREEN);
        expect(sideColour(0.1)).toBeNull();
    });

    it('leaves amidships neutral rather than calling it a side', () => {
        // A rudder dead centre is not "slightly to port". Colouring 0 red would
        // put a red helm on a boat steering straight.
        expect(sideColour(0)).toBeNull();
        expect(sideColour(-0)).toBeNull();
    });

    it('dead-bands the jitter, so a still boat does not strobe red/green', () => {
        // Taken from the heel readout on the Heading panel and its stated
        // reason: an XDR that idles at 0.2° would otherwise flip PORT/STBD
        // every second and look broken. A rudder sensor near centre does the
        // same, so both use it.
        expect(sideColour(0.3)).toBeNull();
        expect(sideColour(-0.3)).toBeNull();
        expect(sideColour(0.2)).toBeNull();
        expect(sideColour(0.4)).toBe(STBD_GREEN);
        expect(sideColour(-0.4)).toBe(PORT_RED);
    });

    it('lets a caller widen or disable the dead-band', () => {
        expect(sideColour(0.2, 0)).toBe(STBD_GREEN);
        expect(sideColour(2, 5)).toBeNull();
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

    it('colours Heel by side too, rather than a fixed violet', () => {
        const heel = source.slice(source.indexOf('label="Heel"'), source.indexOf('label="Heel"') + 260);
        expect(heel).toContain('sideColoured');
        expect(heel).not.toContain('text-violet-300');
    });

    it('drops the minus sign, but only AFTER the colour is decided', () => {
        // Stripping the sign first would make every reading starboard green.
        const decideAt = source.indexOf('const sideTone = sideColoured ? sideColour(shown)');
        const stripAt = source.indexOf('const display = sideColoured && shown !== null ? Math.abs(shown)');
        expect(decideAt).toBeGreaterThan(-1);
        expect(stripAt).toBeGreaterThan(decideAt);
    });

    it('decides from the DISPLAYED value, so colour cannot contradict the number', () => {
        // -0.04 prints as 0.0 at one decimal; painting that red would show a
        // red helm beside a number reading dead centre.
        expect(source).toContain('const shown = has ? Number(text) : null;');
        expect(source).toContain('sideColoured ? sideColour(shown) : null');
    });
});
