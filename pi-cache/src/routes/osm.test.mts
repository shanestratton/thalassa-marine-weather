/**
 * GET /api/osm/overlay over real HTTP through a real express app (Phase 2b,
 * 2026-10-01). The overlay service is a fake, so this needs no Overpass; the
 * status codes and headers are the genuine article.
 *
 * Every success says how fresh it is (X-Osm-Overlay: fresh|cache|stale, and
 * X-Osm-Fetched-At). "Nothing saved and no internet" is a 503 the phone can
 * tell from an empty area — it used to be an empty 200.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createOsmRoutes } from './osm.js';
import {
    OsmOverlayUnavailableError,
    type OsmOverlayOptions,
    type OsmOverlayResult,
    type OsmRouteOverlay,
} from '../services/osm.js';

const T0 = Date.UTC(2026, 8, 28, 2, 0, 0);

const empty = () => ({ type: 'FeatureCollection' as const, features: [] });
const overlay = (): OsmRouteOverlay => ({
    water: {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { _osmId: 7 },
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
    reef: empty(),
    coastline: empty(),
    marina: empty(),
    breakwater: empty(),
    aeroway: empty(),
    canalLines: empty(),
    navLines: empty(),
    berths: empty(),
});

function harness(getOverlay: (bbox: [number, number, number, number]) => Promise<OsmOverlayResult>) {
    const calls: [number, number, number, number][] = [];
    const options: OsmOverlayOptions[] = [];
    const app = express();
    app.use(
        '/api/osm',
        createOsmRoutes(async (bbox, opts) => {
            calls.push(bbox);
            options.push(opts);
            return getOverlay(bbox);
        }),
    );
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    return { calls, options, base: `http://127.0.0.1:${port}/api/osm/overlay`, close: () => server.close() };
}

test('a success carries the overlay, its state and its fetch date, and is never cached by the client', async () => {
    for (const state of ['fresh', 'cache', 'stale'] as const) {
        const h = harness(async () => ({ overlay: overlay(), state, fetchedAt: T0 }));
        try {
            const res = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19&stale=1`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('x-osm-overlay'), state);
            assert.equal(res.headers.get('x-osm-fetched-at'), new Date(T0).toISOString());
            assert.equal(res.headers.get('cache-control'), 'no-store');
            const body = await res.json();
            assert.equal(body.water.features.length, 1);
            assert.deepEqual(h.calls, [[153.09, -27.22, 153.11, -27.19]]);
        } finally {
            h.close();
        }
    }
});

test('nothing saved and no internet → 503 OSM_OVERLAY_UNAVAILABLE, no-store, Retry-After — never an empty 200', async () => {
    const h = harness(async () => {
        throw new OsmOverlayUnavailableError('Overpass unavailable and nothing cached');
    });
    try {
        const res = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('retry-after'), '30');
        assert.equal(res.headers.get('x-osm-overlay'), null);
        const body = await res.json();
        assert.equal(body.code, 'OSM_OVERLAY_UNAVAILABLE');
        assert.match(body.error, /no internet on the Pi and nothing saved for this area/);
        assert.equal(body.water, undefined);
    } finally {
        h.close();
    }
});

test('an unexpected error is a 500, not an overlay', async () => {
    const h = harness(async () => {
        throw new Error('disk on fire');
    });
    try {
        const res = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19`);
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        assert.equal(body.water, undefined);
    } finally {
        h.close();
    }
});

test('bbox validation is unchanged', async () => {
    const h = harness(async () => ({ overlay: overlay(), state: 'fresh', fetchedAt: T0 }));
    try {
        for (const [query, pattern] of [
            ['', /Missing bbox/],
            ['?bbox=1,2,3', /Invalid bbox format/],
            ['?bbox=a,b,c,d', /Invalid bbox format/],
            ['?bbox=153.2,-27.22,153.1,-27.19', /W must be < E/],
            ['?bbox=150,-30,156,-27', /max 5° per side/],
        ] as const) {
            const res = await fetch(`${h.base}${query}`);
            assert.equal(res.status, 400, query);
            assert.match((await res.json()).error, pattern);
        }
        assert.equal(h.calls.length, 0);
    } finally {
        h.close();
    }
});

// Fix-up (2026-10-02): a phone from before 2b ignores X-Osm-Overlay. A stale
// copy of any age would read to it as fresh — held 30 min and written to its
// disk copy with no caveat — so only a phone that asks (&stale=1) gets one.
test('a stale copy only for a phone that asks for it: without &stale=1 it is the 503', async () => {
    const h = harness(async () => ({ overlay: overlay(), state: 'stale', fetchedAt: T0 }));
    try {
        const old = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19`);
        assert.equal(old.status, 503);
        assert.equal(old.headers.get('x-osm-overlay'), null);
        assert.equal((await old.json()).code, 'OSM_OVERLAY_UNAVAILABLE');
        assert.deepEqual(h.options[0], { acceptStale: false });

        const asks = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19&stale=1`);
        assert.equal(asks.status, 200);
        assert.equal(asks.headers.get('x-osm-overlay'), 'stale');
        assert.equal((await asks.json()).water.features.length, 1);
        assert.deepEqual(h.options[1], { acceptStale: true });
    } finally {
        h.close();
    }
});

test('fresh and cached answers reach a pre-2b phone as before', async () => {
    for (const state of ['fresh', 'cache'] as const) {
        const h = harness(async () => ({ overlay: overlay(), state, fetchedAt: T0 }));
        try {
            const res = await fetch(`${h.base}?bbox=153.09,-27.22,153.11,-27.19`);
            assert.equal(res.status, 200);
            assert.equal((await res.json()).water.features.length, 1);
        } finally {
            h.close();
        }
    }
});
