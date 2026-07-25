import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub underway weather strip', () => {
    it('keeps Vessel quiet while logging by using the same weather-only strip as at rest', () => {
        expect(source).toMatch(
            /const weatherOnlySlim = \(state\.label === 'At Rest' \|\| state\.label === 'Underway'\) && !showSwing && vesselNameSet;/,
        );
        expect(source).toContain('if (weatherOnlySlim) {');

        const weatherOnlyBlock = source.slice(
            source.indexOf('if (weatherOnlySlim) {'),
            source.indexOf('\n    return (', source.indexOf('if (weatherOnlySlim) {')),
        );
        expect(weatherOnlyBlock).toContain('<MetricChipStrip showTopBorder={false} chips={metricChips} />');
        expect(weatherOnlyBlock).not.toContain('{state.label}');
    });

    it('preserves the full status card for anchor watch and drag-alarm safety states', () => {
        expect(source).toContain("const showSwing = anchorStatus !== 'disarmed' && anchorRadius > 0;");
        expect(source).toMatch(/weatherOnlySlim = .*&& !showSwing && vesselNameSet;/);
        expect(source).toContain("if (anchorStatus === 'alarm') return { label: 'Drag Alarm'");
    });
});
