/**
 * Ten bugs that survived two independent adversarial refuters in the
 * 2026-09-02 audit, fixed and pinned here on the source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('adversarially confirmed bugs stay fixed', () => {
    it('channel proposal cannot be submitted twice', () => {
        const hook = read('hooks/chat/useChatProposals.ts');
        expect(hook).toMatch(
            /if \(!proposalName\.trim\(\) \|\| proposalSent \|\| proposalSubmittingRef\.current\) return;/,
        );
        expect(hook).toMatch(/proposalSubmittingRef\.current = false;/);
        expect(read('components/chat/ChannelProposalModal.tsx')).toMatch(
            /disabled=\{!proposalName\.trim\(\) \|\| proposalSent\}/,
        );
    });
    it('meal-calendar day labels are formatted in UTC, matching their UTC-date keys', () => {
        const src = read('components/chat/MealCalendar.tsx');
        expect((src.match(/timeZone: 'UTC'/g) ?? []).length).toBe(3);
    });
    it('ChefPlate is keyed per meal so its state cannot leak between meals', () => {
        expect(read('components/chat/MealCalendar.tsx')).toMatch(/<ChefPlate\s+key=\{meal\.id\}/);
    });
    it('declined invitees are not counted as souls aboard', () => {
        expect(read('components/crew/ReadinessCardStack.tsx')).toMatch(
            /visibleCrew\.filter\(\(m\) => m\.status !== 'declined'\)\.length/,
        );
        const cm = read('components/CrewManagement.tsx');
        expect(cm).toMatch(/const activePassageCrew = selectedPassageCrew\.filter/);
        expect(cm).toMatch(/standingCrewAboard \+ activePassageCrew\.length/);
    });
    it("anchorage sheet clears the previous centre's list when a new load starts", () => {
        const src = read('components/map/AnchorageTonightSheet.tsx');
        expect(src).toMatch(/setState\('loading'\);[\s\S]{0,300}setRows\(null\);/);
    });
    it('trace feedback holds one timer and cancels the previous', () => {
        expect(read('components/map/MapHub.tsx')).toMatch(
            /if \(feedbackTimerRef\.current\) clearTimeout\(feedbackTimerRef\.current\);/,
        );
    });
    it('helix sublabel colour is keyed on tense, not on label text', () => {
        expect(read('components/map/ThalassaHelixControl.tsx')).toMatch(/\/\\bForecast\\b\/\.test\(sublabel\)/);
    });
    it('waypoint ETAs round to whole minutes first, in both the modal and the PDF', () => {
        for (const f of ['components/map/TraceReportModal.tsx', 'services/RouteReportPdfService.ts']) {
            const src = read(f);
            expect(src).toMatch(/const totalMin = Math\.round\(w\.hoursFromDep \* 60\);/);
            expect(src).not.toMatch(/Math\.round\(\(w\.hoursFromDep - h\) \* 60\)/);
        }
    });
    it('an anchorage verdict is written only into the popup it was fetched for', () => {
        expect(read('components/map/useAnchorageLayer.ts')).toMatch(/if \(popupRef\.current !== popup\) return;/);
    });
    it('a superseded consensus-matrix generation cannot write into state', () => {
        const src = read('components/map/useConsensusMatrix.ts');
        expect(src).toMatch(/if \(!cancelled\) setConsensusData\(data\);/);
        expect(src).toMatch(/return \(\) => \{\s*cancelled = true;\s*\};/);
    });
});
