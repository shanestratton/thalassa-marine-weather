import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import type { DiaryRelayOutbox, DiaryRelayPublicRecord } from '../diaryRelayOutbox.js';
import type { DiaryVideoRelay } from '../diaryVideoRelay.js';
import { createDiaryRelayRoutes } from './diary.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

async function harness(t: TestContext, initialCancellation?: DiaryRelayPublicRecord['status']) {
    let cancellation = initialCancellation;
    const calls: string[] = [];
    let beginResult: Promise<{ id: string }> = Promise.resolve({ id: 'upload-1' });
    let cleanup: Promise<void> = Promise.resolve();
    const beginEntered = deferred<void>();
    const cleanupEntered = deferred<void>();
    const status = () =>
        cancellation
            ? {
                  kind: 'cancellation',
                  operationId: 'diary-op-1',
                  status: cancellation,
                  clientRevision: 1,
                  allowInternet: false,
                  attemptCount: 0,
                  queuedAt: 1,
              }
            : null;
    const outbox = {
        getStatus: status,
        cancel: () => {
            calls.push('tombstone');
            cancellation = 'queued';
            return status();
        },
        attemptCancellation: async () => {
            calls.push('cloud-attempt');
            return status();
        },
    } as unknown as DiaryRelayOutbox;
    const videoRelay = {
        begin: async () => {
            calls.push('begin');
            beginEntered.resolve();
            return beginResult;
        },
        cancelOperation: async () => {
            calls.push('cleanup');
            cleanupEntered.resolve();
            await cleanup;
        },
    } as unknown as DiaryVideoRelay;
    const app = express();
    app.use(express.json());
    app.use('/api/diary', createDiaryRelayRoutes(outbox, videoRelay));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diary`;
    return {
        calls,
        beginEntered,
        cleanupEntered,
        delayBegin: (promise: Promise<{ id: string }>) => {
            beginResult = promise;
        },
        delayCleanup: (promise: Promise<void>) => {
            cleanup = promise;
        },
        post: (route: string) =>
            fetch(`${base}${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_operation_id: 'diary-op-1',
                    path: 'owner/video.mp4',
                    total_bytes: 8,
                    sha256: 'test',
                }),
            }),
    };
}

for (const status of ['queued', 'synced', 'needs_repair'] as const) {
    test(`video begin refuses an operation with a ${status} cancellation`, async (t) => {
        const h = await harness(t, status);
        const response = await h.post('/video/begin');
        assert.equal(response.status, 409);
        assert.equal((await response.json()).cancelled, true);
        assert.deepEqual(h.calls, []);
    });
}

test('video begin still accepts an operation without a tombstone', async (t) => {
    const h = await harness(t);
    const response = await h.post('/video/begin');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'upload-1' });
    assert.deepEqual(h.calls, ['begin']);
});

test('cancellation during async video begin removes the late clip and refuses its acknowledgement', async (t) => {
    const h = await harness(t);
    const begun = deferred<{ id: string }>();
    h.delayBegin(begun.promise);
    const request = h.post('/video/begin');
    await h.beginEntered.promise;
    const cancelled = await h.post('/cancel');
    assert.equal(cancelled.status, 200);
    begun.resolve({ id: 'late-upload' });
    const response = await request;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).cancelled, true);
    assert.deepEqual(h.calls, ['begin', 'tombstone', 'cleanup', 'cloud-attempt', 'cleanup']);
});

test('cancellation writes its tombstone and completes video cleanup before acknowledging', async (t) => {
    const h = await harness(t);
    const removed = deferred<void>();
    h.delayCleanup(removed.promise);
    let acknowledged = false;
    const request = h.post('/cancel').then((response) => {
        acknowledged = true;
        return response;
    });
    await h.cleanupEntered.promise;
    assert.equal(acknowledged, false);
    assert.deepEqual(h.calls, ['tombstone', 'cleanup']);
    removed.resolve();
    assert.equal((await request).status, 200);
    assert.deepEqual(h.calls, ['tombstone', 'cleanup', 'cloud-attempt']);
});
