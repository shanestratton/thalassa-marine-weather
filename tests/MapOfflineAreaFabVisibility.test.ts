import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFLINE_AREA_FAB_VISIBLE } from '../components/map/mapHubHelpers';

const mapHubSource = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');

describe('Chart offline-area entry point', () => {
    it('keeps the download FAB parked', () => {
        expect(OFFLINE_AREA_FAB_VISIBLE).toBe(false);
        expect(mapHubSource).toMatch(
            /OFFLINE_AREA_FAB_VISIBLE && \(\s*<button[\s\S]*?aria-label="Download offline map area"/,
        );
    });

    it('preserves the underlying modal for the offline recovery flow', () => {
        expect(mapHubSource).toContain('<OfflineAreaModal');
        expect(mapHubSource).toMatch(/setOfflineCardDismissed\(true\);\s*setShowOfflineArea\(true\);/);
    });
});
