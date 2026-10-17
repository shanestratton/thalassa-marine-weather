import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTrackRoutes } from './track.js';
import type { TrackStore } from '../trackStore.js';
import type { TrackRecorderRunner } from '../trackRunner.js';

test('opt-in HTTP paging validates composite cursors before calling SQLite; legacy protocol remains unchanged', async () => {
    const queries: unknown[] = [];
    let legacy = 0;
    const store = {
        points: () => {
            legacy++;
            return [];
        },
        pointsPage: (query: unknown) => {
            queries.push(query);
            return { points: [], snapshot: 0, truncated: false, nextCursor: null };
        },
    } as unknown as TrackStore;
    const app = express();
    app.use('/api/track', createTrackRoutes(store, {} as TrackRecorderRunner));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/track/points`;
    try {
        for (const query of [
            'page=2',
            'page=1&from=NaN',
            'page=1&limit=1.5',
            'page=1&limit=0',
            'page=1&from=1&to=10&cursor=2:3:2',
            'page=1&from=1&to=10&cursor=0:1:2',
            'page=1&cursor=1:2:9007199254740992',
            'page=1&cursor=1%3BDELETE%20FROM%20track_points',
            'page=1&cursor[]=1:1:1',
        ]) {
            assert.equal((await fetch(`${base}?${query}`)).status, 400, query);
        }
        assert.equal(queries.length, 0);
        const paged = await (await fetch(`${base}?page=1&from=1&to=10&limit=9999&cursor=2:1:5`)).json();
        assert.equal(paged.page, 1);
        assert.equal(paged.limit, 2000);
        assert.deepEqual(queries[0], { fromMs: 1, toMs: 10, limit: 2000, cursor: { atMs: 2, rowId: 1, snapshot: 5 } });
        const old = await (await fetch(`${base}?from=1&to=10`)).json();
        assert.equal(old.page, undefined);
        assert.equal(old.snapshot, undefined);
        assert.equal(legacy, 1);
    } finally {
        server.close();
    }
});
