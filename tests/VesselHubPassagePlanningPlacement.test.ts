import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub passage-planning placement', () => {
    /**
     * Reordered 2026-08-30 on Shane's instruction: the Diary and Scuttlebutt
     * tiles now LEAD the scrolling area, ahead of Skipper Device and Passage
     * Planning. This test previously pinned the opposite order — Passage
     * Planning before the Diary tiles — so it is updated rather than deleted:
     * the relationship it really guards is that Passage Planning sits below
     * the publishing-authority card and appears exactly once. Since 2026-10-04
     * it is the first row of the one menu box.
     * The full running order is asserted in tests/VesselHubLayoutOrder.test.ts.
     */
    it('keeps Passage Planning below Skipper Device, after the Diary tiles, in its card above the menu box', () => {
        const diary = source.indexOf('aria-label="Open Diary"');
        const scuttlebutt = source.indexOf('aria-label="Open Scuttlebutt"', diary);
        const skipperDevice = source.indexOf('<SkipperDeviceControl\n');
        const passagePlanning = source.indexOf('label="Crew & Float Plan"');

        expect(diary).toBeGreaterThan(-1);
        expect(scuttlebutt).toBeGreaterThan(diary);
        expect(skipperDevice).toBeGreaterThan(scuttlebutt);
        expect(passagePlanning).toBeGreaterThan(skipperDevice);
        // Since 2026-10-04 it leads the menu, ahead of the Boat Binder (Shane:
        // "one box around crew and float plan, boat binder, settings, nmea
        // gateway, boat network, and music"); since 2026-10-13 in a card of
        // its own just above the box ("the crew and float plan, really needs
        // its own card").
        const crewCard = source.indexOf('data-testid="vessel-hub-crew"');
        const menu = source.indexOf('data-testid="vessel-hub-menu"');
        expect(crewCard).toBeGreaterThan(skipperDevice);
        expect(passagePlanning).toBeGreaterThan(crewCard);
        expect(menu).toBeGreaterThan(passagePlanning);
        expect(source.indexOf('label="Boat Binder"')).toBeGreaterThan(menu);
        expect(source).not.toContain('label="Sharing"');
        expect(source).not.toContain('id="sharing"');
        expect(source.match(/label="Crew & Float Plan"/g)).toHaveLength(1);
        // Renamed from "Passage Planning" by the app glossary (UX scorecard run 6).
        expect(source).not.toContain('label="Passage Planning"');
        expect(source).not.toContain('label="Saved Routes"');
    });

    it('preserves the crew route, avoids a duplicate Saved Routes entry, and keeps GPX import in Boat Binder', () => {
        // End the slices on anchors that sit AFTER their subject regardless of
        // how the cards are ordered. Slicing the passage row up to the Diary
        // tile used to work only because Diary followed it; once Diary moved
        // above, indexOf returned -1 and slice(start, -1) quietly ran to the
        // end of the file — the assertions still passed, on the whole
        // component. A test that cannot fail is worse than no test.
        // The row ends at the next row of the menu, the Boat Binder, first in
        // the box (most used first since 2026-10-04: Crew & Float Plan, Boat
        // Binder, ...).
        const passagePlanning = source.indexOf('label="Crew & Float Plan"');
        const nextRow = source.indexOf('label="Boat Binder"');
        const passageRow = source.slice(passagePlanning, nextRow);
        const binderStart = source.indexOf('if (binderOpen)');
        const hubScroll = source.indexOf('overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 stagger-in');
        const binderBlock = source.slice(binderStart, hubScroll);

        expect(nextRow).toBeGreaterThan(passagePlanning);
        expect(hubScroll).toBeGreaterThan(binderStart);

        expect(passageRow).toContain("onNavigate('crew')");
        // The crew register's count, the float plan's way (129-14, tests/VesselHubCrewCount.test.tsx).
        expect(passageRow).toContain('crewCountShown');
        expect(passageRow).toContain('pendingCrewInvites');
        expect(source).not.toContain('requestSavedRoutesLibraryOpen(scope)');
        expect(source).not.toContain('label="Saved Routes"');
        expect(binderBlock).not.toContain('label="Crew & Float Plan"');
        expect(binderBlock).toContain('label="Import GPX"');
    });

    it('counts the canonical saved-route library and fences cloud refreshes to the active identity', () => {
        expect(source).toContain("import('../services/routeTracer')");
        expect(source).toContain('loadSavedTraces(scope).length');
        expect(source).toContain("import('../services/savedRoutesSync')");
        expect(source).toContain('const merged = await syncSavedRoutes()');
        expect(source).toContain('!isAuthIdentityScopeCurrent(scope)');
        expect(source).toContain('subscribeAuthIdentityScope((next) => refresh(next))');
    });
});
