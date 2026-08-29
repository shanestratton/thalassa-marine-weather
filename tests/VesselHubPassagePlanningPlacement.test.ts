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
     * the relationship it really guards is that Passage Planning sits directly
     * below the publishing-authority card and appears exactly once.
     * The full running order is asserted in tests/VesselHubLayoutOrder.test.ts.
     */
    it('keeps Passage Planning directly below Skipper Device, after the Diary tiles', () => {
        const diary = source.indexOf('aria-label="Open Diary"');
        const scuttlebutt = source.indexOf('aria-label="Open Scuttlebutt"', diary);
        const skipperDevice = source.indexOf('<SkipperDeviceControl\n');
        const passagePlanning = source.indexOf('label="Passage Planning"');

        expect(diary).toBeGreaterThan(-1);
        expect(scuttlebutt).toBeGreaterThan(diary);
        expect(skipperDevice).toBeGreaterThan(scuttlebutt);
        expect(passagePlanning).toBeGreaterThan(skipperDevice);
        expect(source).not.toContain('label="Sharing"');
        expect(source).not.toContain('id="sharing"');
        expect(source.match(/label="Passage Planning"/g)).toHaveLength(1);
        expect(source).not.toContain('label="Saved Routes"');
    });

    it('preserves the crew route, avoids a duplicate Saved Routes entry, and keeps GPX import in Boat Binder', () => {
        // End the slices on anchors that sit AFTER their subject regardless of
        // how the cards are ordered. Slicing the passage row up to the Diary
        // tile used to work only because Diary followed it; once Diary moved
        // above, indexOf returned -1 and slice(start, -1) quietly ran to the
        // end of the file — the assertions still passed, on the whole
        // component. A test that cannot fail is worse than no test.
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const binderRow = source.indexOf('BOAT BINDER — imports / inventory / reference');
        const passageRow = source.slice(passagePlanning, binderRow);
        const binderStart = source.indexOf('if (binderOpen)');
        const hubScroll = source.indexOf('overflow-y-auto vessel-hub-no-scrollbar px-4 pt-4 stagger-in');
        const binderBlock = source.slice(binderStart, hubScroll);

        expect(binderRow).toBeGreaterThan(passagePlanning);
        expect(hubScroll).toBeGreaterThan(binderStart);

        expect(passageRow).toContain("onNavigate('crew')");
        expect(passageRow).toContain('passageCrewCount');
        expect(passageRow).toContain('pendingCrewInvites');
        expect(source).not.toContain('requestSavedRoutesLibraryOpen(scope)');
        expect(source).not.toContain('label="Saved Routes"');
        expect(binderBlock).not.toContain('label="Passage Planning"');
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
