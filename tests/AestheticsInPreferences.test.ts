import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Shane 2026-09-09: "can we move the entire aesthetics page to a section
 * inside the preference page." The three appearance sections now live in
 * Settings → Preferences; the standalone tab is gone from the menu.
 */
const general = readFileSync('components/settings/GeneralTab.tsx', 'utf8');
const aesthetics = readFileSync('components/settings/AestheticsTab.tsx', 'utf8');
const modal = readFileSync('components/SettingsModal.tsx', 'utf8');

describe('Aesthetics lives inside Preferences', () => {
    it('Preferences renders the appearance sections', () => {
        // Each on its own since UX scorecard run 10, so Units can follow
        // Display mode and the orientation lock can sit low on the page.
        expect(general).toContain(
            "import { DisplayModeSection, OrientationSection, VisualPreferencesSection } from './AestheticsTab';",
        );
        for (const section of ['DisplayModeSection', 'VisualPreferencesSection', 'OrientationSection']) {
            expect(general).toContain(`<${section} settings={settings} onSave={onSave} />`);
        }
        // Units come straight after Display mode.
        const displayAt = general.indexOf('<DisplayModeSection');
        const unitsAt = general.indexOf('<Section title="Units">');
        expect(displayAt).toBeGreaterThan(-1);
        expect(unitsAt).toBeGreaterThan(displayAt);
        expect(general.slice(displayAt, unitsAt)).not.toContain('<Section');
    });

    it('the sections are exported without a page wrapper, and keep every control', () => {
        expect(aesthetics).toContain('export const AestheticsSections: React.FC<SettingsTabProps>');
        for (const title of ['Display mode', 'Visual preferences', 'Display orientation']) {
            expect(aesthetics).toContain(`<Section title="${title}">`);
        }
        expect(aesthetics).toContain('Always on display');
        expect(aesthetics).toContain('Dim while always on');
    });

    it('the Settings menu no longer has an Aesthetics tab', () => {
        expect(modal).not.toContain("id: 'scenery'");
        expect(modal).not.toContain("activeTab === 'scenery'");
        expect(modal).not.toContain('import { AestheticsTab }');
    });
});
