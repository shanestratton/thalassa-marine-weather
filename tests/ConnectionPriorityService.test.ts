/**
 * ConnectionPriorityService — network-aware throttling tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
