/**
 * The Pi's OSM overlay cache (Phase 2b, 2026-10-01).
 *
 * Until now a failed Overpass call answered an EMPTY overlay, which the phone
 * took as "no canals here" and saved over its last good copy; a 200 carrying
 * an Overpass runtime error (`remark`) was cached for 7 days as if complete;
 * and the cache key was a Math.round bbox while the query used the unrounded
 * one, so a later request could get water up to ~0.005° short at an edge.
 *
 * Now: a remark reply is a failure, an all-empty reply is served but never
 * cached, the query and the key use the same grid-expanded bbox (v6), and on
 * a failure the newest saved copy for the key is served as 'stale' (any age,
 * a v5 file included) — or the call throws OsmOverlayUnavailableError so the
 * route can answer 503. Overpass is injected (fetchOverpass): the outbound
 * policy blocks 127.0.0.0/8, so a local stub server could not be reached.
 *
 * Run: cd pi-cache && npx tsx --test src/services/osm.test.mts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOsmOverlay, OsmOverlayUnavailableError, type OverpassReply, type OverpassRequest } from './osm.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 2, 0, 0);

/** One closed natural=water way, as Overpass `out geom` returns it. */
const WATER_WAY = {
    type: 'way',
    id: 4242,
    tags: { natural: 'water', water: 'canal' },
    geometry: [
        { lat: -27.21, lon: 153.09 },
        { lat: -27.21, lon: 153.1 },
        { lat: -27.2, lon: 153.1 },
        { lat: -27.21, lon: 153.09 },
    ],
};

function reply(body: unknown, status = 200): OverpassReply {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

async function tempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'osm-cache-test-'));
}

/** A recording Overpass stand-in. */
function overpass(answers: Array<OverpassReply | Error>) {
    const queries: string[] = [];
    return {
        queries,
        fetchOverpass: async (init: OverpassRequest): Promise<OverpassReply> => {
            queries.push(decodeURIComponent(String(init.body).replace(/^data=/, '')));
            const next = answers.shift();
            if (!next) throw new Error('no more answers');
            if (next instanceof Error) throw next;
            return next;
        },
    };
}

test('a good Overpass reply is served fresh and saved as v6; the next call is served from the cache', async () => {
    const cacheDir = await tempDir();
    const o = overpass([reply({ elements: [WATER_WAY] })]);
    const first = await getOsmOverlay(
        [153.0912, -27.2127, 153.1046, -27.1999],
        {},
        {
            fetchOverpass: o.fetchOverpass,
            cacheDir,
            now: () => T0,
        },
    );
    assert.equal(first.state, 'fresh');
    assert.equal(first.fetchedAt, T0);
    assert.equal(first.overlay.water.features.length, 1);
    const files = await fs.readdir(cacheDir);
    assert.deepEqual(files, ['v6_153.09_-27.22_153.11_-27.19.json']);
    const saved = JSON.parse(await fs.readFile(path.join(cacheDir, files[0]), 'utf8'));
    assert.equal(saved.schema, 'v6');
    assert.equal(saved.ts, T0);
    assert.deepEqual(saved.bbox, [153.09, -27.22, 153.11, -27.19]);

    const second = await getOsmOverlay(
        [153.0912, -27.2127, 153.1046, -27.1999],
        {},
        {
            fetchOverpass: o.fetchOverpass,
            cacheDir,
            now: () => T0 + DAY,
        },
    );
    assert.equal(second.state, 'cache');
    assert.equal(second.fetchedAt, T0);
    assert.equal(second.overlay.water.features.length, 1);
    assert.equal(o.queries.length, 1, 'the cache hit must not call Overpass');
});

test('the query and the key use the same grid-expanded bbox (W/S floored, E/N ceiled to 0.01)', async () => {
    const cacheDir = await tempDir();
    const o = overpass([reply({ elements: [WATER_WAY] })]);
    await getOsmOverlay(
        [153.0912, -27.2127, 153.1046, -27.1999],
        {},
        {
            fetchOverpass: o.fetchOverpass,
            cacheDir,
            now: () => T0,
        },
    );
    // Overpass order is (south, west, north, east).
    assert.match(o.queries[0], /\(-27\.22,153\.09,-27\.19,153\.11\)/);
    assert.doesNotMatch(o.queries[0], /153\.0912|-27\.2127/);
    // An edge already on the grid stays put (no float creep to the next step).
    const o2 = overpass([reply({ elements: [WATER_WAY] })]);
    await getOsmOverlay(
        [153.05, -27.25, 153.2, -27.15],
        {},
        { fetchOverpass: o2.fetchOverpass, cacheDir, now: () => T0 },
    );
    assert.match(o2.queries[0], /\(-27\.25,153\.05,-27\.15,153\.2\)/);
});

