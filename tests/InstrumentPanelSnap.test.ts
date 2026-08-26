/**
 * Instrument Panel snap rebuild — Shane 2026-08-26: "make the instruments
 * page really pop… scrolls up and down, but snaps to each instrument…
 * make sure the sail plans etc stay there and go to the bottom".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'components/nmea/TheGlassPage.tsx'), 'utf8');

describe('snap-scroll structure', () => {
    it('one instrument per viewport, snapped — the Hero pattern', () => {
        expect(source).toContain('snap-y snap-mandatory');
        expect((source.match(/snap-start snap-always/g) ?? []).length).toBeGreaterThanOrEqual(5);
    });

    it('sections run Wind → Speed → Depth → Heading → Helm, sail plan LAST', () => {
        const order = [
            'SECTION: WIND',
            'SECTION: SPEED',
            'SECTION: DEPTH',
            'SECTION: HEADING',
            'SECTION: HELM',
            'SECTION: SAIL PLAN',
        ];
        let cursor = -1;
        for (const marker of order) {
            const at = source.indexOf(marker);
            expect(at, marker).toBeGreaterThan(cursor);
            cursor = at;
        }
    });

    it('a dot rail exists and jumps by section', () => {
        expect(source).toContain('aria-label={`Jump to ${name}`}');
        expect(source).toContain('snap-mandatory');
    });
});

describe('the serene brain is gated to her hull', () => {
    it('sail plan renders only for Serene Summer, labelled as hers', () => {
        expect(source).toContain('isSereneSummer &&');
        expect(source).toMatch(/tayana\\?s\*55/i);
        expect(source).toContain('Tuned for Serene Summer');
    });

    it('helm advice is honest about its inputs', () => {
        // No rudder sentence → nothing invented.
        expect(source).toContain('No rudder sensor');
        // The verdict waits for the 30s window rather than flickering.
        expect(source).toContain('30 seconds of rudder history');
        // Runners rule surfaces in the UI, not just the data.
        expect(source).toContain('Runners on BEFORE the staysail');
    });
});
