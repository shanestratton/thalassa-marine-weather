/**
 * Instrument Panel snap pages. Sail Plan was removed from the instrument
 * panel on 2026-09-24; the remaining instruments keep their original order.
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

    it('sections run Wind → Position → Speed → Depth → Sea temp → Heading → Helm', () => {
        const order = [
            'SECTION: WIND',
            'SECTION: POSITION',
            'SECTION: SPEED',
            'SECTION: DEPTH',
            'SECTION: SEA TEMP',
            'SECTION: HEADING',
            'SECTION: HELM',
        ];
        let cursor = -1;
        for (const marker of order) {
            const at = source.indexOf(marker);
            expect(at, marker).toBeGreaterThan(cursor);
            cursor = at;
        }
    });

    it('has no Sail Plan page or empty snap page left behind', () => {
        expect(source).not.toContain('SECTION: SAIL PLAN');
        expect(source).not.toContain('<SailPlanDiagram');
        expect(source).not.toContain('<SailPartsDiagram');
        expect(source).not.toContain('title="Sail Plan"');
        const sections = [...source.matchAll(/<section\b[\s\S]*?<\/section>/g)].map(([section]) => section);
        expect(sections).toHaveLength(10); // Nine instruments plus the conditional crew Watch.
        for (const section of sections) {
            expect(section).toContain('snap-start snap-always');
            expect(section).toContain('<SectionPlate title=');
            expect(section).toMatch(/<(?:div|ShipsBellClock)\b/);
        }
    });

    it('has no dot rail — the punter scrolls to the end', () => {
        // Shane 2026-09-09: "can we remove the 10 dots down the right hand
        // side. not necessary as a punter will keep scrolling until he gets
        // to the end."
        expect(source).not.toContain('Jump to ${name}');
        expect(source).not.toContain('onPanelScroll');
        expect(source).toContain('snap-mandatory');
    });
});

describe('the remaining helm instrument', () => {
    it('helm advice is honest about its inputs', () => {
        // No rudder sentence → nothing invented.
        expect(source).toContain('No rudder sensor');
        // The verdict waits for the 30s window rather than flickering.
        expect(source).toContain('30 seconds of rudder history');
    });
});