test('a 200 with an Overpass remark is a failure: nothing is cached, and with no copy the call throws', async () => {
    const cacheDir = await tempDir();
    const o = overpass([
        reply({ remark: 'runtime error: Query timed out in "query" at line 3', elements: [WATER_WAY] }),
    ]);
    await assert.rejects(
        getOsmOverlay(
            [153.0912, -27.2127, 153.1046, -27.1999],
            { acceptStale: true },
            {
                fetchOverpass: o.fetchOverpass,
                cacheDir,
                now: () => T0,
            },
        ),
        OsmOverlayUnavailableError,
    );
    assert.deepEqual(await fs.readdir(cacheDir).catch(() => []), []);
});

test('an HTTP error, a network error or bad JSON with nothing saved throws OsmOverlayUnavailableError', async () => {
    for (const answer of [reply('busy', 429), new Error('getaddrinfo ENOTFOUND'), reply('<html>oops</html>')]) {
        const cacheDir = await tempDir();
        const o = overpass([answer]);
        await assert.rejects(
            getOsmOverlay(
                [153.09, -27.22, 153.11, -27.19],
                { acceptStale: true },
                {
                    fetchOverpass: o.fetchOverpass,
                    cacheDir,
                    now: () => T0,
                },
            ),
            OsmOverlayUnavailableError,
        );
        assert.deepEqual(await fs.readdir(cacheDir).catch(() => []), []);
    }
});

test('Overpass down with an expired v6 copy → that copy, stale, with its own date; the file is not rewritten', async () => {
    const cacheDir = await tempDir();
    const ok = overpass([reply({ elements: [WATER_WAY] })]);
    await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        {},
        { fetchOverpass: ok.fetchOverpass, cacheDir, now: () => T0 },
    );
    const file = path.join(cacheDir, 'v6_153.09_-27.22_153.11_-27.19.json');
    const before = await fs.readFile(file, 'utf8');

    const down = overpass([new Error('offline')]);
    const later = T0 + 30 * DAY;
    const res = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        { acceptStale: true },
        {
            fetchOverpass: down.fetchOverpass,
            cacheDir,
            now: () => later,
        },
    );
    assert.equal(res.state, 'stale');
    assert.equal(res.fetchedAt, T0);
    assert.equal(res.overlay.water.features.length, 1);
    assert.equal(down.queries.length, 1, 'an expired copy is refreshed first');
    assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('Overpass down with only a legacy v5 copy (Math.round key) → stale, from that file', async () => {
    const cacheDir = await tempDir();
    // The pre-2b Pi keyed by Math.round of the REQUEST bbox.
    await fs.writeFile(
        path.join(cacheDir, 'v5_153.09_-27.21_153.10_-27.20.json'),
        JSON.stringify({
            ts: T0 - 40 * DAY,
            data: {
                water: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            properties: { _osmId: 1 },
                            geometry: {
                                type: 'Polygon',
                                coordinates: [
                                    [
                                        [153.09, -27.21],
                                        [153.1, -27.21],
                                        [153.1, -27.2],
                                        [153.09, -27.21],
                                    ],
                                ],
                            },
                        },
                    ],
                },
                reef: { type: 'FeatureCollection', features: [] },
                coastline: { type: 'FeatureCollection', features: [] },
                marina: { type: 'FeatureCollection', features: [] },
                breakwater: { type: 'FeatureCollection', features: [] },
                aeroway: { type: 'FeatureCollection', features: [] },
                canalLines: { type: 'FeatureCollection', features: [] },
                navLines: { type: 'FeatureCollection', features: [] },
                berths: { type: 'FeatureCollection', features: [] },
            },
        }),
    );
    const down = overpass([reply('gateway timeout', 504)]);
    const res = await getOsmOverlay(
        [153.0912, -27.2127, 153.1046, -27.1999],
        { acceptStale: true },
        {
            fetchOverpass: down.fetchOverpass,
            cacheDir,
            now: () => T0,
        },
    );
    assert.equal(res.state, 'stale');
    assert.equal(res.fetchedAt, T0 - 40 * DAY);
    assert.equal(res.overlay.water.features.length, 1);
    // A v5 file that is all-empty may be a failure the old Pi saved: it is
    // never served as the boat's copy.
    const emptyDir = await tempDir();
    await fs.writeFile(
        path.join(emptyDir, 'v5_153.09_-27.21_153.10_-27.20.json'),
        JSON.stringify({ ts: T0 - DAY, data: { water: { type: 'FeatureCollection', features: [] } } }),
    );
    const down2 = overpass([new Error('offline')]);
    await assert.rejects(
        getOsmOverlay(
            [153.0912, -27.2127, 153.1046, -27.1999],
            { acceptStale: true },
            {
                fetchOverpass: down2.fetchOverpass,
                cacheDir: emptyDir,
                now: () => T0,
            },
        ),
        OsmOverlayUnavailableError,
    );
});

