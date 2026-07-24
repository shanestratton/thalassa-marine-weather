import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub passage-planning placement', () => {
    it('renders the single Passage Planning entry directly after Skipper Device and before Sharing', () => {
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const sharing = source.indexOf('label="Sharing"', passagePlanning);

        expect(skipperDevice).toBeGreaterThan(-1);
        expect(passagePlanning).toBeGreaterThan(skipperDevice);
        expect(sharing).toBeGreaterThan(passagePlanning);
        expect(source.match(/label="Passage Planning"/g)).toHaveLength(1);
    });

    it('preserves the crew route and keeps GPX import in Boat Binder', () => {
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const passageBlock = source.slice(passagePlanning, passagePlanning + 1_200);
        const binderStart = source.indexOf('if (binderOpen)');
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const binderBlock = source.slice(binderStart, skipperDevice);

        expect(passageBlock).toContain("onNavigate('crew')");
        expect(passageBlock).toContain('passageCrewCount');
        expect(passageBlock).toContain('pendingCrewInvites');
        expect(binderBlock).not.toContain('label="Passage Planning"');
        expect(binderBlock).toContain('label="Import GPX"');
    });
});
