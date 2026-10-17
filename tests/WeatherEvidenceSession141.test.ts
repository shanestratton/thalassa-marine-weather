import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNetworkAllowed } from '../services/networkPolicy';
import { openWeatherEvidenceSession } from '../services/weather/evidenceSession';
import type { MeasuredBuoyDetail } from '../services/weather/evidenceContract';

vi.mock('../services/networkPolicy', () => ({ assertNetworkAllowed: vi.fn() }));
const fixture = (name: string) =>
    new Uint8Array(readFileSync(resolve('tests/fixtures/weather-evidence141', name + '.txt')));
const decode = (raw: Uint8Array) => JSON.parse(new TextDecoder().decode(raw));
const NOW = decode(fixture('pointer-buoys')).generatedAt * 1000 + 1000;
const files = new Map<string, Uint8Array>();
for (const kind of ['buoys', 'skill']) {
    const prefix = kind === 'buoys' ? 'buoys/v1/' : 'skill/issued-v1/';
    const pointer = fixture('pointer-' + kind);
    const meta = decode(pointer);
    const index = fixture('index-' + kind);
    const stations = decode(index).stations;
    files.set(prefix + 'latest.json', pointer);
    files.set(prefix + meta.indexPath, index);
    for (const network of kind === 'buoys' ? ['ndbc', 'qld-des'] : ['ndbc']) {
        const body = fixture('detail-' + kind + '-' + network);
        const station = decode(body);
        const ref = stations.find((row: { key: string }) => row.key === station.key);
        files.set(prefix + `generations/${meta.generation}/${ref.detailSha256}.json`, body);
    }
}
const key = (url: string) => new URL(url).pathname.split('/weather/')[1];
const response = (url: string) =>
    new Response(files.get(key(url))?.slice().buffer, {
        status: files.has(key(url)) ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
    });
