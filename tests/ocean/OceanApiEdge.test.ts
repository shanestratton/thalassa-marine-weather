// @vitest-environment node
/**
 * api/ocean/[view].ts: the only door the public page has to the database.
 * Bounded queries, a publishable key only, whitelisted output (fish, private
 * keys and credits on blurred rows can never pass), CDN-cacheable answers,
 * and an honest "not-ready" before the migration is pushed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedHost, handleOcean, parseRowsQuery, publicSummary, publishableKey } from '../../api/ocean/[view]';

const ENV = { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_KEY: 'sb_publishable_FIXTUREfixture123' };
const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

type Seen = { url: string; init: RequestInit };
const seen: Seen[] = [];
function upstream(status: number, body: unknown) {
    seen.length = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            seen.push({ url, init });
            return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
            });
        }),
    );
}
const get = (
    path: string,
    env: Record<string, string> = ENV,
    method = 'GET',
    origin = 'https://ocean.thalassawx.app',
) => handleOcean(new Request(`${origin}${path}`, { method }), env);

afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown> = {}) => ({
    sighting_id: '0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
    taxon_group: 'whale',
    scientific_name: 'Megaptera novaeangliae',
    vernacular_name: 'Humpback whale',
    taxon_rank: 'species',
    individual_count: 2,
    has_calf: true,
    event_time: '2026-10-01T03:10:00+00:00',
    latitude: -24.855,
    longitude: 153.445,
    uncertainty_m: 790,
    generalised: false,
    credit: 'fixture-boat',
    ...over,
});

describe('the publishable key guard', () => {
    it('takes a publishable key or an anon JWT, never a secret or service key', () => {
        expect(publishableKey('sb_publishable_FIXTUREfixture123')).not.toBeNull();
        expect(publishableKey(jwt({ role: 'anon' }))).not.toBeNull();
        expect(publishableKey('sb_secret_FIXTUREfixture123')).toBeNull();
        expect(publishableKey(jwt({ role: 'service_role' }))).toBeNull();
        expect(publishableKey('')).toBeNull();
    });

    it('answers 503 when not configured, and never calls upstream with a secret', async () => {
        upstream(200, {});
        expect((await get('/api/ocean/summary', {})).status).toBe(503);
        expect(
            (await get('/api/ocean/summary', { ...ENV, VITE_SUPABASE_KEY: 'sb_secret_FIXTUREfixture123' })).status,
        ).toBe(503);
        expect((await get('/api/ocean/summary', { ...ENV, VITE_SUPABASE_URL: 'https://evil.test' })).status).toBe(503);
        expect(seen).toHaveLength(0);
    });
});

describe('one host', () => {
    it('answers only on ocean.thalassawx.app, local previews and Vercel deployment hosts', async () => {
        expect(allowedHost('ocean.thalassawx.app')).toBe(true);
        expect(allowedHost('OCEAN.thalassawx.app.')).toBe(true);
        expect(allowedHost('localhost')).toBe(true);
        expect(allowedHost('127.0.0.1')).toBe(true);
        expect(allowedHost('thalassa-abc123-team.vercel.app')).toBe(true);
        for (const host of [
            'random-label.thalassawx.app',
            'serene-summer.thalassawx.app',
            'ocean.thalassawx.com',
            'www.thalassawx.app',
            'ocean.thalassawx.app.evil.test',
            'a.b.vercel.app',
        ]) {
            expect(allowedHost(host), host).toBe(false);
        }
    });

    it('refuses any other host before asking the database, uncached (one CDN cache key)', async () => {
        upstream(200, { v: 1 });
        const res = await get('/api/ocean/summary', ENV, 'GET', 'https://random-label.thalassawx.app');
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(seen).toHaveLength(0);
        await get('/api/ocean/summary', ENV, 'GET', 'http://127.0.0.1:4173');
        expect(seen).toHaveLength(1);
    });
});

describe('requests', () => {
    it('GET and HEAD only, known views only, no stray parameters', async () => {
        upstream(200, { v: 1 });
        const post = await get('/api/ocean/summary', ENV, 'POST');
        expect(post.status).toBe(405);
        expect(post.headers.get('allow')).toBe('GET, HEAD');
        expect((await get('/api/ocean/everything')).status).toBe(404);
        expect((await get('/api/ocean/summary?cache=bust')).status).toBe(400);
        expect((await get(`/api/ocean/rows?s=-21&w=148&n=-19&e=150&x=${'a'.repeat(300)}`)).status).toBe(400);
        expect(seen).toHaveLength(0);
    });

    it('bounds a rows box: whole degrees, at most 10 each way, west before east', () => {
        const q = (s: string) => parseRowsQuery(new URLSearchParams(s));
        expect(q('s=-21&w=148&n=-19&e=150')).toEqual({
            p_south: -21,
            p_west: 148,
            p_north: -19,
            p_east: 150,
            p_before: null,
            p_before_id: null,
        });
        expect(q('s=-30&w=140&n=-10&e=160')).toMatch(/at most 10/);
        expect(q('s=-21.5&w=148&n=-19&e=150')).toMatch(/whole number/);
        expect(q('s=-21&w=178&n=-19&e=-178')).toMatch(/split a box at the dateline/);
        expect(q('s=-21&w=148&n=-19')).toMatch(/whole number/);
        expect(
            q(
                's=-21&w=148&n=-19&e=150&before=2026-10-01T03:10:00%2B00:00&before_id=0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
            ),
        ).toMatchObject({
            p_before: '2026-10-01T03:10:00+00:00',
        });
        expect(q('s=-21&w=148&n=-19&e=150&before=2026-10-01T03:11:00Z')).toMatch(/previous page/);
        expect(q('s=-21&w=148&n=-19&e=150&before_id=0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01')).toMatch(/previous page/);
    });

    // Vercel also passes a dynamic route's segment as a query parameter, so
    // the function sees /api/ocean/summary?view=summary (found live on
    // 2026-10-07, when every summary said 'summary takes no parameters').
    it('accepts the request exactly as Vercel delivers it, with the ?view= echo of its path', async () => {
        upstream(200, { v: 1 });
        expect((await get('/api/ocean/summary?view=summary')).status).not.toBe(400);
        expect(seen[0].url).toBe('https://fixture.supabase.co/rest/v1/rpc/get_ocean_summary');
        upstream(200, []);
        expect((await get('/api/ocean/rows?s=-21&w=148&n=-19&e=150&view=rows')).status).toBe(200);
        expect(JSON.parse(String(seen[0].init.body))).toEqual({
            p_south: -21,
            p_west: 148,
            p_north: -19,
            p_east: 150,
            p_before: null,
            p_before_id: null,
        });
        // Only the echo of the path is dropped: anything else is still refused.
        upstream(200, { v: 1 });
        expect((await get('/api/ocean/summary?view=rows')).status).toBe(400);
        expect((await get('/api/ocean/summary?view=summary&view=summary')).status).toBe(400);
        expect((await get('/api/ocean/rows?s=-21&w=148&n=-19&e=150&view=summary')).status).toBe(400);
        expect(seen).toHaveLength(0);
    });

    it('asks PostgREST with the publishable key only', async () => {
        upstream(200, []);
        await get('/api/ocean/rows?s=-21&w=148&n=-19&e=150');
        expect(seen[0].url).toBe('https://fixture.supabase.co/rest/v1/rpc/get_ocean_sightings');
        const headers = seen[0].init.headers as Record<string, string>;
        expect(headers.apikey).toBe(ENV.VITE_SUPABASE_KEY);
        expect(headers).not.toHaveProperty('authorization');
        expect(JSON.parse(String(seen[0].init.body))).toEqual({
            p_south: -21,
            p_west: 148,
            p_north: -19,
            p_east: 150,
            p_before: null,
            p_before_id: null,
        });
    });
});

describe('answers', () => {
    it('before the push: an honest, briefly cached not-ready', async () => {
        upstream(404, { code: 'PGRST202', message: 'Could not find the function public.get_ocean_summary' });
        const res = await get('/api/ocean/summary');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: 1, status: 'not-ready' });
        expect(res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=60');
    });

    it('kill switch (EXECUTE revoked) or any other failure: 502, never cached', async () => {
        upstream(401, { code: '42501', message: 'permission denied for function get_ocean_summary' });
        const res = await get('/api/ocean/summary');
        expect(res.status).toBe(502);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('whitelists the summary: no private keys, no fish, no small boat counts, no credit on blurred rows', async () => {
        upstream(200, {
            v: 1,
            generated_at: '2026-10-06T00:00:00Z',
            delay_hours: 3,
            observer_id: 'leak',
            grid: { fine_deg: 0.01, coarse_deg: 0.1, cell_deg: 0.1, secret: 1 },
            totals: { sightings: 3, animals: 4, species: 2, boats: 2, boats_min_shown: 3, contributor: 'leak' },
            groups: { whale: [2, 3], fish: [1, 1] },
            cells: [
                [-24.85, 153.45, 'whale', 'Megaptera novaeangliae', false, 2026, 10, 2, 3],
                [-24.85, 153.45, 'fish', null, true, 2026, 10, 1, 1],
                ['bad'],
            ],
            species: [
                {
                    sci: 'Megaptera novaeangliae',
                    group: 'whale',
                    n: 2,
                    months: { '10': 2 },
                    boat_id: 'leak',
                    first: '2026-10-01T03:10:00Z',
                    last: '2026-10-01T03:10:00Z',
                    sst: null,
                },
            ],
            recent: [
                {
                    id: '0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
                    group: 'whale',
                    lat: -24.855,
                    lon: 153.445,
                    time: '2026-10-01T03:10:00Z',
                    generalised: false,
                    credit: 'fixture-boat',
                    photos: ['x'],
                },
                {
                    id: '1f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
                    group: 'dugong',
                    lat: -27.45,
                    lon: 153.35,
                    time: '2026-10-01T03:00:00Z',
                    generalised: true,
                    credit: 'fixture-boat',
                },
                {
                    id: '2f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
                    group: 'fish',
                    lat: -27.45,
                    lon: 153.35,
                    time: '2026-10-01T03:00:00Z',
                },
            ],
        });
        const res = await get('/api/ocean/summary');
        expect(res.status).toBe(200);
        // Short, now that the summary is a 5-minute snapshot: a removal leaves within about 10 minutes.
        expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=120, stale-while-revalidate=120');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        const body = await res.json();
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/leak|secret|photos|fish|contributor|observer|boat_id/);
        expect(body.totals.boats).toBeNull();
        expect(body.cells).toHaveLength(1);
        // The blurred dugong is never an individual record, credited or not; nor is the fish.
        expect(body.recent).toHaveLength(1);
        expect(body.recent[0].credit).toBe('fixture-boat');
        expect(body.recent[0].generalised).toBe(false);
        // No hour-precise first/last time on a species.
        expect(Object.keys(body.species[0])).not.toContain('first');
        expect(Object.keys(body.species[0])).not.toContain('last');
        expect(body.cells_truncated).toBe(false);
        expect(Object.keys(body).sort()).toEqual(
            [
                'cells',
                'cells_truncated',
                'delay_hours',
                'generated_at',
                'grid',
                'groups',
                'recent',
                'species',
                'status',
                'totals',
                'v',
            ].sort(),
        );
    });

    it('keeps a real boat count once at least 3 boats contribute, and says when cells were cut short', () => {
        expect(publicSummary({ v: 1, totals: { boats: 3 } })?.totals).toMatchObject({ boats: 3, boats_min_shown: 3 });
        expect(publicSummary({ v: 1, cells_truncated: true })?.cells_truncated).toBe(true);
        expect(publicSummary({ v: 1, cells_truncated: 'yes' })?.cells_truncated).toBe(false);
    });

    it('rows: short public keys, a next page when full, and HEAD without a body', async () => {
        upstream(
            200,
            Array.from({ length: 200 }, (_, i) =>
                row({ sighting_id: `0f6f2d0e-5d0b-4c4e-9a51-${String(i).padStart(12, '0')}` }),
            ),
        );
        const res = await get('/api/ocean/rows?s=-25&w=153&n=-24&e=154');
        const body = await res.json();
        expect(body.rows).toHaveLength(200);
        expect(Object.keys(body.rows[0]).sort()).toEqual(
            [
                'calf',
                'count',
                'credit',
                'generalised',
                'group',
                'id',
                'lat',
                'lon',
                'name',
                'rank',
                'sci',
                'time',
                'uncertainty_m',
            ].sort(),
        );
        expect(body.next).toEqual({
            before: '2026-10-01T03:10:00+00:00',
            before_id: '0f6f2d0e-5d0b-4c4e-9a51-000000000199',
        });
        // A blurred row is dropped even if the database ever sent one, and
        // paging still continues from the last row of the page.
        upstream(
            200,
            Array.from({ length: 200 }, (_, i) =>
                row({
                    sighting_id: `0f6f2d0e-5d0b-4c4e-9a51-${String(i).padStart(12, '0')}`,
                    generalised: i === 199,
                }),
            ),
        );
        const mixed = await (await get('/api/ocean/rows?s=-25&w=153&n=-24&e=154')).json();
        expect(mixed.rows).toHaveLength(199);
        expect(mixed.rows.every((r: { generalised: boolean }) => r.generalised === false)).toBe(true);
        expect(mixed.next).toEqual({
            before: '2026-10-01T03:10:00+00:00',
            before_id: '0f6f2d0e-5d0b-4c4e-9a51-000000000199',
        });
        upstream(200, [row()]);
        const head = await get('/api/ocean/rows?s=-25&w=153&n=-24&e=154', ENV, 'HEAD');
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
    });
});
