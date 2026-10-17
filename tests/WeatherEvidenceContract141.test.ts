import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    decodeEvidenceIndex,
    decodeEvidencePointer,
    decodeMeasuredBuoy,
    decodeStationSkill,
    type EvidenceKind,
} from '../services/weather/evidenceContract';

const raw = (name: string) => readFileSync(resolve('tests/fixtures/weather-evidence141', name));
const json = (name: string) => JSON.parse(raw(name + '.txt').toString());
function cohort(kind: EvidenceKind) {
    const pointerRaw = json('pointer-' + kind);
    const pointer = decodeEvidencePointer(pointerRaw, kind, pointerRaw.generatedAt + 1);
    const source = json('index-' + kind);
    const index = decodeEvidenceIndex(source, pointer);
    return { pointerRaw, pointer, source, index };
}

describe('actual wx original station cohort client contract', () => {
    it('retains exact original fixture byte/digest identities, not reconstructed JSON hashes', () => {
        const receipt = JSON.parse(raw('receipt.json').toString());
        for (const [name, value] of Object.entries(receipt.files)) {
            if (name.startsWith('generation-')) continue;
            const row = value as { sha256: string; bytes: number };
            expect(raw(name).length).toBe(row.bytes);
            expect(createHash('sha256').update(raw(name)).digest('hex')).toBe(row.sha256);
        }
        for (const kind of ['buoys', 'skill'] as const) {
            expect(
                createHash('sha256')
                    .update(raw(`index-${kind}.txt`))
                    .digest('hex'),
            ).toBe(cohort(kind).pointer.generation);
        }
    });
    it('accepts the actual 29 stations and explicit held networks without claiming complete coverage', () => {
        const { index } = cohort('buoys');
        expect(index.stations).toHaveLength(29);
        expect(index.stations.filter((s) => s.network === 'ndbc')).toHaveLength(19);
        expect(index.stations.filter((s) => s.network === 'qld-des')).toHaveLength(10);
        expect(index.heldNetworks.aodn).toContain('not yet admitted');
        expect(index.heldNetworks['cmems-insitu']).toContain('not yet admitted');
        expect(Object.isFrozen(index.stations[0])).toBe(true);
    });
    it.each(['ndbc', 'qld-des'])('accepts actual %s measurements and preserves their quality/clock/gaps', (network) => {
        const { index } = cohort('buoys');
        const detail = json('detail-buoys-' + network);
        const station = index.stations.find((s) => s.key === detail.key)!;
        const parsed = decodeMeasuredBuoy(detail, station, index.generatedAt);
        expect(parsed.measured).toEqual(detail.measured);
        expect(parsed.receivedAt).toBe(detail.receivedAt);
        expect(parsed.issuedForecasts).toEqual([]); // The first captured future hour had not occurred.
        expect(station.qcBasis).toContain(network === 'ndbc' ? 'preliminary' : 'provisional');
        expect(Object.isFrozen(parsed.measured[0])).toBe(true);
    });
    it('accepts all 20 real warming station skill records without any invented model vote or MAE', () => {
        const { index } = cohort('skill');
        expect(index.stations).toHaveLength(20);
        const detail = json('detail-skill-ndbc');
        const station = index.stations.find((s) => s.key === detail.key)!;
        const parsed = decodeStationSkill(detail, station, index.generatedAt);
        for (const metric of Object.values(parsed.metrics))
            for (const lead of Object.values(metric)) {
                expect(lead.status).toBe('warming');
                expect(lead.closest).toBeNull();
                expect(Object.values(lead.models).every((row) => row.mae === null)).toBe(true);
            }
    });
    it('refuses stale/future pointers, foreign paths, mixed source generations and oversized declarations', () => {
        const { pointerRaw, pointer, source } = cohort('buoys');
        expect(() => decodeEvidencePointer(pointerRaw, 'buoys', pointer.expiresAt)).toThrow();
        expect(() => decodeEvidencePointer(pointerRaw, 'buoys', pointer.generatedAt - 1)).toThrow();
        expect(() =>
            decodeEvidencePointer(
                { ...pointerRaw, indexPath: 'https://evil.example/boat' },
                'buoys',
                pointer.generatedAt,
            ),
        ).toThrow();
        expect(() =>
            decodeEvidencePointer({ ...pointerRaw, indexBytes: 262145 }, 'buoys', pointer.generatedAt),
        ).toThrow();
        expect(() => decodeEvidenceIndex({ ...source, generatedAt: pointer.generatedAt - 1 }, pointer)).toThrow();
        expect(() =>
            decodeEvidenceIndex({ ...source, stations: [...source.stations, source.stations[0]] }, pointer),
        ).toThrow();
    });
    it('refuses a partner/private identity, guessed field, invalid coordinates and unbounded detail size', () => {
        const { pointer, source } = cohort('buoys');
        for (const patch of [
            { owner: 'Private yacht' },
            { key: 'user:abc' },
            { lat: 91 },
            { detailBytes: 131073 },
            { network: 'aodn' },
            { alertSafe: true },
        ]) {
            const stations = [...source.stations];
            stations[0] = { ...stations[0], ...patch };
            expect(() => decodeEvidenceIndex({ ...source, stations }, pointer)).toThrow();
        }
    });
    it('keeps individual station expiry independent from a still-current cohort pointer', () => {
        const { pointer, source } = cohort('buoys');
        const at = Math.min(...source.stations.map((s: { expiresAt: number }) => s.expiresAt));
        expect(at).toBeLessThan(pointer.expiresAt);
        // The original index remains structurally valid. The session/renderer must
        // omit expired individual stations; it must not renew their receipt clocks.
        expect(decodeEvidencePointer(json('pointer-buoys'), 'buoys', at).expiresAt).toBe(pointer.expiresAt);
        expect(decodeEvidenceIndex(source, pointer).stations.some((s) => s.expiresAt === at)).toBe(true);
    });
    it('bounds cohort availability slack to90min without extending original station freshness', () => {
        const { pointerRaw, pointer, source } = cohort('buoys');
        const extended = { ...pointerRaw, expiresAt: pointer.generatedAt + 5400 };
        expect(decodeEvidencePointer(extended, 'buoys', pointer.generatedAt + 5399).expiresAt).toBe(extended.expiresAt);
        expect(() => decodeEvidencePointer(extended, 'buoys', extended.expiresAt)).toThrow();
        expect(() =>
            decodeEvidencePointer({ ...extended, expiresAt: extended.expiresAt + 1 }, 'buoys', pointer.generatedAt),
        ).toThrow();
        const changed = [...source.stations];
        changed[0] = { ...changed[0], expiresAt: changed[0].observedAt + 3 * 3600 + 1 };
        expect(() => decodeEvidenceIndex({ ...source, stations: changed }, pointer)).toThrow();
    });
    it('refuses a provisional station relabelled as QC-controlled and any changed latest measurement', () => {
        const { index } = cohort('buoys');
        const source = json('detail-buoys-qld-des');
        const station = index.stations.find((s) => s.key === source.key)!;
        expect(() =>
            decodeMeasuredBuoy({ ...source, quality: 'quality-controlled' }, station, index.generatedAt),
        ).toThrow();
        const changed = structuredClone(source);
        changed.measured.at(-1)[1] += 0.1;
        expect(() => decodeMeasuredBuoy(changed, station, index.generatedAt)).toThrow();
        expect(() =>
            decodeMeasuredBuoy({ ...source, receivedAt: index.generatedAt + 1 }, station, index.generatedAt),
        ).toThrow();
    });
    it('preserves true zero and refuses nonfinite, duplicate, overlong and outside-window observations', () => {
        const { index } = cohort('buoys');
        const source = json('detail-buoys-ndbc');
        const station = index.stations.find((s) => s.key === source.key)!;
        const zero = structuredClone(source);
        zero.measured.at(-1)[1] = 0;
        expect(decodeMeasuredBuoy(zero, { ...station, hsM: 0 }, index.generatedAt).measured.at(-1)![1]).toBe(0);
        for (const measured of [
            [[index.generatedAt + 1, 1]],
            [[source.measured[0][0], NaN]],
            [source.measured[0], ...source.measured],
            [[index.generatedAt - 72 * 3600 - 1, 1], ...source.measured],
            Array.from({ length: 4097 }, () => source.measured[0]),
        ]) {
            expect(() => decodeMeasuredBuoy({ ...source, measured }, station, index.generatedAt)).toThrow();
        }
    });
    it('requires genuine forward-captured wave lines, with no retrospective/past-days substitution', () => {
        const { index } = cohort('buoys');
        const source = json('detail-buoys-ndbc');
        const station = index.stations.find((s) => s.key === source.key)!;
        const at = Math.floor(index.generatedAt / 3600) * 3600;
        const line = { model: 'ecmwf_wam025', lead: '0-6h', points: [[at, 0, at - 4 * 3600, at - 3 * 3600]] };
        expect(
            decodeMeasuredBuoy({ ...source, issuedForecasts: [line] }, station, index.generatedAt).issuedForecasts[0]
                .points[0][1],
        ).toBe(0);
        for (const patch of [
            { model: 'best_match' },
            { model: 'ecmwf_ifs' },
            { lead: '6-24h' },
            { points: [[at, 1, at - 3600, at + 1]] },
            { points: [line.points[0], line.points[0]] },
        ]) {
            expect(() =>
                decodeMeasuredBuoy({ ...source, issuedForecasts: [{ ...line, ...patch }] }, station, index.generatedAt),
            ).toThrow();
        }
    });
    it('rejects stale/mixed station skill metadata and a warming station promoted in only its index', () => {
        const { index } = cohort('skill');
        const source = json('detail-skill-ndbc');
        const station = index.stations.find((s) => s.key === source.key)!;
        expect(() =>
            decodeStationSkill({ ...source, generatedAt: index.generatedAt - 1 }, station, index.generatedAt),
        ).toThrow();
        expect(() => decodeStationSkill(source, { ...station, status: 'ready' }, index.generatedAt)).toThrow();
        expect(() => decodeStationSkill({ ...source, owner: 'Other provider' }, station, index.generatedAt)).toThrow();
    });
});
