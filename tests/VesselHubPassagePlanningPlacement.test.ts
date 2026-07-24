import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/VesselHub.tsx'), 'utf8');

describe('VesselHub passage-planning placement', () => {
    it('orders Passage Planning and its Saved Routes shortcut after Skipper Device and before Sharing', () => {
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const savedRoutes = source.indexOf('label="Saved Routes"', passagePlanning);
        const sharing = source.indexOf('label="Sharing"', savedRoutes);

        expect(skipperDevice).toBeGreaterThan(-1);
        expect(passagePlanning).toBeGreaterThan(skipperDevice);
        expect(savedRoutes).toBeGreaterThan(passagePlanning);
        expect(sharing).toBeGreaterThan(savedRoutes);
        expect(source.match(/label="Passage Planning"/g)).toHaveLength(1);
        expect(source.match(/label="Saved Routes"/g)).toHaveLength(1);
    });

    it('preserves the crew route, opens the existing Plan library, and keeps GPX import in Boat Binder', () => {
        const passagePlanning = source.indexOf('label="Passage Planning"');
        const savedRoutes = source.indexOf('label="Saved Routes"', passagePlanning);
        const sharing = source.indexOf('label="Sharing"', savedRoutes);
        const passageRow = source.slice(passagePlanning, savedRoutes);
        const savedRoutesRow = source.slice(savedRoutes, sharing);
        const binderStart = source.indexOf('if (binderOpen)');
        const skipperDevice = source.indexOf('<SkipperDeviceControl');
        const binderBlock = source.slice(binderStart, skipperDevice);

        expect(passageRow).toContain("onNavigate('crew')");
        expect(passageRow).toContain('passageCrewCount');
        expect(passageRow).toContain('pendingCrewInvites');
        expect(savedRoutesRow).toContain('requestSavedRoutesLibraryOpen(scope)');
        expect(savedRoutesRow).toContain("onNavigate('voyage')");
        expect(savedRoutesRow).toContain('savedRouteCount');
        expect(savedRoutesRow).not.toContain("onNavigate('crew')");
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
