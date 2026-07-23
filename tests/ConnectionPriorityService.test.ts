/**
 * ConnectionPriorityService — network-aware throttling tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We must re-import after each test module reset because
// the module has top-level state.
let mod: typeof import('../services/ConnectionPriorityService');

describe('ConnectionPriorityService', () => {
    beforeEach(async () => {
        vi.resetModules();
        // Default: navigator.onLine = true, no Network Info API
        Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
        (navigator as any).connection = undefined;
        mod = await import('../services/ConnectionPriorityService');
    });

    afterEach(() => {
        mod.stopConnectionMonitor();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('getConnectionState', () => {
        it('returns connection state object', () => {
            const state = mod.getConnectionState();
            expect(state).toHaveProperty('quality');
            expect(state).toHaveProperty('type');
            expect(state).toHaveProperty('effectiveDownlink');
            expect(state).toHaveProperty('saveData');
        });

        it('defaults to high quality when online with no Network Info API', () => {
            const state = mod.getConnectionState();
            expect(state.quality).toBe('high');
            expect(state.type).toBe('unknown');
        });
    });

    describe('isOperationAllowed', () => {
        it('critical operations always allowed', () => {
            expect(mod.isOperationAllowed('critical')).toBe(true);
        });

        it('normal operations allowed on high quality', () => {
            expect(mod.isOperationAllowed('normal')).toBe(true);
        });

        it('bulk operations allowed on high quality', () => {
            expect(mod.isOperationAllowed('bulk')).toBe(true);
        });
    });

    describe('requireConnection', () => {
        it('does not throw for allowed operations', () => {
            expect(() => mod.requireConnection('critical', 'test op')).not.toThrow();
        });
    });

    describe('getAllowedOperations', () => {
        it('returns all operations when high quality', () => {
            const ops = mod.getAllowedOperations();
            expect(ops.length).toBe(3); // critical + normal + bulk
        });
    });

    describe('forceSatelliteMode', () => {
        it('switches to low quality satellite mode', () => {
            mod.forceSatelliteMode(true);
            const state = mod.getConnectionState();
            expect(state.quality).toBe('low');
            expect(state.type).toBe('satellite');
            expect(state.saveData).toBe(true);
        });

        it('blocks bulk operations in satellite mode', () => {
            mod.forceSatelliteMode(true);
            expect(mod.isOperationAllowed('bulk')).toBe(false);
            expect(mod.isOperationAllowed('normal')).toBe(true);
            expect(mod.isOperationAllowed('critical')).toBe(true);
        });

        it('requireConnection throws for bulk in satellite mode', () => {
            mod.forceSatelliteMode(true);
            expect(() => mod.requireConnection('bulk', 'image upload')).toThrow(mod.ConnectionThrottledError);
        });

        it('disabling satellite mode restores detection', () => {
            mod.forceSatelliteMode(true);
            mod.forceSatelliteMode(false);
            expect(mod.getConnectionState().quality).toBe('high');
        });
    });

    describe('onConnectionChange', () => {
        it('calls listener when state changes', () => {
            const cb = vi.fn();
            mod.onConnectionChange(cb);
            mod.forceSatelliteMode(true);
            expect(cb).toHaveBeenCalledWith(expect.objectContaining({ type: 'satellite' }));
        });

        it('unsubscribe prevents further calls', () => {
            const cb = vi.fn();
            const unsub = mod.onConnectionChange(cb);
            unsub();
            mod.forceSatelliteMode(true);
            expect(cb).not.toHaveBeenCalled();
        });

        it('lazily monitors while subscribed and tears down after the final unsubscribe', () => {
            vi.useFakeTimers();
            const addSpy = vi.spyOn(window, 'addEventListener');
            const removeSpy = vi.spyOn(window, 'removeEventListener');

            const unsubscribeFirst = mod.onConnectionChange(vi.fn());
            const unsubscribeSecond = mod.onConnectionChange(vi.fn());

            expect(addSpy.mock.calls.filter(([event]) => event === 'online')).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(1);
            unsubscribeFirst();
            expect(vi.getTimerCount()).toBe(1);
            unsubscribeSecond();
            expect(removeSpy.mock.calls.filter(([event]) => event === 'online')).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('connection monitoring lifecycle', () => {
        it('starts once and tears down the exact listeners and poller once', () => {
            vi.useFakeTimers();
            const connection = new EventTarget();
            const connectionAddSpy = vi.spyOn(connection, 'addEventListener');
            const connectionRemoveSpy = vi.spyOn(connection, 'removeEventListener');
            Object.assign(connection, { effectiveType: '4g', downlink: 10, saveData: false });
            Object.defineProperty(navigator, 'connection', {
                value: connection,
                writable: true,
                configurable: true,
            });
            const windowAddSpy = vi.spyOn(window, 'addEventListener');
            const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

            mod.startConnectionMonitor();
            mod.startConnectionMonitor();

            expect(windowAddSpy.mock.calls.filter(([event]) => event === 'online')).toHaveLength(1);
            expect(windowAddSpy.mock.calls.filter(([event]) => event === 'offline')).toHaveLength(1);
            expect(connectionAddSpy).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(1);

            mod.stopConnectionMonitor();
            mod.stopConnectionMonitor();

            expect(windowRemoveSpy.mock.calls.filter(([event]) => event === 'online')).toHaveLength(1);
            expect(windowRemoveSpy.mock.calls.filter(([event]) => event === 'offline')).toHaveLength(1);
            expect(connectionRemoveSpy).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('treats a zero-downlink connection as satellite instead of defaulting to broadband', () => {
            const connection = new EventTarget();
            Object.assign(connection, {
                effectiveType: 'slow-2g',
                downlink: 0,
                saveData: false,
            });
            Object.defineProperty(navigator, 'connection', {
                value: connection,
                writable: true,
                configurable: true,
            });

            mod.forceSatelliteMode(false);

            expect(mod.getConnectionState()).toMatchObject({
                quality: 'low',
                type: 'satellite',
                effectiveDownlink: 0,
            });
        });

        it('keeps the explicit satellite override active across monitor refreshes', () => {
            vi.useFakeTimers();
            mod.forceSatelliteMode(true);

            mod.startConnectionMonitor();
            vi.advanceTimersByTime(60_000);

            expect(mod.getConnectionState()).toMatchObject({
                quality: 'low',
                type: 'satellite',
                saveData: true,
            });
        });

        it('notifies listeners when save-data or downlink changes without a type change', () => {
            const connection = new EventTarget();
            Object.assign(connection, { effectiveType: '4g', downlink: 10, saveData: false });
            Object.defineProperty(navigator, 'connection', {
                value: connection,
                writable: true,
                configurable: true,
            });
            mod.forceSatelliteMode(false);
            const listener = vi.fn();
            mod.onConnectionChange(listener);
            Object.assign(connection, { downlink: 8, saveData: true });

            connection.dispatchEvent(new Event('change'));

            expect(listener).toHaveBeenCalledWith(expect.objectContaining({ effectiveDownlink: 8, saveData: true }));
        });
    });

    describe('ConnectionThrottledError', () => {
        it('has correct properties', () => {
            const err = new mod.ConnectionThrottledError(
                'image upload',
                { quality: 'low', type: 'satellite', effectiveDownlink: 0.02, saveData: true },
                'bulk',
            );
            expect(err.name).toBe('ConnectionThrottledError');
            expect(err.operation).toBe('image upload');
            expect(err.requiredPriority).toBe('bulk');
            expect(err.message).toContain('image upload');
            expect(err.message).toContain('satellite');
        });
    });
});
