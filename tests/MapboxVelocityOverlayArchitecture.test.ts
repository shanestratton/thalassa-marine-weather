import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const overlaySource = readFileSync(resolve(process.cwd(), 'components/map/MapboxVelocityOverlay.tsx'), 'utf8');
const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');

describe('MapboxVelocityOverlay selected-grid architecture', () => {
    it('does not run a second private GFS/cache/static wind pipeline or render its stale badge', () => {
        expect(overlaySource).not.toContain('fetchWindData');
        expect(overlaySource).not.toContain('fetch-wind-velocity');
        expect(overlaySource).not.toContain('thalassa-wind-cache');
        expect(overlaySource).not.toContain('wind_test.json');
        expect(overlaySource).not.toContain('Offline ·');
    });

    it('receives the reactive selected-model grid rather than the initial-load ref', () => {
        expect(mapHubSource).toContain('windGrid={weather.windState.grid ?? undefined}');
        expect(mapHubSource).not.toContain('windGrid={weather.windGridRef?.current ?? undefined}');
    });

    it('covers frame zero in both grid-arrival orders and clears an absent grid', () => {
        expect(overlaySource).toContain('windGridFrameToVelocityData(windGrid, windHour)');
        expect(overlaySource).toContain('windGridFrameToVelocityData(windGridPropRef.current, windHourRef.current)');
        expect(overlaySource).toMatch(
            /if \(!nextData\) \{[\s\S]*?removeVelocityLayer\(leafletMap, velocityLayerRef\.current\);[\s\S]*?velocityLayerRef\.current = null;/,
        );
        expect(overlaySource).not.toContain('curHour > 0');
    });

    it('cancels the deferred view snap before an overlay remount can reuse shared refs', () => {
        expect(overlaySource).toMatch(
            /return \(\) => \{\s*cancelled = true;\s*if \(snapTimer\) \{\s*clearTimeout\(snapTimer\);/,
        );
        expect(overlaySource).toMatch(/snapTimer = setTimeout\(\(\) => \{\s*if \(cancelled\) return;/);
    });
});
