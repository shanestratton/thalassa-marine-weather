import { describe, expect, it } from 'vitest';
import {
    ATMOS_CELLS,
    ATMOS_DATASETS,
    ATMOS_FIELDS,
    ATMOS_HEADER_BYTES,
    atmosFileBytes,
    canonicalAtmosGeneration,
    decodeAtmosFrame,
    validateAtmosManifest,
    type AtmosDataset,
} from '../services/weather/api/atmosContract';
import { sha256Hex } from '../services/weather/api/marineManifestContract';

const RUN = '2026-10-17T00:00:00Z';
const runMs = Date.parse(RUN);
const HOUR = 3_600_000;
const HEX = 'a'.repeat(64);
const originals = { gust: 12, visibility: 5000, pressure: 101200, temperature: 290, dewpoint: 289 };

function binary(dataset: AtmosDataset = 'gfs-atmos', offsetHours = 0): ArrayBuffer {
    const spec = ATMOS_DATASETS[dataset];
    const buffer = new ArrayBuffer(atmosFileBytes(dataset));
    const view = new DataView(buffer);
    view.setUint32(0, 0x53414854, true);
    view.setUint8(4, 1);
    view.setUint8(5, spec.code);
    view.setUint8(6, spec.fields.length);
    view.setUint16(8, 360, true);
    view.setUint16(10, 181, true);
    view.setFloat64(12, -180, true);
    view.setFloat64(20, -90, true);
    view.setFloat64(28, 1, true);
    view.setFloat64(36, 1, true);
    view.setFloat64(44, runMs, true);
    view.setUint16(52, offsetHours, true);
    spec.fields.forEach((name, channel) => {
        view.setUint8(56 + channel, ATMOS_FIELDS[name].code);
        const base = ATMOS_HEADER_BYTES + channel * ATMOS_CELLS * 5;
        for (let index = 0; index < ATMOS_CELLS; index++) view.setFloat32(base + index * 4, originals[name], true);
        new Uint8Array(buffer, base + ATMOS_CELLS * 4, ATMOS_CELLS).fill(1);
    });
    return buffer;
}

