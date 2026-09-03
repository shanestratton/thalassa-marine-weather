/**
 * Screen-reader labels that were developer placeholders (audit 2026-09-02):
 * VoiceOver read "Input Ref, button" on the profile-photo button and "Active
 * Wp" on every waypoint tab. These pin the fixes so a regenerated label
 * cannot quietly bring them back.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cases: Array<[string, RegExp]> = [
    ['components/chat/ChatProfileView.tsx', /aria-label="Input Ref"/],
    ['components/passage/ModelComparisonCard.tsx', /aria-label="Active Wp"/],
    ['components/crew/RegisterButton.tsx', /aria-label="Register your vessel"/],
    ['components/settings/AccountTab.tsx', /aria-label="Lock account settings"/],
    ['components/crew-finder/CrewBrowseBoard.tsx', /aria-label="Go to previous step"/],
    ['components/chat/ChatHeader.tsx', /aria-label="Toggle notification mute"/],
    ['components/chat/ChatDMView.tsx', /aria-label="Cancel editing message"/],
    ['components/crew-finder/CrewProfileForm.tsx', /aria-label="Show interest"/],
    ['components/dashboard/WeatherGrid_exports.tsx', /weather grid export page|weather export panel/],
];

describe('leaked placeholder aria-labels', () => {
    for (const [file, re] of cases) {
        it(`${file} no longer carries ${re}`, () => {
            expect(readFileSync(file, 'utf8')).not.toMatch(re);
        });
    }
    it('the share-position button is not announced as an export', () => {
        // The Stop / Share position / New Entry row moved out of
        // pages/LogPage.tsx into pages/log/ on 2026-09-03; same markup, new home.
        const src = readFileSync('pages/log/TrackingFooterControls.tsx', 'utf8');
        expect(src).toMatch(/aria-label="Share your position"\s+onClick=\{handleShareCurrentPosition\}/);
    });
    it('ResourceCalculator renders its Crew / Days / Meals / Water summary once', () => {
        const src = readFileSync('components/passage/ResourceCalculator.tsx', 'utf8');
        expect((src.match(/>Crew</g) ?? []).length).toBe(1);
        expect(src).not.toContain('THREE RESOURCE CARDS (fuel, water, provisions)');
    });
});
