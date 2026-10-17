import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    decodeEvidenceIndex,
    decodeEvidencePointer,
    decodeMeasuredBuoy,
    decodeStationSkill,
    type EvidenceKind,
} from '../services/weather/evidenceContract';
import { openWeatherEvidenceSession } from '../services/weather/evidenceSession';
import { thinnedBuoyStations } from '../services/weather/buoyPresentation';
vi.mock('../services/networkPolicy', () => ({ assertNetworkAllowed: vi.fn() }));

const fixtureRaw = readFileSync(resolve('tests/fixtures/weather-evidence141/scheduled-cohort.txt'));
const fixture = JSON.parse(fixtureRaw.toString('utf8')) as {
    checkedAt: number;
    receiptSha256: string;
    objects: { path: string; bytes: number; sha256: string; bodyBase64: string }[];
};
const files = new Map(fixture.objects.map((row) => [row.path, Uint8Array.from(Buffer.from(row.bodyBase64, 'base64'))]));
const parse = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)!));
const prefix = (kind: EvidenceKind) => (kind === 'buoys' ? 'buoys/v1/' : 'skill/issued-v1/');
function cohort(kind: EvidenceKind) {
    const p = prefix(kind);
    const pointer = decodeEvidencePointer(parse(p + 'latest.json'), kind, fixture.checkedAt);
    return { pointer, index: decodeEvidenceIndex(parse(p + pointer.indexPath), pointer) };
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(fixture.checkedAt * 1000);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
            const path = new URL(input).pathname.split('/weather/')[1];
            const raw = files.get(path);
            return new Response(raw?.slice().buffer, {
                status: raw ? 200 : 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('actual first scheduled public cohort originals, 2026-10-17', () => {
    it('matches all 65 downloaded object bytes and original independent receipt', () => {
        expect(createHash('sha256').update(fixtureRaw).digest('hex')).toBe(
            '39fe9947c31ad39f35fb1da1fb589291e2126c1c3303cc801abfa7ee1389bad1',
        );
        expect(fixture.receiptSha256).toBe('c7f2f49758419781238a716df601756cc13b912449ee5ad8dc5c5e8d1333af78');
        expect(files.size).toBe(65);
        for (const row of fixture.objects) {
            const raw = files.get(row.path)!;
            expect(raw.byteLength).toBe(row.bytes);
            expect(createHash('sha256').update(raw).digest('hex')).toBe(row.sha256);
        }
    });
    it('decodes all 41 current NOAA/Queensland histories and 90 minute availability without renewing station clocks', () => {
        const { pointer, index } = cohort('buoys');
        expect(pointer.expiresAt - pointer.generatedAt).toBe(5400);
        expect(index.stations).toHaveLength(41);
        expect(index.stations.filter((row) => row.quality === 'provisional')).toHaveLength(22);
        let samples = 0;
        for (const row of index.stations) {
            const detail = decodeMeasuredBuoy(
                parse(prefix('buoys') + `generations/${index.generation}/${row.detailSha256}.json`),
                row,
                index.generatedAt,
            );
            expect(row.expiresAt).toBeLessThanOrEqual(row.observedAt! + 10800);
            samples += detail.measured.length;
            expect(detail.issuedForecasts).toHaveLength(0);
        }
        expect(samples).toBe(7132);
    });
    it('keeps all 20 stations/160 lead-metric bins honestly warming without a winner or MAE', () => {
        const { index } = cohort('skill');
        expect(index.stations).toHaveLength(20);
        let bins = 0;
        for (const row of index.stations) {
            const detail = decodeStationSkill(
                parse(prefix('skill') + `generations/${index.generation}/${row.detailSha256}.json`),
                row,
                index.generatedAt,
            );
            for (const metric of Object.values(detail.metrics))
                for (const lead of Object.values(metric)) {
                    bins++;
                    expect(lead.status).toBe('warming');
                    expect(lead.closest).toBeNull();
                    for (const model of Object.values(lead.models)) expect(model.mae).toBeNull();
                }
        }
        expect(bins).toBe(160);
    });
    it('refuses a cached original Queensland station at its earlier expiry while the actual cohort remains current', async () => {
        const { index } = cohort('buoys');
        const earliest = [...index.stations].sort((a, b) => a.expiresAt - b.expiresAt)[0];
        expect(earliest.expiresAt).toBeLessThan(index.expiresAt);
        vi.mocked(Date.now).mockReturnValue(earliest.expiresAt * 1000 - 1000);
        const session = await openWeatherEvidenceSession('buoys', new AbortController().signal);
        try {
            await session.readStation(earliest.key);
            expect(fetch).toHaveBeenCalledTimes(3);
            vi.mocked(Date.now).mockReturnValue(earliest.expiresAt * 1000);
            expect(session.isCurrent()).toBe(true);
            await expect(session.readStation(earliest.key)).rejects.toThrow(/expired/);
            expect(fetch).toHaveBeenCalledTimes(3);
            const visible = thinnedBuoyStations(index.stations, Date.now(), () => ({ x: 100, y: 100 }), 375, 667);
            expect(visible.every((row) => row.expiresAt > Date.now() / 1000)).toBe(true);
            expect(visible.some((row) => row.key === earliest.key)).toBe(false);
        } finally {
            session.close();
        }
    });
});