function manifest(dataset: AtmosDataset = 'gfs-atmos') {
    const spec = ATMOS_DATASETS[dataset];
    const generation = canonicalAtmosGeneration(RUN, dataset, Array(spec.steps).fill(HEX));
    return {
        schema_version: 2,
        dataset: { key: dataset, id: spec.id },
        generation,
        generated_at: '2026-10-17T04:00:00Z',
        published_at: '2026-10-17T04:05:00Z',
        data_start: RUN,
        data_end: new Date(runMs + (spec.steps - 1) * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
        cadence_hours: 6,
        dimensions: { width: 360, height: 181 },
        bounds: { west: -180, south: -90, east: 179, north: 90 },
        producer: { commit: 'b'.repeat(40), run_id: 1, run_attempt: 1 },
        metadata: {
            model: spec.model,
            source_resolution_degrees: '0.25',
            display_resolution_degrees: '1',
            fields: spec.fields.join(','),
            attribution: spec.attribution,
            licence: spec.licence,
        },
        files: Array.from({ length: spec.steps }, (_, step) => ({
            step,
            offset_hours: step * 6,
            data_time: new Date(runMs + step * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: atmosFileBytes(dataset),
            sha256: HEX,
            content_type: 'application/octet-stream',
        })),
    };
}

describe('atmospheric source contracts', () => {
    it('uses the existing standard SHA identity without changing marine dataset admission', () => {
        expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
        expect(canonicalAtmosGeneration(RUN, 'gfs-atmos', [HEX])).not.toBe(
            canonicalAtmosGeneration(RUN, 'ifs-pressure', [HEX]),
        );
    });

    it.each(['gfs-atmos', 'ifs-pressure'] as const)(
        'admits only a complete owned %s cohort with exact source clocks',
        (dataset) => {
            const source = manifest(dataset);
            const result = validateAtmosManifest(source, dataset, runMs + 5 * HOUR);
            expect(result.files).toHaveLength(ATMOS_DATASETS[dataset].steps);
            expect(result.files.at(-1)?.offset_hours).toBe(dataset === 'gfs-atmos' ? 168 : 240);
            source.files[0].sha256 = 'c'.repeat(64);
            source.files[0].filename = 'changed';
            expect(result.files[0].sha256).toBe(HEX);
            expect(result.files[0].filename).not.toBe('changed');
            expect(Object.isFrozen(result.files[0])).toBe(true);
        },
    );

    it('refuses a different selected model, nine-kilometre claim or altered licence', () => {
        for (const metadata of [
            { model: 'aifs' },
            { source_resolution_degrees: '0.09' },
            { display_resolution_degrees: '0.09' },
            { licence: 'anything' },
            { fields: 'pressure' },
        ]) {
            const source = manifest();
            Object.assign(source.metadata, metadata);
            expect(() => validateAtmosManifest(source, 'gfs-atmos', runMs + 5 * HOUR)).toThrow();
        }
        expect(() => validateAtmosManifest(manifest(), 'ifs-pressure', runMs + 5 * HOUR)).toThrow();
    });

    it('refuses partial, shifted, repeated, forged-digest or out-of-order frames', () => {
        const mutations = [
            (s: ReturnType<typeof manifest>) => {
                s.files.pop();
            },
            (s: ReturnType<typeof manifest>) => {
                s.files[1] = s.files[0];
            },
            (s: ReturnType<typeof manifest>) => {
                s.files[1].offset_hours = 7;
            },
            (s: ReturnType<typeof manifest>) => {
                s.files[1].data_time = '2026-10-17T07:00:00Z';
            },
            (s: ReturnType<typeof manifest>) => {
                s.files[1].sha256 = 'c'.repeat(64);
            },
            (s: ReturnType<typeof manifest>) => {
                s.files[1].bytes++;
            },
            (s: ReturnType<typeof manifest>) => {
                s.generation = 'g-20261017T000000Z-' + '0'.repeat(12);
            },
            (s: ReturnType<typeof manifest>) => {
                s.data_end = '2026-10-23T00:00:00Z';
            },
            (s: ReturnType<typeof manifest>) => {
                s.bounds.east = 180;
            },
        ];
        for (const mutate of mutations) {
            const s = manifest();
            mutate(s);
            expect(() => validateAtmosManifest(s, 'gfs-atmos', runMs + 5 * HOUR)).toThrow();
        }
    });

    it('refuses stale, future, impossible UTC and ineligible IFS06/18 cycles', () => {
        expect(() => validateAtmosManifest(manifest(), 'gfs-atmos', runMs + 13 * HOUR)).toThrow(/stale/);
        expect(() => validateAtmosManifest(manifest('ifs-pressure'), 'ifs-pressure', runMs + 25 * HOUR)).toThrow(
            /stale/,
        );
        expect(() => validateAtmosManifest(manifest(), 'gfs-atmos', runMs - HOUR)).toThrow(/future/);
        const source = manifest();
        source.data_start = '2026-02-30T00:00:00Z';
        expect(() => validateAtmosManifest(source, 'gfs-atmos', runMs + 5 * HOUR)).toThrow(/date/);
        for (const hour of [6, 18]) {
            const m = manifest('ifs-pressure');
            m.data_start = `2026-10-17T${String(hour).padStart(2, '0')}:00:00Z`;
            expect(() => validateAtmosManifest(m, 'ifs-pressure', runMs + 20 * HOUR)).toThrow(/cycle/);
        }
    });

    it.each(['gfs-atmos', 'ifs-pressure'] as const)(
        'decodes exact %s native units and gives owned scalar planes',
        (dataset) => {
            const buffer = binary(dataset, 6);
            const result = decodeAtmosFrame(buffer, dataset, runMs, 6);
            expect(result.fields.pressure?.values[0]).toBe(101200);
            expect(result.fields.pressure?.wrapLongitude).toBe(true);
            expect(result.fields.gust?.values[0]).toBe(dataset === 'gfs-atmos' ? 12 : undefined);
            new Uint8Array(buffer).fill(0);
            expect(result.fields.pressure?.values[0]).toBe(101200);
        },
    );

    it('rejects THCU, wrong model, reordered fields, dimensions, clock and trailing bytes', () => {
        const edits = [
            (v: DataView) => v.setUint32(0, 0x55434854, true),
            (v: DataView) => v.setUint8(4, 2),
            (v: DataView) => v.setUint8(5, 2),
            (v: DataView) => v.setUint8(56, 3),
            (v: DataView) => v.setUint8(63, 1),
            (v: DataView) => v.setUint16(8, 361, true),
            (v: DataView) => v.setFloat64(28, 0.25, true),
            (v: DataView) => v.setFloat64(44, runMs + 6 * HOUR, true),
            (v: DataView) => v.setUint16(52, 6, true),
            (v: DataView) => v.setUint16(54, 1, true),
        ];
        for (const edit of edits) {
            const b = binary();
            edit(new DataView(b));
            expect(() => decodeAtmosFrame(b, 'gfs-atmos', runMs, 0)).toThrow();
        }
        expect(() => decodeAtmosFrame(new ArrayBuffer(atmosFileBytes('gfs-atmos') + 1), 'gfs-atmos', runMs, 0)).toThrow(
            /size/,
        );
    });

    it('keeps known missing cells masked and refuses nonbinary, nonfinite or physically wrong values', () => {
        const buffer = binary();
        const view = new DataView(buffer);
        view.setFloat32(ATMOS_HEADER_BYTES, 0, true);
        view.setUint8(ATMOS_HEADER_BYTES + ATMOS_CELLS * 4, 0);
        const frame = decodeAtmosFrame(buffer, 'gfs-atmos', runMs, 0);
        expect(frame.fields.gust?.validMask[0]).toBe(0);
        for (const value of [NaN, Infinity, -1, 151]) {
            const b = binary();
            new DataView(b).setFloat32(ATMOS_HEADER_BYTES, value, true);
            expect(() => decodeAtmosFrame(b, 'gfs-atmos', runMs, 0)).toThrow(/values/);
        }
        const invalid = binary();
        new DataView(invalid).setUint8(ATMOS_HEADER_BYTES + ATMOS_CELLS * 4, 2);
        expect(() => decodeAtmosFrame(invalid, 'gfs-atmos', runMs, 0)).toThrow(/mask/);
        const hidden = binary();
        new DataView(hidden).setUint8(ATMOS_HEADER_BYTES + ATMOS_CELLS * 4, 0);
        expect(() => decodeAtmosFrame(hidden, 'gfs-atmos', runMs, 0)).toThrow(/mask/);
    });

    it('refuses a nearly empty plane and checks retirement while decoding', () => {
        const b = binary();
        new Uint8Array(b, ATMOS_HEADER_BYTES, ATMOS_CELLS * 5).fill(0);
        expect(() => decodeAtmosFrame(b, 'gfs-atmos', runMs, 0)).toThrow(/coverage/);
        let checks = 0;
        expect(() =>
            decodeAtmosFrame(binary(), 'gfs-atmos', runMs, 0, () => {
                if (++checks === 4) throw new Error('retired');
            }),
        ).toThrow('retired');
        expect(checks).toBe(4);
    });
});
