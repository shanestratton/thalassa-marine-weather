import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { encodeSeabedCsv, type SeabedRow } from '../services/seabed/seabedCore';
import { readExportedBatch, digest, type ExportPorts } from '../supabase/functions/crowd-sounding-export/core';
import { handleCrowdExport, type ExportOptions } from '../supabase/functions/crowd-sounding-export/handler';
const at = Date.UTC(2026, 8, 1, 12),
    now = at + 31 * 86400000;
const owner = '11111111-1111-4111-8111-111111111111',
    boat = '22222222-2222-4222-8222-222222222222',
    batchId = '33333333-3333-4333-8333-333333333333';
const row: SeabedRow = {
    lon: 154,
    lat: -27,
    depth: 10,
    timeMs: at,
    depthRef: 'T',
    flags: 0,
    sogKn: 5,
    cogDeg: 45,
    hdgDeg: 45,
    heelDeg: 0,
    fixQ: 1,
    hdop: 1,
    sats: 8,
    posAgeMs: 100,
};
function fixture() {
    const text = encodeSeabedCsv([row]),
        bytes = new Uint8Array(gzipSync(text));
    const candidate = {
        schema: 1,
        purpose: 'map',
        ownerId: owner,
        boatId: boat,
        batchId,
        csbUuid: '44444444-4444-4444-8444-444444444444',
        objectPath: owner + '/fixture.csv.gz',
        sentSha256: 'a'.repeat(64),
        storedBytes: bytes.length,
        rowCount: 1,
        capturedStart: new Date(at).toISOString(),
        capturedEnd: new Date(at).toISOString(),
        eligibleAfter: new Date(at + 30 * 86400000).toISOString(),
        captureMeta: { time_source: 'gnss', depth_source: 'signalk:belowTransducer', surface_to_transducer_m: 0.8 },
        privacyZones: [],
        platformRevision: new Date(at).toISOString(),
        consentRevision: '55555555-5555-4555-8555-555555555555',
        consentVersion: '2026-10-17-public-1',
        mapEnabled: true,
        dcdbEnabled: false,
        effectiveFrom: new Date(at - 1000).toISOString(),
        calibration: {
            schema: 1,
            depthReference: 'T',
            depthSource: 'signalk:belowTransducer',
            sounderProduct: 'Fictional fixture',
            measuredAt: at - 3600000,
            waterlineToTransducerM: 0.8,
            offsetUncertaintyM: 0.1,
            sounderUncertaintyM: 0.2,
            checkedDepthLimitM: 30,
            method: 'measured-offset-and-sounder-check',
        },
    };
    const ports: ExportPorts = {
        candidate: vi.fn(async () => structuredClone(candidate)),
        object: vi.fn(async () => bytes),
        inflate: vi.fn(async () => text),
        now: () => now,
    };
    return { candidate, bytes, ports };
}
describe('private crowd export authority', () => {
    it('uses actual stored object SHA, requalifies rows and re-reads the current source after awaits', async () => {
        const f = fixture(),
            result = await readExportedBatch(batchId, 'map', f.ports, new AbortController().signal);
        expect(result.originalStoredSha256).toBe(await digest(f.bytes));
        expect(result.originalStoredSha256).not.toBe(result.sentSha256);
        expect(result.rows).toEqual([row]);
        expect(f.ports.candidate).toHaveBeenCalledTimes(2);
        expect(result.expiresAt).toBe(now + 60000);
    });
    it.each(['consentRevision', 'platformRevision', 'privacyZones', 'boatId'])(
        'holds a source whose %s changes during the original read',
        async (key) => {
            const f = fixture();
            f.ports.object = async () => {
                (f.candidate as Record<string, unknown>)[key] = key === 'privacyZones' ? [{ kind: 'home' }] : 'retired';
                return f.bytes;
            };
            await expect(readExportedBatch(batchId, 'map', f.ports, new AbortController().signal)).rejects.toThrow();
        },
    );
    it('refuses unsigned purpose, unknown UTC, corrupt source, wrong row count and cancellation', async () => {
        for (const change of [
            (v: ReturnType<typeof fixture>) => {
                v.candidate.dcdbEnabled = false;
            },
            (v: ReturnType<typeof fixture>) => {
                v.candidate.captureMeta.time_source = 'device-clock';
            },
            (v: ReturnType<typeof fixture>) => {
                v.candidate.rowCount = 2;
            },
        ]) {
            const f = fixture();
            change(f);
            await expect(
                readExportedBatch(
                    batchId,
                    f.candidate.captureMeta.time_source === 'gnss' && f.candidate.rowCount === 1 ? 'dcdb' : 'map',
                    f.ports,
                    new AbortController().signal,
                ),
            ).rejects.toThrow();
        }
        const f = fixture(),
            abort = new AbortController();
        f.ports.object = async () => {
            abort.abort();
            return f.bytes;
        };
        await expect(readExportedBatch(batchId, 'map', f.ports, abort.signal)).rejects.toThrow();
    });
    it('preserves the canonical publication-policy mirror without touching the three capture mirrors', () => {
        const app = fs
            .readFileSync('services/seabed/crowdPolicy.ts', 'utf8')
            .replaceAll('\r\n', '\n')
            .replace("from './seabedCore'", "from './seabedCore.ts'");
        expect(fs.readFileSync('supabase/functions/_shared/crowdPolicy.ts', 'utf8').replaceAll('\r\n', '\n')).toBe(app);
    });
});
describe('closed worker handler with real gzip decoding', () => {
    const token = 'b'.repeat(64);
    async function options() {
        const f = fixture();
        const fetcher = vi.fn(
            async (url: string) =>
                new Response(url.includes('/storage/') ? f.bytes : JSON.stringify(f.candidate), { status: 200 }),
        );
        const opts: ExportOptions = {
            enabled: true,
            tokenHash: await digest(new TextEncoder().encode(token)),
            origin: 'https://fixture.supabase.co',
            serviceKey: 'fixture-edge-only',
            fetch: fetcher as unknown as typeof fetch,
            now: () => now,
        };
        return { f, fetcher, opts };
    }
    const request = (body: unknown, credential = token) =>
        new Request('https://fixture.invalid', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    it('does no backend work when disabled or token is invalid', async () => {
        const { opts, fetcher } = await options();
        expect((await handleCrowdExport(request({}), { ...opts, enabled: false })).status).toBe(503);
        expect((await handleCrowdExport(request({}, 'c'.repeat(64)), opts)).status).toBe(401);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('reads and checks an exact source through fixed bounded REST/storage hosts', async () => {
        const { opts, fetcher } = await options();
        const first = await handleCrowdExport(request({ action: 'read', purpose: 'map', batchId }), opts);
        expect(first.status).toBe(200);
        const value = await first.json();
        expect(value.rows).toEqual([row]);
        expect(fetcher).toHaveBeenCalledTimes(3);
        for (const [url, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
            expect(url.startsWith(opts.origin + '/')).toBe(true);
            expect(init.redirect).toBe('error');
            expect(init.signal).toBeInstanceOf(AbortSignal);
        }
        const check = await handleCrowdExport(
            request({ action: 'check', purpose: 'map', batchId, sourceKey: value.sourceKey }),
            opts,
        );
        expect(check.status).toBe(200);
        expect(await check.json()).toMatchObject({ sourceKey: value.sourceKey, expiresAt: now + 60000 });
        expect(
            (
                await handleCrowdExport(
                    request({ action: 'check', purpose: 'map', batchId, sourceKey: 'f'.repeat(64) }),
                    opts,
                )
            ).status,
        ).toBe(409);
    });
    it('holds oversized/decompression-bomb originals and caller-supplied authority fields', async () => {
        const { opts, fetcher } = await options();
        expect(
            (await handleCrowdExport(request({ action: 'read', purpose: 'map', batchId, current: true }), opts)).status,
        ).toBe(409);
        expect(fetcher).not.toHaveBeenCalled();
        const bomb = gzipSync('x'.repeat(2097153));
        const f = fixture();
        f.candidate.storedBytes = bomb.length;
        opts.fetch = vi.fn(
            async (url: string) => new Response(url.includes('/storage/') ? bomb : JSON.stringify(f.candidate)),
        ) as unknown as typeof fetch;
        expect((await handleCrowdExport(request({ action: 'read', purpose: 'map', batchId }), opts)).status).toBe(409);
    });
});
