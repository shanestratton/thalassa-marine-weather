/**
 * The chart's hydration walk gets the boat's Pi rung (127-C-c decision 8a).
 *
 * A licensed cell is held in memory only, so after any relaunch (or an iOS
 * reclaim) the chart has to refill it from the boat. Until 127 the walk asked
 * the cloud alone — and the cloud answers NOAA cells only since 126-20 — so a
 * memory-only cell would never come back. Protected → the Pi; open → the
 * cloud. Fictional ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    downloadPiCell: vi.fn(async (_id: string) => true),
    downloadCloudCell: vi.fn(async (_id: string) => true),
}));
vi.mock('../services/enc/piCellSync', () => ({ downloadPiCell: h.downloadPiCell }));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCell: h.downloadCloudCell }));

import * as meta from '../services/enc/EncCellMetadata';
import { __hydrateMissingCellsForTest } from '../services/enc/EncHazardService';
import type { EncCell } from '../services/enc/types';

const rec = (id: string, sourceHO: string, licence?: EncCell['licence']): EncCell => ({
    id,
    sourceHO,
    edition: 1,
    issued: '2026-09-01',
    importedAt: '2026-09-02T00:00:00.000Z',
    bbox: [-9.3, 38.6, -9.1, 38.8],
    geojsonPath: 'vault',
    hazardCount: 2,
    usage: 'navigation',
    ...(licence ? { licence } : {}),
});

describe('hydrateMissingCells — protected cells refill from the Pi, open ones from the cloud', () => {
    beforeEach(() => {
        localStorage.clear();
        meta.clearAllCellMetadata();
        h.downloadPiCell.mockClear();
        h.downloadCloudCell.mockClear();
    });

    it('sends a protected id to downloadPiCell and a NOAA id to downloadCloudCell', async () => {
        meta.putCell(rec('OC-99-ZZ0301', 'ZZ'));
        meta.putCell(rec('US5ZZ01M', 'US'));
        await __hydrateMissingCellsForTest(['OC-99-ZZ0301', 'US5ZZ01M']);
        expect(h.downloadPiCell.mock.calls.map((c) => c[0])).toEqual(['OC-99-ZZ0301']);
        expect(h.downloadCloudCell.mock.calls.map((c) => c[0])).toEqual(['US5ZZ01M']);
    });

    it('a NOAA-named cell the Pi stamped protected goes to the Pi, never the cloud', async () => {
        meta.putCell(rec('US4ZZ02M', 'US', 'protected'));
        await __hydrateMissingCellsForTest(['US4ZZ02M']);
        expect(h.downloadPiCell).toHaveBeenCalledWith('US4ZZ02M');
        expect(h.downloadCloudCell).not.toHaveBeenCalled();
    });
});
