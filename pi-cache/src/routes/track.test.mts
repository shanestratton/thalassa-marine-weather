/**
 * The track routes, driven over real HTTP through a real express app.
 *
 * The store and runner are fakes so this needs no native sqlite binding, but
 * the routing, parsing and status codes are the genuine article.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTrackRoutes } from './track.js';
import type { TrackStore } from '../trackStore.js';
import type { TrackRecorderRunner } from '../trackRunner.js';

const T0 = 1_756_500_000_000;

function harness(over: { points?: Record<string, unknown>[]; startThrows?: boolean } = {}) {
    const calls: string[] = [];
    let enabled = false;
    let lastQuery: { fromMs: number; toMs: number; limit?: number } | null = null;

    const store = {
        isEnabled: () => enabled,
        setEnabled: (v: boolean) => {
            enabled = v;
            calls.push(`setEnabled:${v}`);
        },
        points: (q: { fromMs: number; toMs: number; limit?: number }) => {
            lastQuery = q;
            return over.points ?? [];
        },
        summary: () => ({ points: 3, firstMs: T0, lastMs: T0 + 60_000, bytes: 4096 }),
    } as unknown as TrackStore;

    const runner = {
        start: () => {
            calls.push('start');
            if (over.startThrows) throw new Error('signal k is down');
        },
        stop: () => calls.push('stop'),
        describe: () => ({
            running: enabled,
            lastOutcome: 'logged' as const,
            writtenThisSession: 7,
            stored: { points: 3, firstMs: T0, lastMs: T0 + 60_000, bytes: 4096 },
        }),
    } as unknown as TrackRecorderRunner;

    const app = express();
    app.use(express.json());
    app.use('/api/track', createTrackRoutes(store, runner));
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    return {
        calls,
        query: () => lastQuery,
        base: `http://127.0.0.1:${port}/api/track`,
        close: () => server.close(),
    };
}

test('status reports what is running and what is held', async () => {
    const h = harness();
    try {
        const body = await (await fetch(`${h.base}/status`)).json();
        assert.equal(body.enabled, false);
        assert.equal(body.writtenThisSession, 7);
        assert.equal(body.stored.points, 3);
    } finally {
        h.close();
    }
});

test('enabling starts the recorder and remembers the choice', async () => {
    const h = harness();
    try {
        const res = await fetch(`${h.base}/enable`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).enabled, true);
        assert.deepEqual(h.calls, ['setEnabled:true', 'start']);
    } finally {
        h.close();
    }
});

test('the preference is written BEFORE the runner is touched', async () => {
    // A Pi that dies mid-request must come back in the state the skipper asked
    // for, not the one it happened to be in.
    const h = harness({ startThrows: true });
    try {
        await fetch(`${h.base}/enable`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        }).catch(() => undefined);
        assert.equal(h.calls[0], 'setEnabled:true');
    } finally {
        h.close();
    }
});

test('disabling stops it', async () => {
    const h = harness();
    try {
        await fetch(`${h.base}/enable`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        });
        assert.deepEqual(h.calls, ['setEnabled:false', 'stop']);
    } finally {
        h.close();
    }
});

test('a missing or non-boolean flag is refused, not guessed at', async () => {
    const h = harness();
    try {
        for (const body of ['{}', '{"enabled":"yes"}', '{"enabled":1}']) {
            const res = await fetch(`${h.base}/enable`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            });
            assert.equal(res.status, 400, body);
        }
        assert.deepEqual(h.calls, []);
    } finally {
        h.close();
    }
});

test('points default to the last day rather than the whole log', async () => {
    // An open-ended request would mean "send me everything", and on a log meant
    // to run for years nobody asks that on purpose.
    const h = harness();
    try {
        await fetch(`${h.base}/points`);
        const q = h.query();
        assert.ok(q);
        assert.ok(q.toMs - q.fromMs === 24 * 60 * 60_000);
    } finally {
        h.close();
    }
});

test('an explicit window is honoured', async () => {
    const h = harness();
    try {
        await fetch(`${h.base}/points?from=${T0}&to=${T0 + 3600_000}`);
        assert.deepEqual({ from: h.query()?.fromMs, to: h.query()?.toMs }, { from: T0, to: T0 + 3600_000 });
    } finally {
        h.close();
    }
});

test('a backwards window is refused', async () => {
    const h = harness();
    try {
        const res = await fetch(`${h.base}/points?from=${T0 + 1000}&to=${T0}`);
        assert.equal(res.status, 400);
    } finally {
        h.close();
    }
});

test('a truncated answer SAYS it was truncated', async () => {
    // A silently cut track looks exactly like a boat that stopped, which is the
    // one misreading this log must never invite.
    const h = harness({ points: [{ at_ms: T0 }, { at_ms: T0 + 1 }] });
    try {
        const body = await (await fetch(`${h.base}/points?limit=2`)).json();
        assert.equal(body.truncated, true);
        assert.equal(body.limit, 2);
    } finally {
        h.close();
    }
});

test('a short answer does not claim truncation', async () => {
    const h = harness({ points: [{ at_ms: T0 }] });
    try {
        const body = await (await fetch(`${h.base}/points?limit=500`)).json();
        assert.equal(body.truncated, false);
    } finally {
        h.close();
    }
});

test('the limit is clamped, so one request cannot drag the whole log', async () => {
    const h = harness();
    try {
        await fetch(`${h.base}/points?limit=999999999`);
        assert.equal(h.query()?.limit, 50_000);
    } finally {
        h.close();
    }
});

test('there is no way to erase the track over HTTP', async () => {
    // Deliberate: the Pi keeping the record is the whole point, and an endpoint
    // that wipes years of it on one request is worse than any convenience.
    const h = harness();
    try {
        for (const [method, path] of [
            ['DELETE', '/points'],
            ['DELETE', '/'],
            ['POST', '/clear'],
        ]) {
            const res = await fetch(`${h.base}${path}`, { method });
            assert.ok(res.status === 404 || res.status === 405, `${method} ${path} → ${res.status}`);
        }
    } finally {
        h.close();
    }
});
