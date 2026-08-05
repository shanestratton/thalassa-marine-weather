import { describe, expect, it } from 'vitest';
import { buildMpaPopupHtml, formatMpaSourceDate } from '../components/map/useMpaLayer';

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
            expect(html).toMatch(/verify current fishing and anchoring rules with the managing authority/i);
            expect(html).toMatch(/not legal advice and not for navigation/i);
            expect(html).toMatch(/width: 44px/);
            expect(html).toMatch(/height: 44px/);
            expect(html).toMatch(/\.mpa-popup-close:focus-visible/);
            expect(html).toContain('color: #cbd5e1');
            expect(html).toContain('color: #b6c2d1');
            expect(html).toMatch(/font-size: 11px[^>]*>[\s\S]*Indicative CAPAD overlay only/);
            expect(html).not.toMatch(/No fishing, collecting, or extraction permitted/i);
            expect(html).not.toMatch(/Recreational fishing usually permitted/i);
        },
    );

    it('uses readable class and metadata tones on the dark popup surface', () => {
        expect(buildMpaPopupHtml({ protection_class: 'high' })).toContain('color: #f87171');
        expect(buildMpaPopupHtml({ protection_class: 'conditional' })).toContain('color: #fbbf24');
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use' })).toContain('color: #60a5fa');
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use', area_km2: 1 })).toContain('color: #cbd5e1');
        expect(buildMpaPopupHtml({ protection_class: 'multiple_use' })).toContain('color: #b6c2d1');

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
                const foreground = /color:\s*(#[0-9a-f]{6})/i.exec(style)?.[1];
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
        expect(html).toContain('Area: 0.001 km²');
        expect(buildMpaPopupHtml({ name: 'Invalid', area_km2: 0 })).not.toContain('Area:');
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
