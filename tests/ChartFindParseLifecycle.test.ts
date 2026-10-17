import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    captureChartFindCell,
    indexChartFindCell,
    retireChartFindMemory,
    searchChartFindMemory,
} from '../services/enc/chartFindMemory';
import { parseAndCacheCellText, parseAndCacheCellTextAsync, shedCellMemory } from '../services/enc/EncCellStore';
import { putCell, removeCell, clearAllCellMetadata } from '../services/enc/EncCellMetadata';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import { importCell } from '../services/enc/EncHazardService';
import { Filesystem } from '@capacitor/filesystem';
const blob: EncConversionResult = {
    cellId: 'US5TEST1',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    bbox: [150, -28, 152, -26],
    layers: {
        LIGHTS: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { OBJNAM: 'Fixture light', LITCHR: 2, COLOUR: '4', SIGPER: 3 },
                    geometry: { type: 'Point', coordinates: [151, -27] },
                },
            ],
        },
    },
};
const cell: EncCell = {
    id: blob.cellId,
    sourceHO: 'US',
    edition: 1,
    issued: blob.issued,
    importedAt: '2026-10-16T00:00:00Z',
    bbox: blob.bbox,
    geojsonPath: 'local',
    hazardCount: 0,
};
beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
    retireChartFindMemory();
    vi.stubGlobal('Worker', undefined);
});
describe('chart-find hooks in actual chart lifecycle', () => {
    it('keeps the original account fence while a second import waits in the cell queue', async () => {
        let finish!: (value: { uri: string }) => void;
        vi.mocked(Filesystem.writeFile).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const first = importCell(blob);
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const queued = importCell({ ...blob, edition: 2 });
        setAuthIdentityScope('after-queued-import');
        finish({ uri: 'fixture-only' });
        await Promise.all([first, queued]);
        expect(searchChartFindMemory('Fl.G3s', () => true).matches).toHaveLength(0);
    });
    it('indexes the validated byte-import after its metadata commit, but not an import completed for an old account', async () => {
        await importCell(blob);
        expect(searchChartFindMemory('Fl.G3s', () => true).matches).toHaveLength(1);
        let finish!: (value: { uri: string }) => void;
        vi.mocked(Filesystem.writeFile).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const replacement = importCell({ ...blob, edition: 2 });
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        setAuthIdentityScope('new-import-owner');
        finish({ uri: 'fixture-only' });
        await replacement;
        expect(searchChartFindMemory('Fl.G3s', () => true).matches).toHaveLength(0);
    });
    it('indexes an actual parsed cell and preserves it on a byte-identical metadata upsert, then retires on revision/removal/memory shed', () => {
        putCell(cell);
        parseAndCacheCellText(cell.id, JSON.stringify(blob));
        const query = () => searchChartFindMemory('Fl.G3s', () => true).matches;
        expect(query()).toHaveLength(1);
        putCell(cell);
        expect(query()).toHaveLength(1);
        putCell({ ...cell, edition: 2 });
        expect(query()).toHaveLength(0);
        indexChartFindCell(captureChartFindCell(cell.id), blob, 'open');
        removeCell(cell.id);
        expect(query()).toHaveLength(0);
        indexChartFindCell(captureChartFindCell(cell.id), blob, 'open');
        shedCellMemory();
        expect(query()).toHaveLength(0);
    });
    it('never indexes a late worker reply or its sync-error fallback after an account switch', async () => {
        class Worker {
            static latest: Worker;
            message: { seq: number } | null = null;
            onmessage: ((event: { data: { seq: number; blob: unknown } }) => void) | null = null;
            onerror: (() => void) | null = null;
            constructor() {
                Worker.latest = this;
            }
            postMessage(message: { seq: number }) {
                this.message = message;
            }
        }
        vi.stubGlobal('Worker', Worker);
        setAuthIdentityScope('parse-owner-a');
        const pending = parseAndCacheCellTextAsync(cell.id, JSON.stringify(blob));
        setAuthIdentityScope('parse-owner-b');
        Worker.latest.onmessage!({ data: { seq: Worker.latest.message!.seq, blob } });
        await pending;
        expect(searchChartFindMemory('light', () => true).matches).toHaveLength(0);
        const fallback = parseAndCacheCellTextAsync(cell.id, JSON.stringify(blob));
        retireChartFindMemory();
        Worker.latest.onerror!();
        await fallback;
        expect(searchChartFindMemory('light', () => true).matches).toHaveLength(0);
    });
});
