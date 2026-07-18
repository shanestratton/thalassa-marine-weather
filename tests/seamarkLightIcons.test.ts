/**
 * White lights must NOT render near-white on the day chart (closing audit
 * 2026-07-18, rendering finding #2). The white-light flare renders in the
 * S-52 warm yellow-white hue LIGHT_COLOUR_HEX['1'] bakes into `_lightColor`
 * — the exact hex EncVectorLayer's LIGHTS match uses as the `sm-light-white`
 * key — so the icon's colour IS its semantic colour and it holds contrast
 * over DEPARE b20to50 (#ecf4fa) / b50plus (#ffffff).
 */
import { describe, it, expect } from 'vitest';

import { getSeamarkIconDefs } from '../components/map/seamarkIcons';
import { lightColourHex } from '../services/enc/types';

const defsById = () => new Map(getSeamarkIconDefs().map((d) => [d.id, d]));

describe('seamark light icons — white light hue', () => {
    it('registers a sm-light-white icon', () => {
        expect(defsById().has('sm-light-white')).toBe(true);
    });

    it('renders the white light in the warm yellow-white flare hue, not near-white', () => {
        const svg = defsById().get('sm-light-white')!.svg;
        const whiteLightHex = lightColourHex('1'); // S-57 COLOUR '1' = white
        expect(whiteLightHex).toBe('#f0e030');
        // The star PATH (body) is filled with the flare hue, not near-white —
        // a regression to lightSvg(COLOURS.white) would fill the path #F7FAFC
        // and drop #f0e030 entirely. (White survives only as the thin stroke
        // and the centre dot, which is correct.)
        expect(svg).toMatch(new RegExp(`<path[^>]*fill="${whiteLightHex}"`));
        expect(svg).not.toMatch(/<path[^>]*fill="#F7FAFC"/);
    });

    it('the coloured lights keep their own hues — the white fix is scoped', () => {
        const byId = defsById();
        expect(byId.get('sm-light-red')!.svg).toContain('#E53E3E');
        expect(byId.get('sm-light-green')!.svg).toContain('#38A169');
    });

    it('the full sector-light palette is registered so blue/yellow/amber/orange keep their colour (re-audit)', () => {
        const byId = defsById();
        for (const id of ['sm-light-blue', 'sm-light-yellow', 'sm-light-amber', 'sm-light-orange']) {
            expect(byId.has(id), `${id} not registered`).toBe(true);
        }
        // Each glyph carries its charted hex (LIGHT_COLOUR_HEX case) so it
        // matches its LIGHTSEC sector arc.
        expect(byId.get('sm-light-blue')!.svg.toLowerCase()).toContain('#3b82f6');
        expect(byId.get('sm-light-amber')!.svg.toLowerCase()).toContain('#f59e0b');
    });
});