test('an all-empty reply is served fresh but never cached', async () => {
    const cacheDir = await tempDir();
    const o = overpass([reply({ elements: [] }), reply({ elements: [] })]);
    const res = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        {},
        {
            fetchOverpass: o.fetchOverpass,
            cacheDir,
            now: () => T0,
        },
    );
    assert.equal(res.state, 'fresh');
    assert.equal(res.overlay.water.features.length, 0);
    assert.deepEqual(await fs.readdir(cacheDir).catch(() => []), []);
    // …so the next request asks Overpass again rather than trusting nothing.
    await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        {},
        { fetchOverpass: o.fetchOverpass, cacheDir, now: () => T0 },
    );
    assert.equal(o.queries.length, 2);
});

// ── Fix-up, 2026-10-02 ───────────────────────────────────────────────
// A phone from before 2b ignores X-Osm-Overlay: a stale copy would read to it
// as fresh, be held for 30 min and written to its disk copy with no caveat.
// So 'stale' is served only to a phone that asks for it (acceptStale, the
// route's &stale=1); any other gets the 503 it already reads as a failure.
// And a hanging Overpass no longer holds the phone past its own 20 s timeout:
// with a copy to fall back on, the copy goes out after a short wait while the
// fetch carries on and refreshes the cache.

/** Seed a v6 copy for [153.09, -27.22, 153.11, -27.19], saved at `ts`. */
async function seedV6(cacheDir: string, ts: number): Promise<void> {
    const ok = overpass([reply({ elements: [WATER_WAY] })]);
    await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        {},
        { fetchOverpass: ok.fetchOverpass, cacheDir, now: () => ts },
    );
}

test('a client that does not accept stale (a pre-2b phone) never gets the stale copy: unavailable instead', async () => {
    const cacheDir = await tempDir();
    await seedV6(cacheDir, T0);
    const down = overpass([new Error('offline')]);
    await assert.rejects(
        getOsmOverlay(
            [153.09, -27.22, 153.11, -27.19],
            {},
            {
                fetchOverpass: down.fetchOverpass,
                cacheDir,
                now: () => T0 + 30 * DAY,
            },
        ),
        OsmOverlayUnavailableError,
    );
    // …while a copy under 7 days old is still served to it as 'cache', as
    // the pre-2b Pi always did.
    const res = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        {},
        {
            fetchOverpass: down.fetchOverpass,
            cacheDir,
            now: () => T0 + DAY,
        },
    );
    assert.equal(res.state, 'cache');
});

/** An Overpass that answers only when released, and fails when aborted. */
function hangingOverpass() {
    let release: ((r: OverpassReply) => void) | null = null;
    let calls = 0;
    let markAborted: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
        markAborted = resolve;
    });
    return {
        get calls() {
            return calls;
        },
        /** Settles when the client aborts the hanging fetch (its deadline). */
        aborted,
        release: (r: OverpassReply) => release?.(r),
        fetchOverpass: (init: OverpassRequest): Promise<OverpassReply> => {
            calls++;
            return new Promise<OverpassReply>((resolve, reject) => {
                release = resolve;
                init.signal.addEventListener('abort', () => {
                    markAborted();
                    reject(new Error('aborted'));
                });
            });
        },
    };
}

