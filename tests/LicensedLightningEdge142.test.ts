import { describe, expect, it, vi } from 'vitest';
import { handleLicensedLightning, type LightningPorts } from '../supabase/functions/licensed-lightning/handler';
const NOW = 1792230000000;
const request = (body: unknown = { latitude: -27, longitude: 154 }) =>
    new Request('https://synthetic.test', { method: 'POST', body: JSON.stringify(body) });
const fixture = { success: true, error: null, response: [] };
const ports = (extra: Partial<LightningPorts> = {}): LightningPorts => ({
    reserve: vi.fn(async () => true),
    authorize: async () => null,
    admission: () => ({
        clientId: 'fictional-id',
        secret: 'fictional-secret',
        expiresAt: NOW + 86400000,
        display: true,
        push: true,
    }),
    now: () => NOW,
    fetch: vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })),
    ...extra,
});
describe('Licensed lightning fixed authenticated transport', () => {
    it('refuses shared cost-budget denial or failure before any paid request', async () => {
        for (const reserve of [
            async () => false,
            async () => {
                throw new Error('Unavailable quota database');
            },
        ]) {
            const p = ports({ reserve });
            expect([429, 503]).toContain((await handleLicensedLightning(request(), p)).status);
            expect(p.fetch).not.toHaveBeenCalled();
        }
    });
    it('rechecks licence expiry after a slow shared-budget reservation', async () => {
        let admitted = true;
        const valid = ports().admission()!;
        const p = ports({
            admission: () => (admitted ? valid : null),
            reserve: async () => {
                admitted = false;
                return true;
            },
        });
        expect((await handleLicensedLightning(request(), p)).status).toBe(503);
        expect(p.fetch).not.toHaveBeenCalled();
    });
    it('refuses auth/quota denial before body, licence and paid network access', async () => {
        const p = ports({
            authorize: async () => new Response('Denied', { status: 429 }),
            admission: () => {
                throw new Error('must not read');
            },
        });
        expect((await handleLicensedLightning(request(), p)).status).toBe(429);
        expect(p.fetch).not.toHaveBeenCalled();
    });
    it.each([
        null,
        { latitude: -27, longitude: 154, url: 'https://untrusted.test' },
        { latitude: '0', longitude: 0 },
        { latitude: 91, longitude: 0 },
    ])('refuses unknown request parameters and invalid locations %#', async (body) => {
        const p = ports();
        expect((await handleLicensedLightning(request(body), p)).status).toBe(400);
        expect(p.fetch).not.toHaveBeenCalled();
    });
    it('keeps missing, expired, display-only or push-only licence admission closed', async () => {
        const valid = ports().admission()!;
        for (const admission of [
            null,
            { ...valid, expiresAt: NOW },
            { ...valid, display: false },
            { ...valid, push: false },
        ]) {
            const p = ports({ admission: () => admission });
            expect((await handleLicensedLightning(request(), p)).status).toBe(503);
            expect(p.fetch).not.toHaveBeenCalled();
        }
    });
    it('makes one fixed closest query with20NM,5minutes, no pagination, no redirect or free fallback', async () => {
        const p = ports();
        const response = await handleLicensedLightning(request(), p);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(p.fetch).toHaveBeenCalledTimes(1);
        const [url, options] = vi.mocked(p.fetch).mock.calls[0];
        const actual = new URL(String(url));
        expect(actual.origin + actual.pathname).toBe('https://data.api.xweather.com/lightning/closest');
        expect(Object.fromEntries(actual.searchParams)).toMatchObject({
            p: '-27,154',
            radius: '37.04km',
            from: '-5minutes',
            limit: '1000',
        });
        expect(actual.searchParams.has('skip')).toBe(false);
        expect(options?.redirect).toBe('error');
    });
    it('refuses credential/licence retirement during the actual upstream await', async () => {
        let admitted = true;
        const valid = ports().admission()!;
        const p = ports({
            admission: () => (admitted ? valid : null),
            fetch: vi.fn(async () => {
                admitted = false;
                return new Response(JSON.stringify(fixture));
            }),
        });
        expect((await handleLicensedLightning(request(), p)).status).toBe(503);
    });
    it('preserves unavailable for provider rejection, malformed JSON and an oversized body', async () => {
        for (const response of [
            new Response('Forbidden', { status: 403 }),
            new Response('{}'),
            new Response('x'.repeat(512 * 1024 + 1)),
        ]) {
            const p = ports({ fetch: vi.fn(async () => response) });
            expect((await handleLicensedLightning(request(), p)).status).toBe(503);
            expect(p.fetch).toHaveBeenCalledTimes(1);
        }
    });
    it('preflights without an upstream and rejects GET', async () => {
        const p = ports();
        expect(
            (await handleLicensedLightning(new Request('https://synthetic.test', { method: 'OPTIONS' }), p)).status,
        ).toBe(204);
        expect((await handleLicensedLightning(new Request('https://synthetic.test'), p)).status).toBe(405);
        expect(p.fetch).not.toHaveBeenCalled();
    });
});
