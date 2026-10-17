import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { encLightRhythm, osmLightRhythm, lightRhythmHtml, type LightRhythm } from '../components/map/lightRhythm';
import { buildFeaturePopupHtml } from '../components/map/encPopup';
import { ENC_VEC_LAYERS } from '../components/map/encLayerIds';
import { SeamarkPopup } from '../components/map/SeamarkPopup';

const enc = (extra: Record<string, unknown> = {}) =>
    encLightRhythm({ LITCHR: 2, SIGPER: 10, SIGGRP: '(2)', COLOUR: 3, ...extra });
function animated(model: LightRhythm) {
    expect(model.state).toBe('animated');
    if (model.state !== 'animated') throw Error('Expected an animated rhythm');
    return model;
}

describe('popup light rhythm source interpretation', () => {
    it('retains the complete period, group count and red colour without pretending pulse widths were supplied', () => {
        const model = animated(enc());
        expect(model.period).toBe(10);
        expect(model.colour).toBe('#ef4444');
        expect(model.exact).toBe(false);
        expect(model.intervals.filter((value) => value.on)).toHaveLength(2);
        expect(model.intervals.reduce((sum, value) => sum + value.seconds, 0)).toBeCloseTo(10, 10);
        expect(lightRhythmHtml(model)).toContain('Illustrative rhythm · 10 s');
    });
    it('respects explicit light/eclipse intervals and rejects a different total period or group', () => {
        const source = { SIGSEQ: '0.3+(1.7)+0.3+(7.7)' };
        expect(animated(enc(source)).intervals).toEqual([
            { on: true, seconds: 0.3 },
            { on: false, seconds: 1.7 },
            { on: true, seconds: 0.3 },
            { on: false, seconds: 7.7 },
        ]);
        expect(animated(enc(source)).exact).toBe(true);
        expect(enc({ ...source, SIGPER: 11 })).toEqual({ state: 'unavailable' });
        expect(enc({ ...source, SIGGRP: '(3)' })).toEqual({ state: 'unavailable' });
    });
    it('reads lower-case ENC fields, numeric colours and numbered OSM light tags', () => {
        expect(encLightRhythm({ litchr: 7, sigper: 4, colour: 4 })).toMatchObject({
            state: 'animated',
            colour: '#22c55e',
            exact: true,
            intervals: [
                { on: true, seconds: 2 },
                { on: false, seconds: 2 },
            ],
        });
        const osm = animated(
            osmLightRhythm({ 'light:2:character': 'Fl', 'light:2:period': '5', 'light:2:colour': 'white' }, 'light:2:'),
        );
        expect(osm.colour).toBe('#ffffff');
        expect(osm.period).toBe(5);
    });
    it('keeps fixed lights steady without a guessed period', () => {
        const model = enc({ LITCHR: 1, SIGPER: undefined });
        expect(model).toMatchObject({ state: 'fixed', period: 0, intervals: [] });
        expect(lightRhythmHtml(model)).not.toContain('@keyframes');
        expect(lightRhythmHtml(model)).not.toContain('animation:');
    });
    it('uses equal on/off phases for isophase and reverses the occulting sequence', () => {
        const iso = animated(enc({ LITCHR: 7, SIGGRP: undefined }));
        expect(iso.intervals).toEqual([
            { on: true, seconds: 5 },
            { on: false, seconds: 5 },
        ]);
        const oc = animated(enc({ LITCHR: 8, SIGGRP: '(1)', SIGSEQ: '0.5+(9.5)' }));
        expect(oc.intervals).toEqual([
            { on: false, seconds: 0.5 },
            { on: true, seconds: 9.5 },
        ]);
    });
    it('does not portray a short flash as a long flash or a slow unknown quick light as one flash', () => {
        expect(
            animated(enc({ LITCHR: 3, SIGGRP: '(1)' }))
                .intervals.filter((value) => value.on)
                .every((value) => value.seconds >= 2),
        ).toBe(true);
        expect(enc({ LITCHR: 3, SIGGRP: '(1)', SIGSEQ: '0.5+(9.5)' }).state).toBe('unavailable');
        expect(enc({ LITCHR: 4, SIGGRP: undefined }).state).toBe('unavailable');
        expect(animated(enc({ LITCHR: 5, SIGPER: 0.5, SIGGRP: undefined })).period).toBe(0.5);
    });
    it.each([
        { COLOUR: undefined },
        { COLOUR: '1,3' },
        { COLOUR: 'constructor' },
        { LITCHR: undefined },
        { LITCHR: 999 },
        { LITCHR: 28 },
        { LITCHR: 12, SIGGRP: '(A)' },
        { SIGPER: undefined },
        { SIGPER: 0 },
        { SIGPER: '' },
        { SIGPER: null },
        { SIGPER: -1 },
        { SIGPER: Infinity },
        { SIGPER: 121 },
        { SIGGRP: '(0)' },
        { SIGGRP: '(99)' },
        { SIGSEQ: '0.30.3' },
        { SIGSEQ: '0.3+(9.7' },
        { SIGSEQ: '1+(1)'.repeat(40) },
        { SIGSEQ: '<script>alert(1)</script>' },
    ])('leaves missing, ambiguous or malformed source data unknown: %j', (extra) => {
        const model = enc(extra);
        expect(model).toEqual({ state: 'unavailable' });
        expect(lightRhythmHtml(model)).toBe(
            '<div class="light-rhythm" style="font-size:11px;margin-top:8px">Rhythm preview unavailable</div>',
        );
    });
    it('rejects unrecognised OSM colour aliases and composite colours instead of choosing the first', () => {
        for (const colour of ['white;red', 'unknown', 'constructor', '#fff" onload="alert(1)']) {
            expect(osmLightRhythm({ 'light:character': 'Fl', 'light:period': '5', 'light:colour': colour })).toEqual({
                state: 'unavailable',
            });
        }
    });
});

describe('existing light popup paths', () => {
    it('includes the same preview in standalone ENC lights and a lit mark’s folded light section only', () => {
        const light = { LITCHR: 2, SIGPER: 10, SIGGRP: '(2)', COLOUR: 3 };
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.LIGHTS, light)).toContain('Illustrative rhythm · 10 s');
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.BOYLAT, { OBJNAM: 'Fictional buoy' }, { light })).toContain(
            'Illustrative rhythm · 10 s',
        );
        expect(buildFeaturePopupHtml(ENC_VEC_LAYERS.BOYLAT, { OBJNAM: 'Fictional unlit buoy' })).not.toContain(
            'light-rhythm-lamp',
        );
    });
    it('keeps separate numbered OSM sectors and existing textual source details', () => {
        const html = renderToStaticMarkup(
            <SeamarkPopup
                seamarkType="light"
                name="Fictional light"
                coordinates={[0, 0]}
                tags={{
                    'light:1:character': 'Fl',
                    'light:1:period': '5',
                    'light:1:colour': 'red',
                    'light:2:character': 'Iso',
                    'light:2:period': '4',
                    'light:2:colour': 'green',
                }}
            />,
        );
        expect(html.match(/<svg /g)).toHaveLength(2);
        expect(html).toContain('fill="#ef4444"');
        expect(html).toContain('fill="#22c55e"');
        expect(html).toContain('Flashing Red');
        expect(html).toContain('Isophase Green');
        expect(html).toContain('@media(prefers-reduced-motion:reduce)');
    });
});
