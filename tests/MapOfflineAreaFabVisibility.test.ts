import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFLINE_AREA_FAB_VISIBLE } from '../components/map/mapHubHelpers';
import { BULK_OFFLINE_PREFETCH_CAPABILITY } from '../services/MapOfflineService';

const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');

describe('Chart offline-area entry point', () => {
    it('opens owned relief only while public OSM bulk download stays disabled', () => {
        expect(BULK_OFFLINE_PREFETCH_CAPABILITY.enabled).toBe(false);
        expect(OFFLINE_AREA_FAB_VISIBLE).toBe(true);
        expect(mapHubSource).toMatch(
            /OFFLINE_AREA_FAB_VISIBLE && \([\s\S]*?<button[\s\S]*?aria-label="Download offline relief"/,
        );
    });

    it('keeps imports available without routing the offline notice into bulk prefetch', () => {
        expect(mapHubSource).toContain('<OfflineAreaModal');
        expect(mapHubSource).not.toMatch(/setOfflineCardDismissed\(true\);\s*setShowOfflineArea\(true\);/);
        expect(mapHubSource).toMatch(
            /Free NOAA charts[\s\S]*Chart Locker[\s\S]*Licensed charts require your boat Pi connection/,
        );
        const modal = readFileSync(resolve(process.cwd(), 'components/map/OfflineAreaModal.tsx'), 'utf8');
        expect(modal).toContain('downloadReliefArea');
        expect(modal).not.toContain('MapOfflineService');
        expect(modal).toContain('Mapbox imagery, place labels and public OSM tiles are not stored');
    });
});
