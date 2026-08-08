/**
 * The Vessel page shows nothing at all when at rest or underway.
 *
 * It used to collapse the hero into a strip of weather chips. Shane, 2026-08-09:
 * "complete waste of real estate". The same numbers live on The Glass, one tab
 * away, which is where you go to read conditions — the band only pushed the
 * actual vessel content down the screen.
 *
 * The full status card survives, and these tests exist to keep it that way:
 * anchor watch and drag alarms carry swing and safety state, and there the
 * conditions are context for something rather than the entire payload.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub at rest and underway', () => {
    it('renders no hero at all — the weather band is gone, not merely shrunk', () => {
        expect(source).toMatch(
            /const weatherOnlySlim = \(state\.label === 'At Rest' \|\| state\.label === 'Underway'\) && !showSwing && vesselNameSet;/,
        );
        // An early null return, not a block that renders something smaller.
        expect(source).toMatch(/if \(weatherOnlySlim\) return null;/);
    });

    it('leaves no weather-only card behind for the band to creep back into', () => {
        const guard = source.indexOf('if (weatherOnlySlim)');
        const fullCard = source.indexOf('\n    return (', guard);
        const between = source.slice(guard, fullCard);
        expect(between).not.toMatch(/<MetricChipStrip/);
        expect(between).not.toMatch(/<div/);
    });

    it('preserves the full status card for anchor watch and drag-alarm safety states', () => {
        expect(source).toContain("const showSwing = anchorStatus !== 'disarmed' && anchorRadius > 0;");
        expect(source).toMatch(/weatherOnlySlim = .*&& !showSwing && vesselNameSet;/);
        expect(source).toContain("if (anchorStatus === 'alarm') return { label: 'Drag Alarm'");
        // Conditions still ride along with swing state, where they are context.
        expect(source).toMatch(/<MetricChipStrip showTopBorder=\{!showSog\} chips=\{metricChips\} \/>/);
    });
});
