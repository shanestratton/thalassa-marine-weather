import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    PI_WORKLOAD_BUSY_CODE,
    PiWorkloadAbortedError,
    PiWorkloadBusyError,
    PiWorkloadGovernor,
} from './workloadGovernor.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('each lane admits one active task, two queued tasks, then a stable 429 overflow', async () => {
    const governor = new PiWorkloadGovernor();
    const gate = deferred();
    let active = 0;
    let maximumActive = 0;
    const run = (): Promise<void> =>
        governor.submit('conversion', async () => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            await gate.promise;
            active--;
        }).completion;

    const first = run();
    const second = run();
    const third = run();
    assert.deepEqual(governor.snapshot('conversion'), { active: 1, queued: 2, activeLimit: 1, queueLimit: 2 });
    assert.throws(
        () => run(),
        (error: unknown) =>
            error instanceof PiWorkloadBusyError &&
            error.status === 429 &&
            error.code === PI_WORKLOAD_BUSY_CODE &&
            error.retryAfterSeconds === 10,
    );

    gate.resolve();
    await Promise.all([first, second, third]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(governor.snapshot('conversion'), { active: 0, queued: 0, activeLimit: 1, queueLimit: 2 });
});

test('conversion and route lanes can make progress independently', async () => {
    const governor = new PiWorkloadGovernor();
    const conversion = deferred();
    const route = deferred();
    let conversionStarted = false;
    let routeStarted = false;

    const conversionRun = governor.submit('conversion', async () => {
        conversionStarted = true;
        await conversion.promise;
    }).completion;
    const routeRun = governor.submit('route', async () => {
        routeStarted = true;
        await route.promise;
    }).completion;
    await Promise.resolve();

    assert.equal(conversionStarted, true);
    assert.equal(routeStarted, true);
    conversion.resolve();
    route.resolve();
    await Promise.all([conversionRun, routeRun]);
});

test('queue is FIFO and rejected work always releases the next lease', async () => {
    const governor = new PiWorkloadGovernor();
    const firstGate = deferred();
    const order: string[] = [];
    const first = governor.submit('route', async () => {
        order.push('first');
        await firstGate.promise;
        throw new Error('expected route failure');
    }).completion;
    const second = governor.submit('route', () => {
        order.push('second');
    }).completion;
    const third = governor.submit('route', () => {
        order.push('third');
    }).completion;

    firstGate.resolve();
    await assert.rejects(first, /expected route failure/);
    await Promise.all([second, third]);
    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.equal(governor.snapshot('route').active, 0);
});

test('aborting a queued admission removes it and leaves capacity usable', async () => {
    const governor = new PiWorkloadGovernor();
    const first = await governor.admit('conversion').lease;
    const controller = new AbortController();
    const queued = governor.admit('conversion', { signal: controller.signal }).lease;
    controller.abort();
    await assert.rejects(queued, PiWorkloadAbortedError);
    assert.equal(governor.snapshot('conversion').queued, 0);

    const replacement = governor.admit('conversion');
    assert.equal(replacement.queued, true);
    first.release();
    const replacementLease = await replacement.lease;
    replacementLease.release();
    assert.equal(governor.snapshot('conversion').active, 0);
});

test('an aborted active task releases its lane exactly once', async () => {
    const governor = new PiWorkloadGovernor();
    const controller = new AbortController();
    const active = governor.submit(
        'route',
        (signal) =>
            new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('task aborted')), { once: true });
            }),
        { signal: controller.signal },
    ).completion;
    const next = governor.submit('route', () => 'next').completion;
    await Promise.resolve();
    controller.abort();

    await assert.rejects(active, /task aborted/);
    assert.equal(await next, 'next');
    assert.deepEqual(governor.snapshot('route'), { active: 0, queued: 0, activeLimit: 1, queueLimit: 2 });
});
