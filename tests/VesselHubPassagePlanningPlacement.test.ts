import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub passage-planning placement', () => {
    it('orders the single Passage Planning entry after Skipper Device and before the permanent Diary tiles', () => {
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const diary = source.indexOf('aria-label="Open Diary"', passagePlanning);
        const scuttlebutt = source.indexOf('aria-label="Open Scuttlebutt"', diary);

        expect(skipperDevice).toBeGreaterThan(-1);
        expect(passagePlanning).toBeGreaterThan(skipperDevice);
        expect(diary).toBeGreaterThan(passagePlanning);
        expect(scuttlebutt).toBeGreaterThan(diary);
        expect(source).not.toContain('label="Sharing"');
        expect(source).not.toContain('id="sharing"');
        expect(source.match(/label="Passage Planning"/g)).toHaveLength(1);
        expect(source).not.toContain('label="Saved Routes"');
    });

    it('preserves the crew route, avoids a duplicate Saved Routes entry, and keeps GPX import in Boat Binder', () => {
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const diary = source.indexOf('aria-label="Open Diary"', passagePlanning);
        const passageRow = source.slice(passagePlanning, diary);
        const binderStart = source.indexOf('if (binderOpen)');
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const binderBlock = source.slice(binderStart, skipperDevice);

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
