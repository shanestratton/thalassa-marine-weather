import { describe, expect, it } from 'vitest';
import {
    addLocalChart,
    localChartKind,
    localChartPath,
    readLocalChartManifest,
    LOCAL_CHART_LIBRARY_BYTES,
    LOCAL_CHART_MANIFEST_BYTES,
    type LocalChartRecord,
} from '../services/charts/localChartLibraryContract';

const owner = 'a'.repeat(32),
    other = 'b'.repeat(32);
const chart = (number = 1, changes: Partial<LocalChartRecord> = {}): LocalChartRecord => ({
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    name: 'My anchorage.mbtiles',
    kind: 'mbtiles',
    bytes: 512,
    rights: 'own',
    importedAt: Date.UTC(2026, 9, 17),
    sha256: 'c'.repeat(64),
    ...changes,
});
const manifest = (charts: LocalChartRecord[] = []) => ({ schema: 1 as const, ownerNamespace: owner, charts });
const read = (value: unknown, namespace = owner) => readLocalChartManifest(JSON.stringify(value), namespace);

describe('private retained chart admission', () => {
    it('keeps charts after reopening the owner index without loading a database', () => {
        const saved = addLocalChart(manifest(), chart());
        expect(read(saved)).toEqual(saved);
        expect(localChartPath(owner, saved.charts[0])).toBe(`chart-library/${owner}/${chart().id}.mbtiles`);
    });
    it('refuses the previous owner index and caller provided paths', () => {
        expect(() => read(manifest([chart()]), other)).toThrow();
        expect(() => localChartPath('../' + owner, chart())).toThrow();
        expect(() => localChartPath(owner, chart(1, { id: '../../somewhere' }))).toThrow();
        const saved = read(manifest([Object.assign(chart(), { path: '../foreign', enabled: true })]));
        expect(saved.charts[0]).not.toHaveProperty('path');
        expect(saved.charts[0]).not.toHaveProperty('enabled');
    });
    it.each([
        '../mine.mbtiles',
        'folder/mine.kap',
        'folder\\mine.tif',
        'mine..kap',
        'mine\0.mbtiles',
        'oeSENC.oesenc',
        'catalogue.bsb',
        'mine.gpx',
        'x'.repeat(161) + '.kap',
    ])('refuses unsafe or unsupported file %s', (name) => {
        expect(() => localChartKind(name)).toThrow();
    });
    it.each(['mbtiles', 'kap', 'tif', 'tiff'] as const)(
        'admits the %s extension without pretending to validate chart content',
        (kind) => {
            expect(localChartKind(`My area.${kind.toUpperCase()}`)).toBe(kind);
            expect(read(manifest([chart(1, { name: `My area.${kind}`, kind })])).charts[0].kind).toBe(kind);
        },
    );
    it('requires explicit own or open rights on every retained chart', () => {
        for (const rights of [undefined, null, '', 'licensed', 'yes', true]) {
            expect(() => read(manifest([{ ...chart(), rights } as unknown as LocalChartRecord]))).toThrow();
        }
        expect(read(manifest([chart(1, { rights: 'open' })])).charts[0].rights).toBe('open');
    });
    it('enforces the exact whole-file and retained-library byte limits', () => {
        const half = LOCAL_CHART_LIBRARY_BYTES / 2;
        expect(read(manifest([chart(1, { bytes: half }), chart(2, { bytes: half })])).charts).toHaveLength(2);
        expect(() => read(manifest([chart(1, { bytes: half + 1 })]))).toThrow();
        expect(() => read(manifest([chart(1, { bytes: half }), chart(2, { bytes: half }), chart(3)]))).toThrow();
        for (const bytes of [0, -1, 7, 512.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => read(manifest([chart(1, { bytes })]))).toThrow();
        }
    });
    it('refuses duplicates and a ninth chart without evicting a retained chart', () => {
        const eight = manifest(Array.from({ length: 8 }, (_, i) => chart(i + 1)));
        expect(read(eight).charts).toHaveLength(8);
        expect(() => addLocalChart(eight, chart(9))).toThrow();
        expect(eight.charts).toHaveLength(8);
        expect(() => read(manifest([chart(), chart()]))).toThrow();
    });
    it('checks actual UTF-8 metadata bytes before parsing an untrusted index', () => {
        const long = JSON.stringify({ ...manifest(), padding: '🌊'.repeat(5000) });
        expect(long.length).toBeLessThan(LOCAL_CHART_MANIFEST_BYTES);
        expect(() => readLocalChartManifest(long, owner)).toThrow();
        expect(() => readLocalChartManifest('{', owner)).toThrow();
    });
    it.each([{ importedAt: 1 }, { sha256: 'invalid' }, { kind: 'kap' }, { name: '' }])(
        'refuses corrupted saved metadata %o',
        (changes) => {
            expect(() => read(manifest([chart(1, changes as Partial<LocalChartRecord>)]))).toThrow();
        },
    );
});
