import { describe, expect, it } from 'vitest';
import {
    buildMpaPopupHtml,
    formatMpaArea,
    formatMpaSourceDate,
    pickStrictestMpaRecord,
} from '../components/map/useMpaLayer';

function relativeLuminance(hex: string): number {
    const channels = hex
        .slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16) / 255)
        .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
    const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
    const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

describe('MPA overlay safety language', () => {
    it.each(['high', 'conditional', 'multiple_use'])(
        'never turns indicative CAPAD class %s into permission',
        (protectionClass) => {
            const html = buildMpaPopupHtml({
                name: 'Example marine area',
                protection_class: protectionClass,
                authority: 'Example authority',
            });

            expect(html).toMatch(/inferred/i);
            expect(html).toMatch(/verify current entry, fishing and anchoring rules with the managing authority/i);
            expect(html).toMatch(/not legal advice and not for navigation/i);
            expect(html).toMatch(/width: 44px/);
            expect(html).toMatch(/height: 44px/);
            expect(html).toMatch(/\.mpa-popup-close:focus-visible/);
            expect(html).toContain('color: var(--day-ui-muted, #cbd5e1)');
            expect(html).toContain('color: var(--day-ui-muted, #b6c2d1)');
            expect(html).toMatch(/font-size: 11px[^>]*>[\s\S]*Indicative CAPAD overlay only/);
            expect(html).not.toMatch(/No fishing, collecting, or extraction permitted/i);
            expect(html).not.toMatch(/Recreational fishing usually permitted/i);
        },
    );

    it('preserves readable dark-popup tones as the daylight-token fallbacks', () => {
        expect(buildMpaPopupHtml({ protection_class: 'high' })).toContain('color: var(--day-ui-danger, #f87171)');
        expect(buildMpaPopupHtml({ protection_class: 'conditional' })).toContain('color: var(--day-ui-amber, #fbbf24)');
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use' })).toContain(
            'color: var(--day-ui-accent, #60a5fa)',
        );
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use', area_km2: 1 })).toContain(
            'color: var(--day-ui-muted, #cbd5e1)',
        );
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use' })).toContain(
            'color: var(--day-ui-muted, #b6c2d1)',
        );

        for (const protectionClass of ['high', 'conditional', 'multiple_use']) {
            const html = buildMpaPopupHtml(
                {
                    protection_class: protectionClass,
                    type: 'Marine protected area',
                    area_km2: 1,
                    authority: 'Example authority',
                },
                '2024-06-30T00:00:00Z',
            );
            const elevenPixelStyles = [...html.matchAll(/style="([\s\S]*?)"/g)]
                .map((match) => match[1])
                .filter((style) => /font-size:\s*11px/.test(style));
            expect(elevenPixelStyles.length).toBeGreaterThanOrEqual(4);
            for (const style of elevenPixelStyles) {
                const foreground = /color:\s*(?:var\(--day-ui-[\w-]+,\s*)?(#[0-9a-f]{6})/i.exec(style)?.[1];
                expect(foreground, style).toBeDefined();
                expect(contrastRatio(foreground!, '#0f172a'), style).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    it('preserves tiny positive official areas instead of rounding them to zero', () => {
        const html = buildMpaPopupHtml({
            name: 'Tiny protected zone',
            protection_class: 'multiple_use',
            area_km2: 0.001,
        });
        expect(html).toContain('Area of this mapped part: 1,000 m²');
        expect(buildMpaPopupHtml({ name: 'Invalid', area_km2: 0 })).not.toContain('Area');
        // Real CAPAD 2024-06-30 slivers (Sloping Island TAS 1e-10 km², Eighty Mile
        // Beach WA 2.2e-9, Ningaloo WA 1e-8, a GBR part 4.1e-7) used to read "0 km²".
        for (const sliver of [1e-10, 2.2e-9, 1e-8, 4.1e-7]) {
            const sliverHtml = buildMpaPopupHtml({ name: 'Sliver', protection_class: 'conditional', area_km2: sliver });
            expect(sliverHtml).toContain('Area of this mapped part: &lt; 1 m²');
            const dom = document.createElement('div');
            dom.innerHTML = sliverHtml;
            expect(dom.textContent).toContain('Area of this mapped part: < 1 m²');
            expect(dom.textContent).not.toMatch(/part: 0[ .]/);
        }
    });

    it.each([
        [1e-10, '< 1 m²'],
        [9.9e-7, '< 1 m²'],
        [1e-6, '1 m²'],
        [3.547e-5, '35 m²'],
        [0.00104191, '1,042 m²'],
        [0.0099999, '10,000 m²'],
        [0.01, '0.01 km²'],
        [0.04885538, '0.049 km²'],
        [14.0187198, '14.02 km²'],
        [343966.2, '343,966 km²'],
    ])('formats a CAPAD area of %s km² as %s', (areaKm2, expected) => {
        expect(formatMpaArea(areaKm2)).toBe(expected);
    });

    it('never formats a positive CAPAD area as zero, NaN or blank', () => {
        for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatMpaArea(invalid)).toBe('');
        for (let exponent = -12; exponent <= 7; exponent += 0.125) {
            const text = formatMpaArea(10 ** exponent);
            expect(text, String(10 ** exponent)).toMatch(
                /^(?:< 1 m²|[1-9][\d,]* m²|(?:0\.0[1-9]\d?|0\.[1-9]\d{0,2}|[1-9][\d,]*(?:\.\d{1,2})?) km²)$/,
            );
        }
    });

    it('shows the strictest inferred class where CAPAD records overlap, and counts the others', () => {
        // Real overlap near the Whitsundays: a Great Barrier Reef IUCN II zone under a
        // Fish Habitat Area and a Dugong Protection Area, drawn in that file order.
        const gbrZone = {
            name: 'Great Barrier Reef',
            type: 'Marine Park',
            iucn: 'II',
            authority: 'GBRMPA',
            protection_class: 'high',
        };
        const fishHabitat = {
            name: 'Repulse',
            type: 'Fish Habitat Area (A)',
            iucn: 'VI',
            authority: 'QLD_DAF',
            protection_class: 'multiple_use',
        };
        const dugong = {
            name: 'Repulse Bay',
            type: 'Dugong Protection Area (A)',
            iucn: 'IV',
            authority: 'QLD_DES',
            protection_class: 'conditional',
        };
        const picked = pickStrictestMpaRecord([fishHabitat, dugong, gbrZone, { ...gbrZone }, fishHabitat]);
        expect(picked).toEqual({ props: gbrZone, overlapping: 2 });
        const html = buildMpaPopupHtml(picked!.props, undefined, picked!.overlapping);
        expect(html).toContain('Inferred high-protection class');
        expect(html).toContain('2 other protected-area records overlap here; the strictest inferred class is shown.');
        expect(buildMpaPopupHtml(dugong, undefined, 1)).toContain('1 other protected-area record overlaps here');
        // Parts of one reserve count once, and a lone record says nothing about overlaps.
        expect(pickStrictestMpaRecord([gbrZone, { ...gbrZone }])).toEqual({ props: gbrZone, overlapping: 0 });
        expect(buildMpaPopupHtml(gbrZone, undefined, 0)).not.toContain('overlap');
        expect(pickStrictestMpaRecord([])).toBeNull();
    });

    it('names the managing authority a skipper can look up, keeping the CAPAD code', () => {
        expect(buildMpaPopupHtml({ name: 'GBR', authority: 'GBRMPA' })).toContain(
            'Managed by: Great Barrier Reef Marine Park Authority (GBRMPA)',
        );
        expect(buildMpaPopupHtml({ name: 'Rottnest', authority: 'WA_DBCA' })).toContain(
            'Managed by: WA Department of Biodiversity, Conservation and Attractions (WA_DBCA)',
        );
        expect(buildMpaPopupHtml({ name: 'Unknown', authority: 'LILC' })).toContain('Managed by: LILC');
        expect(buildMpaPopupHtml({ name: 'Hostile', authority: '<img src=x>' })).toContain(
            'Managed by: &lt;img src=x&gt;',
        );
    });

    it('puts the verified CAPAD snapshot date beside the authority warning', () => {
        const html = buildMpaPopupHtml(
            { name: 'Example', protection_class: 'multiple_use', authority: 'DCCEEW' },
            '2024-06-30T00:00:00Z',
        );
        expect(html).toContain('Dataset snapshot: 30 Jun 2024');
        expect(formatMpaSourceDate('2024-02-30T00:00:00Z')).toBe('');
        expect(formatMpaSourceDate('<script>')).toBe('');
    });
});
