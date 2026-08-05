import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFLINE_AREA_FAB_VISIBLE } from '../components/map/mapHubHelpers';
import { BULK_OFFLINE_PREFETCH_CAPABILITY } from '../services/MapOfflineService';

const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');

describe('Chart offline-area entry point', () => {
    it('parks the bulk-download entry point for an unlicensed public tile provider', () => {
        expect(BULK_OFFLINE_PREFETCH_CAPABILITY.enabled).toBe(false);
        expect(OFFLINE_AREA_FAB_VISIBLE).toBe(false);
        expect(mapHubSource).toMatch(
            /OFFLINE_AREA_FAB_VISIBLE && \([\s\S]*?<button[\s\S]*?aria-label="Download offline map area"/,
        );
    });

    it('keeps imports available without routing the offline notice into bulk prefetch', () => {
        expect(mapHubSource).toContain('<OfflineAreaModal');
        expect(mapHubSource).not.toMatch(/setOfflineCardDismissed\(true\);\s*setShowOfflineArea\(true\);/);
        expect(mapHubSource).toMatch(/Imported MBTiles,[\s\S]*licensed charts[\s\S]*remain available offline/);
    });
});
