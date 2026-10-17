import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const policy = vi.hoisted(() => ({ allowed: true }));
vi.mock('../services/networkPolicy', () => ({
    assertNetworkAllowed: () => {
        if (!policy.allowed) throw Error('metered');
    },
}));
import { crowdViewportTiles, decodeCrowdIndex, decodeCrowdTile, readCrowdViewport } from '../services/seabed/crowdMap';
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/crowd142/fictional-cohort.json', 'utf8'));
const pointer = JSON.parse(fixture.pointer),
    generation = pointer.generation;
const rawIndex = fixture.objects[generation + '/index.json'];
const tileKey = Object.keys(JSON.parse(rawIndex).tiles)[0];
const rawTile = fixture.objects[generation + '/tile-' + tileKey + '.json'];
const bounds = [153.99, -27.01, 154.01, -26.99] as const;
beforeEach(() => {
    policy.allowed = true;
    vi.spyOn(Date, 'now').mockReturnValue(fixture.now);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function transport() {
    return vi.fn(async (url: string) => {
        const key = new URL(url).pathname.split('/crowd/v1/generations/')[1];
        const body = url.endsWith('/latest.json') ? fixture.pointer : fixture.objects[key];
        return new Response(body ?? 'missing', { status: body ? 200 : 404 });
    });
}
it('has no import I/O and validates the real Python-sealed fixture before bounded viewport reads', async () => {
    const fetcher = transport();
    vi.stubGlobal('fetch', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    const lease = await readCrowdViewport(bounds, new AbortController().signal, () => true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(lease.data.features).toHaveLength(1);
    expect(lease.data.features[0].properties).toMatchObject({
        depthM: 10.5,
        navigationAuthority: false,
        uncertaintyM: 1,
        contourIntervalM: 0.5,
    });
    expect(lease.isCurrent()).toBe(true);
    lease.release();
    expect(lease.isCurrent()).toBe(false);
    expect(fetcher.mock.calls.every(([url]) => url.startsWith('https://tiles.thalassatiles.com/crowd/v1/'))).toBe(true);
});
it('refuses metered network, stale owner, expiry and oversized viewport before any reads', async () => {
    const fetcher = transport();
    vi.stubGlobal('fetch', fetcher);
    policy.allowed = false;
    await expect(readCrowdViewport(bounds, new AbortController().signal, () => true)).rejects.toThrow();
    policy.allowed = true;
    await expect(readCrowdViewport(bounds, new AbortController().signal, () => false)).rejects.toThrow();
    await expect(readCrowdViewport([-180, -80, 180, 80], new AbortController().signal, () => true)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(fixture.now + 3600000);
    await expect(readCrowdViewport(bounds, new AbortController().signal, () => true)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects corrupted original bytes, false authority, private fields, wrong datum and unrealistic contour links', async () => {
    const index = decodeCrowdIndex(JSON.parse(rawIndex), generation, fixture.now);
    for (const change of [
        { navigationAuthority: true },
        { ownerId: 'private-identity' },
        { datumId: 'unreviewed' },
        { uncertaintyM: 0.5 },
    ]) {
        const tile = JSON.parse(rawTile);
        Object.assign(tile.features[0].properties, change);
        expect(() => decodeCrowdTile(tile, index, tileKey)).toThrow();
    }
    const tile = JSON.parse(rawTile);
    tile.features[0].geometry.coordinates[1][0] += 1;
    expect(() => decodeCrowdTile(tile, index, tileKey)).toThrow();
    const fetcher = transport();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => (url.endsWith('/index.json') ? new Response(rawIndex + ' ') : fetcher(url))),
    );
    await expect(readCrowdViewport(bounds, new AbortController().signal, () => true)).rejects.toThrow();
});
it('retires the whole lease after owner/policy/clock changes and never adopts a late A/B/A read', async () => {
    let current = true,
        resolve!: (value: Response) => void;
    vi.stubGlobal(
        'fetch',
        vi.fn(
            () =>
                new Promise<Response>((r) => {
                    resolve = r;
                }),
        ),
    );
    const abort = new AbortController(),
        reading = readCrowdViewport(bounds, abort.signal, () => current);
    current = false;
    abort.abort();
    current = true;
    await expect(reading).rejects.toThrow();
    resolve(new Response(fixture.pointer));
    await Promise.resolve();
    await Promise.resolve();
    vi.stubGlobal('fetch', transport());
    const lease = await readCrowdViewport(bounds, new AbortController().signal, () => current);
    policy.allowed = false;
    expect(lease.isCurrent()).toBe(false);
    policy.allowed = true;
    vi.mocked(Date.now).mockReturnValue(fixture.now - 1);
    expect(lease.isCurrent()).toBe(false);
    lease.release();
});
it('keeps missing tiles empty and refuses unbounded/dateline windows', async () => {
    vi.stubGlobal('fetch', transport());
    const lease = await readCrowdViewport([153, -28, 153.01, -27.99], new AbortController().signal, () => true);
    expect(lease.data.features).toEqual([]);
    lease.release();
    expect(() => crowdViewportTiles([179, -27, -179, -26])).toThrow();
    expect(() => crowdViewportTiles([150, -30, 153, -27])).toThrow();
});
