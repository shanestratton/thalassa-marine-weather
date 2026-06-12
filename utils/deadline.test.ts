/**
 * deadline tests — the JS-level bounds that replace AbortSignal on
 * device (CapacitorHttp's fetch patch ignores options.signal; see
 * deadline.ts header).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceeded, withDeadline, withTimeout } from './deadline';

describe('withTimeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('passes through a fast resolution', async () => {
        const p = withTimeout(Promise.resolve(42), 0, 1000);
        await expect(p).resolves.toBe(42);
    });

    it('resolves the fallback when the promise never settles', async () => {
        const never = new Promise<number>(() => {});
        const p = withTimeout(never, -1, 5000);
        vi.advanceTimersByTime(5001);
        await expect(p).resolves.toBe(-1);
    });

    it('propagates rejection (existing catch blocks keep working)', async () => {
        const p = withTimeout(Promise.reject(new Error('boom')), 0, 1000);
        await expect(p).rejects.toThrow('boom');
    });

    it('late settlement after timeout is ignored, not unhandled', async () => {
        let resolveLate: (v: number) => void = () => {};
        const late = new Promise<number>((res) => (resolveLate = res));
        const p = withTimeout(late, -1, 100);
        vi.advanceTimersByTime(101);
        await expect(p).resolves.toBe(-1);
        resolveLate(99); // must not throw or re-resolve
    });
});

describe('withDeadline', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('passes through a fast resolution', async () => {
        await expect(withDeadline(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok');
    });

    it('rejects DeadlineExceeded with the label when stalled', async () => {
        const never = new Promise<string>(() => {});
        const p = withDeadline(never, 30_000, 'gebco-depth');
        const assertion = expect(p).rejects.toMatchObject({
            name: 'DeadlineExceeded',
            message: expect.stringContaining('gebco-depth'),
        });
        vi.advanceTimersByTime(30_001);
        await assertion;
    });

    it('original rejection wins over the deadline', async () => {
        const p = withDeadline(Promise.reject(new Error('real failure')), 1000, 'test');
        await expect(p).rejects.toThrow('real failure');
    });

    it('DeadlineExceeded is an Error instance', () => {
        const e = new DeadlineExceeded('x', 5);
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toContain('5ms');
    });
});
