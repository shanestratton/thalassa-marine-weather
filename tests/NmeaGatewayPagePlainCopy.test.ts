import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Shane 2026-09-09 on the NMEA Gateway page: the Pi card "is very cryptic.
 * because not everyone will be connecting via a ydwg-02 device. so we need
 * that to be a more generic message"; and "Share what you hear" belongs in
 * Settings → Preferences with the other toggles.
 */
const page = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');
const general = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
const section = readFileSync('components/settings/FleetSharingSection.tsx', 'utf8');

describe('NMEA Gateway page — plain words, fewer toggles', () => {
    it('the Pi card speaks for any gateway, not the YDWG-02', () => {
        expect(page).not.toMatch(/three TCP slots/);
        expect(page).toContain('Your Pi is paired, so this phone reads the boat&rsquo;s instruments through it.');
        expect(page).toContain('the gateway settings are only for');
        expect(page).toContain('when the Pi is down.');
    });

    it('"Share what you hear" has left the gateway page for Settings → Preferences', () => {
        expect(page).not.toContain('Share what you hear');
        expect(page).not.toContain('FleetSharingCard');
        expect(page).not.toContain("from '../../services/AisShareService'");
        expect(general).toContain("import { FleetSharingSection } from './FleetSharingSection';");
        expect(general).toContain('<Section title="Share what you hear">');
        expect(general).toContain('<FleetSharingSection />');
    });

    it('the moved section keeps the consent rules: on asks first, off is immediate, the sheet is centred', () => {
        expect(section).toContain('if (value) {');
        expect(section).toContain('setSheetOpen(true);');
        expect(section).toContain('setShareEnabled(false);');
        expect(section).toMatch(/fixed inset-0 z-200 flex items-center justify-center/);
        expect(section).toContain('role="dialog"');
        // It reads the boat's link itself — no prop from the page that mounts it.
        expect(section).toContain('useNmeaConnectionStatus()');
        expect(section).toContain("link.status === 'remote' && link.remote?.via === 'lan'");
    });
});
