import { it, expect, vi, beforeEach } from 'vitest';
const f = vi.hoisted(() => ({
    version: 1,
    pair: { deviceId: 'pi-A' },
    lan: 'https://boat.local',
    cell: {
        id: 'AU123456',
        sourceHO: 'AU',
        edition: 1,
        updateNumber: 2,
        contentSha256: 'a'.repeat(64),
        usage: 'navigation',
    },
    data: null as unknown,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => f.version,
    getDisplayCell: (id: string) => (id === f.cell.id ? f.cell : null),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => f.pair }));
vi.mock('../services/enc/piCellSync', () => ({ boatLanBaseNow: () => f.lan }));
import { registerEntryChartView, borrowedEntryChartAreas } from '../services/userOverlays/chartAreas';
import type { EncMergedVectorData } from '../services/enc/EncHazardService';
const polygon = (x: number) => ({
    type: 'Feature',
    properties: { _cellId: 'AU123456', _caution: 'RESARE', RESTRN: '7,13,14,27', OBJNAM: '' },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x, 0],
                [x + 1, 0],
                [x + 1, 1],
                [x, 1],
                [x, 0],
            ],
        ],
    },
});
beforeEach(() => {
    f.version = 1;
    f.pair = { deviceId: 'pi-A' };
    f.lan = 'https://boat.local';
    f.cell = {
        id: 'AU123456',
        sourceHO: 'AU',
        edition: 1,
        updateNumber: 2,
        contentSha256: 'a'.repeat(64),
        usage: 'navigation',
    };
});
it('borrows current data synchronously with distinct unnamed feature+revision keys and no IO', () => {
    const map = {},
        data = {
            CAUTION_AREAS: { type: 'FeatureCollection', features: [polygon(0), polygon(2)] },
        } as unknown as EncMergedVectorData;
    const release = registerEntryChartView(map, () => data);
    const areas = borrowedEntryChartAreas(map)!;
    expect(areas).toHaveLength(2);
    expect(areas[0].key).not.toBe(areas[1].key);
    expect(areas[0].geometry).toBe(data.CAUTION_AREAS.features[0].geometry);
    expect(areas[0].label).toContain('no wake');
    const first = areas[0].key;
    f.cell.updateNumber++;
    expect(borrowedEntryChartAreas(map)![0].key).not.toBe(first);
    release();
    expect(borrowedEntryChartAreas(map)).toBeNull();
});
it('aboard, displayed revision and source ownership are mandatory; no-row never means clear', () => {
    const map = {};
    registerEntryChartView(
        map,
        () => ({ CAUTION_AREAS: { features: [polygon(0)] } }) as unknown as EncMergedVectorData,
    );
    f.lan = '';
    expect(borrowedEntryChartAreas(map)).toBeNull();
    f.lan = 'boat';
    f.cell.usage = 'reference';
    expect(borrowedEntryChartAreas(map)).toBeNull();
    f.cell.usage = 'navigation';
    const release = registerEntryChartView(map, () => null);
    expect(borrowedEntryChartAreas(map)).toBeNull();
    release();
});
it('a seafloor-heavy current view does not mask its bounded restricted polygons', () => {
    const map = {};
    registerEntryChartView(
        map,
        () =>
            ({
                CAUTION_AREAS: {
                    features: [
                        ...Array.from({ length: 3000 }, () => ({
                            ...polygon(0),
                            properties: { _cellId: 'AU123456', _caution: 'SBDARE' },
                        })),
                        polygon(1),
                    ],
                },
            }) as unknown as EncMergedVectorData,
    );
    expect(borrowedEntryChartAreas(map)).toHaveLength(1);
});
