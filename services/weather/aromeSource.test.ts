import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../supabase', () => ({
    supabase: null,
    supabaseUrl: 'https://project.example',
    supabaseAnonKey: 'public-test-key',
}));
vi.mock('../networkPolicy', () => ({ satelliteModeActive: vi.fn(() => false) }));
vi.mock('./openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));
import { satelliteModeActive } from '../networkPolicy';
import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { fetchOwnAromePoint } from './aromeSource';
import { isModelLive, probeModelLiveness, resetModelLivenessForTests } from './modelLiveness';
import { addAromeSeries, ATMOS_VARS, queryModelSpread } from './ModelSpreadService';
import {
    aromePointFixture,
    AROME_TEST_RUN as run,
    AROME_TEST_POINT as point,
    AROME_TEST_MODEL as model,
} from '../../tests/fixtures/arome142';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(run + 3600_000);
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockReset().mockImplementation(async () => new Response(JSON.stringify(aromePointFixture())));
    vi.mocked(satelliteModeActive).mockReturnValue(false);
    resetModelLivenessForTests();
    vi.mocked(fetchOpenMeteoProxy)
        .mockReset()
        .mockImplementation(async (_operation, params) => {
            const hours = Number(params.forecast_hours);
            const hourly: Record<string, unknown> = {
                time: Array.from({ length: hours }, (_, index) => run / 1000 + index * 3600),
            };
            for (const member of String(params.models).split(','))
                for (const variable of String(params.hourly).split(','))
                    hourly[`${variable}_${member}`] = Array(hours).fill(12);
            return { hourly };
        });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('14206 own regional transport', () => {
    it('uses only the fixed own Edge operation and does not forward an arbitrary origin or paid-model request', async () => {
        const own = await fetchOwnAromePoint(model, point);
        expect(own?.model).toBe(model);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][0]).toBe('https://project.example/functions/v1/regional-arome');
        expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ model, ...point });
        expect(vi.mocked(fetchOpenMeteoProxy)).not.toHaveBeenCalled();
    });

    it.each([404, 500, 503])('keeps missing deployment/cohort HTTP%s unavailable without fallback', async (status) => {
        fetcher.mockResolvedValue(new Response('unavailable', { status }));
        expect(await fetchOwnAromePoint(model, point)).toBeNull();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(vi.mocked(fetchOpenMeteoProxy)).not.toHaveBeenCalled();
    });

    it('refuses Satellite/offline/unknown model/outside domain/cancelled intent before the network', async () => {
        vi.mocked(satelliteModeActive).mockReturnValue(true);
        expect(await fetchOwnAromePoint(model, point)).toBeNull();
        vi.mocked(satelliteModeActive).mockReturnValue(false);
        expect(await fetchOwnAromePoint('meteofrance_arome_france', point)).toBeNull();
        expect(await fetchOwnAromePoint(model, { lat: -35, lon: 166 })).toBeNull();
        const cancellation = new AbortController();
        cancellation.abort();
        expect(await fetchOwnAromePoint(model, point, cancellation.signal)).toBeNull();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        expect(await fetchOwnAromePoint(model, point)).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        { lat: -28, lon: 166 },
        { lat: -20, lon: 157 },
        { lat: -12, lon: 166 },
        { lat: -20, lon: 173 },
    ])('does not query an old-only NCALED point %j', async (outside) => {
        expect(await fetchOwnAromePoint(model, outside)).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
        expect(vi.mocked(fetchOpenMeteoProxy)).not.toHaveBeenCalled();
    });

    it('bounds headers and body even when a native transport ignores AbortSignal', async () => {
        fetcher.mockImplementation(() => new Promise(() => undefined));
        const headers = fetchOwnAromePoint(model, point);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await headers).toBeNull();
        fetcher.mockResolvedValue(
            new Response(
                new ReadableStream({
                    start() {
                        /* deliberate stalled body */
                    },
                }),
            ),
        );
        const body = fetchOwnAromePoint(model, point);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await body).toBeNull();
    });

    it('refuses oversized, malformed and stale bodies', async () => {
        for (const response of [
            new Response('x', { headers: { 'content-length': String(64 * 1024 + 1) } }),
            new Response('x'.repeat(64 * 1024 + 1)),
            new Response('{'),
            new Response(JSON.stringify({ ...aromePointFixture(), runUtc: '2026-10-16T00:00:00Z' })),
        ]) {
            fetcher.mockResolvedValueOnce(response);
            expect(await fetchOwnAromePoint(model, point)).toBeNull();
        }
    });

    it('admits liveness from the own original sea cohort at this exact point and expires at the original run clock', async () => {
        await probeModelLiveness(model, point);
        expect(isModelLive(model, point)).toBe(true);
        expect(isModelLive(model, { ...point, lat: point.lat + 0.001 })).toBe(false);
        expect(vi.mocked(fetchOpenMeteoProxy)).not.toHaveBeenCalled();
        vi.setSystemTime(run + 18 * 3600_000 + 1);
        expect(isModelLive(model, point)).toBe(false);
    });

    it('does not send our IDs to the paid proxy and leaves the exhausted regional tail and absent variables unknown', async () => {
        const result = await queryModelSpread(point.lat, point.lon);
        const member = result.atmos?.models.find((entry) => entry.id === model);
        expect(member).toBeDefined();
        expect(member?.sourceRunAtMs).toBe(run);
        expect(member?.sourceCohortSha256).toBe('a'.repeat(64));
        expect(member?.values.wind_speed_10m.slice(47, 51)).toEqual([10, 10, null, null]);
        expect(member?.values.visibility.every((value) => value === null)).toBe(true);
        expect(
            vi
                .mocked(fetchOpenMeteoProxy)
                .mock.calls.every(([, params]) => !String(params.models).includes('thalassa_arome')),
        ).toBe(true);
    });

    it('aligns the same valid hour and never shifts model issue time to receipt time', () => {
        const own = aromePointFixture();
        const admitted = JSON.parse(JSON.stringify(own));
        const merged = addAromeSeries(
            { times: [run + 3600_000, run + 48 * 3600_000, run + 49 * 3600_000], models: [] },
            admitted,
            { id: model, label: 'Local', provider: 'Météo-France', hex: '#fff' },
        );
        expect(merged.models[0].values.wind_speed_10m).toEqual([10, 10, null]);
        expect(Object.keys(merged.models[0].values)).toEqual([...ATMOS_VARS]);
        expect(merged.models[0].sourceRunAtMs).toBe(run);
    });
});
