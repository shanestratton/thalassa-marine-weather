import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const policy = vi.hoisted(() => ({ metered: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => policy.metered }));
const raw = (area = 'X') => ({
    msgYear: 2026,
    msgNumber: 1,
    navArea: area,
    text: 'Invented warning 27-00.0S 153-00.0E',
    issueDate: '160000Z OCT 2026',
    authority: 'Generated fixture',
});
beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    policy.metered = false;
    vi.stubEnv('VITE_SUPABASE_URL', 'https://fixture.example.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fixture-anon-key');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe('bounded public notice transport and original cache clocks', () => {
    it('makes no refresh request or freshness write in Satellite Mode', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        policy.metered = true;
        const { NoticeToMarinersService: service } = await import('../services/NoticeToMarinersService');
        await expect(service.refresh(true)).resolves.toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
        expect(localStorage.getItem('thalassa_ntm_cache_v1')).toBeNull();
    });
    it('preserves a failed source and its original check clock across a cold restart and partial refresh', async () => {
        const first = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(first);
        const fetcher = vi.fn(
            async (url: RequestInfo | URL) =>
                new Response(
                    JSON.stringify({ 'broadcast-warn': String(url).includes('broadcast-warn') ? [raw('4')] : [] }),
                ),
        );
        vi.stubGlobal('fetch', fetcher);
        let service = (await import('../services/NoticeToMarinersService')).NoticeToMarinersService;
        await service.refresh(true);
        expect(service.getCached().notices).toHaveLength(1);
        vi.resetModules();
        vi.spyOn(Date, 'now').mockReturnValue(first + 3600000);
        fetcher.mockImplementation(async (url: RequestInfo | URL) =>
            String(url).includes('broadcast-warn')
                ? new Response('', { status: 503 })
                : new Response(JSON.stringify({ 'broadcast-warn': [] })),
        );
        service = (await import('../services/NoticeToMarinersService')).NoticeToMarinersService;
        expect(service.getCached().notices[0].issueDateParsed).toBeInstanceOf(Date);
        await service.refresh(true);
        expect(service.getCached().notices[0].issueDateParsed).toBeInstanceOf(Date);
        expect(service.getSourceHealth().find((s) => s.source === 'nga')).toMatchObject({
            failing: true,
            fetchedAt: first,
            count: 1,
        });
    });
    it('refuses oversized and excessive source bodies without replacing held warnings', async () => {
        let huge = false;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async (url: RequestInfo | URL) =>
                    new Response(
                        huge
                            ? ' '.repeat(1024 * 1024 + 1)
                            : JSON.stringify({
                                  'broadcast-warn': String(url).includes('broadcast-warn') ? [raw('4')] : [],
                              }),
                    ),
            ),
        );
        const { NoticeToMarinersService: service } = await import('../services/NoticeToMarinersService');
        await service.refresh(true);
        huge = true;
        await service.refresh(true);
        expect(service.getCached().notices).toHaveLength(1);
        expect(service.getSourceHealth().find((s) => s.source === 'nga')?.failing).toBe(true);
    });
    it('does not certify the merged receipt clock of a legacy cache as a measured per-source check', async () => {
        const now = Date.now();
        localStorage.setItem(
            'thalassa_ntm_cache_v1',
            JSON.stringify({
                fetchedAt: now,
                notices: [
                    {
                        id: 'X-2026/1',
                        ...raw(),
                        title: 'Invented',
                        areaLabel: 'NAVAREA X',
                        subregion: '',
                        status: 'A',
                        coordinates: [{ lat: -27, lon: 153 }],
                        issueDateParsed: null,
                    },
                ],
            }),
        );
        const { NoticeToMarinersService: service } = await import('../services/NoticeToMarinersService');
        expect(service.getCached().notices).toHaveLength(1);
        expect(service.getSourceHealth()).toContainEqual(
            expect.objectContaining({ source: 'amsa', fetchedAt: 0, failing: true, count: 1 }),
        );
    });
});
