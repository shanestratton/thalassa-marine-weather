import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAscatSession } from '../services/weather/ascatSession';
import { assertNetworkAllowed } from '../services/networkPolicy';
vi.mock('../services/networkPolicy', () => ({ assertNetworkAllowed: vi.fn() }));
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/ascat141-packet.json'), 'utf8'));
const resources = fixture.resources as Record<string, string>;
const path = (url: string) => url.split('/weather/ascat/v1/')[1];
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(Date, 'now').mockReturnValue(fixture.now * 1000);
    vi.mocked(assertNetworkAllowed).mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
describe('141 bounded foreground satellite reads', () => {
    it('reads only pointer/index then only the explicit viewport with exact immutable source hashes', async () => {
        const fetcher = vi.fn(async (url: string, options: RequestInit) => {
            expect(options.redirect).toBe('error');
            return new Response(resources[path(url)] ?? '', { status: resources[path(url)] ? 200 : 404 });
        });
        vi.stubGlobal('fetch', fetcher);
        const session = await openAscatSession(new AbortController().signal, () => true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect((await session.readViewport([153, -28, 155, -26])).rows).toHaveLength(2);
        expect(fetcher).toHaveBeenCalledTimes(3);
        const before = fetcher.mock.calls.length;
        await expect(session.readViewport([-180, -80, 180, 80])).rejects.toThrow(/Zoom in/);
        expect(fetcher).toHaveBeenCalledTimes(before);
        expect((await session.readViewport([0, 0, 1, 1])).rows).toHaveLength(0);
        session.close();
        expect(session.isCurrent()).toBe(false);
        expect(() => session.index).toThrow(/retired/);
    });
    it('refuses changed child bytes and an unavailable namespace without mock or forecast fallback', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(path(url).includes('tile-') ? '{}' : resources[path(url)])),
        );
        const session = await openAscatSession(new AbortController().signal, () => true);
        await expect(session.readViewport([153, -28, 155, -26])).rejects.toThrow(/checksum/);
        session.close();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        await expect(openAscatSession(new AbortController().signal, () => true)).rejects.toThrow(/unavailable/);
    });
    it('fences actual owner changes, network policy, original expiry and rollback without refreshing truth', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(resources[path(url)])),
        );
        let owner = true;
        const session = await openAscatSession(new AbortController().signal, () => owner);
        owner = false;
        expect(session.isCurrent()).toBe(false);
        await expect(session.readViewport([153, -28, 155, -26])).rejects.toThrow(/retired/);
        owner = true;
        vi.mocked(Date.now).mockReturnValue(fixture.now * 1000 - 1001);
        expect(session.isCurrent()).toBe(false);
        vi.mocked(Date.now).mockReturnValue((fixture.now + 3600) * 1000);
        expect(session.isCurrent()).toBe(false);
        vi.mocked(Date.now).mockReturnValue(fixture.now * 1000);
        vi.mocked(assertNetworkAllowed).mockImplementation(() => {
            throw new Error('offline');
        });
        expect(session.isCurrent()).toBe(false);
        session.close();
    });
    it('retires a viewport superseded by a gap or wide view, even if native fetch ignores abort', async () => {
        let late!: (value: Response) => void;
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
        const session = await openAscatSession(new AbortController().signal, () => true);
        const first = session.readViewport([153, -28, 155, -26]);
        const rejected = expect(first).rejects.toThrow(/retired/);
        await expect(session.readViewport([-180, -80, 180, 80])).rejects.toThrow(/Zoom in/);
        await rejected;
        late(new Response(resources[Object.keys(resources).find((key) => key.includes('tile-'))!]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.close();
    });
});
