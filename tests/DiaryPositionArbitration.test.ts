import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'components/DiaryPage.tsx'), 'utf8');
const service = readFileSync(resolve(process.cwd(), 'services/DiaryService.ts'), 'utf8');

describe('diary position arbitration — the pub-vs-passage question', () => {
    it('the vessel candidate is live NMEA only, never the ship-log fix', () => {
        // The ship-log fix follows whatever device feeds the track — which may
        // be this same phone wearing a different hat. Only the boat's own
        // electronics may claim to be the boat.
        expect(service).toContain("await import('./NmeaGpsProvider')");
        expect(service).toContain('NmeaGpsProvider.getPosition()');
    });

    it('agreement or a single candidate resolves silently; only conflict asks', () => {
        expect(page).toContain('if (distanceM >= 200) {');
        expect(page).toContain('setGpsConflict({ vessel, phone, distanceM });');
        // Both single-candidate branches must exist, tagged with their source.
        expect(page).toMatch(/loc = vessel;\s*\n\s*setGpsSource\('vessel'\);/);
        expect(page).toMatch(/loc = phone;\s*\n\s*setGpsSource\('phone'\);/);
    });

    it('the modal offers exactly the two honest answers', () => {
        expect(page).toContain('Two positions, skipper');
        expect(page).toContain("applyGpsChoice('vessel')");
        expect(page).toContain("applyGpsChoice('phone')");
    });

    it('the chosen source is visible on the compose form', () => {
        expect(page).toContain("gpsSource === 'vessel' ? '⚓ '");
    });
});
