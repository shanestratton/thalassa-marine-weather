// @vitest-environment node
import React, { Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyRetry } from '../utils/lazyRetry';
import { crumb } from '../utils/flightRecorder';

vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));

type LazyModule = { default: React.ComponentType };
const complete = () => ({ default: () => null });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function pendingModule(name = 'DeferredChunk') {
    let resolve!: (value: LazyModule) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<LazyModule>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const factory = vi.fn(() => promise);
    const Component = lazyRetry(factory, name);
    const render = () =>
        renderToString(React.createElement(Suspense, { fallback: 'loading' }, React.createElement(Component)));
    return { resolve, reject, factory, render };
}

describe('lazy chunk recovery respects the outgoing document lifetime', () => {
    let lifetime: EventTarget & { location: { reload: ReturnType<typeof vi.fn> } };
    let values: Map<string, string>;
    let storage: {
        getItem: ReturnType<typeof vi.fn>;
        setItem: ReturnType<typeof vi.fn>;
        removeItem: ReturnType<typeof vi.fn>;
    };
    beforeEach(() => {
        lifetime = Object.assign(new EventTarget(), { location: { reload: vi.fn() } });
        values = new Map();
        storage = {
            getItem: vi.fn((key: string) => values.get(key) ?? null),
            setItem: vi.fn((key: string, value: string) => values.set(key, value)),
            removeItem: vi.fn((key: string) => values.delete(key)),
        };
        vi.stubGlobal('window', lifetime);
        vi.stubGlobal('sessionStorage', storage);
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps wrapping pure until the real React lazy factory renders', () => {
        const add = vi.spyOn(lifetime, 'addEventListener');
        const chunk = pendingModule();
        expect(chunk.factory).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
        expect(storage.getItem).not.toHaveBeenCalled();
    });

    it.each(['beforeunload', 'pagehide'])(
        'does not reload or arm cooldown after %s rejects the outgoing import',
        async (event) => {
            const remove = vi.spyOn(lifetime, 'removeEventListener');
            const chunk = pendingModule();
            chunk.render();
            lifetime.dispatchEvent(new Event(event));
            chunk.reject(new TypeError('Importing a module script failed.'));
            await flush();
            expect(lifetime.location.reload).not.toHaveBeenCalled();
            expect(storage.getItem).not.toHaveBeenCalled();
            expect(storage.setItem).not.toHaveBeenCalled();
            expect(crumb).not.toHaveBeenCalled();
            expect(remove.mock.calls.map(([name]) => name)).toEqual(['beforeunload', 'pagehide']);
            expect(chunk.render()).toContain('Importing a module script failed.');
        },
    );

    it('still reloads a stationary stale chunk once and records both recovery fences', async () => {
        const chunk = pendingModule('StaleChunk');
        chunk.render();
        chunk.reject(new TypeError('Importing a module script failed.'));
        await flush();
        expect(lifetime.location.reload).toHaveBeenCalledTimes(1);
        expect(values.get('lazyRetry_StaleChunk')).toBe('1');
        expect(values.get('lazyRetry_lastReloadAt')).toBe('1000000');
        expect(crumb).toHaveBeenCalledWith('lazyRetry:reload', 'StaleChunk');
    });

    it('preserves the global cooldown across a different stationary module', async () => {
        values.set('lazyRetry_lastReloadAt', '999000');
        const chunk = pendingModule('AnotherChunk');
        chunk.render();
        chunk.reject(new TypeError('Genuine stale chunk'));
        await flush();
        expect(lifetime.location.reload).not.toHaveBeenCalled();
        expect(storage.removeItem).toHaveBeenCalledWith('lazyRetry_AnotherChunk');
        expect(chunk.render()).toContain('Genuine stale chunk');
    });

    it('preserves the per-module one-retry fence outside the global cooldown', async () => {
        values.set('lazyRetry_AlreadyRetried', '1');
        const chunk = pendingModule('AlreadyRetried');
        chunk.render();
        chunk.reject(new TypeError('Still missing'));
        await flush();
        expect(lifetime.location.reload).not.toHaveBeenCalled();
        expect(storage.removeItem).toHaveBeenCalledWith('lazyRetry_AlreadyRetried');
        expect(chunk.render()).toContain('Still missing');
    });

    it('removes both listeners after success and does not retire a later fresh factory', async () => {
        const remove = vi.spyOn(lifetime, 'removeEventListener');
        const chunk = pendingModule();
        chunk.render();
        chunk.resolve(complete());
        await flush();
        expect(remove.mock.calls.map(([name]) => name)).toEqual(['beforeunload', 'pagehide']);
        lifetime.dispatchEvent(new Event('beforeunload'));
        const next = pendingModule('FreshAttempt');
        next.render();
        next.reject(new TypeError('A new stale chunk'));
        await flush();
        expect(lifetime.location.reload).toHaveBeenCalledTimes(1);
        expect(values.get('lazyRetry_FreshAttempt')).toBe('1');
    });

    it('cleans both listeners if the factory itself throws synchronously', () => {
        const remove = vi.spyOn(lifetime, 'removeEventListener');
        const Component = lazyRetry(() => {
            throw Error('Synchronous import setup');
        });
        const html = renderToString(
            React.createElement(Suspense, { fallback: 'loading' }, React.createElement(Component)),
        );
        expect(html).toContain('Synchronous import setup');
        expect(remove.mock.calls.map(([name]) => name)).toEqual(['beforeunload', 'pagehide']);
        expect(lifetime.location.reload).not.toHaveBeenCalled();
    });
});
