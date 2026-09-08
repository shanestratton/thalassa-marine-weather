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
        expect(general).toContain("import { AestheticsSections } from './AestheticsTab';");
        expect(general).toContain('<AestheticsSections settings={settings} onSave={onSave} />');
    });

    it('the sections are exported without a page wrapper, and keep every control', () => {
        expect(aesthetics).toContain('export const AestheticsSections: React.FC<SettingsTabProps>');
        for (const title of ['Display Mode', 'Visual Preferences', 'Display Orientation']) {
            expect(aesthetics).toContain(`<Section title="${title}">`);
        }
        expect(aesthetics).toContain('Always On Display');
        expect(aesthetics).toContain('Dim While Always On');
    });

    it('the Settings menu no longer has an Aesthetics tab', () => {
        expect(modal).not.toContain("id: 'scenery'");
        expect(modal).not.toContain("activeTab === 'scenery'");
        expect(modal).not.toContain('import { AestheticsTab }');
    });
});