test('a hanging Overpass with a saved copy → the copy, stale, within the short wait; the fetch carries on and refreshes the cache', async () => {
    const cacheDir = await tempDir();
    await seedV6(cacheDir, T0);
    const later = T0 + 30 * DAY;
    const hang = hangingOverpass();
    const started = Date.now();
    const res = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        { acceptStale: true },
        {
            fetchOverpass: hang.fetchOverpass,
            cacheDir,
            now: () => later,
            staleAfterMs: 50,
            overpassTimeoutMs: 5_000,
        },
    );
    assert.equal(res.state, 'stale');
    assert.equal(res.fetchedAt, T0);
    assert.ok(Date.now() - started < 2_000, 'served long before the Overpass deadline');

    // A second request meanwhile joins the same Overpass call.
    const again = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        { acceptStale: true },
        {
            fetchOverpass: hang.fetchOverpass,
            cacheDir,
            now: () => later,
            staleAfterMs: 50,
            overpassTimeoutMs: 5_000,
        },
    );
    assert.equal(again.state, 'stale');
    assert.equal(hang.calls, 1);

    // Overpass answers after all: the cache is refreshed for the next call.
    hang.release(reply({ elements: [WATER_WAY, { ...WATER_WAY, id: 4343 }] }));
    let next: Awaited<ReturnType<typeof getOsmOverlay>> | null = null;
    for (let i = 0; i < 50; i++) {
        next = await getOsmOverlay(
            [153.09, -27.22, 153.11, -27.19],
            { acceptStale: true },
            {
                fetchOverpass: async () => {
                    throw new Error('must not be asked: the cache is fresh');
                },
                cacheDir,
                now: () => later,
                staleAfterMs: 50,
            },
        ).catch(() => null);
        if (next?.state === 'cache') break;
        await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(next?.state, 'cache');
    assert.equal(next?.fetchedAt, later);
    assert.equal(next?.overlay.water.features.length, 2);
});

test('a hanging Overpass with nothing saved waits for its full deadline, then is unavailable', async () => {
    const cacheDir = await tempDir();
    const hang = hangingOverpass();
    const started = Date.now();
    await assert.rejects(
        getOsmOverlay(
            [153.09, -27.22, 153.11, -27.19],
            { acceptStale: true },
            {
                fetchOverpass: hang.fetchOverpass,
                cacheDir,
                now: () => T0,
                staleAfterMs: 20,
                overpassTimeoutMs: 200,
            },
        ),
        OsmOverlayUnavailableError,
    );
    assert.ok(Date.now() - started >= 180, 'no copy to fall back on: the whole deadline is used');
    assert.deepEqual(await fs.readdir(cacheDir).catch(() => []), []);
});

test('a hanging Overpass that never answers is aborted at its deadline after the stale copy went out', async () => {
    const cacheDir = await tempDir();
    await seedV6(cacheDir, T0);
    const file = path.join(cacheDir, 'v6_153.09_-27.22_153.11_-27.19.json');
    const before = await fs.readFile(file, 'utf8');
    const hang = hangingOverpass();
    const res = await getOsmOverlay(
        [153.09, -27.22, 153.11, -27.19],
        { acceptStale: true },
        {
            fetchOverpass: hang.fetchOverpass,
            cacheDir,
            now: () => T0 + 30 * DAY,
            staleAfterMs: 20,
            overpassTimeoutMs: 150,
        },
    );
    assert.equal(res.state, 'stale');
    // Wait for the deadline's abort itself, not a fixed 300 ms: on a loaded CI
    // runner the 150 ms timer plus the in-flight cleanup overran 300 ms
    // (run 37402933748, 2026-10-06), and the next call still saw the refresh
    // in flight and answered 'stale'.
    await hang.aborted;
    // Aborted, not saved over; and a later call asks Overpass again.
    assert.equal(await fs.readFile(file, 'utf8'), before);
    const ok = overpass([reply({ elements: [WATER_WAY] })]);
    let fresh = { state: 'stale' } as Awaited<ReturnType<typeof getOsmOverlay>>;
    for (let attempt = 0; attempt < 40 && fresh.state === 'stale'; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 25));
        // A call made while the aborted refresh is still being cleared up
        // answers 'stale' WITHOUT asking Overpass, so ok.queries stays exact.
        fresh = await getOsmOverlay(
            [153.09, -27.22, 153.11, -27.19],
            { acceptStale: true },
            {
                fetchOverpass: ok.fetchOverpass,
                cacheDir,
                now: () => T0 + 30 * DAY,
                staleAfterMs: 20,
            },
        );
    }
    // On a loaded runner a call's 20 ms wait can run out before Overpass
    // answers (CI run 37678438362, 2026-10-08): that call says 'stale' while
    // its refresh lands and saves, and the next call is served the new copy
    // as 'cache'. Either way the copy is the one new Overpass reply's.
    assert.ok(fresh.state === 'fresh' || fresh.state === 'cache', `state ${fresh.state}`);
    assert.equal(fresh.fetchedAt, T0 + 30 * DAY);
    assert.equal(ok.queries.length, 1);
});

test('a cache write leaves no temporary file behind', async () => {
    const cacheDir = await tempDir();
    await seedV6(cacheDir, T0);
    assert.deepEqual(await fs.readdir(cacheDir), ['v6_153.09_-27.22_153.11_-27.19.json']);
});
