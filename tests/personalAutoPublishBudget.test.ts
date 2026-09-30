/**
 * Auto-publish is for "a few new cells", never a whole library behind the
 * skipper's back (Phase 2a review, 2026-09-30).
 *
 * The opt-in exists because a first publish is ~400 MB on an unknown
 * connection. But a converter schema change (schema 2 re-extracts every chart
 * with the bridge and overhead-line layers) changes every cell's size, so
 * every cell "needs publish" again — and the fire-and-forget auto-publish at
 * the end of a Pi sync would re-upload the whole personal library over
 * Starlink or 4G, under way, with no confirmation. Past a small budget it now
 * waits for the manual publish, which shows the size first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cells: [] as unknown[],
    upload: vi.fn(async () => ({ error: null })),
    manifest: null as unknown,
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    getCurrentUserId: async () => 'user-1',
    supabase: {
        storage: {
            from: () => ({
                download: async () =>
                    mocks.manifest
                        ? { data: new Blob([JSON.stringify(mocks.manifest)]), error: null }
                        : { data: null, error: { message: 'not found' } },
                upload: mocks.upload,
            }),
        },
    },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    listRegisteredCells: () => mocks.cells,
    putCell: vi.fn(),
    resumeNotifications: vi.fn(),
    suspendNotifications: vi.fn(),
}));
vi.mock('../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: async (id: string) => ({ cellId: id, layers: {} }),
}));

import {
    AUTO_PUBLISH_MAX_BYTES,
    publishNewCellsIfEnabled,
    resetPersonalCellSync,
    setAutoPublishEnabled,
} from '../services/enc/personalCellSync';

const cell = (i: number, sizeBytes: number) => ({
    id: `OC-61-${String(100000 + i)}`,
    bbox: [153, -27.5, 153.1, -27.4],
    edition: 1,
    sizeBytes,
    usage: 'navigation',
});

beforeEach(() => {
    localStorage.clear();
    resetPersonalCellSync();
    mocks.upload.mockClear();
    setAutoPublishEnabled(true);
});

describe('auto-publish budget', () => {
    it('a whole library whose sizes all changed (a converter schema change) is NOT auto-uploaded', async () => {
        const n = 300;
        mocks.cells = Array.from({ length: n }, (_, i) => cell(i, 1_400_000 + 1));
        mocks.manifest = {
            version: 3,
            cells: Array.from({ length: n }, (_, i) => ({
                cellId: cell(i, 0).id,
                bbox: [153, -27.5, 153.1, -27.4],
                sourceBytes: 1_400_000,
                edition: 1,
            })),
        };
        await publishNewCellsIfEnabled();
        expect(mocks.upload).not.toHaveBeenCalled();
    });

    it('a few newly imported cells still auto-publish', async () => {
        mocks.cells = [cell(1, 900_000), cell(2, 1_100_000)];
        mocks.manifest = null;
        await publishNewCellsIfEnabled();
        // Two cells + the manifest.
        expect(mocks.upload).toHaveBeenCalledTimes(3);
    });

    it('the budget is small enough for a mobile link', () => {
        expect(AUTO_PUBLISH_MAX_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
    });
});