const buoy = decode(fixture('detail-buoys-ndbc')).key as string;
const qld = decode(fixture('detail-buoys-qld-des')).key as string;
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => Promise.resolve(response(url))),
    );
    vi.mocked(assertNetworkAllowed).mockReset();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('caller-owned public weather original-byte reader', () => {
    it('loads exact pointer/index/detail and closes without any authentication or background polling', async () => {
        const owner = new AbortController();
        const session = await openWeatherEvidenceSession('buoys', owner.signal);
        const value = (await session.readStation(buoy)) as MeasuredBuoyDetail;
        expect(value.station.key).toBe(buoy);
        expect(value.measured.length).toBeGreaterThan(10);
        expect(fetch).toHaveBeenCalledTimes(3);
        await session.readStation(buoy);
        expect(fetch).toHaveBeenCalledTimes(3);
        for (const [url, options] of vi.mocked(fetch).mock.calls) {
            expect(String(url)).toMatch(
                /^https:\/\/pcisdplnodrphauixcau\.supabase\.co\/storage\/v1\/object\/public\/weather\//,
            );
            expect(options).toMatchObject({
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
                headers: { Accept: 'application/json' },
            });
        }
        session.close();
        expect(session.isCurrent()).toBe(false);
        expect(() => session.index).toThrow();
        await expect(session.readStation(buoy)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(3);
    });
    it('reads genuine warming skill without creating a retrospective winner', async () => {
        const session = await openWeatherEvidenceSession('skill', new AbortController().signal);
        const station = decode(fixture('detail-skill-ndbc')).key;
        const result = await session.readStation(station);
        expect('metrics' in result && result.metrics.wave_hs_m['0-6h'].status).toBe('warming');
        session.close();
    });
    it('does no request for a retired, aborted or metered owner', async () => {
        const owner = new AbortController();
        owner.abort();
        await expect(openWeatherEvidenceSession('buoys', owner.signal)).rejects.toThrow();
        await expect(openWeatherEvidenceSession('buoys', new AbortController().signal, () => false)).rejects.toThrow();
        vi.mocked(assertNetworkAllowed).mockImplementation(() => {
            throw new Error('Satellite mode');
        });
        await expect(openWeatherEvidenceSession('buoys', new AbortController().signal)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('refuses checksum-corrupt index bytes before parsing or reading any detail', async () => {
        vi.mocked(fetch).mockImplementation(async (url) =>
            String(url).includes('/index.json')
                ? new Response(new Uint8Array(fixture('index-buoys').length).fill(32), {
                      headers: { 'Content-Type': 'application/json' },
                  })
                : response(String(url)),
        );
        await expect(openWeatherEvidenceSession('buoys', new AbortController().signal)).rejects.toThrow(
            'original bytes',
        );
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('refuses foreign/expired station keys before a request and preserves original per-station expiry', async () => {
        const session = await openWeatherEvidenceSession('buoys', new AbortController().signal);
        await expect(session.readStation('private:yacht')).rejects.toThrow('absent or expired');
        const station = session.index.stations.find((row) => row.key === qld)!;
        vi.spyOn(Date, 'now').mockReturnValue(station.expiresAt * 1000);
        await expect(session.readStation(qld)).rejects.toThrow('absent or expired');
        expect(fetch).toHaveBeenCalledTimes(2);
        session.close();
    });
    it('retires the session on original pointer expiry even if a detail was already cached', async () => {
        const session = await openWeatherEvidenceSession('buoys', new AbortController().signal);
        await session.readStation(buoy);
        const expiry = session.index.expiresAt;
        vi.spyOn(Date, 'now').mockReturnValue(expiry * 1000);
        expect(session.isCurrent()).toBe(false);
        await expect(session.readStation(buoy)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(3);
    });
    it('does not adopt a late index after the actual caller context retires', async () => {
        let current = true;
        let release!: (value: Response) => void;
        vi.mocked(fetch).mockImplementation((url) =>
            String(url).includes('/index.json')
                ? new Promise<Response>((resolve) => {
                      release = resolve;
                  })
                : Promise.resolve(response(String(url))),
        );
        const opened = openWeatherEvidenceSession('buoys', new AbortController().signal, () => current);
        const rejected = expect(opened).rejects.toThrow();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        current = false;
        release(new Response(fixture('index-buoys'), { headers: { 'Content-Type': 'application/json' } }));
        await rejected;
    });
    it('aborts an ignored fetch immediately and cancels its late response instead of retaining a body', async () => {
        let release!: (value: Response) => void;
        const cancel = vi.fn();
        vi.mocked(fetch).mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    release = resolve;
                }),
        );
        const owner = new AbortController();
        const opened = openWeatherEvidenceSession('buoys', owner.signal);
        const rejected = expect(opened).rejects.toThrow();
        owner.abort();
        await rejected;
        release(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    });
    it('fences A/B/A detail reads and cancels the first response when it arrives late', async () => {
        const session = await openWeatherEvidenceSession('buoys', new AbortController().signal);
        const originalFetch = vi.mocked(fetch).getMockImplementation()!;
        let release!: (value: Response) => void;
        let first = true;
        const cancel = vi.fn();
        const hash = session.index.stations.find((row) => row.key === buoy)!.detailSha256;
        vi.mocked(fetch).mockImplementation((url, options) => {
            if (String(url).includes(hash) && first) {
                first = false;
                return new Promise<Response>((resolve) => {
                    release = resolve;
                });
            }
            return originalFetch(url, options);
        });
        const old = session.readStation(buoy);
        const rejected = expect(old).rejects.toThrow();
        expect((await session.readStation(qld)).station.key).toBe(qld);
        await rejected;
        expect((await session.readStation(buoy)).station.key).toBe(buoy);
        release(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        session.close();
    });
    it('cancels a never-finishing body when its owner aborts, even if cancel never resolves', async () => {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        vi.mocked(fetch).mockResolvedValue(
            new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }),
        );
        const owner = new AbortController();
        const opened = openWeatherEvidenceSession('buoys', owner.signal);
        const rejected = expect(opened).rejects.toThrow();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        owner.abort();
        await rejected;
        expect(cancel).toHaveBeenCalledTimes(1);
    });
    it('bounds a fetch that never honours AbortSignal with the fixed request deadline', async () => {
        vi.useFakeTimers();
        vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined));
        const opened = openWeatherEvidenceSession('buoys', new AbortController().signal);
        const rejected = expect(opened).rejects.toThrow('deadline');
        await vi.advanceTimersByTimeAsync(15_001);
        await rejected;
    });
});
