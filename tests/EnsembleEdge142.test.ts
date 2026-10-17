import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleEnsemble, type EnsemblePorts } from '../supabase/functions/ensemble-forecast/handler';
import { ensembleFixture, ENSEMBLE_FIXTURE_NOW } from './fixtures/ensemble142';

const request = (body: unknown = { product: 'ifs', latitude: -27, longitude: 153 }, signal?: AbortSignal) =>
    new Request('https://fictional.invalid/ensemble', { method: 'POST', body: JSON.stringify(body), signal });
function ports(): EnsemblePorts {
    return {
        authorize: vi.fn(async () => null),
        key: () => 'fictional-test-only',
        fetch: vi.fn(async () => new Response(JSON.stringify(ensembleFixture()))),
        now: () => ENSEMBLE_FIXTURE_NOW,
    };
}
afterEach(() => vi.unstubAllGlobals());
describe('142 bounded ensemble edge', () => {
    it.each(['ifs', 'ec46'] as const)(
        'reduces one %s product using only its fixed commercial endpoint/model',
        async (product) => {
            vi.stubGlobal('crypto', webcrypto);
            const p = ports();
            const response = await handleEnsemble(request({ product, latitude: -27, longitude: 153 }), p);
            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.hours[0].wind.exceeding).toBe(26);
            expect(data.rawSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.stringify(data)).not.toContain('fictional-test-only');
            const [url, init] = vi.mocked(p.fetch).mock.calls[0];
            const u = new URL(String(url));
            expect(u.origin).toBe(
                product === 'ifs'
                    ? 'https://customer-ensemble-api.open-meteo.com'
                    : 'https://customer-seasonal-api.open-meteo.com',
            );
            expect(u.searchParams.get('models')).toBe(product === 'ifs' ? 'ecmwf_ifs025_ensemble' : 'ecmwf_ec46');
            expect(u.searchParams.get('forecast_days')).toBe(product === 'ifs' ? '15' : '46');
            expect(init?.redirect).toBe('error');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
        },
    );
    it('requires actual authorization before any upstream request or credential read', async () => {
        const p = ports();
        p.authorize = async () => new Response('{}', { status: 401 });
        p.key = vi.fn();
        expect((await handleEnsemble(request(), p)).status).toBe(401);
        expect(p.fetch).not.toHaveBeenCalled();
        expect(p.key).not.toHaveBeenCalled();
    });
    it.each([
        { product: 'deterministic', latitude: -27, longitude: 153 },
        { product: 'ifs', latitude: [-27], longitude: 153 },
        { product: 'ifs', latitude: -27, longitude: 153, models: 'mean' },
        { product: 'ifs', latitude: -27, longitude: 153, apikey: 'caller-key' },
        { product: 'ifs', latitude: -27, longitude: 153, url: 'https://attacker.invalid' },
    ])('refuses caller-controlled products/credentials/hosts/multi-points', async (body) => {
        const p = ports();
        expect((await handleEnsemble(request(body), p)).status).toBe(400);
        expect(p.fetch).not.toHaveBeenCalled();
    });
    it('keeps existing-plan refusal explicit without fallback to a free or deterministic host', async () => {
        const p = ports();
        p.fetch = vi.fn(async () => new Response('secret-url-and-error', { status: 403 }));
        const response = await handleEnsemble(request(), p);
        expect(response.status).toBe(503);
        expect((await response.json()).error).toBe(
            'Ensemble access unavailable with the configured weather credential',
        );
        expect(p.fetch).toHaveBeenCalledTimes(1);
    });
    it('refuses a declared oversized body before JSON allocation', async () => {
        const p = ports();
        p.fetch = vi.fn(async () => new Response('{}', { headers: { 'Content-Length': '2097153' } }));
        expect((await handleEnsemble(request(), p)).status).toBe(503);
    });
    it('refuses streamed overflow even if the declared length is absent', async () => {
        const p = ports();
        p.fetch = vi.fn(async () => new Response(new Uint8Array(2097153)));
        expect((await handleEnsemble(request(), p)).status).toBe(503);
    });
    it('propagates cancellation and never emits a completed forecast after abort', async () => {
        vi.stubGlobal('crypto', webcrypto);
        const c = new AbortController();
        const p = ports();
        p.fetch = vi.fn(async () => {
            c.abort();
            return new Response(JSON.stringify(ensembleFixture()));
        });
        expect((await handleEnsemble(request(undefined, c.signal), p)).status).toBe(503);
    });
});
