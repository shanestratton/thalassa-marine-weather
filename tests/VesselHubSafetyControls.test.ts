import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub safety controls', () => {
    it('keeps weather and safety controls in a fixed operational deck outside the Vessel scroll port', () => {
        const deck = source.indexOf('aria-label="Vessel status and safety controls"');
        const scrollPort = source.indexOf('Only the lower-priority vessel work scrolls.');

        expect(deck).toBeGreaterThan(-1);
        expect(scrollPort).toBeGreaterThan(deck);
        expect(source.slice(deck, scrollPort)).toContain('<NavStationHero');
        expect(source.slice(deck, scrollPort)).toContain('data-testid="vessel-safety-controls"');
        expect(source.slice(scrollPort)).toContain('flex-1 min-h-0 overflow-y-auto');
    });

    it('gives the pinned operational controls a dedicated, visible safety bezel', () => {
        expect(source).toContain('const SAFETY_CONTROL_GROUP');
        expect(source).toContain('const SAFETY_CONTROL_CARD');
        expect(source).toContain('rgba(74, 222, 128, 0.42)');
        expect(source).toContain('data-testid="vessel-safety-controls"');
        expect(source).toContain('aria-label="Safety controls"');
        expect(source).toContain('style={SAFETY_CONTROL_GROUP}');
    });

    it('keeps the emergency controls red while ordinary safety controls receive the emerald treatment', () => {
        const safetyControls = source.slice(
            source.indexOf('data-testid="vessel-safety-controls"'),
            source.indexOf(
                "/* Weather Window + Skipper's Reference moved",
                source.indexOf('data-testid="vessel-safety-controls"'),
            ),
        );

        expect(safetyControls).toContain('aria-label="Anchor Watch"');
        expect(safetyControls).toContain("anchorStatus === 'alarm' ? ALERT_SAFETY_CONTROL_CARD : SAFETY_CONTROL_CARD");
        expect(safetyControls).toContain('aria-label="Open Guardian bay watch"');
        expect(safetyControls).toContain('aria-label="Man Overboard"');
        expect(safetyControls).toContain('aria-label="Open radio position reporting"');
        expect(safetyControls.match(/style=\{SAFETY_CONTROL_CARD\}/g)).toHaveLength(2);
        expect(safetyControls.match(/style=\{ALERT_SAFETY_CONTROL_CARD\}/g)).toHaveLength(1);
        expect(safetyControls.match(/focus-visible:outline-emerald-300/g)).toHaveLength(4);
    });
});
