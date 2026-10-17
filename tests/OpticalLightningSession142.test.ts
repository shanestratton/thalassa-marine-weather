import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOpticalSession } from '../services/weather/api/opticalLightningSession';
import { assertNetworkAllowed } from '../services/networkPolicy';
vi.mock('../services/networkPolicy', () => ({ assertNetworkAllowed: vi.fn() }));
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/optical142/fictional-packet.json', 'utf8'));
const resources = fixture.resources as Record<string, string>,
    path = (u: string) => u.split('/optical-lightning/v1/')[1];
const fetcher = () =>
    vi.fn(async (url: string, opts: RequestInit) => {
        expect(opts.redirect).toBe('error');
        return new Response(resources[path(url)] ?? '', { status: resources[path(url)] ? 200 : 404 });
    });
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(Date, 'now').mockReturnValue(fixture.now);
    vi.mocked(assertNetworkAllowed).mockReset();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('142 bounded optical-only sessions', () => {
    it('does zero import/default work and reads pointer/index then only current viewport tiles', async () => {
        const fetch = fetcher();
        vi.stubGlobal('fetch', fetch);
        expect(fetch).not.toHaveBeenCalled();
        const session = await openOpticalSession(new AbortController().signal, () => true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await session.readViewport([-71, 9, -69, 11])).rows).toHaveLength(6);
        expect(fetch).toHaveBeenCalledTimes(3);
        const count = fetch.mock.calls.length;
        await expect(session.readViewport([-180, -80, 180, 80])).rejects.toThrow(/Zoom in/);
        expect(fetch).toHaveBeenCalledTimes(count);
        expect((await session.readViewport([0, 0, 1, 1])).rows).toEqual([]);
        session.close();
        expect(session.isCurrent()).toBe(false);
    });
    it('refuses changed child hashes and absent public admission without provider fallback', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(path(url).includes('tile-') ? '{}' : resources[path(url)])),
        );
        const session = await openOpticalSession(new AbortController().signal, () => true);
        await expect(session.readViewport([-71, 9, -69, 11])).rejects.toThrow(/checksum/);
        session.close();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        await expect(openOpticalSession(new AbortController().signal, () => true)).rejects.toThrow(/unavailable/);
    });
    it.each(['owner', 'expiry', 'rollback', 'network'] as const)(
        'permanently retires after %s even if state later returns A',
        async (reason) => {
            vi.stubGlobal('fetch', fetcher());
            let owner = true;
            const session = await openOpticalSession(new AbortController().signal, () => owner);
            if (reason === 'owner') owner = false;
            if (reason === 'expiry') vi.mocked(Date.now).mockReturnValue(fixture.now + 60000);
            if (reason === 'rollback') vi.mocked(Date.now).mockReturnValue(fixture.now - 1);
            if (reason === 'network')
                vi.mocked(assertNetworkAllowed).mockImplementation(() => {
                    throw Error('satellite mode');
                });
            expect(session.isCurrent()).toBe(false);
            owner = true;
            vi.mocked(Date.now).mockReturnValue(fixture.now);
            vi.mocked(assertNetworkAllowed).mockReset();
            expect(session.isCurrent()).toBe(false);
            expect(() => session.index).toThrow(/retired/);
        },
    );
    it('aborts an old viewport when a new gap supersedes it even if native fetch ignores abort', async () => {
        let late!: (r: Response) => void;
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) =>
                path(url).includes('tile-')
                    ? new Promise<Response>((resolve) => {
                          late = resolve;
                      })
                    : Promise.resolve(new Response(resources[path(url)])),
            ),
        );
        const session = await openOpticalSession(new AbortController().signal, () => true);
        const old = session.readViewport([-71, 9, -69, 11]);
        const refused = expect(old).rejects.toThrow(/retired/);
        expect((await session.readViewport([0, 0, 1, 1])).rows).toEqual([]);
        await refused;
        late(new Response(resources[Object.keys(resources).find((k) => k.includes('tile-'))!]));
        await new Promise((r) => setTimeout(r, 0));
        session.close();
    });
    it('keeps both aborted native read slots charged until their actual promises settle', async () => {
        const finish: Array<(response: Response) => void> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>((resolve) => finish.push(resolve))),
        );
        const first = new AbortController(),
            second = new AbortController();
        const a = openOpticalSession(first.signal, () => true),
            b = openOpticalSession(second.signal, () => true);
        const refusedA = expect(a).rejects.toThrow(/retired/),
            refusedB = expect(b).rejects.toThrow(/retired/);
        expect(finish).toHaveLength(2);
        first.abort();
        second.abort();
        await refusedA;
        await refusedB;
        await expect(openOpticalSession(new AbortController().signal, () => true)).rejects.toThrow(/capacity/);
        finish.forEach((resolve) => resolve(new Response(resources['latest.json'])));
        await new Promise((resolve) => setTimeout(resolve, 0));
        vi.stubGlobal('fetch', fetcher());
        const fresh = await openOpticalSession(new AbortController().signal, () => true);
        fresh.close();
    });
});
